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
import kotlin.reflect.KClass
import org.eclipse.microprofile.jwt.JsonWebToken

@WebSocket(path = "/ws")
@Authenticated
class SharedWebSocketRouter
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val authConfig: WebSocketAuthConfig,
    private val jsonWebToken: JsonWebToken,
) {
    // Map message class to its handler
    private val messageHandlers = ConcurrentHashMap<KClass<out WebSocketMessage>, WebSocketMessageHandler>()

    // Keep track of all registered handlers for lifecycle callbacks
    private val allHandlers = ConcurrentHashMap.newKeySet<WebSocketMessageHandler>()

    /** Register a message handler for the message types it handles */
    fun registerMessageHandler(messageHandler: WebSocketMessageHandler) {
        allHandlers.add(messageHandler)
        messageHandler.getHandledMessageTypes().forEach { messageType ->
            messageHandlers[messageType] = messageHandler
            Log.info(
                "Registered handler ${messageHandler::class.simpleName} for message type: ${messageType.simpleName}"
            )
        }
    }

    @OnOpen
    suspend fun onOpen(connection: WebSocketConnection) {
        try {
            val userId = jsonWebToken.subject
            Log.debug("User ID from security identity: $userId")

            if (userId.isNullOrBlank()) {
                Log.warn("Unauthenticated WebSocket connection attempt - no valid principal name")
                connection.closeAndAwait(CloseReason(1008, "Authentication required"))
                return
            }

            val expirationTime = jsonWebToken.expirationTime

            if (expirationTime <= now().epochSecond) {
                Log.warn("JWT token has expired: $expirationTime")
                connection.closeAndAwait(CloseReason(1008, "Invalid token"))
                return
            }

            val userIdKey = authConfig.session().userIdKey()
            val expirationKey = authConfig.session().tokenExpirationKey()

            connection.userData().put(TypedKey.forString(userIdKey), userId)
            connection.userData().put(TypedKey.forLong(expirationKey), expirationTime)

            Log.info("WebSocket connection opened: ${connection.id()} for user: $userId")
            Log.debug("Token expiration time: $expirationTime (${java.time.Instant.ofEpochSecond(expirationTime)})")

            allHandlers.forEach { handler ->
                try {
                    handler.onOpen(connection, userId)
                } catch (e: Exception) {
                    Log.error("Error in handler.onOpen for ${handler::class.simpleName}", e)
                }
            }
        } catch (e: Exception) {
            Log.error("Error during WebSocket open", e)
            connection.closeAndAwait(CloseReason(1011, "Server error"))
        }
    }

    @OnTextMessage(broadcast = false)
    suspend fun onMessage(messageStr: String, connection: WebSocketConnection) {
        try {
            val userIdKey = authConfig.session().userIdKey()
            val expirationKey = authConfig.session().tokenExpirationKey()

            val expirationTime = connection.userData().get(TypedKey.forLong(expirationKey))
            val currentTime = now().epochSecond

            if (expirationTime == null) {
                Log.error("No expiration time found for connection: ${connection.id()}")
                sendErrorResponse(connection, "Connection not initialized")
                connection.closeAndAwait(CloseReason(4001, "Connection not properly initialized"))
                return
            }

            if (currentTime >= expirationTime) {
                Log.warn("Token expired for connection: ${connection.id()}")
                sendErrorResponse(connection, "Token expired")
                connection.closeAndAwait(CloseReason(4001, "Token expired"))
                return
            }

            val userId =
                connection.userData().get(TypedKey.forString(userIdKey))
                    ?: run {
                        Log.error("No user ID found for connection: ${connection.id()}")
                        sendErrorResponse(connection, "Not authenticated")
                        connection.closeAndAwait(CloseReason(4001, "Connection not authenticated"))
                        return
                    }

            // Parse the message - Jackson will automatically deserialize to the correct type
            val message =
                try {
                    objectMapper.readValue(messageStr, WebSocketMessage::class.java)
                } catch (e: Exception) {
                    Log.error("Failed to parse WebSocket message", e)
                    sendErrorResponse(connection, "Invalid message format")
                    return
                }

            Log.debug("Received message type: ${message::class.simpleName} for connection: ${connection.id()}")

            // Look up handler by message class
            val messageHandler = messageHandlers[message::class]

            if (messageHandler == null) {
                Log.warn("No handler registered for message type: ${message::class.simpleName}")
                sendErrorResponse(connection, "Unknown message type: ${message::class.simpleName}", message.requestId)
                return
            }

            // Handle the message
            messageHandler.handleMessage(message, connection, userId)
        } catch (e: Exception) {
            Log.error("Error processing message", e)
            sendErrorResponse(connection, "Internal error: ${e.message}")
        }
    }

    @OnClose
    suspend fun onClose(connection: WebSocketConnection) {
        val userIdKey = authConfig.session().userIdKey()
        val userId = connection.userData().get(TypedKey.forString(userIdKey))

        Log.info("WebSocket connection closed: ${connection.id()} for user: $userId")

        if (userId != null) {
            allHandlers.forEach { messageHandler ->
                try {
                    messageHandler.onClose(connection, userId)
                } catch (e: Exception) {
                    Log.error("Error in messageHandler.onClose for ${messageHandler::class.simpleName}", e)
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
            allHandlers.forEach { messageHandler ->
                try {
                    messageHandler.onError(connection, userId, throwable)
                } catch (e: Exception) {
                    Log.error("Error in messageHandler.onError for ${messageHandler::class.simpleName}", e)
                }
            }
        }
    }

    private suspend fun sendErrorResponse(
        connection: WebSocketConnection,
        message: String,
        requestId: String? = null,
        errorCode: Int = 5000
    ) {
        try {
            val errorJson =
                objectMapper.writeValueAsString(
                    mapOf(
                        "type" to "error",
                        "requestId" to requestId,
                        "error" to mapOf("code" to errorCode, "message" to message)
                    )
                )
            connection.sendTextAndAwait(errorJson)
        } catch (e: Exception) {
            Log.error("Failed to send error response", e)
        }
    }
}
