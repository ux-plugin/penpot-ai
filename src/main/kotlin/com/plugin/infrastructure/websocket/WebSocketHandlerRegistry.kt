package com.plugin.infrastructure.websocket

import jakarta.annotation.PostConstruct
import org.springframework.stereotype.Component

/**
 * Registers all WebSocket message handlers with the shared handler on application startup
 */
@Component
class WebSocketHandlerRegistry(
    private val sharedHandler: SharedWebSocketHandler,
    private val messageHandlers: List<WebSocketMessageHandler>
) {

    @PostConstruct
    fun registerHandlers() {
        println("Initializing WebSocket infrastructure...")
        messageHandlers.forEach { handler ->
            sharedHandler.registerMessageHandler(handler)
        }
        println("WebSocket infrastructure initialized successfully. Registered ${messageHandlers.size} handler(s)")
    }
}
