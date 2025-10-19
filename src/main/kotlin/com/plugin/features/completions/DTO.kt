package com.plugin.features.completions

import com.fasterxml.jackson.annotation.JsonSubTypes
import com.fasterxml.jackson.annotation.JsonTypeInfo
import java.time.Instant

data class PromptRequest(val prompt: String)

data class StreamingDataMessage(val timestamp: Long, val drawnPath: String, val audioChunk: String)

data class ComponentCompletionResponse(
    var id: String,
    var prompt: String,
    var aiCompletion: FrameNode,
    var createdAt: Instant,
)

data class CreationFailedResponse(val message: String = "Failed to create completion")

data class CompletionsLoadFailedResponse(val message: String = "Failed to load completions")

data class CompletionNotFoundResponse(val message: String = "Completion not found")

/** WebSocket command message types */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "event")
@JsonSubTypes(
    JsonSubTypes.Type(value = RefreshTokenCommand::class, name = "refresh_token"),
    JsonSubTypes.Type(value = CompletionRequestCommand::class, name = "completion_request"),
    JsonSubTypes.Type(value = CompletionRequestEndCommand::class, name = "completion_request_end"),
    JsonSubTypes.Type(value = CompletionResponseCommand::class, name = "completion_response"),
    JsonSubTypes.Type(value = CompletionResponseEndCommand::class, name = "completion_response_end"),
)
sealed class WebSocketCommand {
    abstract val event: String
}

data class RefreshTokenCommand(override val event: String = "refresh_token", val token: String) : WebSocketCommand()

data class CompletionRequestCommand(
    override val event: String = "completion_request",
    val fe_id: String,
    val drawn_path: String,
    val audio_chunk: String,
    val timestamp: Long,
) : WebSocketCommand()

data class CompletionRequestEndCommand(
    override val event: String = "completion_request_end",
    val fe_id: String,
) : WebSocketCommand()

data class CompletionResponseCommand(
    override val event: String = "completion_response",
    val fe_id: String,
    val action: String,
    val target: String,
    val params: String,
) : WebSocketCommand()

data class CompletionResponseEndCommand(
    override val event: String = "completion_response_end",
    val fe_id: String,
) : WebSocketCommand()
