package com.plugin.features.auth.core

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.infrastructure.websocket.*
import io.quarkus.logging.Log
import io.quarkus.websockets.next.UserData.TypedKey
import io.quarkus.websockets.next.WebSocketConnection
import io.smallrye.jwt.auth.principal.JWTParser
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import kotlin.reflect.KClass

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

    override fun getHandledMessageTypes(): List<KClass<out WebSocketMessage>> =
        listOf(AuthRefreshTokenRequest::class, AuthRefreshTokenResponse::class)

    override suspend fun handleMessage(message: WebSocketMessage, connection: WebSocketConnection, userId: String) {
        when (message) {
            is AuthRefreshTokenRequest -> handleRefreshToken(message, connection, userId)
            else -> {
                Log.warn("Unexpected message type in AuthMessageHandler: ${message::class.simpleName}")
                sendErrorResponse(connection, "Unsupported message type", message.requestId, 4003)
            }
        }
    }

    /** Handle token refresh request Validates the new access token and updates connection expiration */
    private suspend fun handleRefreshToken(
        message: AuthRefreshTokenRequest,
        connection: WebSocketConnection,
        userId: String
    ) {
        try {
            val newAccessToken = message.payload.access_token

            if (newAccessToken.isBlank()) {
                Log.warn("Refresh token request missing access_token payload for user: $userId")
                sendErrorResponse(connection, "Missing access_token in payload", message.requestId, 4002)
                return
            }

            // Parse and validate the new JWT token
            val jwt =
                try {
                    jwtParser.parse(newAccessToken)
                } catch (e: Exception) {
                    Log.error("Failed to parse new access token", e)
                    sendErrorResponse(connection, "Invalid access token", message.requestId, 4001)
                    return
                }

            // Verify the token is for the same user
            if (jwt.subject != userId) {
                Log.warn("Token user mismatch: expected $userId, got ${jwt.subject}")
                sendErrorResponse(connection, "Token user mismatch", message.requestId, 4001)
                return
            }

            // Extract expiration time from the new token
            val newExpiration = jwt.expirationTime
            if (newExpiration <= 0) {
                Log.error("Invalid expiration time in new token: $newExpiration")
                sendErrorResponse(connection, "Invalid token expiration", message.requestId, 4001)
                return
            }

            // Update connection expiration in attributes
            val expirationKey = authConfig.session().tokenExpirationKey()
            connection.userData().put(TypedKey.forLong(expirationKey), newExpiration)

            Log.info("Token refreshed for user: $userId, connection: ${connection.id()}")
            Log.debug("New expiration time: $newExpiration (${java.time.Instant.ofEpochSecond(newExpiration)})")

            // Send success response
            val response =
                AuthRefreshTokenResponse(
                    payload = AuthRefreshTokenResponsePayload(status = "ok"),
                    requestId = message.requestId
                )
            connection.sendTextAndAwait(objectMapper.writeValueAsString(response))
        } catch (e: Exception) {
            Log.error("Error handling refresh token", e)
            sendErrorResponse(connection, "Failed to refresh token: ${e.message}", message.requestId, 5000)
        }
    }

    private suspend fun sendErrorResponse(
        connection: WebSocketConnection,
        message: String,
        requestId: String?,
        errorCode: Int
    ) {
        try {
            val error =
                AuthRefreshTokenResponse(
                    payload = AuthRefreshTokenResponsePayload(status = "error"),
                    requestId = requestId,
                    error = WebSocketError(code = errorCode, message = message)
                )
            connection.sendTextAndAwait(objectMapper.writeValueAsString(error))
        } catch (e: Exception) {
            Log.error("Failed to send error response", e)
        }
    }
}
