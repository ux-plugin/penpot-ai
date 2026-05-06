package com.plugin.api.security

import kotlinx.coroutines.reactor.mono
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.security.authentication.TestingAuthenticationToken
import org.springframework.security.core.Authentication
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.security.core.context.SecurityContextImpl
import reactor.core.publisher.Mono

class AuthorizationServiceTest {
    private val service = AuthorizationService()

    @Test
    fun `canIngest is true when the api-key auth has matching orgId`() {
        val auth = ApiKeyAuthentication("k1", orgId = "org-A", userId = "u1", keyPrefix = "pk_test_abcd")
        val result = mono { service.canIngest("org-A") }.contextWrite(authContext(auth)).block()!!
        assertThat(result).isTrue
    }

    @Test
    fun `canIngest is false when the api-key auth orgId differs from the requested org`() {
        val auth = ApiKeyAuthentication("k1", orgId = "org-A", userId = "u1", keyPrefix = "pk_test_abcd")
        val result = mono { service.canIngest("org-OTHER") }.contextWrite(authContext(auth)).block()!!
        assertThat(result).isFalse
    }

    @Test
    fun `canIngest is false when the security context carries a non-api-key authentication`() {
        val jwtLike = TestingAuthenticationToken("user", "creds", emptyList()).also { it.isAuthenticated = true }
        val result = mono { service.canIngest("org-A") }.contextWrite(authContext(jwtLike)).block()!!
        assertThat(result).isFalse
    }

    @Test
    fun `canIngest is false when no security context is present`() = runBlocking {
        assertThat(service.canIngest("org-A")).isFalse
    }

    @Test
    fun `currentApiKeyAuthentication returns the populated api-key auth and null for jwt`() {
        val auth = ApiKeyAuthentication("k1", orgId = "org-A", userId = "u1", keyPrefix = "pk_test_abcd")
        val present = mono { service.currentApiKeyAuthentication() }.contextWrite(authContext(auth)).block()
        assertThat(present).isEqualTo(auth)

        val absent = mono { service.currentApiKeyAuthentication() }
            .contextWrite(authContext(TestingAuthenticationToken("u", "p", emptyList())))
            .block()
        assertThat(absent).isNull()
    }

    private fun authContext(auth: Authentication) =
        ReactiveSecurityContextHolder.withSecurityContext(Mono.just(SecurityContextImpl(auth)))
}
