package com.plugin.infrastructure.websocket

import io.quarkus.websockets.next.WebSocketConnection

/**
 * Base interface for WebSocket message handlers
 *
 * Each handler manages a specific feature domain (e.g., completions, user) and implements the business logic for its
 * messages.
 *
 * Updated to use Quarkus WebSocket Next API with WebSocketConnection and Uni for reactive programming.
 */
interface WebSocketMessageHandler {
    /** Get the message type prefix this handler manages (e.g., "completions:", "user:") */
    fun getMessageTypePrefix(): String

    /**
     * Handle a WebSocket message
     *
     * @param message The WebSocket message to handle
     * @param connection The WebSocket connection
     * @param userId The authenticated user ID
     * @return Uni containing the response to send back to the client, or null if no response needed
     */
    suspend fun handleMessage(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse?

    /**
     * Called when a WebSocket connection is opened
     *
     * @param connection The WebSocket connection
     * @param userId The authenticated user ID
     * @return Uni that completes when initialization is done
     */
    suspend fun onOpen(connection: WebSocketConnection, userId: String) {
        // Default implementation does nothing
        return
    }

    /**
     * Called when a WebSocket connection is closed
     *
     * @param connection The WebSocket connection
     * @param userId The authenticated user ID
     * @return Uni that completes when cleanup is done
     */
    suspend fun onClose(connection: WebSocketConnection, userId: String) {
        // Default implementation does nothing
        return
    }

    /**
     * Called when a WebSocket error occurs
     *
     * @param connection The WebSocket connection
     * @param userId The authenticated user ID
     * @param error The error that occurred
     * @return Uni that completes when error handling is done
     */
    suspend fun onError(connection: WebSocketConnection, userId: String, error: Throwable) {
        // Default implementation does nothing
        return
    }
}
