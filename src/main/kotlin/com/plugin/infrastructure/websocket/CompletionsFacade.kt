package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.features.completions.CommandDispatcher
import com.plugin.features.completions.WebSocketCommand
import io.quarkus.logging.Log
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.websocket.Session
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

/**
 * Facade for handling completions-related WebSocket messages
 * 
 * This facade wraps the existing completion logic and integrates it with
 * the shared WebSocket infrastructure.
 */
@ApplicationScoped
class CompletionsFacade
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val commandDispatcher: CommandDispatcher,
) : WebSocketFacade {
    
    // Store audio buffers per session (migrated from ComponentStreamingWebSocket)
    private val audioBuffers = ConcurrentHashMap<String, ByteArrayOutputStream>()
    
    override fun getMessageTypePrefix(): String = "completions:"
    
    override suspend fun handleMessage(
        message: WebSocketMessage,
        session: Session,
        userId: String
    ): WebSocketResponse? {
        return try {
            // Convert new message format to legacy command format for backwards compatibility
            val legacyCommand = convertToLegacyCommand(message)
            
            if (legacyCommand != null) {
                // Use existing command dispatcher
                val response = commandDispatcher.dispatch(legacyCommand, session, userId)
                
                // Convert response to new format
                WebSocketResponse(
                    type = message.type,
                    payload = mapOf("response" to response),
                    requestId = message.requestId
                )
            } else {
                Log.warn("Unable to convert message to legacy command: ${message.type}")
                WebSocketResponse(
                    type = "error",
                    payload = emptyMap(),
                    requestId = message.requestId,
                    error = "Unsupported message type: ${message.type}"
                )
            }
        } catch (e: Exception) {
            Log.error("Error handling completions message", e)
            WebSocketResponse(
                type = "error",
                payload = emptyMap(),
                requestId = message.requestId,
                error = e.message ?: "Unknown error"
            )
        }
    }
    
    override suspend fun onOpen(session: Session, userId: String) {
        Log.debug("CompletionsFacade: Session opened for user $userId")
        audioBuffers[session.id] = ByteArrayOutputStream()
    }
    
    override suspend fun onClose(session: Session, userId: String) {
        Log.debug("CompletionsFacade: Session closed for user $userId")
        // Clean up audio buffers
        audioBuffers.remove(session.id)
    }
    
    override suspend fun onError(session: Session, userId: String, error: Throwable) {
        Log.error("CompletionsFacade: Error for user $userId", error)
        // Clean up audio buffers
        audioBuffers.remove(session.id)
    }
    
    /**
     * Convert new WebSocket message format to legacy command format
     * This maintains backwards compatibility with existing command handlers
     */
    private fun convertToLegacyCommand(message: WebSocketMessage): WebSocketCommand? {
        return try {
            // Extract the command type (everything after "completions:")
            val commandType = message.type.substringAfter("completions:")
            
            // Create a JSON string with the legacy format
            val legacyJson = objectMapper.writeValueAsString(
                mapOf("event" to commandType) + message.payload
            )
            
            // Parse into legacy command
            objectMapper.readValue(legacyJson, WebSocketCommand::class.java)
        } catch (e: Exception) {
            Log.error("Failed to convert message to legacy command", e)
            null
        }
    }
}
