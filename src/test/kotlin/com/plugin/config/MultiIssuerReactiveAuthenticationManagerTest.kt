package com.plugin.config

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.authentication.ReactiveAuthenticationManagerResolver
import org.springframework.security.authentication.TestingAuthenticationToken
import org.springframework.security.core.Authentication
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException
import org.springframework.security.oauth2.server.resource.authentication.BearerTokenAuthenticationToken
import reactor.core.publisher.Mono
import reactor.test.StepVerifier
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import java.util.Date

class MultiIssuerReactiveAuthenticationManagerTest {
    private val privateKey: RSAPrivateKey = KeyPairGenerator.getInstance("RSA")
        .apply { initialize(2048) }
        .generateKeyPair()
        .private as RSAPrivateKey

    private fun signed(issuer: String?): String {
        val claims = JWTClaimsSet.Builder().apply {
            if (issuer != null) issuer(issuer)
            subject("test-subject")
            issueTime(Date())
            expirationTime(Date(System.currentTimeMillis() + 60_000))
        }.build()
        val jwt = SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).build(), claims)
        jwt.sign(RSASSASigner(privateKey))
        return jwt.serialize()
    }

    @Test
    fun `routes to manager registered for the JWT issuer`() {
        val authenticated: Authentication = TestingAuthenticationToken("u", "p", "ROLE_USER").apply { isAuthenticated = true }
        val selfHostedManager = ReactiveAuthenticationManager { Mono.just(authenticated) }
        val resolver = ReactiveAuthenticationManagerResolver<String> { issuer ->
            if (issuer == SELF_HOSTED_ISSUER) Mono.just(selfHostedManager) else Mono.empty()
        }
        val manager = MultiIssuerReactiveAuthenticationManager(resolver)

        val token = BearerTokenAuthenticationToken(signed(SELF_HOSTED_ISSUER))

        StepVerifier.create(manager.authenticate(token))
            .assertNext { assertEquals("u", it.name) }
            .verifyComplete()
    }

    @Test
    fun `rejects token from unknown issuer with InvalidBearerTokenException`() {
        val resolver = ReactiveAuthenticationManagerResolver<String> { Mono.empty() }
        val manager = MultiIssuerReactiveAuthenticationManager(resolver)

        val token = BearerTokenAuthenticationToken(signed("https://evil.example/"))

        StepVerifier.create(manager.authenticate(token))
            .expectError(InvalidBearerTokenException::class.java)
            .verify()
    }

    @Test
    fun `rejects token missing iss claim`() {
        val resolver = ReactiveAuthenticationManagerResolver<String> { Mono.empty() }
        val manager = MultiIssuerReactiveAuthenticationManager(resolver)

        val token = BearerTokenAuthenticationToken(signed(issuer = null))

        StepVerifier.create(manager.authenticate(token))
            .expectError(InvalidBearerTokenException::class.java)
            .verify()
    }

    @Test
    fun `rejects garbage token (parse failure) cleanly`() {
        val resolver = ReactiveAuthenticationManagerResolver<String> { Mono.empty() }
        val manager = MultiIssuerReactiveAuthenticationManager(resolver)

        val token = BearerTokenAuthenticationToken("not-a-jwt")

        StepVerifier.create(manager.authenticate(token))
            .expectError(InvalidBearerTokenException::class.java)
            .verify()
    }
}
