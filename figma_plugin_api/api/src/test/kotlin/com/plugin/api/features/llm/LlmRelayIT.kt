package com.plugin.api.features.llm

import com.fasterxml.jackson.databind.ObjectMapper
import dev.langchain4j.data.message.AiMessage
import dev.langchain4j.model.chat.StreamingChatModel
import dev.langchain4j.model.chat.request.ChatRequest
import dev.langchain4j.model.chat.response.ChatResponse
import dev.langchain4j.model.chat.response.StreamingChatResponseHandler
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Integration test for the Build-mode LLM relay. Wires the REAL [LlmController] + [LlmService]
 * + Jackson and exercises the full controller → callbackFlow bridge → OpenAI SSE serialization
 * path. The only stub is the genuine external boundary — the provider [StreamingChatModel] —
 * which would otherwise make a real network call. No DB/Redis/keys needed.
 */
class LlmRelayIT {
    private val mapper = ObjectMapper()

    /** Fake provider: drives the handler imperatively with the given script, then completes. */
    private fun model(emit: (StreamingChatResponseHandler) -> Unit): StreamingChatModel =
        object : StreamingChatModel {
            override fun chat(chatRequest: ChatRequest, handler: StreamingChatResponseHandler) {
                emit(handler)
            }
        }

    private fun controllerFor(model: StreamingChatModel) = LlmController(LlmService(model), mapper)

    private fun request(text: String) =
        ChatCompletionRequest(messages = listOf(ChatMessageDto(role = "user", content = text)))

    @Test
    fun `streams OpenAI-shaped chunks, a stop, then the DONE sentinel`() {
        runBlocking {
            val controller = controllerFor(
                model { h ->
                    h.onPartialResponse("Hello")
                    h.onPartialResponse(" world")
                    h.onCompleteResponse(ChatResponse.builder().aiMessage(AiMessage.from("Hello world")).build())
                },
            )

            val datas = controller.chatCompletions(request("hi")).toList().mapNotNull { it.data() }

            // terminates with the OpenAI [DONE] sentinel
            assertThat(datas.last()).isEqualTo("[DONE]")

            val chunks = datas.dropLast(1).map { mapper.readTree(it) }
            // every data chunk is an OpenAI chat.completion.chunk
            assertThat(chunks).allSatisfy { assertThat(it["object"].asText()).isEqualTo("chat.completion.chunk") }
            // streamed deltas reconstruct the model output
            val content = chunks.mapNotNull { it["choices"][0]["delta"]["content"]?.asText() }.joinToString("")
            assertThat(content).isEqualTo("Hello world")
            // exactly one terminal chunk carries finish_reason = stop
            val stops = chunks.count { it["choices"][0]["finish_reason"]?.asText() == "stop" }
            assertThat(stops).isEqualTo(1)
        }
    }

    @Test
    fun `surfaces a provider error in-band, then still closes with DONE`() {
        runBlocking {
            val controller = controllerFor(model { h -> h.onError(RuntimeException("boom")) })

            val datas = controller.chatCompletions(request("hi")).toList().mapNotNull { it.data() }

            assertThat(datas.last()).isEqualTo("[DONE]")
            assertThat(datas.any { it.contains("[error]") && it.contains("boom") }).isTrue()
        }
    }
}
