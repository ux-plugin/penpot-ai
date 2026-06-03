package com.plugin.api.security

import com.plugin.api.config.properties.ApiKeyProperties
import org.springframework.http.HttpHeaders
import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.core.Authentication
import org.springframework.security.core.AuthenticationException
import org.springframework.security.web.server.authentication.ServerAuthenticationConverter
import org.springframework.web.server.ServerWebExchange
import reactor.core.publisher.Mono

/**
 * Pulls a candidate API key from `Authorization: Bearer <token>` or `X-Api-Key: <token>`.
 * Returns Mono.empty() when the request has no API-key shape so Spring's chain falls
 * through to the JWT filter; recognized only by the configured prefix.
 */
class ApiKeyAuthenticationConverter(private val props: ApiKeyProperties) : ServerAuthenticationConverter {

    override fun convert(exchange: ServerWebExchange): Mono<Authentication> {
        val token = extractToken(exchange) ?: return Mono.empty()
        if (!token.startsWith(props.prefix)) return Mono.empty()
        return Mono.just(UnverifiedApiKeyAuthentication(token))
    }

    private fun extractToken(exchange: ServerWebExchange): String? {
        val headers = exchange.request.headers
        headers.getFirst(HttpHeaders.AUTHORIZATION)?.let {
            if (it.startsWith(BEARER_PREFIX, ignoreCase = true)) return it.substring(BEARER_PREFIX.length).trim()
        }
        headers.getFirst("X-Api-Key")?.let { return it.trim() }
        return null
    }

    companion object {
        private const val BEARER_PREFIX = "Bearer "
    }
}

class UnverifiedApiKeyAuthentication(val plaintext: String) : AbstractAuthenticationToken(emptyList()) {
    init {
        isAuthenticated = false
    }

    override fun getCredentials(): Any = plaintext

    override fun getPrincipal(): Any = "unverified"
}

class InvalidApiKeyException(message: String) : AuthenticationException(message)
