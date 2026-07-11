package com.plugin.api.features.llm

import dev.langchain4j.data.message.ChatMessage
import dev.langchain4j.model.chat.StreamingChatModel
import dev.langchain4j.model.chat.request.ChatRequest
import dev.langchain4j.model.chat.response.ChatResponse
import dev.langchain4j.model.chat.response.StreamingChatResponseHandler
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/**
 * Generic streaming relay over the configured provider (OpenAI / Anthropic / Gemini via the
 * shared `figmaDesignStreamingChatModel` bean, platform key from `agent.figma-design.*`).
 *
 * It is intentionally dumb: it forwards the caller's messages and streams back raw assistant
 * text. No system prompt, no tools — the Build-mode prompt + `{reply, ir}` contract are owned
 * by the frontend. LangChain4j's callback-based [StreamingChatResponseHandler] is bridged into
 * a cold [Flow] with [callbackFlow] (same pattern as `CompletionsRSocketController`).
 */
@Service
class LlmService(
    @Qualifier("figmaDesignStreamingChatModel") private val streamingModel: StreamingChatModel,
) {
    /** Cold flow of assistant text tokens for [messages]. Errors propagate as flow failures. */
    fun streamTokens(messages: List<ChatMessage>): Flow<String> = callbackFlow {
        val request = ChatRequest.builder().messages(messages).build()
        streamingModel.chat(
            request,
            object : StreamingChatResponseHandler {
                override fun onPartialResponse(partialResponse: String) {
                    trySend(partialResponse)
                }

                override fun onCompleteResponse(completeResponse: ChatResponse) {
                    close()
                }

                override fun onError(error: Throwable) {
                    close(error)
                }
            },
        )
        // TokenStream has no cancel handle; the stream ends via close() above.
        awaitClose { }
    }
}
