package com.plugin.features.apps

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import io.quarkus.logging.Log
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.redis.datasource.list.KeyValue
import io.quarkus.redis.datasource.list.ReactiveListCommands
import io.smallrye.mutiny.coroutines.awaitSuspending
import io.vertx.mutiny.redis.client.Command
import io.vertx.mutiny.redis.client.Request
import io.vertx.mutiny.redis.client.Response
import io.vertx.redis.client.impl.types.ErrorType
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import org.eclipse.microprofile.config.inject.ConfigProperty

@ApplicationScoped
class ConfigSyncService @Inject constructor(
    val redis: ReactiveRedisDataSource,
    val objectMapper: ObjectMapper
) {

    @ConfigProperty(name = "apps.companion-app-key-prefix")
    lateinit var companionAppKeyPrefix: String

    @ConfigProperty(name = "apps.plugin-key-prefix")
    lateinit var pluginKeyPrefix: String

    val appConfigQueue: ReactiveListCommands<String, AppState> = redis.list(AppState::class.java)
    val pluginConfigQueue: ReactiveListCommands<String, PluginState> = redis.list(PluginState::class.java)

    suspend fun listenToAppConfigUpdate(userId: String): AppState {
        val redisResult = waitGetListElement(companionAppKeyPrefix + userId)
        val parsedResult: AppState = objectMapper.readValue(redisResult.toString())
        return parsedResult
    }

    suspend fun updateAppConfig(userId: String, newConfig: AppState) {
        try {
            appConfigQueue.lset(companionAppKeyPrefix + userId, 0, newConfig).awaitSuspending()
        } catch (e: ErrorType) {
            if (e.message?.contains("ERR no such key") == true) {
                appConfigQueue.lpush(companionAppKeyPrefix + userId, newConfig).awaitSuspending()
            } else {
                throw e
            }
        }
    }

    suspend fun listenToPluginConfigUpdate(userId: String): PluginState {
        val redisResult = waitGetListElement(queueName = pluginKeyPrefix + userId)
        val parsedResult: PluginState = objectMapper.readValue(redisResult.toString())
        return parsedResult
    }

    suspend fun updatePluginConfig(userId: String, newConfig: PluginState) {
        try {
            pluginConfigQueue.lset(pluginKeyPrefix + userId, 0, newConfig).awaitSuspending()
        } catch (e: ErrorType) {
            if (e.message?.contains("ERR no such key") == true) {
                pluginConfigQueue.lpush(pluginKeyPrefix + userId, newConfig).awaitSuspending()
            } else {
                throw e
            }
        }
    }

    suspend fun waitGetListElement(queueName: String): Response {
        val request = Request.cmd(Command.BLPOP)
            .arg(queueName)
            .arg(0)
        val response: Response = redis.redis.send(request).awaitSuspending()
        if (response.delegate != null) {
            val value = response.get(1)
            return value
        } else {
            throw IllegalStateException("Failed to get list element")
        }
    }
}