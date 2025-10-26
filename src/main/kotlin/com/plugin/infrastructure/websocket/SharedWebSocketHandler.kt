package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.websocket.*
import jakarta.websocket.server.ServerEndpoint
import org.eclipse.microprofile.jwt.JsonWebToken
import java.util.concurrent.ConcurrentHashMap

/**
 * Shared WebSocket handler that routes messages to appropriate facades
 * 
 * This handler manages WebSocket connections, authentication, and message routing.
 * Messages are routed to registered facades based on their type prefix.
 */
@ServerEndpoint("/ws")
@ApplicationScoped
@Authenticated
class SharedWebSocketHandler
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val jsonWebToken: JsonWebToken,
) {
    // Store user IDs per session for authenticated users
    private val sessionUserIds = ConcurrentHashMap<String, String>()
    
    // Store JWT token expiration times per session
    private val sessionTokenExpirations = ConcurrentHashMap<String, Long>()
    
    // Registry of facades by their message type prefix
    private val facades = ConcurrentHashMap<String, WebSocketFacade>()
    
    /**
     * Register a facade to handle messages with a specific type prefix
     */
    fun registerFacade(facade: WebSocketFacade) {
        facades[facade.getMessageTypePrefix()] = facade
        Log.info("Registered WebSocket facade for prefix: ${facade.getMessageTypePrefix()}")
    }
    
    @OnOpen
    fun onOpen(session: Session) {
        try {
            // Verify authentication - check if JWT token exists and has a subject
            val userId = jsonWebToken.subject
            Log.debug("User ID from JWT token: $userId")
            
            if (userId == null || userId.isBlank()) {
                Log.warn("Unauthenticated WebSocket connection attempt - no valid JWT subject")
                session.close(CloseReason(CloseReason.CloseCodes.VIOLATED_POLICY, "Authentication required"))
                return
            }
            
            // Cache the token expiration time
            val expirationTime = jsonWebToken.expirationTime
            if (expirationTime <= 0) {
                Log.warn("JWT token has no valid expiration time: $expirationTime")
                session.close(CloseReason(CloseReason.CloseCodes.VIOLATED_POLICY, "Invalid token"))
                return
            }
            
            sessionUserIds[session.id] = userId
            sessionTokenExpirations[session.id] = expirationTime
            
            Log.info("WebSocket connection opened: ${session.id} for user: $userId")
            Log.debug("Token expiration time: $expirationTime (${java.time.Instant.ofEpochSecond(expirationTime)})")
            
            // Notify all facades about the connection
            kotlinx.coroutines.runBlocking {
                facades.values.forEach { facade ->
                    try {
                        facade.onOpen(session, userId)
                    } catch (e: Exception) {
                        Log.error("Error in facade.onOpen for ${facade.getMessageTypePrefix()}", e)
                    }
                }
            }
        } catch (e: Exception) {
            Log.error("Error during WebSocket authentication", e)
            session.close(CloseReason(CloseReason.CloseCodes.UNEXPECTED_CONDITION, "Authentication failed"))
        }
    }
    
    @OnMessage
    fun onMessage(messageStr: String, session: Session): String {
        return try {
            // Check if token has expired
            val expirationTime = sessionTokenExpirations[session.id]
            val currentTime = System.currentTimeMillis() / 1000 // Convert to seconds
            
            if (expirationTime == null) {
                Log.error("No expiration time found for session: ${session.id}")
                session.close(CloseReason(CloseReason.CloseCodes.TRY_AGAIN_LATER, "Session not properly initialized"))
                return createErrorResponse("Session not initialized")
            }
            
            if (currentTime >= expirationTime) {
                Log.warn("Token expired for session: ${session.id}")
                session.close(CloseReason(CloseReason.CloseCode { 4001 }, "Token expired"))
                return createErrorResponse("Token expired")
            }
            
            val userId = sessionUserIds[session.id]
                ?: run {
                    Log.error("No user ID found for session: ${session.id}")
                    session.close(CloseReason(CloseReason.CloseCodes.VIOLATED_POLICY, "Session not authenticated"))
                    return createErrorResponse("Not authenticated")
                }
            
            // Parse the message
            val message = try {
                objectMapper.readValue(messageStr, WebSocketMessage::class.java)
            } catch (e: Exception) {
                Log.error("Failed to parse WebSocket message", e)
                return createErrorResponse("Invalid message format")
            }
            
            Log.debug("Received message type: ${message.type} for session: ${session.id}")
            
            // Route to appropriate facade based on message type prefix
            val prefix = message.type.substringBefore(':') + ":"
            val facade = facades[prefix]
            
            if (facade == null) {
                Log.warn("No facade registered for message type: ${message.type}")
                return createErrorResponse("Unknown message type: ${message.type}", message.requestId)
            }
            
            // Handle the message with the facade
            val response = kotlinx.coroutines.runBlocking {
                facade.handleMessage(message, session, userId)
            }
            
            // Return response if available, otherwise success acknowledgment
            response?.let { objectMapper.writeValueAsString(it) }
                ?: createSuccessResponse(message.requestId)
            
        } catch (e: Exception) {
            Log.error("Error processing message", e)
            createErrorResponse("Internal error: ${e.message}")
        }
    }
    
    @OnClose
    fun onClose(session: Session) {
        val userId = sessionUserIds[session.id]
        Log.info("WebSocket connection closed: ${session.id} for user: $userId")
        
        // Notify all facades about the closure
        userId?.let { uid ->
            kotlinx.coroutines.runBlocking {
                facades.values.forEach { facade ->
                    try {
                        facade.onClose(session, uid)
                    } catch (e: Exception) {
                        Log.error("Error in facade.onClose for ${facade.getMessageTypePrefix()}", e)
                    }
                }
            }
        }
        
        // Clean up session data
        sessionUserIds.remove(session.id)
        sessionTokenExpirations.remove(session.id)
    }
    
    @OnError
    fun onError(throwable: Throwable, session: Session) {
        val userId = sessionUserIds[session.id]
        Log.error("WebSocket error on connection: ${session.id} for user: $userId", throwable)
        
        // Notify all facades about the error
        userId?.let { uid ->
            kotlinx.coroutines.runBlocking {
                facades.values.forEach { facade ->
                    try {
                        facade.onError(session, uid, throwable)
                    } catch (e: Exception) {
                        Log.error("Error in facade.onError for ${facade.getMessageTypePrefix()}", e)
                    }
                }
            }
        }
        
        // Clean up session data
        sessionUserIds.remove(session.id)
        sessionTokenExpirations.remove(session.id)
    }
    
    private fun createErrorResponse(message: String, requestId: String? = null): String {
        val error = WebSocketResponse(
            type = "error",
            payload = emptyMap(),
            requestId = requestId,
            error = message
        )
        return objectMapper.writeValueAsString(error)
    }
    
    private fun createSuccessResponse(requestId: String? = null): String {
        val response = WebSocketResponse(
            type = "ack",
            payload = mapOf("status" to "ok"),
            requestId = requestId
        )
        return objectMapper.writeValueAsString(response)
    }
}
