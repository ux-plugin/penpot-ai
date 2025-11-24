package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import kotlinx.coroutines.reactive.awaitFirst
import org.springframework.stereotype.Component
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Mono
import kotlin.reflect.KClass

/**
 * Example message handler for user-related WebSocket messages
 * This demonstrates how to implement a WebSocketMessageHandler
 */
@Component
class UserWebSocketMessageHandler(
    private val objectMapper: ObjectMapper,
) : WebSocketMessageHandler {

    override fun getHandledMessageTypes(): List<KClass<out WebSocketMessage>> {
        return listOf(
            UserSubscribePortsRequest::class,
            UserUnsubscribePortsRequest::class
        )
    }

    override suspend fun handleMessage(message: WebSocketMessage, session: WebSocketSession, userId: String) {
        when (message) {
            is UserSubscribePortsRequest -> handleSubscribePorts(message, session, userId)
            is UserUnsubscribePortsRequest -> handleUnsubscribePorts(message, session, userId)
        }
    }

    private suspend fun handleSubscribePorts(
        message: UserSubscribePortsRequest,
        session: WebSocketSession,
        userId: String
    ) {
        val response = UserSubscribePortsResponse(requestId = message.requestId)
        sendMessage(session, response)
    }

    private suspend fun handleUnsubscribePorts(
        message: UserUnsubscribePortsRequest,
        session: WebSocketSession,
        userId: String
    ) {
        val response = UserUnsubscribePortsResponse(requestId = message.requestId)
        sendMessage(session, response)
    }

    private suspend fun sendMessage(session: WebSocketSession, message: Any) {
        try {
            val json = objectMapper.writeValueAsString(message)
            session.send(Mono.just(session.textMessage(json))).awaitFirst()
        } catch (e: Exception) {
            println("Failed to send message: ${e.message}")
        }
    }

    override suspend fun onOpen(session: WebSocketSession, userId: String) {
        println("User WebSocket opened for user: $userId")
    }

    override suspend fun onClose(session: WebSocketSession, userId: String) {
        println("User WebSocket closed for user: $userId")
    }
}
