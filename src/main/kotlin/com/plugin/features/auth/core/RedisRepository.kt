package com.plugin.features.auth.core

import io.quarkus.logging.Log
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.redis.datasource.list.KeyValue
import io.quarkus.redis.datasource.list.ReactiveListCommands
import io.quarkus.redis.datasource.value.ReactiveValueCommands
import io.smallrye.mutiny.coroutines.awaitSuspending
import io.vertx.mutiny.redis.client.Command
import io.vertx.mutiny.redis.client.Request
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import java.time.Duration
import java.util.*

/** Implementation of Redis operations used in authentication flows */
@ApplicationScoped
class RedisRepository @Inject constructor(private val redisDataSource: ReactiveRedisDataSource) {

    private val redisValues: ReactiveValueCommands<String, String> = redisDataSource.value(String::class.java)
    private val redisList: ReactiveListCommands<String, String> = redisDataSource.list(String::class.java)

    /** Sets a key-value pair in Redis if the key does not exist, with an expiration time */
    suspend fun setnxex(key: String, value: String, expiresIn: Int): Boolean {
        val request = Request.cmd(Command.SET).arg(key).arg(value).arg("NX").arg("EX").arg(expiresIn)
        return redisDataSource.redis.send(request).onItem().transform { it != null }.awaitSuspending()
    }

    /** Generates a unique key with a prefix, ensuring it doesn't exist in Redis */
    suspend fun generateUniqueKey(
        prefix: String,
        maxRetries: Int,
        valueOfKey: String,
        expiresIn: Int,
    ): String {
        var retries = 0
        while (retries < maxRetries) {
            val uniqueToken = UUID.randomUUID().toString()
            val key = prefix + uniqueToken
            if (setnxex(key, valueOfKey, expiresIn)) {
                return uniqueToken // Success!
            }
            retries++
            Log.warn("Key $key already exists, generating a new one")
        }
        throw IllegalStateException("Failed to generate a unique key after $maxRetries attempts")
    }

    /** Reads an access token from a Redis list with blocking operation */
    suspend fun readAccessToken(
        readToken: String,
        timeout: Duration,
    ): KeyValue<String, String>? {
        return redisList.blpop(timeout, readToken).awaitSuspending()
    }

    /** Gets a value from Redis by key */
    suspend fun getValue(key: String): String? {
        return redisValues.get(key).awaitSuspending()
    }

    /** Sets a value in Redis with an expiration time */
    suspend fun setValueWithExpiration(key: String, value: String, expiresIn: Int) {
        redisValues.setex(key, expiresIn.toLong(), value).awaitSuspending()
    }

    /** Pushes an access token to a Redis list */
    suspend fun pushAccessToken(queueName: String, accessToken: String): Long {
        return redisList.lpush(queueName, accessToken).awaitSuspending()
    }
}
