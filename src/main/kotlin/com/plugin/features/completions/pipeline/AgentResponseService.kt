package com.plugin.features.completions.pipeline

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.features.completions.FrameNode
import com.plugin.features.completions.frameNodeJsonSchema
import dev.langchain4j.data.message.SystemMessage
import dev.langchain4j.data.message.UserMessage
import dev.langchain4j.model.chat.request.ChatRequest
import dev.langchain4j.model.openai.OpenAiChatModel
import io.quarkus.logging.Log
import jakarta.enterprise.context.ApplicationScoped
import org.eclipse.microprofile.config.inject.ConfigProperty

/** Data class for agent input containing transcribed text and cursor context */
data class AgentInput(val transcribedText: String, val cursorContext: String? = null, val drawnPath: String? = null)

/** Data class for agent output */
data class AgentOutput(val response: FrameNode)

/**
 * Agent response generation service using LangChain4j
 *
 * This service generates AI responses based on transcribed audio and user cursor context.
 */
@ApplicationScoped
class AgentResponseService(private val objectMapper: ObjectMapper) {

    @ConfigProperty(name = "openai.api.key") private lateinit var apiKey: String

    @ConfigProperty(name = "openai.api.base-url") private lateinit var baseUrl: String

    @ConfigProperty(name = "agent.model.name", defaultValue = "gpt-4o-mini") private lateinit var modelName: String

    /**
     * Generate AI response based on transcribed text and cursor context
     *
     * @param transcribedText The text transcribed from audio
     * @param cursorContext Optional user cursor context
     * @param drawnPath Optional drawn path from user
     * @return Generated FrameNode response
     */
    suspend fun generateResponse(
        transcribedText: String,
        cursorContext: String? = null,
        drawnPath: String? = null
    ): FrameNode {
        Log.info("Generating AI response for transcription: ${transcribedText.take(100)}...")

        // Build the prompt with transcription and context
        val prompt = buildPrompt(transcribedText, cursorContext, drawnPath)

        val model: OpenAiChatModel =
            OpenAiChatModel.builder().baseUrl(baseUrl).apiKey(apiKey).modelName(modelName).build()

        val systemMessage =
            SystemMessage(
                "You are a helpful AI assistant that creates Figma design components based on voice commands. " +
                    "Respond with valid FrameNode JSON structures that represent the requested design elements."
            )
        val userMessage = UserMessage(prompt)
        val messages = listOf(systemMessage, userMessage)

        val chatRequest: ChatRequest =
            ChatRequest.builder().messages(messages).responseFormat(frameNodeJsonSchema).build()

        val response = model.chat(chatRequest).aiMessage().text()
        Log.debug("Raw AI response: $response")

        val parsedResponse: FrameNode = objectMapper.readValue(response, FrameNode::class.java)
        Log.info("AI response generated successfully: ${parsedResponse.id}")

        return parsedResponse
    }

    /** Build a comprehensive prompt from transcribed text and context */
    private fun buildPrompt(transcribedText: String, cursorContext: String?, drawnPath: String?): String {
        val promptBuilder = StringBuilder()

        promptBuilder.append("User voice command: \"$transcribedText\"\n\n")

        if (cursorContext != null) {
            promptBuilder.append("Cursor context: $cursorContext\n\n")
        }

        if (drawnPath != null) {
            promptBuilder.append("Drawn path: $drawnPath\n\n")
        }

        promptBuilder.append(
            "Please create a Figma FrameNode based on this voice command. " +
                "Consider the drawn path and cursor context if provided."
        )

        return promptBuilder.toString()
    }
}

/**
 * Pipeline step for agent response generation
 *
 * This step generates AI responses based on transcribed audio text.
 */
@ApplicationScoped
class AgentResponseStep(private val agentResponseService: AgentResponseService) :
    PipelineStep<AgentInput, AgentOutput> {

    override suspend fun execute(input: AgentInput, context: PipelineContext): AgentOutput {
        Log.info("Pipeline step: ${getName()}")

        val response =
            agentResponseService.generateResponse(input.transcribedText, input.cursorContext, input.drawnPath)

        context.put("agentResponse", response)
        return AgentOutput(response)
    }

    override fun getName(): String = "AgentResponseGeneration"
}
