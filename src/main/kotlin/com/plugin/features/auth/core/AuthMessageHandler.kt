package com.plugin.features.auth.core

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.infrastructure.websocket.WebSocketMessage
import com.plugin.infrastructure.websocket.WebSocketMessageHandler
import com.plugin.infrastructure.websocket.WebSocketMessageType
import com.plugin.infrastructure.websocket.WebSocketResponse
import io.quarkus.logging.Log
import io.quarkus.websockets.next.UserData.TypedKey
import io.quarkus.websockets.next.WebSocketConnection
import io.smallrye.jwt.auth.principal.JWTParser
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject

/**
 * Handler for authentication-related WebSocket messages
 *
 * Handles:
 * - auth:refresh_token - Validates new access token and updates connection expiration
 * - Future auth operations can be added here
 *
 * Migrated to Quarkus WebSocket Next API.
 */
@ApplicationScoped
class AuthMessageHandler
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val jwtParser: JWTParser,
    private val authConfig: WebSocketAuthConfig,
) : WebSocketMessageHandler {

    override fun getMessageTypePrefix(): String = "auth:"

    override suspend fun handleMessage(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse? {
        return when (message.type) {
            WebSocketMessageType.AUTH_REFRESH_TOKEN -> handleRefreshToken(message, connection, userId)
            else -> {
                Log.warn("Unknown auth message type: ${message.type}")
                WebSocketResponse(
                    type = "error",
                    payload = emptyMap(),
                    requestId = message.requestId,
                    error = "Unknown message type: ${message.type}"
                )
            }
        }
    }

    /** Handle token refresh request Validates the new access token and updates connection expiration */
    private suspend fun handleRefreshToken(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse {
        return try {
            val newAccessToken = message.payload["access_token"] as? String

            if (newAccessToken.isNullOrBlank()) {
                Log.warn("Refresh token request missing access_token payload for user: $userId")
                return WebSocketResponse(
                    type = "error",
                    payload = emptyMap(),
                    requestId = message.requestId,
                    error = "Missing access_token in payload"
                )
            }

            // Parse and validate the new JWT token
            val jwt =
                try {
                    jwtParser.parse(newAccessToken)
                } catch (e: Exception) {
                    Log.error("Failed to parse new access token", e)
                    return WebSocketResponse(
                        type = "error",
                        payload = emptyMap(),
                        requestId = message.requestId,
                        error = "Invalid access token"
                    )
                }

            // Verify the token is for the same user
            if (jwt.subject != userId) {
                Log.warn("Token user mismatch: expected $userId, got ${jwt.subject}")
                return WebSocketResponse(
                    type = "error",
                    payload = emptyMap(),
                    requestId = message.requestId,
                    error = "Token user mismatch"
                )
            }

            // Extract expiration time from the new token
            val newExpiration = jwt.expirationTime
            if (newExpiration <= 0) {
                Log.error("Invalid expiration time in new token: $newExpiration")
                return WebSocketResponse(
                    type = "error",
                    payload = emptyMap(),
                    requestId = message.requestId,
                    error = "Invalid token expiration"
                )
            }

            // Update connection expiration in attributes
            val expirationKey = authConfig.session().tokenExpirationKey()
            connection.userData().put(TypedKey.forLong(expirationKey), newExpiration)

            Log.info("Token refreshed for user: $userId, connection: ${connection.id()}")
            Log.debug("New expiration time: $newExpiration (${java.time.Instant.ofEpochSecond(newExpiration)})")

            WebSocketResponse(
                type = WebSocketMessageType.AUTH_REFRESH_TOKEN,
                payload = mapOf("status" to "ok", "expires_at" to newExpiration),
                requestId = message.requestId
            )
        } catch (e: Exception) {
            Log.error("Error handling refresh token", e)
            WebSocketResponse(
                type = "error",
                payload = emptyMap(),
                requestId = message.requestId,
                error = "Failed to refresh token: ${e.message}"
            )
        }
    }
}
