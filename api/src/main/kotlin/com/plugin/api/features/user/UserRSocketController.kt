package com.plugin.api.features.user

import com.plugin.api.config.properties.UserProperties
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.reactive.asFlow
import kotlinx.coroutines.reactor.awaitSingle
import org.slf4j.LoggerFactory
import org.springframework.data.redis.core.ReactiveRedisTemplate
import org.springframework.messaging.handler.annotation.MessageMapping
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.stereotype.Controller

/**
 * RSocket controller that replaces the legacy UserWebSocketMessageHandler.
 *
 * Routes:
 * - user.ports.current: request-response with user's current port (if any)
 * - user.ports.stream: request-stream that emits current port immediately (when present) and then streams further
 *   updates from Redis pub/sub
 */
@Controller
class UserRSocketController(
    private val userService: UserService,
    private val reactiveRedisTemplate: ReactiveRedisTemplate<String, PortState>,
    private val userProperties: UserProperties,
) {
    private val logger = LoggerFactory.getLogger(javaClass)

    @MessageMapping("user.ports.stream")
    suspend fun stream(): Flow<PortState> = coroutineScope {
        // Extract JWT from security context
        val jwt = ReactiveSecurityContextHolder.getContext().map { it.authentication.principal as Jwt }.awaitSingle()

        val userId = jwt.subject
        val channel = userProperties.companionAppKeyPrefix + userId

        // Fetch current port with error handling
        // This ensures the database transaction completes before streaming starts
        val currentPort =
            try {
                userService.getCurrentPort(userId)
            } catch (e: Exception) {
                // Log the error but don't fail the stream
                logger.warn("Failed to fetch current port for user $userId: ${e.message}", e)
                null // Continue without initial value
            }

        val updatesFlux = reactiveRedisTemplate.listenToChannel(channel).map { it.message }

        // Now create the flow with the already-fetched value
        flow {
            // Emit the current value if successfully fetched
            if (currentPort != null) emit(currentPort)

            // Stream subsequent updates from Redis
            updatesFlux.asFlow().collect { emit(it) }
        }
    }
}
