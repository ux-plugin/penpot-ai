package com.plugin.infrastructure.websocket

import jakarta.websocket.Session

/**
 * Base interface for WebSocket facades
 * 
 * Each facade handles a specific feature domain (e.g., completions, user)
 * and implements the business logic for its messages.
 */
interface WebSocketFacade {
    /**
     * Get the message type prefix this facade handles (e.g., "completions:", "user:")
     */
    fun getMessageTypePrefix(): String
    
    /**
     * Handle a WebSocket message
     * 
     * @param message The WebSocket message to handle
     * @param session The WebSocket session
     * @param userId The authenticated user ID
     * @return Response to send back to the client, or null if no response needed
     */
    suspend fun handleMessage(message: WebSocketMessage, session: Session, userId: String): WebSocketResponse?
    
    /**
     * Called when a WebSocket connection is opened
     * 
     * @param session The WebSocket session
     * @param userId The authenticated user ID
     */
    suspend fun onOpen(session: Session, userId: String) {
        // Default implementation does nothing
    }
    
    /**
     * Called when a WebSocket connection is closed
     * 
     * @param session The WebSocket session
     * @param userId The authenticated user ID
     */
    suspend fun onClose(session: Session, userId: String) {
        // Default implementation does nothing
    }
    
    /**
     * Called when a WebSocket error occurs
     * 
     * @param session The WebSocket session
     * @param userId The authenticated user ID
     * @param error The error that occurred
     */
    suspend fun onError(session: Session, userId: String, error: Throwable) {
        // Default implementation does nothing
    }
}
