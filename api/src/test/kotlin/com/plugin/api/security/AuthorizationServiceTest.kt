package com.plugin.api.security

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.security.authentication.TestingAuthenticationToken
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.security.core.context.SecurityContextImpl
import reactor.core.publisher.Mono
import reactor.test.StepVerifier

class AuthorizationServiceTest {
    private val service = AuthorizationService()

    @Test
    fun `canIngest is true when the api-key auth has matching orgId`() {
        val auth = ApiKeyAuthentication("k1", orgId = "org-A", userId = "u1", keyPrefix = "pk_test_abcd")
        val mono = service.canIngest("org-A").contextWrite(authContext(auth))
        StepVerifier.create(mono).expectNext(true).verifyComplete()
    }

    @Test
    fun `canIngest is false when the api-key auth orgId differs from the requested org`() {
        val auth = ApiKeyAuthentication("k1", orgId = "org-A", userId = "u1", keyPrefix = "pk_test_abcd")
        val mono = service.canIngest("org-OTHER").contextWrite(authContext(auth))
        StepVerifier.create(mono).expectNext(false).verifyComplete()
    }

    @Test
    fun `canIngest is false when the security context carries a non-api-key authentication`() {
        val jwtLike = TestingAuthenticationToken("user", "creds", emptyList()).also { it.isAuthenticated = true }
        val mono = service.canIngest("org-A").contextWrite(authContext(jwtLike))
        StepVerifier.create(mono).expectNext(false).verifyComplete()
    }

    @Test
    fun `canIngest is false when no security context is present`() {
        StepVerifier.create(service.canIngest("org-A")).expectNext(false).verifyComplete()
    }

    @Test
    fun `currentApiKeyAuthentication returns the populated api-key auth and nothing for jwt`() {
        val auth = ApiKeyAuthentication("k1", orgId = "org-A", userId = "u1", keyPrefix = "pk_test_abcd")
        val present = service.currentApiKeyAuthentication().contextWrite(authContext(auth))
        StepVerifier.create(present).expectNext(auth).verifyComplete()

        val absent = service.currentApiKeyAuthentication()
            .contextWrite(authContext(TestingAuthenticationToken("u", "p", emptyList())))
        StepVerifier.create(absent).verifyComplete()
    }

    private fun authContext(auth: org.springframework.security.core.Authentication) =
        ReactiveSecurityContextHolder.withSecurityContext(Mono.just(SecurityContextImpl(auth)))
}
