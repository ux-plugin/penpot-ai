package com.plugin.features.completions

import com.openai.client.OpenAIClient
import com.openai.client.okhttp.OpenAIOkHttpClient
import com.openai.models.ChatModel
import com.openai.models.chat.completions.ChatCompletionCreateParams
import com.openai.models.chat.completions.StructuredChatCompletion
import com.openai.models.chat.completions.StructuredChatCompletionCreateParams
import io.smallrye.mutiny.Uni
import jakarta.annotation.Priority
import jakarta.enterprise.context.ApplicationScoped
import jakarta.enterprise.inject.Alternative
import jakarta.ws.rs.ProcessingException
import jakarta.ws.rs.WebApplicationException
import org.eclipse.microprofile.config.inject.ConfigProperty

/**
 * Repository for interacting with the AI server
 * This implementation uses Java's HttpClient to make requests to the AI server
 */
@ApplicationScoped
@Alternative
@Priority(2)
class OpenAiServerRepository : IAiServerRepository {
    @ConfigProperty(name = "openai.api.key")
    private lateinit var openaiApiKey: String

    @ConfigProperty(name = "openai.project.id")
    private lateinit var openaiProjectId: String

    @ConfigProperty(name = "openai.org.id")
    private lateinit var openaiOrgId: String

    /**
     * Create a completion by sending a prompt to the AI server
     * @param prompt The prompt to send to the AI server
     * @return The generated FrameNode
     * @throws WebApplicationException if the AI server returns an error
     * @throws ProcessingException if there's an error communicating with the AI server
     */

    override fun createCompletion(prompt: String): Uni<FrameNode> {
        val client: OpenAIClient =
            OpenAIOkHttpClient.builder()
                .apiKey(openaiApiKey)
                .project(openaiProjectId)
                .organization(openaiOrgId)
                .build()

        val params: StructuredChatCompletionCreateParams<FrameNode> = ChatCompletionCreateParams.builder()
            .addUserMessage(prompt)
            .model(ChatModel.GPT_4O_MINI)
            .responseFormat(FrameNode::class.java)
            .build()
        val chatCompletion: StructuredChatCompletion<FrameNode> = client.chat().completions().create(params)

        return Uni.createFrom().item(chatCompletion.choices().first().message().content().orElse(FrameNode("")))
    }
}
