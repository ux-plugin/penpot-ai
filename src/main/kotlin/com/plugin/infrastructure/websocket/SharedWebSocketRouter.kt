package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.features.auth.core.WebSocketAuthConfig
import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import io.quarkus.websockets.next.CloseReason
import io.quarkus.websockets.next.OnClose
import io.quarkus.websockets.next.OnError
import io.quarkus.websockets.next.OnOpen
import io.quarkus.websockets.next.OnTextMessage
import io.quarkus.websockets.next.UserData.TypedKey
import io.quarkus.websockets.next.WebSocket
import io.quarkus.websockets.next.WebSocketConnection
import jakarta.inject.Inject
import java.time.Instant.now
import java.util.concurrent.ConcurrentHashMap
import org.eclipse.microprofile.jwt.JsonWebToken

/**
 * Shared WebSocket handler that routes messages to appropriate message handlers
 *
 * This handler manages WebSocket connections, authentication, and message routing. Messages are routed to registered
 * handlers based on their type prefix.
 *
 * Migrated to Quarkus WebSocket Next API for parallel message processing.
 */
@WebSocket(path = "/ws")
@Authenticated
class SharedWebSocketRouter
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val authConfig: WebSocketAuthConfig,
    private val jsonWebToken: JsonWebToken,
) {
    private val messageHandlers = ConcurrentHashMap<String, WebSocketMessageHandler>()

    /** Register a message handler to handle messages with a specific type prefix */
    fun registerMessageHandler(messageHandler: WebSocketMessageHandler) {
        messageHandlers[messageHandler.getMessageTypePrefix()] = messageHandler
        Log.info("Registered WebSocket handler for prefix: ${messageHandler.getMessageTypePrefix()}")
    }

    @OnOpen
    suspend fun onOpen(connection: WebSocketConnection) {
        try {
            // Extract user ID from the principal
            val userId = jsonWebToken.subject
            Log.debug("User ID from security identity: $userId")

            if (userId.isNullOrBlank()) {
                Log.warn("Unauthenticated WebSocket connection attempt - no valid principal name")
                connection.closeAndAwait(CloseReason(1008, "Authentication required"))
                return
            }

            // Get JWT token from identity attributes
            val expirationTime = jsonWebToken.expirationTime

            if (expirationTime <= now().epochSecond) {
                Log.warn("JWT token has expired: $expirationTime")
                connection.closeAndAwait(CloseReason(1008, "Invalid token"))
                return
            }

            // Store authentication data in connection userData
            val userIdKey = authConfig.session().userIdKey()
            val expirationKey = authConfig.session().tokenExpirationKey()

            connection.userData().put(TypedKey.forString(userIdKey), userId)
            connection.userData().put(TypedKey.forLong(expirationKey), expirationTime)

            Log.info("WebSocket connection opened: ${connection.id()} for user: $userId")
            Log.debug("Token expiration time: $expirationTime (${java.time.Instant.ofEpochSecond(expirationTime)})")

            // Notify all handlers about the connection
            messageHandlers.values.forEach { handler ->
                try {
                    handler.onOpen(connection, userId)
                } catch (e: Exception) {
                    Log.error("Error in handler.onOpen for ${handler.getMessageTypePrefix()}", e)
                }
            }
        } catch (e: Exception) {
            Log.error("Error during WebSocket open", e)
            connection.closeAndAwait(CloseReason(1011, "Server error"))
        }
    }

    @OnTextMessage(broadcast = false)
    suspend fun onMessage(messageStr: String, connection: WebSocketConnection): String {
        return try {
            // Get session data from connection attributes
            val userIdKey = authConfig.session().userIdKey()
            val expirationKey = authConfig.session().tokenExpirationKey()

            val expirationTime = connection.userData().get(TypedKey.forLong(expirationKey))
            val currentTime = now().epochSecond

            if (expirationTime == null) {
                Log.error("No expiration time found for connection: ${connection.id()}")
                connection.closeAndAwait(CloseReason(4001, "Connection not properly initialized"))
                return createErrorResponse("Connection not initialized")
            }

            if (currentTime >= expirationTime) {
                Log.warn("Token expired for connection: ${connection.id()}")
                connection.closeAndAwait(CloseReason(4001, "Token expired"))
                return createErrorResponse("Token expired")
            }

            val userId =
                connection.userData().get(TypedKey.forString(userIdKey))
                    ?: run {
                        Log.error("No user ID found for connection: ${connection.id()}")
                        connection.closeAndAwait(CloseReason(4001, "Connection not authenticated"))
                        return createErrorResponse("Not authenticated")
                    }

            // Parse the message
            val message =
                try {
                    objectMapper.readValue(messageStr, WebSocketMessage::class.java)
                } catch (e: Exception) {
                    Log.error("Failed to parse WebSocket message", e)
                    return createErrorResponse("Invalid message format")
                }

            Log.debug("Received message type: ${message.type} for connection: ${connection.id()}")

            // Route to appropriate handler based on message type prefix
            val prefix = message.type.substringBefore(':') + ":"
            val messageHandler = messageHandlers[prefix]

            if (messageHandler == null) {
                Log.warn("No handler registered for message type: ${message.type}")
                return createErrorResponse("Unknown message type: ${message.type}", message.requestId)
            }

            // Handle the message (this runs in parallel with other messages!)
            val response = messageHandler.handleMessage(message, connection, userId)

            // Return response if available, otherwise success acknowledgment
            response?.let { objectMapper.writeValueAsString(it) } ?: createSuccessResponse(message.requestId)
        } catch (e: Exception) {
            Log.error("Error processing message", e)
            createErrorResponse("Internal error: ${e.message}")
        }
    }

    @OnClose
    suspend fun onClose(connection: WebSocketConnection) {
        val userIdKey = authConfig.session().userIdKey()
        val userId = connection.userData().get(TypedKey.forString(userIdKey))

        Log.info("WebSocket connection closed: ${connection.id()} for user: $userId")

        // Notify all handlers about the closure
        if (userId != null) {
            messageHandlers.values.forEach { messageHandler ->
                try {
                    messageHandler.onClose(connection, userId)
                } catch (e: Exception) {
                    Log.error("Error in messageHandler.onClose for ${messageHandler.getMessageTypePrefix()}", e)
                }
            }
        }
    }

    @OnError
    suspend fun onError(connection: WebSocketConnection, throwable: Throwable) {
        val userIdKey = authConfig.session().userIdKey()
        val userId = connection.userData().get(TypedKey.forString(userIdKey))

        Log.error("WebSocket error on connection: ${connection.id()} for user: $userId", throwable)

        if (userId != null) {
            messageHandlers.values.forEach { messageHandler ->
                try {
                    messageHandler.onError(connection, userId, throwable)
                } catch (e: Exception) {
                    Log.error("Error in messageHandler.onError for ${messageHandler.getMessageTypePrefix()}", e)
                }
            }
        }
    }

    private fun createErrorResponse(message: String, requestId: String? = null): String {
        val error = WebSocketResponse(type = "error", payload = emptyMap(), requestId = requestId, error = message)
        return objectMapper.writeValueAsString(error)
    }

    private fun createSuccessResponse(requestId: String? = null): String {
        val response = WebSocketResponse(type = "ack", payload = mapOf("status" to "ok"), requestId = requestId)
        return objectMapper.writeValueAsString(response)
    }
}
