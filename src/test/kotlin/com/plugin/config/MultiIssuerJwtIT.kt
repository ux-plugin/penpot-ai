package com.plugin.config

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import com.plugin.config.properties.Auth0Properties
import com.plugin.config.properties.JwtProperties
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.test.autoconfigure.web.reactive.WebFluxTest
import org.springframework.context.annotation.Import
import org.springframework.http.HttpHeaders
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import org.springframework.test.context.TestPropertySource
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.util.Date

@WebFluxTest(controllers = [MultiIssuerJwtIT.MeController::class])
@Import(SecurityConfig::class, MultiIssuerJwtIT.MeController::class)
@EnableConfigurationProperties(JwtProperties::class, Auth0Properties::class)
@TestPropertySource(
    properties = [
        "jwt.private-key-location=classpath:META-INF/resources/privateKey-dev.pem",
        "jwt.public-key-location=classpath:META-INF/resources/publicKey-dev.pem",
        "jwt.token.lifespan=600",
        "auth0.issuer=https://test.auth0.local/",
        "auth0.audience=figma-plugin-test",
    ],
)
class MultiIssuerJwtIT {
    @RestController
    class MeController {
        @GetMapping("/me")
        fun me(@AuthenticationPrincipal jwt: Jwt): Map<String, String> = mapOf("sub" to jwt.subject)
    }

    @Autowired private lateinit var webTestClient: WebTestClient

    @Autowired private lateinit var selfHostedPrivateKey: RSAPrivateKey

    @Test
    fun `valid self-hosted token authenticates`() {
        val token = signSelfHosted(subject = "user-1")

        webTestClient
            .get()
            .uri("/me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer $token")
            .exchange()
            .expectStatus()
            .isOk
            .expectBody()
            .jsonPath("$.sub")
            .isEqualTo("user-1")
    }

    @Test
    fun `valid Auth0 token authenticates and exposes prefixed sub`() {
        val token = signAuth0(
            subject = "auth0|abc123",
            audience = AUTH0_AUDIENCE,
        )

        webTestClient
            .get()
            .uri("/me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer $token")
            .exchange()
            .expectStatus()
            .isOk
            .expectBody()
            .jsonPath("$.sub")
            .isEqualTo("auth0|abc123")
    }

    @Test
    fun `expired Auth0 token returns 401`() {
        val token = signAuth0(
            subject = "auth0|expired",
            audience = AUTH0_AUDIENCE,
            expiresAt = Date(System.currentTimeMillis() - 5 * 60_000),
        )

        webTestClient
            .get()
            .uri("/me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer $token")
            .exchange()
            .expectStatus()
            .isUnauthorized
    }

    @Test
    fun `Auth0 token with wrong audience returns 401`() {
        val token = signAuth0(
            subject = "auth0|wrong-aud",
            audience = "some-other-api",
        )

        webTestClient
            .get()
            .uri("/me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer $token")
            .exchange()
            .expectStatus()
            .isUnauthorized
    }

    @Test
    fun `untrusted issuer returns 401`() {
        val token = signAuth0(
            subject = "auth0|x",
            audience = AUTH0_AUDIENCE,
            issuer = "https://evil.example/",
        )

        webTestClient
            .get()
            .uri("/me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer $token")
            .exchange()
            .expectStatus()
            .isUnauthorized
    }

    private fun signSelfHosted(subject: String): String {
        val claims = JWTClaimsSet
            .Builder()
            .issuer(SELF_HOSTED_ISSUER)
            .subject(subject)
            .issueTime(Date())
            .expirationTime(Date(System.currentTimeMillis() + 60_000))
            .build()
        val signed = SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID("ux-plugin").build(), claims)
        signed.sign(RSASSASigner(selfHostedPrivateKey))
        return signed.serialize()
    }

    private fun signAuth0(
        subject: String,
        audience: String,
        issuer: String = AUTH0_ISSUER,
        expiresAt: Date = Date(System.currentTimeMillis() + 60_000),
    ): String {
        val claims = JWTClaimsSet
            .Builder()
            .issuer(issuer)
            .subject(subject)
            .audience(audience)
            .issueTime(Date())
            .expirationTime(expiresAt)
            .build()
        val signed = SignedJWT(
            JWSHeader.Builder(JWSAlgorithm.RS256).keyID(AUTH0_KEY_ID).build(),
            claims,
        )
        signed.sign(RSASSASigner(auth0Keypair.private as RSAPrivateKey))
        return signed.serialize()
    }

    companion object {
        private const val AUTH0_ISSUER = "https://test.auth0.local/"
        private const val AUTH0_AUDIENCE = "figma-plugin-test"
        private const val AUTH0_KEY_ID = "auth0-test-key"

        private val auth0Keypair = KeyPairGenerator
            .getInstance("RSA")
            .apply { initialize(2048) }
            .generateKeyPair()

        private val mockJwksServer: MockWebServer = MockWebServer().apply {
            start()
            val publicJwk = RSAKey
                .Builder(auth0Keypair.public as RSAPublicKey)
                .keyID(AUTH0_KEY_ID)
                .algorithm(JWSAlgorithm.RS256)
                .build()
            val jwksJson = JWKSet(publicJwk).toString()
            dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse = MockResponse()
                    .setBody(jwksJson)
                    .setHeader("Content-Type", "application/json")
            }
        }

        @JvmStatic
        @AfterAll
        fun shutdown() {
            mockJwksServer.shutdown()
        }

        @JvmStatic
        @DynamicPropertySource
        fun props(registry: DynamicPropertyRegistry) {
            registry.add("auth0.jwk-set-uri") { mockJwksServer.url("/.well-known/jwks.json").toString() }
        }
    }
}
