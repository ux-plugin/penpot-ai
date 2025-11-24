package com.plugin.infrastructure.websocket

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.reactive.HandlerMapping
import org.springframework.web.reactive.handler.SimpleUrlHandlerMapping
import org.springframework.web.reactive.socket.server.WebSocketService
import org.springframework.web.reactive.socket.server.support.HandshakeWebSocketService
import org.springframework.web.reactive.socket.server.support.WebSocketHandlerAdapter
import org.springframework.web.reactive.socket.server.upgrade.ReactorNettyRequestUpgradeStrategy

@Configuration
class WebSocketConfiguration(
    private val authHandshakeInterceptor: AuthHandshakeInterceptor
) {

    @Bean
    fun webSocketHandlerMapping(sharedWebSocketHandler: SharedWebSocketHandler): HandlerMapping {
        val map = mapOf("/ws" to sharedWebSocketHandler)
        val handlerMapping = SimpleUrlHandlerMapping()
        handlerMapping.order = 1
        handlerMapping.urlMap = map
        return handlerMapping
    }

    @Bean
    fun webSocketHandlerAdapter(): WebSocketHandlerAdapter {
        return WebSocketHandlerAdapter(webSocketService())
    }

    @Bean
    fun webSocketService(): WebSocketService {
        val upgradeStrategy = ReactorNettyRequestUpgradeStrategy()
        val service = HandshakeWebSocketService(upgradeStrategy)
        service.setSessionAttributePredicate { true } // Allow all attributes to pass through
        return service
    }
}
