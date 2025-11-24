package com.plugin.features.user

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.infrastructure.websocket.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.reactive.awaitFirst
import kotlinx.coroutines.reactive.awaitSingle
import org.springframework.data.redis.core.ReactiveRedisTemplate
import org.springframework.stereotype.Component
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Mono
import java.util.concurrent.ConcurrentHashMap
import kotlin.reflect.KClass

@Component
class UserWebSocketMessageHandler(
    private val objectMapper: ObjectMapper,
    private val userService: UserService,
    private val reactiveRedisTemplate: ReactiveRedisTemplate<String, PortState>,
) : WebSocketMessageHandler {

    private val portSubscriptions = ConcurrentHashMap<String, PortSubscription>()

    data class PortSubscription(
        val channel: Channel<PortState>,
        val userId: String,
        var isActive: Boolean = true
    )

    override fun getHandledMessageTypes(): List<KClass<out WebSocketMessage>> =
        listOf(UserSubscribePortsRequest::class, UserUnsubscribePortsRequest::class)

    override suspend fun handleMessage(message: WebSocketMessage, session: WebSocketSession, userId: String) {
        when (message) {
            is UserSubscribePortsRequest -> handleSubscribePorts(message, session, userId)
            is UserUnsubscribePortsRequest -> handleUnsubscribePorts(message, session, userId)
            else -> {
                println("Unexpected message type in UserWebSocketMessageHandler: ${message::class.simpleName}")
                sendErrorResponse(session, "Unsupported message type", message.requestId, 4003)
            }
        }
    }

    private suspend fun handleSubscribePorts(
        message: UserSubscribePortsRequest,
        session: WebSocketSession,
        userId: String
    ) {
        try {
            if (portSubscriptions.containsKey(session.id)) {
                println("Session ${session.id} already subscribed to port updates")
                val response = UserSubscribePortsResponse(requestId = message.requestId)
                sendMessage(session, response)
                return
            }

            // Get current port and send immediately
            val currentPort = userService.getCurrentPort(userId)
            currentPort?.let { sendPortUpdate(session, it, message.requestId) }

            // Create subscription channel
            val channel = Channel<PortState>(Channel.UNLIMITED)
            portSubscriptions[session.id] = PortSubscription(channel, userId)

            // Subscribe to Redis pub/sub
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val messageListener = reactiveRedisTemplate.listenToChannel(userService.companionAppKeyPrefix + userId)
                    
                    messageListener.subscribe { message ->
                        channel.trySend(message.message)
                    }

                    // Listen for updates and send to client
                    for (update in channel) {
                        val subscription = portSubscriptions[session.id]
                        if (subscription?.isActive == true) {
                            sendPortUpdate(session, update)
                        } else {
                            break
                        }
                    }
                } catch (e: Exception) {
                    println("Error processing port updates for session ${session.id}: ${e.message}")
                } finally {
                    channel.close()
                    portSubscriptions.remove(session.id)
                }
            }

            println("User $userId subscribed to port updates on session ${session.id}")

            val response = UserSubscribePortsResponse(requestId = message.requestId)
            sendMessage(session, response)
        } catch (e: Exception) {
            println("Error subscribing to port updates: ${e.message}")
            sendErrorResponse(session, e.message ?: "Failed to subscribe", message.requestId, 5000)
        }
    }

    private suspend fun handleUnsubscribePorts(
        message: UserUnsubscribePortsRequest,
        session: WebSocketSession,
        userId: String
    ) {
        try {
            val subscription = portSubscriptions.remove(session.id)
            if (subscription != null) {
                subscription.isActive = false
                subscription.channel.close()
                println("User $userId unsubscribed from port updates on session ${session.id}")
            }

            val response = UserUnsubscribePortsResponse(requestId = message.requestId)
            sendMessage(session, response)
        } catch (e: Exception) {
            println("Error unsubscribing from port updates: ${e.message}")
            sendErrorResponse(session, e.message ?: "Failed to unsubscribe", message.requestId, 5000)
        }
    }

    private suspend fun sendMessage(session: WebSocketSession, message: Any) {
        try {
            val json = objectMapper.writeValueAsString(message)
            session.send(Mono.just(session.textMessage(json))).awaitFirst()
        } catch (e: Exception) {
            println("Failed to send message: ${e.message}")
        }
    }

    private suspend fun sendPortUpdate(session: WebSocketSession, portState: PortState, requestId: String? = null) {
        try {
            val response = UserPortUpdate(payload = UserPortUpdatePayload(port = portState.port), requestId = requestId)
            sendMessage(session, response)
        } catch (e: Exception) {
            println("Error sending port update to session ${session.id}: ${e.message}")
        }
    }

    private suspend fun sendErrorResponse(
        session: WebSocketSession,
        message: String,
        requestId: String?,
        errorCode: Int
    ) {
        try {
            val error = UserSubscribePortsResponse(
                payload = UserSubscribePortsResponsePayload(status = "error"),
                requestId = requestId,
                error = WebSocketError(code = errorCode, message = message)
            )
            sendMessage(session, error)
        } catch (e: Exception) {
            println("Failed to send error response: ${e.message}")
        }
    }

    override suspend fun onClose(session: WebSocketSession, userId: String) {
        println("UserWebSocketMessageHandler: Connection closed for user $userId")
        val subscription = portSubscriptions.remove(session.id)
        subscription?.let {
            it.isActive = false
            it.channel.close()
        }
    }

    override suspend fun onError(session: WebSocketSession, userId: String, error: Throwable) {
        println("UserWebSocketMessageHandler: Error for user $userId - ${error.message}")
        val subscription = portSubscriptions.remove(session.id)
        subscription?.let {
            it.isActive = false
            it.channel.close()
        }
    }
}
