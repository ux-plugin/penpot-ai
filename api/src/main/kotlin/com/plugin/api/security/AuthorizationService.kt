package com.plugin.api.security

import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.stereotype.Service

/**
 * Coarse-grained gate for ingest-time decisions. Resolves to the API-key authentication
 * from the reactive security context and matches `orgId`. Stub for FGA/finer-grained
 * sharing rules later.
 */
@Service
class AuthorizationService {

    suspend fun canIngest(orgId: String): Boolean = currentApiKeyAuthentication()?.orgId == orgId

    suspend fun currentApiKeyAuthentication(): ApiKeyAuthentication? =
        ReactiveSecurityContextHolder.getContext().awaitFirstOrNull()
            ?.authentication as? ApiKeyAuthentication
}
