package com.plugin.api.security

import org.springframework.security.core.Authentication
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.stereotype.Service
import reactor.core.publisher.Mono

/**
 * Coarse-grained gate for ingest-time decisions. Resolves to the API-key authentication
 * from the reactive security context and matches `orgId`. Stub for FGA/finer-grained
 * sharing rules later.
 */
@Service
class AuthorizationService {

    fun canIngest(orgId: String): Mono<Boolean> =
        currentApiKeyAuthentication().map { auth -> auth.orgId == orgId }.defaultIfEmpty(false)

    fun currentApiKeyAuthentication(): Mono<ApiKeyAuthentication> =
        ReactiveSecurityContextHolder.getContext()
            .map<Authentication?> { it.authentication }
            .filter { it is ApiKeyAuthentication }
            .cast(ApiKeyAuthentication::class.java)
}
