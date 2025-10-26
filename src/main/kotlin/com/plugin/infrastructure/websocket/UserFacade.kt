package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.features.user.PortState
import com.plugin.features.user.UserService
import io.quarkus.logging.Log
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.websocket.Session
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * Facade for handling user-related WebSocket messages
 * 
 * This facade handles port subscription/broadcasting functionality,
 * migrating from the SSE-based approach to WebSocket.
 */
@ApplicationScoped
class UserFacade
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val userService: UserService,
) : WebSocketFacade {
    
    // Store active port subscriptions per session
    private val portSubscriptions = ConcurrentHashMap<String, PortSubscription>()
    
    data class PortSubscription(
        val channel: Channel<PortState>,
        val userId: String,
        var isActive: Boolean = true
    )
    
    override fun getMessageTypePrefix(): String = "user:"
    
    override suspend fun handleMessage(
        message: WebSocketMessage,
        session: Session,
        userId: String
    ): WebSocketResponse? {
        return when (message.type) {
            WebSocketMessageType.USER_SUBSCRIBE_PORTS -> handleSubscribePorts(message, session, userId)
            WebSocketMessageType.USER_UNSUBSCRIBE_PORTS -> handleUnsubscribePorts(message, session, userId)
            else -> {
                Log.warn("Unknown user message type: ${message.type}")
                WebSocketResponse(
                    type = "error",
                    payload = emptyMap(),
                    requestId = message.requestId,
                    error = "Unknown message type: ${message.type}"
                )
            }
        }
    }
    
    private suspend fun handleSubscribePorts(
        message: WebSocketMessage,
        session: Session,
        userId: String
    ): WebSocketResponse {
        return try {
            // Check if already subscribed
            if (portSubscriptions.containsKey(session.id)) {
                Log.debug("Session ${session.id} already subscribed to port updates")
                return WebSocketResponse(
                    type = WebSocketMessageType.USER_SUBSCRIBE_PORTS,
                    payload = mapOf("status" to "already_subscribed"),
                    requestId = message.requestId
                )
            }
            
            // Get current port state and send it immediately
            val currentPort = userService.getCurrentPort(userId)
            currentPort?.let {
                sendPortUpdate(session, it, message.requestId)
            }
            
            // Create subscription channel
            val channel = Channel<PortState>(Channel.UNLIMITED)
            portSubscriptions[session.id] = PortSubscription(channel, userId)
            
            // Subscribe to Redis pub/sub
            val subscriber = userService.portConfigPubSub
                .subscribe(userService.companionAppKeyPrefix + userId) { portState ->
                    channel.trySend(portState)
                }
                .awaitSuspending()
            
            // Start coroutine to listen for updates and send them to the client
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    for (update in channel) {
                        val subscription = portSubscriptions[session.id]
                        if (subscription?.isActive == true) {
                            sendPortUpdate(session, update)
                        } else {
                            break
                        }
                    }
                } catch (e: Exception) {
                    Log.error("Error processing port updates for session ${session.id}", e)
                } finally {
                    // Unsubscribe from Redis
                    try {
                        subscriber.unsubscribe().awaitSuspending()
                    } catch (e: Exception) {
                        Log.error("Error unsubscribing from Redis", e)
                    }
                    channel.close()
                    portSubscriptions.remove(session.id)
                }
            }
            
            Log.info("User $userId subscribed to port updates on session ${session.id}")
            
            WebSocketResponse(
                type = WebSocketMessageType.USER_SUBSCRIBE_PORTS,
                payload = mapOf("status" to "subscribed"),
                requestId = message.requestId
            )
        } catch (e: Exception) {
            Log.error("Error subscribing to port updates", e)
            WebSocketResponse(
                type = "error",
                payload = emptyMap(),
                requestId = message.requestId,
                error = e.message ?: "Failed to subscribe to port updates"
            )
        }
    }
    
    private suspend fun handleUnsubscribePorts(
        message: WebSocketMessage,
        session: Session,
        userId: String
    ): WebSocketResponse {
        return try {
            val subscription = portSubscriptions.remove(session.id)
            if (subscription != null) {
                subscription.isActive = false
                subscription.channel.close()
                Log.info("User $userId unsubscribed from port updates on session ${session.id}")
                
                WebSocketResponse(
                    type = WebSocketMessageType.USER_UNSUBSCRIBE_PORTS,
                    payload = mapOf("status" to "unsubscribed"),
                    requestId = message.requestId
                )
            } else {
                WebSocketResponse(
                    type = WebSocketMessageType.USER_UNSUBSCRIBE_PORTS,
                    payload = mapOf("status" to "not_subscribed"),
                    requestId = message.requestId
                )
            }
        } catch (e: Exception) {
            Log.error("Error unsubscribing from port updates", e)
            WebSocketResponse(
                type = "error",
                payload = emptyMap(),
                requestId = message.requestId,
                error = e.message ?: "Failed to unsubscribe from port updates"
            )
        }
    }
    
    private fun sendPortUpdate(session: Session, portState: PortState, requestId: String? = null) {
        try {
            if (session.isOpen) {
                val response = WebSocketResponse(
                    type = WebSocketMessageType.USER_PORT_UPDATE,
                    payload = mapOf(
                        "port" to portState.port
                    ),
                    requestId = requestId
                )
                session.asyncRemote.sendText(objectMapper.writeValueAsString(response))
            }
        } catch (e: Exception) {
            Log.error("Error sending port update to session ${session.id}", e)
        }
    }
    
    override suspend fun onClose(session: Session, userId: String) {
        Log.debug("UserFacade: Session closed for user $userId")
        // Clean up subscription
        val subscription = portSubscriptions.remove(session.id)
        subscription?.let {
            it.isActive = false
            it.channel.close()
        }
    }
    
    override suspend fun onError(session: Session, userId: String, error: Throwable) {
        Log.error("UserFacade: Error for user $userId", error)
        // Clean up subscription
        val subscription = portSubscriptions.remove(session.id)
        subscription?.let {
            it.isActive = false
            it.channel.close()
        }
    }
}
