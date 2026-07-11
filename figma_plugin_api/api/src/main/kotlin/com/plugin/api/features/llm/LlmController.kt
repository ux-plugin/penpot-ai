package com.plugin.api.features.llm

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.api.security.ApiKeyAuthentication
import dev.langchain4j.data.message.AiMessage
import dev.langchain4j.data.message.ChatMessage
import dev.langchain4j.data.message.SystemMessage
import dev.langchain4j.data.message.UserMessage
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.slf4j.LoggerFactory
import org.springframework.http.MediaType
import org.springframework.http.codec.ServerSentEvent
import org.springframework.security.core.context.ReactiveSecurityContextHolder
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController
import java.util.UUID

/**
 * OpenAI-compatible chat-completions endpoint — the web/platform path of the Build-mode chat.
 *
 * `POST /api/llm/v1/chat/completions` streams `text/event-stream` of OpenAI
 * `chat.completion.chunk` JSON, terminated by `data: [DONE]`.
 *
 * Auth (B3): the HTTP `SecurityConfig` requires an authenticated principal for the `/api/llm`
 * routes and accepts EITHER a user JWT or an API key. The caller id is resolved here for
 * metering/observability; per-user request-rate limiting is a follow-up (P4) — single
 * completion length is already bounded by the model bean's configured maxTokens.
 *
 * Returns a coroutine [Flow] (not a Flux); the LangChain4j → Flow bridge lives in [LlmService].
 */
@RestController
@RequestMapping("/api/llm")
class LlmController(
    private val service: LlmService,
    private val mapper: ObjectMapper,
) {
    private val log = LoggerFactory.getLogger(LlmController::class.java)

    @PostMapping("/v1/chat/completions", produces = [MediaType.TEXT_EVENT_STREAM_VALUE])
    fun chatCompletions(@RequestBody req: ChatCompletionRequest): Flow<ServerSentEvent<String>> {
        val messages = req.messages.map { it.toLangChain() }
        val id = "chatcmpl-${UUID.randomUUID()}"
        val created = System.currentTimeMillis() / 1000
        val model = req.model ?: "platform"

        fun event(delta: Delta, finishReason: String?): ServerSentEvent<String> {
            val payload = ChatCompletionChunk(
                id = id,
                created = created,
                model = model,
                choices = listOf(ChunkChoice(delta = delta, finishReason = finishReason)),
            )
            return ServerSentEvent.builder(mapper.writeValueAsString(payload)).build()
        }

        val done = ServerSentEvent.builder("[DONE]").build()

        return flow {
            val caller = currentCallerId()
            log.info("llm chat start caller={} model={} messages={}", caller, model, messages.size)
            emit(event(Delta(role = "assistant"), null)) // OpenAI-style opening chunk
            service.streamTokens(messages).collect { token ->
                emit(event(Delta(content = token), null))
            }
            emit(event(Delta(), "stop"))
        }.catch { e ->
            // surface provider/stream errors in-band, then still close cleanly with [DONE]
            log.warn("llm chat stream failed: {}", e.message)
            emit(event(Delta(content = "\n[error] ${e.message ?: "stream failed"}"), "stop"))
        }.onCompletion {
            emit(done)
        }
    }

    /** Authenticated caller id (API-key `userId` or JWT subject) for metering/observability. */
    private suspend fun currentCallerId(): String? =
        ReactiveSecurityContextHolder.getContext().awaitFirstOrNull()?.authentication?.let { auth ->
            when (auth) {
                is ApiKeyAuthentication -> auth.userId
                else -> auth.name
            }
        }
}

private fun ChatMessageDto.toLangChain(): ChatMessage = when (role.lowercase()) {
    "system" -> SystemMessage.from(content)
    "assistant" -> AiMessage.from(content)
    else -> UserMessage.from(content)
}
