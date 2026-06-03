package com.plugin.api.features.auth.auth0

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import com.plugin.api.config.auth0JwtDecoder
import com.plugin.api.config.properties.Auth0Properties
import com.plugin.api.config.properties.UserProperties
import com.plugin.api.features.auth.core.SocialProvider
import com.plugin.api.features.user.UserRepository
import com.plugin.api.features.user.UserRole
import com.plugin.api.features.user.UsersTable
import io.r2dbc.postgresql.codec.EnumCodec
import io.r2dbc.spi.ConnectionFactories
import io.r2dbc.spi.ConnectionFactoryOptions
import io.r2dbc.spi.IsolationLevel
import io.r2dbc.spi.Option
import kotlinx.coroutines.runBlocking
import liquibase.Liquibase
import liquibase.database.DatabaseFactory
import liquibase.database.jvm.JdbcConnection
import liquibase.resource.ClassLoaderResourceAccessor
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.assertj.core.api.Assertions.assertThat
import org.jetbrains.exposed.v1.core.vendors.PostgreSQLDialect
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabaseConfig
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.security.oauth2.server.resource.authentication.BearerTokenAuthenticationToken
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken
import org.testcontainers.containers.PostgreSQLContainer
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.sql.DriverManager
import java.util.Date

/**
 * Integration test for the Auth0 user-sync flow.
 *
 * Boots a real Postgres via Testcontainers, runs Liquibase migrations, then exercises
 * [Auth0UserSyncAuthenticationManager] end-to-end against a real [UserRepository]. Auth0 tokens are signed with
 * a locally-generated key and validated against a [MockWebServer] JWKS endpoint.
 */
class Auth0UserSyncIT {
    private lateinit var database: R2dbcDatabase
    private lateinit var userRepository: UserRepository
    private lateinit var authManager: Auth0UserSyncAuthenticationManager

    @BeforeEach
    fun setUp() {
        database = buildDatabase()
        userRepository = UserRepository(database, UserProperties(companionAppKeyPrefix = "test:", encryptionKeyTtlS = 3600))
        val provisioner = Auth0UserProvisioner(userRepository)
        val decoder = auth0JwtDecoder(
            Auth0Properties(issuer = AUTH0_ISSUER, audience = AUTH0_AUDIENCE, jwkSetUri = jwkSetUri),
        )
        authManager = Auth0UserSyncAuthenticationManager(decoder, provisioner)

        runBlocking {
            suspendTransaction(database) { exec("TRUNCATE TABLE users CASCADE") }
        }
    }

    @Test
    fun `first auth with fresh Auth0 JWT provisions user, second auth reuses it`() {
        runBlocking {
            val token = signAuth0Jwt(subject = "auth0|alice", email = "alice@example.com", name = "Alice")

            val first = authManager.authenticate(BearerTokenAuthenticationToken(token)).block()
            assertThat(first).isInstanceOf(JwtAuthenticationToken::class.java)

            val provisioned = userRepository.findByAuth0Sub("auth0|alice")
            assertThat(provisioned).isNotNull
            assertThat(provisioned!!.id).isEqualTo("auth0|alice")
            assertThat(provisioned.email).isEqualTo("alice@example.com")
            assertThat(provisioned.username).isNull()
            assertThat(provisioned.name).isEqualTo("Alice")
            assertThat(provisioned.auth0Sub).isEqualTo("auth0|alice")

            val createdAt = provisioned.createdAt
            authManager.authenticate(BearerTokenAuthenticationToken(token)).block()

            val again = userRepository.findByAuth0Sub("auth0|alice")
            assertThat(again).isNotNull
            assertThat(again!!.id).isEqualTo("auth0|alice")
            assertThat(again.createdAt).isEqualTo(createdAt)
            assertThat(countUsers()).isEqualTo(1L)
        }
    }

    private suspend fun countUsers(): Long = suspendTransaction(database) { UsersTable.selectAll().count() }

    private fun signAuth0Jwt(
        subject: String,
        email: String?,
        name: String?,
        audience: String = AUTH0_AUDIENCE,
        issuer: String = AUTH0_ISSUER,
        expiresAt: Date = Date(System.currentTimeMillis() + 60_000),
    ): String {
        val claims = JWTClaimsSet.Builder().apply {
            issuer(issuer)
            subject(subject)
            audience(audience)
            issueTime(Date())
            expirationTime(expiresAt)
            if (email != null) claim("email", email)
            if (name != null) claim("name", name)
        }.build()
        val signed = SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID(AUTH0_KEY_ID).build(), claims)
        signed.sign(RSASSASigner(auth0KeyPair.private as RSAPrivateKey))
        return signed.serialize()
    }

    private fun buildDatabase(): R2dbcDatabase {
        val options = ConnectionFactoryOptions
            .builder()
            .from(
                ConnectionFactoryOptions.parse(
                    "r2dbc:postgresql://${postgres.host}:${postgres.firstMappedPort}/${postgres.databaseName}",
                ),
            ).option(ConnectionFactoryOptions.USER, postgres.username)
            .option(ConnectionFactoryOptions.PASSWORD, postgres.password)
            .option(
                Option.valueOf("extensions"),
                listOf(
                    EnumCodec
                        .builder()
                        .withEnum("user_roles", UserRole::class.java)
                        .withEnum("social_providers", SocialProvider::class.java)
                        .build(),
                ),
            ).build()
        val cf = ConnectionFactories.get(options)
        return R2dbcDatabase.connect(
            connectionFactory = cf,
            databaseConfig = R2dbcDatabaseConfig {
                defaultMaxAttempts = 3
                defaultR2dbcIsolationLevel = IsolationLevel.READ_COMMITTED
                explicitDialect = PostgreSQLDialect()
            },
        )
    }

    companion object {
        private const val AUTH0_ISSUER = "https://test.auth0.local/"
        private const val AUTH0_AUDIENCE = "figma-plugin-test"
        private const val AUTH0_KEY_ID = "auth0-test-key"

        @JvmStatic
        val postgres: PostgreSQLContainer<*> = PostgreSQLContainer("postgres:15").apply {
            withDatabaseName("auth0_sync_test")
            withUsername("test")
            withPassword("test")
        }

        private val auth0KeyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()

        private val mockJwksServer = MockWebServer().apply {
            start()
            val publicJwk = RSAKey
                .Builder(auth0KeyPair.public as RSAPublicKey)
                .keyID(AUTH0_KEY_ID)
                .algorithm(JWSAlgorithm.RS256)
                .build()
            val jwksJson = JWKSet(publicJwk).toString()
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse =
                    MockResponse().setBody(jwksJson).setHeader("Content-Type", "application/json")
            }
        }

        private val jwkSetUri: String = mockJwksServer.url("/.well-known/jwks.json").toString()

        @BeforeAll
        @JvmStatic
        fun migrate() {
            postgres.start()
            DriverManager
                .getConnection(postgres.jdbcUrl, postgres.username, postgres.password)
                .use { conn ->
                    val database = DatabaseFactory.getInstance().findCorrectDatabaseImplementation(JdbcConnection(conn))
                    Liquibase("db/changelog/master.yaml", ClassLoaderResourceAccessor(), database).use { liquibase ->
                        liquibase.update("")
                    }
                }
        }

        @AfterAll
        @JvmStatic
        fun shutdown() {
            mockJwksServer.shutdown()
            postgres.stop()
        }
    }
}
