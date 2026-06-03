package com.plugin.api.security

import com.plugin.api.config.properties.ApiKeyProperties
import com.plugin.api.features.apikey.ApiKeyGenerator
import com.plugin.api.features.apikey.ApiKeyRepository
import com.plugin.core.util.logger
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.reactor.mono
import org.springframework.context.annotation.Primary
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.core.Authentication
import org.springframework.stereotype.Component
import reactor.core.publisher.Mono
import java.time.Duration
import java.time.Instant

// @Primary makes this the default ReactiveAuthenticationManager so Spring Security's
// RSocket auto-config can autowire a single bean. The Auth0 manager is still injected
// elsewhere via @Qualifier("auth0AuthenticationManager").
@Component
@Primary
class ApiKeyReactiveAuthenticationManager(
    private val repository: ApiKeyRepository,
    private val generator: ApiKeyGenerator,
    private val redis: ReactiveStringRedisTemplate,
    private val props: ApiKeyProperties,
) : ReactiveAuthenticationManager {

    private val log = logger()

    override fun authenticate(authentication: Authentication): Mono<Authentication> = mono {
        val unverified = authentication as? UnverifiedApiKeyAuthentication
            ?: throw InvalidApiKeyException("Unsupported authentication type")
        val plaintext = unverified.plaintext
        val hash = generator.hash(plaintext)
        val cacheKey = props.redisCachePrefix + hash

        val resolved = redis.opsForValue().get(cacheKey).awaitFirstOrNull()
            ?.let { parseCache(it) }
            ?: resolveFromDb(hash, cacheKey)

        val auth = ApiKeyAuthentication(
            apiKeyId = resolved.id,
            orgId = resolved.orgId,
            userId = resolved.userId,
            keyPrefix = plaintext.take(props.prefix.length + 4),
        )
        scheduleTouch(auth.apiKeyId)
        auth
    }

    private suspend fun resolveFromDb(hash: String, cacheKey: String): ResolvedApiKey {
        val entity = repository.findActiveByHash(hash)
            ?: throw InvalidApiKeyException("Invalid API key")
        val resolved = ResolvedApiKey(entity.id, entity.orgId, entity.createdByUserId, entity.lastUsedAt)
        redis.opsForValue()
            .set(cacheKey, encodeCache(resolved), Duration.ofSeconds(props.redisCacheTtlSec))
            .awaitFirstOrNull()
        return resolved
    }

    /**
     * Fire-and-forget: don't block the auth response on the side-effecting write. Debounced via
     * a Redis SETNX with TTL = lastUsedDebounceSec — only the first auth in each window
     * actually issues the DB UPDATE, the rest skip cleanly.
     */
    private fun scheduleTouch(apiKeyId: String) {
        val touchKey = "apikey:touch:" + apiKeyId
        redis.opsForValue()
            .setIfAbsent(touchKey, "1", Duration.ofSeconds(props.lastUsedDebounceSec))
            .filter { it == true }
            .flatMap { mono { repository.touchLastUsed(apiKeyId, Instant.now()) }.then() }
            .onErrorResume { err ->
                log.warn("touchLastUsed failed for {}: {}", apiKeyId, err.message)
                Mono.empty()
            }
            .subscribe()
    }

    private fun encodeCache(r: ResolvedApiKey): String = "${r.id}|${r.orgId}|${r.userId}"

    private fun parseCache(raw: String?): ResolvedApiKey? {
        if (raw == null) return null
        val parts = raw.split('|')
        if (parts.size < 3) return null
        return ResolvedApiKey(parts[0], parts[1], parts[2], null)
    }

    private data class ResolvedApiKey(val id: String, val orgId: String, val userId: String, val lastUsedAt: Instant?)
}
