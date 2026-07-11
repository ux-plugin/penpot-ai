package com.plugin.api.features.llm

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty

/**
 * OpenAI-compatible chat-completions DTOs for the Build-mode LLM relay.
 *
 * The backend is a thin, normalized LLM *provider*: it accepts the OpenAI request shape and
 * streams OpenAI `chat.completion.chunk` events, so any OpenAI-compatible client (the Vercel
 * AI SDK on the frontend) works unchanged. The prompt/IR contract lives in the caller — this
 * relay bakes no system prompt.
 */

/** One conversation message in the request (`role` ∈ system | user | assistant). */
data class ChatMessageDto(
    val role: String = "user",
    val content: String = "",
)

/** OpenAI-shaped request body. `stream` is assumed true; non-stream is not offered. */
data class ChatCompletionRequest(
    val model: String? = null,
    val messages: List<ChatMessageDto> = emptyList(),
    val stream: Boolean = true,
    val temperature: Double? = null,
    @JsonProperty("max_tokens") val maxTokens: Int? = null,
)

/** Streamed delta — only the changed fields are present per chunk. */
@JsonInclude(JsonInclude.Include.NON_NULL)
data class Delta(
    val role: String? = null,
    val content: String? = null,
)

@JsonInclude(JsonInclude.Include.NON_NULL)
data class ChunkChoice(
    val index: Int = 0,
    val delta: Delta,
    // @get: so the rename applies to SERIALIZATION (constructor-param annotations only
    // affect deserialization; the getter drives the emitted JSON).
    @get:JsonProperty("finish_reason") val finishReason: String? = null,
)

/** One Server-Sent `data:` payload, serialized to the OpenAI streaming-chunk JSON. */
@JsonInclude(JsonInclude.Include.NON_NULL)
data class ChatCompletionChunk(
    val id: String,
    val `object`: String = "chat.completion.chunk",
    val created: Long,
    val model: String,
    val choices: List<ChunkChoice>,
)
