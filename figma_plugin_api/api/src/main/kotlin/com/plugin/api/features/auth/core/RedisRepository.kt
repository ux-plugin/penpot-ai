package com.plugin.api.features.auth.core

import kotlinx.coroutines.reactor.awaitSingle
import kotlinx.coroutines.reactor.awaitSingleOrNull
import org.springframework.data.redis.core.ReactiveRedisTemplate
import org.springframework.stereotype.Repository
import java.time.Duration
import java.util.*

@Repository
class RedisRepository(private val reactiveRedisTemplate: ReactiveRedisTemplate<String, String>) {

    suspend fun generateUniqueKey(prefix: String, maxRetries: Int, valueOfKey: String, expiresIn: Long): String {
        var retries = 0
        while (retries < maxRetries) {
            val uniqueToken = UUID.randomUUID().toString()
            val key = prefix + uniqueToken
            try {
                val success =
                    reactiveRedisTemplate
                        .opsForValue()
                        .setIfAbsent(key, valueOfKey, Duration.ofSeconds(expiresIn))
                        .awaitSingle()

                if (success) {
                    return uniqueToken
                }
            } catch (e: Exception) {
                retries++
            }
        }
        throw IllegalStateException("Failed to generate a unique key after $maxRetries attempts")
    }

    suspend fun readAccessToken(readToken: String, timeout: Duration): Pair<String, String>? {
        // Using rightPop with timeout for blocking operation
        return reactiveRedisTemplate
            .opsForList()
            .rightPop(readToken, timeout)
            .map { value -> readToken to value }
            .awaitSingleOrNull()
    }

    suspend fun getValue(key: String): String? = reactiveRedisTemplate.opsForValue().get(key).awaitSingleOrNull()

    suspend fun setValueWithExpiration(key: String, value: String, expiresIn: Long) {
        reactiveRedisTemplate.opsForValue().set(key, value, Duration.ofSeconds(expiresIn)).awaitSingle()
    }

    suspend fun pushAccessToken(queueName: String, accessToken: String): Long =
        reactiveRedisTemplate.opsForList().leftPush(queueName, accessToken).awaitSingle()
}
