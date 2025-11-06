package com.plugin.infrastructure.websocket

/**
 * Base class for all WebSocket messages
 *
 * @property type The message type (namespaced: "completions:*", "user:*")
 * @property payload The message payload (feature-specific data)
 * @property requestId Optional correlation ID for request-response pattern
 */
data class WebSocketMessage(val type: String, val payload: Map<String, Any?>, val requestId: String? = null)

/** WebSocket command types */
object WebSocketMessageType {
    // Auth namespace
    const val AUTH_REFRESH_TOKEN = "auth:refresh_token"

    // Completions namespace
    const val COMPLETIONS_REQUEST = "completions:request"
    const val COMPLETIONS_REQUEST_END = "completions:request_end"
    const val COMPLETIONS_RESPONSE = "completions:response"
    const val COMPLETIONS_RESPONSE_END = "completions:response_end"

    // User namespace
    const val USER_SUBSCRIBE_PORTS = "user:subscribe_ports"
    const val USER_UNSUBSCRIBE_PORTS = "user:unsubscribe_ports"
    const val USER_PORT_UPDATE = "user:port_update"
}

/** Response wrapper for WebSocket messages */
data class WebSocketResponse(
    val type: String,
    val payload: Map<String, Any?>,
    val requestId: String? = null,
    val error: String? = null
)

/** Error response for WebSocket */
data class WebSocketError(val message: String, val code: String? = null, val requestId: String? = null)
