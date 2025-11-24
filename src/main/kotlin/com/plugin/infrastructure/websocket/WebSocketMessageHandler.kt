package com.plugin.infrastructure.websocket

import org.springframework.web.reactive.socket.WebSocketSession
import kotlin.reflect.KClass

interface WebSocketMessageHandler {
    /** Returns the list of message types this handler can process */
    fun getHandledMessageTypes(): List<KClass<out WebSocketMessage>>

    /** Handle a WebSocket message */
    suspend fun handleMessage(message: WebSocketMessage, session: WebSocketSession, userId: String)

    /** Called when a connection is opened */
    suspend fun onOpen(session: WebSocketSession, userId: String) {}

    /** Called when a connection is closed */
    suspend fun onClose(session: WebSocketSession, userId: String) {}

    /** Called when an error occurs */
    suspend fun onError(session: WebSocketSession, userId: String, error: Throwable) {}
}
