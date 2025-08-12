package com.plugin.features.apps

import com.plugin.shared.PostgresTestResourceManager
import com.plugin.shared.RedisTestResourceManager
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.redis.datasource.list.ReactiveListCommands
import io.quarkus.test.common.QuarkusTestResource
import io.quarkus.test.junit.QuarkusTest
import io.quarkus.test.junit.QuarkusTestProfile
import io.quarkus.test.junit.TestProfile
import io.restassured.RestAssured.given
import io.restassured.http.ContentType
import io.smallrye.jwt.build.Jwt
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.inject.Inject
import kotlinx.coroutines.runBlocking
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.hibernate.reactive.mutiny.Mutiny
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.UUID
import java.util.concurrent.TimeUnit

class ConfigSyncTestProfile : QuarkusTestProfile {
    override fun getConfigOverrides(): Map<String, String> = mapOf(
        "apps.companion-app-key-prefix" to "test-app-"
    )
}

@QuarkusTest
@TestProfile(ConfigSyncTestProfile::class)
@QuarkusTestResource(RedisTestResourceManager::class, parallel = true)
@QuarkusTestResource(PostgresTestResourceManager::class, parallel = true)
class ConfigSyncResourceIT {

    @Inject
    lateinit var redis: ReactiveRedisDataSource

    @Inject
    lateinit var sessionFactory: Mutiny.SessionFactory

    @ConfigProperty(name = "apps.companion-app-key-prefix")
    lateinit var companionAppKeyPrefix: String

    private val appConfigUpdatesQueue: ReactiveListCommands<String, AppState> by lazy {
        redis.list(AppState::class.java)
    }

    private val testUserId = "test-user-${UUID.randomUUID()}"
    private val testJwt by lazy {
        Jwt.claims()
            .subject(testUserId)
            .issuer("ux-plugin")
            .claim("role", "USER")
            .expiresAt(System.currentTimeMillis() + TimeUnit.HOURS.toMillis(1))
            .sign()
    }

    @BeforeEach
    fun setup() {
        // Clear any existing data for the test user
        val appQueueKey = companionAppKeyPrefix + testUserId
        
        runBlocking {
            // Clear any existing data
            redis.key().del(appQueueKey).awaitSuspending()
        }

        sessionFactory.withTransaction { session, _ ->
            val sql = """
                DO $$
                BEGIN
                   IF EXISTS (SELECT FROM information_schema.tables
                              WHERE table_schema = 'public'
                              AND table_name = 'users') THEN
                      EXECUTE 'TRUNCATE TABLE Users RESTART IDENTITY CASCADE';
                   END IF;
                END $$;
            """.trimIndent()
            session.createNativeQuery<Void>(sql).executeUpdate()
        }.await().indefinitely()
        

    }

    @Test
    fun testAppConfigUpdateEndpoint() {
        val newAppState = AppState(port = 8080)

        // Send an update
        given()
            .header("Authorization", "Bearer $testJwt")
            .contentType(ContentType.JSON)
            .body(newAppState)
            .`when`()
            .post("/sync/app/update")
            .then()
            .statusCode(200)

        // Verify the update was stored in Redis
        runBlocking {
            val queueName = companionAppKeyPrefix + testUserId
            val storedState = appConfigUpdatesQueue.lindex(queueName, 0).awaitSuspending()
            assert(storedState != null) { "No app state was stored in Redis" }
            assert(storedState?.port == newAppState.port) { "Stored port doesn't match" }
        }
    }

    @Test
    fun testAppConfigUpdateWithNullPort() {
        val newAppState = AppState(port = null)

        // Send an update
        given()
            .header("Authorization", "Bearer $testJwt")
            .contentType(ContentType.JSON)
            .body(newAppState)
            .`when`()
            .post("/sync/app/update")
            .then()
            .statusCode(200)

        // Verify the update was stored in Redis
        runBlocking {
            val queueName = companionAppKeyPrefix + testUserId
            val storedState = appConfigUpdatesQueue.lindex(queueName, 0).awaitSuspending()
            assert(storedState != null) { "No app state was stored in Redis" }
            assert(storedState?.port == null) { "Stored port should be null" }
        }
    }

    @Test
    fun testAppConfigUpdateOverwritesExisting() {
        val initialAppState = AppState(port = 3000)
        val updatedAppState = AppState(port = 9090)

        runBlocking {
            val queueName = companionAppKeyPrefix + testUserId
            // First, create an initial entry
            appConfigUpdatesQueue.lpush(queueName, initialAppState).awaitSuspending()
        }

        // Send an update
        given()
            .header("Authorization", "Bearer $testJwt")
            .contentType(ContentType.JSON)
            .body(updatedAppState)
            .`when`()
            .post("/sync/app/update")
            .then()
            .statusCode(200)

        // Verify the update overwrote the existing value
        runBlocking {
            val queueName = companionAppKeyPrefix + testUserId
            val storedState = appConfigUpdatesQueue.lindex(queueName, 0).awaitSuspending()
            assert(storedState != null) { "No app state was stored in Redis" }
            assert(storedState?.port == updatedAppState.port) { "Stored port should be updated value" }
            
            // Verify there's only one item in the list
            val listLength = appConfigUpdatesQueue.llen(queueName).awaitSuspending()
            assert(listLength == 1L) { "List should contain only one item after update" }
        }
    }

    @Test
    fun testUnauthorizedAccess() {
        // Try to access without authentication
        given()
            .`when`()
            .get("/sync/app/updates")
            .then()
            .statusCode(401)

        given()
            .contentType(ContentType.JSON)
            .body(AppState(port = 8080))
            .`when`()
            .post("/sync/app/update")
            .then()
            .statusCode(401)

        given()
            .`when`()
            .get("/sync/key/get")
            .then()
            .statusCode(401)

        given()
            .`when`()
            .post("/sync/key/generate")
            .then()
            .statusCode(401)
    }

    @Test
    fun testKeyGenerationEndpoints() {

        // Create a ConfigUser for the test user ID to support key generation tests
        sessionFactory.withTransaction { session, _ ->
            val sql = """
            INSERT INTO users (id, username, name, role, allowSavingCompletions, createdAt)
            VALUES ('$testUserId', '$testUserId', 'Test User', 'USER', false, NOW())
            ON CONFLICT (id) DO NOTHING;
        """.trimIndent()

            session.createNativeQuery<Void>(sql)
                .executeUpdate()
        }
            .await()
            .indefinitely()

        // Test key generation
        val generateResponse = given()
            .header("Authorization", "Bearer $testJwt")
            .`when`()
            .post("/sync/key/generate")
            .then()
            .statusCode(200)
            .extract()
            .response()

        val generatedKey = generateResponse.body.asString()
        assert(generatedKey.isNotEmpty()) { "Generated key should not be empty" }

        // Test key retrieval
        val getResponse = given()
            .header("Authorization", "Bearer $testJwt")
            .`when`()
            .get("/sync/key/get")
            .then()
            .statusCode(200)
            .extract()
            .response()

        val retrievedKey = getResponse.body.asString()
        assert(retrievedKey == generatedKey) { "Retrieved key should match generated key" }
    }
}