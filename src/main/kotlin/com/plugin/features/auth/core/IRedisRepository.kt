package com.plugin.features.auth.core

import io.quarkus.redis.datasource.list.KeyValue
import io.smallrye.mutiny.Uni
import java.time.Duration

/**
 * Interface for Redis operations used in authentication flows
 */
interface IRedisRepository {
    /**
     * Sets a key-value pair in Redis if the key does not exist, with an expiration time
     * @param key The key to set
     * @param value The value to set
     * @param expiresIn The expiration time in seconds
     * @return true if the key was set, false if the key already exists
     */
    suspend fun setnxex(key: String, value: String, expiresIn: Int): Boolean

    /**
     * Generates a unique key with a prefix, ensuring it doesn't exist in Redis
     * @param prefix The prefix for the key
     * @param maxRetries Maximum number of retries to generate a unique key
     * @param valueOfKey The value to set for the key
     * @param expiresIn The expiration time in seconds
     * @return The generated unique key
     */
    suspend fun generateUniqueKey(prefix: String, maxRetries: Int, valueOfKey: String, expiresIn: Int = 5): String

    /**
     * Gets a value from Redis by key
     * @param key The key to get
     * @return The value associated with the key, or null if the key doesn't exist
     */
    suspend fun getValue(key: String): String?
    
    /**
     * Sets a value in Redis with an expiration time
     * @param key The key to set
     * @param value The value to set
     * @param expiresIn The expiration time in seconds
     */
    suspend fun setValueWithExpiration(key: String, value: String, expiresIn: Int)

    /**
     * Reads an access token from a Redis list with blocking operation
     * @param readToken The token used to identify the list
     * @param timeout The timeout for the blocking operation
     * @return The key-value pair containing the access token, or null if timeout
     */
    suspend fun readAccessToken(readToken: String, timeout: Duration): KeyValue<String, String>?

    /**
     * Pushes an access token to a Redis list
     * @param queueName The name of the list
     * @param accessToken The access token to push
     * @return The length of the list after the push operation
     */
    suspend fun pushAccessToken(queueName: String, accessToken: String): Long
}