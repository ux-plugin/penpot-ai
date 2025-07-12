package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import dev.langchain4j.data.message.UserMessage
import dev.langchain4j.model.chat.request.ChatRequest
import dev.langchain4j.model.openai.OpenAiChatModel
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Qualifier
import org.eclipse.microprofile.config.inject.ConfigProperty

@Qualifier
@Retention(AnnotationRetention.RUNTIME)
@Target(AnnotationTarget.FIELD, AnnotationTarget.FUNCTION, AnnotationTarget.CLASS)
annotation class LangChain4JServer

@LangChain4JServer
@ApplicationScoped
class LangChain4JRepository(
    private val objectMapper: ObjectMapper  // Inject the configured ObjectMapper
) : IAiServerRepository {

    @ConfigProperty(name = "openai.api.key")
    private lateinit var apiKey: String

    @ConfigProperty(name = "openai.api.base-url")
    private lateinit var baseUrl: String

    override fun createCompletion(prompt: String): Uni<FrameNode> {
        return Uni.createFrom().item {
            val model: OpenAiChatModel =
                OpenAiChatModel.builder().baseUrl(baseUrl).apiKey(apiKey).modelName("gpt-4o-mini").build()
            val userMessage = UserMessage(prompt)
            val messages = listOf(userMessage)
            val chatRequest: ChatRequest = ChatRequest.builder()
                .messages(messages)
                .responseFormat(frameNodeJsonSchema)
                .build()

            val response = model.chat(chatRequest).aiMessage().text()
            println(response)
            val parsedResponse: FrameNode = objectMapper.readValue(response, FrameNode::class.java)
            parsedResponse
        }
    }
}

