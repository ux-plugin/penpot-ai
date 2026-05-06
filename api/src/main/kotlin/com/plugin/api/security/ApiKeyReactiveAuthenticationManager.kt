package com.plugin.api.security

import com.plugin.api.config.properties.ApiKeyProperties
import com.plugin.api.features.apikey.ApiKeyGenerator
import com.plugin.api.features.apikey.ApiKeyRepository
import com.plugin.core.util.logger
import kotlinx.coroutines.reactor.mono
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.security.authentication.ReactiveAuthenticationManager
import org.springframework.security.core.Authentication
import org.springframework.stereotype.Component
import reactor.core.publisher.Mono
import java.time.Duration
import java.time.Instant

@Component
class ApiKeyReactiveAuthenticationManager(
    private val repository: ApiKeyRepository,
    private val generator: ApiKeyGenerator,
    private val redis: ReactiveStringRedisTemplate,
    private val props: ApiKeyProperties,
) : ReactiveAuthenticationManager {

    private val log = logger()

    override fun authenticate(authentication: Authentication): Mono<Authentication> {
        val unverified = authentication as? UnverifiedApiKeyAuthentication
            ?: return Mono.error(InvalidApiKeyException("Unsupported authentication type"))
        val plaintext = unverified.plaintext
        val hash = generator.hash(plaintext)
        val cacheKey = props.redisCachePrefix + hash
        return redis.opsForValue().get(cacheKey)
            .flatMap { cached -> Mono.justOrEmpty<ResolvedApiKey>(parseCache(cached)) }
            .switchIfEmpty(Mono.defer { resolveFromDb(hash, cacheKey) })
            .map { ctx -> buildAuthentication(ctx, plaintext.take(props.prefix.length + 4)) as Authentication }
            .doOnNext { auth -> scheduleTouch((auth as ApiKeyAuthentication).apiKeyId) }
    }

    private fun resolveFromDb(hash: String, cacheKey: String): Mono<ResolvedApiKey> = mono {
        val entity = repository.findActiveByHash(hash) ?: throw InvalidApiKeyException("Invalid API key")
        ResolvedApiKey(entity.id, entity.orgId, entity.createdByUserId, entity.lastUsedAt)
    }.flatMap { resolved ->
        redis.opsForValue()
            .set(cacheKey, encodeCache(resolved), Duration.ofSeconds(props.redisCacheTtlSec))
            .thenReturn(resolved)
    }

    private fun buildAuthentication(ctx: ResolvedApiKey, displayPrefix: String) =
        ApiKeyAuthentication(
            apiKeyId = ctx.id,
            orgId = ctx.orgId,
            userId = ctx.userId,
            keyPrefix = displayPrefix,
        )

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
