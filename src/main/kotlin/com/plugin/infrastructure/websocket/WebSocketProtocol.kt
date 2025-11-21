package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.annotation.JsonSubTypes
import com.fasterxml.jackson.annotation.JsonTypeInfo
import com.fasterxml.jackson.annotation.JsonTypeName

/** WebSocket command types */
object WebSocketMessageType {
    // Auth namespace
    const val AUTH_REFRESH_TOKEN = "auth:refresh_token"
    const val AUTH_REFRESH_TOKEN_RESPONSE = "auth:refresh_token_response"

    // Completions namespace
    const val COMPLETIONS_REQUEST = "completions:request"
    const val COMPLETIONS_REQUEST_END = "completions:request_end"
    const val COMPLETIONS_RESPONSE = "completions:response"
    const val COMPLETIONS_RESPONSE_END = "completions:response_end"

    // User namespace
    const val USER_SUBSCRIBE_PORTS = "user:subscribe_ports"
    const val USER_SUBSCRIBE_PORTS_RESPONSE = "user:subscribe_ports_response"
    const val USER_UNSUBSCRIBE_PORTS = "user:unsubscribe_ports"
    const val USER_UNSUBSCRIBE_PORTS_RESPONSE = "user:unsubscribe_ports_response"
    const val USER_PORT_UPDATE = "user:port_update"
}

/** Error response for WebSocket */
data class WebSocketError(val code: Int, val message: String)

/** Base interface for all WebSocket messages */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes(
    JsonSubTypes.Type(value = AuthRefreshTokenRequest::class, name = WebSocketMessageType.AUTH_REFRESH_TOKEN),
    JsonSubTypes.Type(value = AuthRefreshTokenResponse::class, name = WebSocketMessageType.AUTH_REFRESH_TOKEN_RESPONSE),
    JsonSubTypes.Type(value = CompletionRequest::class, name = WebSocketMessageType.COMPLETIONS_REQUEST),
    JsonSubTypes.Type(value = CompletionRequestEnd::class, name = WebSocketMessageType.COMPLETIONS_REQUEST_END),
    JsonSubTypes.Type(value = CompletionResponse::class, name = WebSocketMessageType.COMPLETIONS_RESPONSE),
    JsonSubTypes.Type(value = CompletionResponseEnd::class, name = WebSocketMessageType.COMPLETIONS_RESPONSE_END),
    JsonSubTypes.Type(value = UserSubscribePortsRequest::class, name = WebSocketMessageType.USER_SUBSCRIBE_PORTS),
    JsonSubTypes.Type(
        value = UserSubscribePortsResponse::class,
        name = WebSocketMessageType.USER_SUBSCRIBE_PORTS_RESPONSE
    ),
    JsonSubTypes.Type(value = UserUnsubscribePortsRequest::class, name = WebSocketMessageType.USER_UNSUBSCRIBE_PORTS),
    JsonSubTypes.Type(
        value = UserUnsubscribePortsResponse::class,
        name = WebSocketMessageType.USER_UNSUBSCRIBE_PORTS_RESPONSE
    ),
    JsonSubTypes.Type(value = UserPortUpdate::class, name = WebSocketMessageType.USER_PORT_UPDATE)
)
interface WebSocketMessage {
    val requestId: String?
    val error: WebSocketError?
}

// ============================================================================
// AUTH MESSAGES
// ============================================================================

/** Auth: Refresh Token Payload */
data class AuthRefreshTokenPayload(val access_token: String)

@JsonTypeName(WebSocketMessageType.AUTH_REFRESH_TOKEN)
data class AuthRefreshTokenRequest(
    val payload: AuthRefreshTokenPayload,
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

/** Auth: Refresh Token Response Payload */
data class AuthRefreshTokenResponsePayload(val status: String)

@JsonTypeName(WebSocketMessageType.AUTH_REFRESH_TOKEN_RESPONSE)
data class AuthRefreshTokenResponse(
    val payload: AuthRefreshTokenResponsePayload,
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

// ============================================================================
// COMPLETIONS MESSAGES
// ============================================================================

/** Completions: Request Payload */
data class CompletionRequestPayload(
    val fe_id: String,
    val drawn_path: String,
    val audio_chunk: String,
    val timestamp: Long
)

@JsonTypeName(WebSocketMessageType.COMPLETIONS_REQUEST)
data class CompletionRequest(
    val payload: CompletionRequestPayload,
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

/** Completions: Request End Payload */
data class CompletionRequestEndPayload(val fe_id: String)

@JsonTypeName(WebSocketMessageType.COMPLETIONS_REQUEST_END)
data class CompletionRequestEnd(
    val payload: CompletionRequestEndPayload,
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

/** Completions: Action details */
data class CompletionAction(val action: String, val target: String, val params: String)

/** Completions: Response Payload */
data class CompletionResponsePayload(
    val fe_id: String,
    val action: CompletionAction? = null,
    val reasoning: String? = null,
    val text: String? = null
)

@JsonTypeName(WebSocketMessageType.COMPLETIONS_RESPONSE)
data class CompletionResponse(
    val payload: CompletionResponsePayload,
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

/** Completions: Response End Payload */
data class CompletionResponseEndPayload(val fe_id: String)

@JsonTypeName(WebSocketMessageType.COMPLETIONS_RESPONSE_END)
data class CompletionResponseEnd(
    val payload: CompletionResponseEndPayload,
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

// ============================================================================
// USER MESSAGES
// ============================================================================

/** User: Empty Payload (for subscribe/unsubscribe operations) */
data class EmptyPayload(val dummy: Boolean = true)

@JsonTypeName(WebSocketMessageType.USER_SUBSCRIBE_PORTS)
data class UserSubscribePortsRequest(
    val payload: EmptyPayload = EmptyPayload(),
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

@JsonTypeName(WebSocketMessageType.USER_UNSUBSCRIBE_PORTS)
data class UserUnsubscribePortsRequest(
    val payload: EmptyPayload = EmptyPayload(),
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

/** User: Subscribe Ports Response Payload */
data class UserSubscribePortsResponsePayload(val status: String = "subscribed")

@JsonTypeName(WebSocketMessageType.USER_SUBSCRIBE_PORTS_RESPONSE)
data class UserSubscribePortsResponse(
    val payload: UserSubscribePortsResponsePayload = UserSubscribePortsResponsePayload(),
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

/** User: Unsubscribe Ports Response Payload */
data class UserUnsubscribePortsResponsePayload(val status: String = "unsubscribed")

@JsonTypeName(WebSocketMessageType.USER_UNSUBSCRIBE_PORTS_RESPONSE)
data class UserUnsubscribePortsResponse(
    val payload: UserUnsubscribePortsResponsePayload = UserUnsubscribePortsResponsePayload(),
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage

/** User: Port Update Payload */
data class UserPortUpdatePayload(val port: Int?)

@JsonTypeName(WebSocketMessageType.USER_PORT_UPDATE)
data class UserPortUpdate(
    val payload: UserPortUpdatePayload,
    override val requestId: String? = null,
    override val error: WebSocketError? = null
) : WebSocketMessage
