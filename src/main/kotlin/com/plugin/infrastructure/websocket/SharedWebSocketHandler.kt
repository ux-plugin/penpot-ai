package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import kotlinx.coroutines.reactive.awaitFirst
import kotlinx.coroutines.reactor.mono
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
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
    private val jwtDecoder: ReactiveJwtDecoder,
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
        return mono {
            try {
                // Extract and validate JWT from query params
                val token = session.handshakeInfo.uri.query?.split("&")
                    ?.find { it.startsWith("token=") }
                    ?.substringAfter("token=")

                if (token.isNullOrBlank()) {
                    session.close().awaitFirst()
                    return@mono
                }

                val jwt = try {
                    jwtDecoder.decode(token).awaitFirst()
                } catch (e: Exception) {
                    session.close().awaitFirst()
                    return@mono
                }

                val userId = jwt.subject
                val expirationTime = jwt.expiresAt

                if (userId.isNullOrBlank() || expirationTime == null || expirationTime.isBefore(Instant.now())) {
                    session.close().awaitFirst()
                    return@mono
                }

                sessionUserMap[session.id] = userId

                // Notify handlers of connection open
                allHandlers.forEach { handler ->
                    try {
                        handler.onOpen(session, userId)
                    } catch (e: Exception) {
                        println("Error in handler.onOpen: ${e.message}")
                    }
                }

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
                    .awaitFirst()
            } catch (e: Exception) {
                println("WebSocket error: ${e.message}")
                session.close().awaitFirst()
            }
        }.then()
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
