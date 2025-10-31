package com.plugin.features.user

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.infrastructure.websocket.WebSocketMessage
import com.plugin.infrastructure.websocket.WebSocketMessageHandler
import com.plugin.infrastructure.websocket.WebSocketMessageType
import com.plugin.infrastructure.websocket.WebSocketResponse
import io.quarkus.logging.Log
import io.quarkus.websockets.next.WebSocketConnection
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch

/**
 * Handler for user-related WebSocket messages
 *
 * This handler manages port subscription/broadcasting functionality, migrating from the SSE-based approach to
 * WebSocket.
 *
 * Migrated to Quarkus WebSocket Next API with thread-safe subscription management.
 */
@ApplicationScoped
class UserMessageHandler
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val userService: UserService,
) : WebSocketMessageHandler {

    // Store active port subscriptions per connection (thread-safe)
    private val portSubscriptions = ConcurrentHashMap<String, PortSubscription>()

    data class PortSubscription(val channel: Channel<PortState>, val userId: String, var isActive: Boolean = true)

    override fun getMessageTypePrefix(): String = "user:"

    override suspend fun handleMessage(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse? {
        return when (message.type) {
            WebSocketMessageType.USER_SUBSCRIBE_PORTS -> handleSubscribePorts(message, connection, userId)
            WebSocketMessageType.USER_UNSUBSCRIBE_PORTS -> handleUnsubscribePorts(message, connection, userId)
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
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse {
        return try {
            // Check if already subscribed
            if (portSubscriptions.containsKey(connection.id())) {
                Log.debug("Connection ${connection.id()} already subscribed to port updates")
                return WebSocketResponse(
                    type = WebSocketMessageType.USER_SUBSCRIBE_PORTS,
                    payload = mapOf("status" to "already_subscribed"),
                    requestId = message.requestId
                )
            }

            // Get the current port state and send it immediately
            val currentPort = userService.getCurrentPort(userId)
            currentPort?.let { sendPortUpdate(connection, it, message.requestId) }

            // Create subscription channel
            val channel = Channel<PortState>(Channel.UNLIMITED)
            portSubscriptions[connection.id()] = PortSubscription(channel, userId)

            val currentUserPort = userService.getCurrentPort(userId)

            // Subscribe to Redis pub/sub (using coroutine for async operation)
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    currentUserPort?.let { sendPortUpdate(connection, it, message.requestId) }
                    val subscriber =
                        userService.portConfigPubSub
                            .subscribe(userService.companionAppKeyPrefix + userId) { portState ->
                                channel.trySend(portState)
                            }
                            .awaitSuspending()

                    // Listen for updates and send them to the client
                    for (update in channel) {
                        val subscription = portSubscriptions[connection.id()]
                        if (subscription?.isActive == true) {
                            sendPortUpdate(connection, update)
                        } else {
                            break
                        }
                    }

                    // Unsubscribe from Redis when done
                    subscriber.unsubscribe().awaitSuspending()
                } catch (e: Exception) {
                    Log.error("Error processing port updates for connection ${connection.id()}", e)
                } finally {
                    channel.close()
                    portSubscriptions.remove(connection.id())
                }
            }

            Log.info("User $userId subscribed to port updates on connection ${connection.id()}")

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
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse {
        return try {
            val subscription = portSubscriptions.remove(connection.id())
            if (subscription != null) {
                subscription.isActive = false
                subscription.channel.close()
                Log.info("User $userId unsubscribed from port updates on connection ${connection.id()}")

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

    private fun sendPortUpdate(connection: WebSocketConnection, portState: PortState, requestId: String? = null) {
        try {
            if (connection.isOpen) {
                val response =
                    WebSocketResponse(
                        type = WebSocketMessageType.USER_PORT_UPDATE,
                        payload = mapOf("port" to portState.port),
                        requestId = requestId
                    )
                // Use sendTextAndAwait for async sending
                connection.sendTextAndAwait(objectMapper.writeValueAsString(response))
            }
        } catch (e: Exception) {
            Log.error("Error sending port update to connection ${connection.id()}", e)
        }
    }

    override suspend fun onClose(connection: WebSocketConnection, userId: String) {
        Log.debug("UserMessageHandler: Connection closed for user $userId")
        // Clean up subscription
        val subscription = portSubscriptions.remove(connection.id())
        subscription?.let {
            it.isActive = false
            it.channel.close()
        }
    }

    override suspend fun onError(connection: WebSocketConnection, userId: String, error: Throwable) {
        Log.error("UserMessageHandler: Error for user $userId", error)
        // Clean up subscription
        val subscription = portSubscriptions.remove(connection.id())
        subscription?.let {
            it.isActive = false
            it.channel.close()
        }
    }
}
