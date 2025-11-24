package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import kotlinx.coroutines.reactive.awaitFirst
import kotlinx.coroutines.reactor.mono
import org.springframework.stereotype.Component
import org.springframework.web.reactive.socket.WebSocketHandler
import org.springframework.web.reactive.socket.WebSocketMessage as SpringWebSocketMessage
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Mono
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlin.reflect.KClass

@Component
class SharedWebSocketHandler(
    private val objectMapper: ObjectMapper,
    private val authInterceptor: AuthHandshakeInterceptor,
) : WebSocketHandler {

    private val messageHandlers = ConcurrentHashMap<KClass<out WebSocketMessage>, WebSocketMessageHandler>()
    private val allHandlers = ConcurrentHashMap.newKeySet<WebSocketMessageHandler>()
    private val sessionUserMap = ConcurrentHashMap<String, String>()

    fun registerMessageHandler(messageHandler: WebSocketMessageHandler) {
        allHandlers.add(messageHandler)
        messageHandler.getHandledMessageTypes().forEach { messageType ->
            messageHandlers[messageType] = messageHandler
            println("Registered handler ${messageHandler::class.simpleName} for message type: ${messageType.simpleName}")
        }
    }

    override fun handle(session: WebSocketSession): Mono<Void> {
        // Authenticate first
        return authInterceptor.authenticate(session)
            .flatMap { authenticated ->
                if (!authenticated) {
                    println("WebSocket authentication failed for session: ${session.id}")
                    return@flatMap session.close()
                }

                val userId = authInterceptor.getUserId(session)
                val expirationTime = authInterceptor.getExpiration(session)

                if (userId == null || expirationTime == null) {
                    println("Missing user ID or expiration time in session attributes")
                    return@flatMap session.close()
                }

                println("WebSocket authenticated for user: $userId, session: ${session.id}")
                sessionUserMap[session.id] = userId

                // Notify handlers of connection open
                mono {
                    allHandlers.forEach { handler ->
                        try {
                            handler.onOpen(session, userId)
                        } catch (e: Exception) {
                            println("Error in handler.onOpen: ${e.message}")
                        }
                    }
                }.subscribe()

                // Handle incoming messages
                session.receive()
                    .doOnNext { message ->
                        mono {
                            handleIncomingMessage(message, session, userId, expirationTime)
                        }.subscribe()
                    }
                    .doFinally {
                        sessionUserMap.remove(session.id)
                        allHandlers.forEach { handler ->
                            mono {
                                try {
                                    handler.onClose(session, userId)
                                } catch (e: Exception) {
                                    println("Error in handler.onClose: ${e.message}")
                                }
                            }.subscribe()
                        }
                    }
                    .then()
            }
            .onErrorResume { error ->
                println("WebSocket error: ${error.message}")
                session.close()
            }
    }

    private suspend fun handleIncomingMessage(
        springMessage: SpringWebSocketMessage,
        session: WebSocketSession,
        userId: String,
        expirationTime: Instant
    ) {
        try {
            if (expirationTime.isBefore(Instant.now())) {
                sendErrorResponse(session, "Token expired")
                session.close().awaitFirst()
                return
            }

            val messageStr = springMessage.payloadAsText
            val message = try {
                objectMapper.readValue(messageStr, WebSocketMessage::class.java)
            } catch (e: Exception) {
                sendErrorResponse(session, "Invalid message format")
                return
            }

            val messageHandler = messageHandlers[message::class]
            if (messageHandler == null) {
                sendErrorResponse(session, "Unknown message type: ${message::class.simpleName}", message.requestId)
                return
            }

            messageHandler.handleMessage(message, session, userId)
        } catch (e: Exception) {
            println("Error processing message: ${e.message}")
            sendErrorResponse(session, "Internal error: ${e.message}")
        }
    }

    private suspend fun sendErrorResponse(
        session: WebSocketSession,
        message: String,
        requestId: String? = null,
        errorCode: Int = 5000
    ) {
        try {
            val errorJson = objectMapper.writeValueAsString(
                mapOf(
                    "type" to "error",
                    "requestId" to requestId,
                    "error" to mapOf("code" to errorCode, "message" to message)
                )
            )
            session.send(Mono.just(session.textMessage(errorJson))).awaitFirst()
        } catch (e: Exception) {
            println("Failed to send error response: ${e.message}")
        }
    }
}
