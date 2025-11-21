package com.plugin.infrastructure.websocket

import io.quarkus.websockets.next.WebSocketConnection
import kotlin.reflect.KClass

interface WebSocketMessageHandler {
    /** Returns the list of message types this handler can process */
    fun getHandledMessageTypes(): List<KClass<out WebSocketMessage>>

    /** Handle a WebSocket message */
    suspend fun handleMessage(message: WebSocketMessage, connection: WebSocketConnection, userId: String)

    /** Called when a connection is opened */
    suspend fun onOpen(connection: WebSocketConnection, userId: String) {}

    /** Called when a connection is closed */
    suspend fun onClose(connection: WebSocketConnection, userId: String) {}

    /** Called when an error occurs */
    suspend fun onError(connection: WebSocketConnection, userId: String, error: Throwable) {}
}
