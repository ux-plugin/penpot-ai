package com.plugin.features.auth.core

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.config.JwtService
import com.plugin.infrastructure.websocket.*
import kotlinx.coroutines.reactive.awaitFirst
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import org.springframework.stereotype.Component
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Mono
import java.time.Instant
import kotlin.reflect.KClass

@Component
class AuthWebSocketMessageHandler(
    private val objectMapper: ObjectMapper,
    private val jwtDecoder: ReactiveJwtDecoder,
) : WebSocketMessageHandler {

    override fun getHandledMessageTypes(): List<KClass<out WebSocketMessage>> =
        listOf(AuthRefreshTokenRequest::class)

    override suspend fun handleMessage(message: WebSocketMessage, session: WebSocketSession, userId: String) {
        when (message) {
            is AuthRefreshTokenRequest -> handleRefreshToken(message, session, userId)
            else -> {
                println("Unexpected message type in AuthWebSocketMessageHandler: ${message::class.simpleName}")
                sendErrorResponse(session, "Unsupported message type", message.requestId, 4003)
            }
        }
    }

    private suspend fun handleRefreshToken(
        message: AuthRefreshTokenRequest,
        session: WebSocketSession,
        userId: String
    ) {
        try {
            val newAccessToken = message.payload.access_token

            if (newAccessToken.isBlank()) {
                println("Refresh token request missing access_token payload for user: $userId")
                sendErrorResponse(session, "Missing access_token in payload", message.requestId, 4002)
                return
            }

            // Parse and validate the new JWT token
            val jwt = try {
                jwtDecoder.decode(newAccessToken).awaitFirst()
            } catch (e: Exception) {
                println("Failed to parse new access token: ${e.message}")
                sendErrorResponse(session, "Invalid access token", message.requestId, 4001)
                return
            }

            // Verify the token is for the same user
            if (jwt.subject != userId) {
                println("Token user mismatch: expected $userId, got ${jwt.subject}")
                sendErrorResponse(session, "Token user mismatch", message.requestId, 4001)
                return
            }

            // Extract expiration time from the new token
            val newExpiration = jwt.expiresAt
            if (newExpiration == null || newExpiration.isBefore(Instant.now())) {
                println("Invalid expiration time in new token")
                sendErrorResponse(session, "Invalid token expiration", message.requestId, 4001)
                return
            }

            // Update session attributes with new expiration
            session.attributes["jwtExpiration"] = newExpiration

            println("Token refreshed for user: $userId, session: ${session.id}")
            println("New expiration time: $newExpiration")

            // Send success response
            val response = AuthRefreshTokenResponse(
                payload = AuthRefreshTokenResponsePayload(status = "ok"),
                requestId = message.requestId
            )
            sendMessage(session, response)
        } catch (e: Exception) {
            println("Error handling refresh token: ${e.message}")
            sendErrorResponse(session, "Failed to refresh token: ${e.message}", message.requestId, 5000)
        }
    }

    private suspend fun sendMessage(session: WebSocketSession, message: Any) {
        try {
            val json = objectMapper.writeValueAsString(message)
            session.send(Mono.just(session.textMessage(json))).awaitFirst()
        } catch (e: Exception) {
            println("Failed to send message: ${e.message}")
        }
    }

    private suspend fun sendErrorResponse(
        session: WebSocketSession,
        message: String,
        requestId: String?,
        errorCode: Int
    ) {
        try {
            val error = AuthRefreshTokenResponse(
                payload = AuthRefreshTokenResponsePayload(status = "error"),
                requestId = requestId,
                error = WebSocketError(code = errorCode, message = message)
            )
            sendMessage(session, error)
        } catch (e: Exception) {
            println("Failed to send error response: ${e.message}")
        }
    }
}
