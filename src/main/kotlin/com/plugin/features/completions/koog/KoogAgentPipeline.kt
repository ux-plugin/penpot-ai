package com.plugin.features.completions.koog

import ai.koog.agents.core.agent.AIAgent
import ai.koog.agents.core.dsl.builder.forwardTo
import ai.koog.agents.core.dsl.builder.strategy
import ai.koog.agents.core.dsl.extension.nodeLLMRequestStreamingAndSendResults
import ai.koog.agents.features.eventHandler.feature.handleEvents
import ai.koog.prompt.executor.clients.openai.OpenAIModels
import ai.koog.prompt.executor.llms.all.simpleOpenAIExecutor
import ai.koog.prompt.message.Message
import ai.koog.prompt.message.RequestMetaInfo
import ai.koog.prompt.streaming.StreamFrame
import io.quarkus.logging.Log
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import java.io.File
import org.eclipse.microprofile.config.inject.ConfigProperty

/**
 * Callback interface for streaming response chunks This functional interface allows KoogAgentPipeline to stream
 * responses directly without creating new coroutine scopes or channels
 */
fun interface StreamCallback {
    suspend fun onChunk(chunk: String)
}

/**
 * Data class representing the input to the agent pipeline
 *
 * @param audioFile The complete recorded audio file to transcribe
 * @param cursorContext User cursor context (e.g., drawn path, position)
 */
data class AgentPipelineInput(val audioFile: File, val cursorContext: String?)

/**
 * Koog-based agent pipeline for processing audio and generating responses
 *
 * This service orchestrates a two-step pipeline: 1. Transcribe audio using Fireworks AI Whisper v3 Large 2. Generate
 * agent response based on transcription and cursor context
 *
 * The pipeline is designed to be modular and extensible for future enhancements.
 */
@ApplicationScoped
class KoogAgentPipeline {

    @Inject lateinit var transcriptionService: FireworksTranscriptionService

    @Inject @ConfigProperty(name = "koog.openai.api-key") lateinit var openaiApiKey: String

    @Inject @ConfigProperty(name = "koog.llm.model", defaultValue = "gpt-4o-mini") lateinit var llmModelName: String

    @Inject @ConfigProperty(name = "koog.llm.temperature", defaultValue = "0.7") lateinit var llmTemperature: String

    /**
     * Resolve the LLM model from configuration
     *
     * Maps the configured model name to the appropriate OpenAI model object. Currently supports GPT-4o and GPT-4o-mini.
     */
    private fun resolveLLMModel() =
        when (llmModelName.lowercase()) {
            "gpt-4o" -> OpenAIModels.Reasoning.O1
            "gpt-4o-mini",
            "default" -> OpenAIModels.CostOptimized.GPT4oMini
            else -> {
                Log.warn("Unknown model '$llmModelName', defaulting to gpt-4o-mini")
                OpenAIModels.CostOptimized.GPT4oMini
            }
        }

    /**
     * Execute the complete agent pipeline: transcription + LLM response
     *
     * @param input Pipeline input containing audio file and cursor context
     * @param onStreamChunk Callback to stream response chunks to (for WebSocket streaming)
     */
    suspend fun executePipeline(input: AgentPipelineInput, onStreamChunk: StreamCallback? = null) {
        Log.info("Starting Koog agent pipeline execution")

        try {
            // Step 1: Transcribe audio using Fireworks AI Whisper
            Log.info("Pipeline Step 1: Transcribing audio with Fireworks AI Whisper v3 Large")
            val transcribedText = transcriptionService.transcribeAudio(input.audioFile)
            Log.info("Transcription completed: ${transcribedText.take(100)}...")

            // Step 2: Generate response using Koog agent with LLM
            Log.info("Pipeline Step 2: Generating response with Koog agent")
            generateAgentResponse(transcribedText, input.cursorContext, onStreamChunk)

            Log.info("Koog agent pipeline execution completed successfully")
        } catch (e: Exception) {
            Log.error("Pipeline execution failed", e)
            onStreamChunk?.onChunk("ERROR: ${e.message}")
            throw e
        }
    }

    /**
     * Generate agent response based on transcribed text and cursor context
     *
     * This creates a Koog AI agent that processes the transcribed audio and context to generate intelligent responses.
     */
    private suspend fun generateAgentResponse(
        transcribedText: String,
        cursorContext: String?,
        onStreamChunk: StreamCallback?
    ) {
        val executor = simpleOpenAIExecutor(openaiApiKey)

        // Create a streaming strategy for response generation
        val streamingStrategy =
            strategy("audio_response_streaming") {
                val nodeStreaming by nodeLLMRequestStreamingAndSendResults()

                val mapInputToRequests by
                    node<String, List<Message.Request>> { userMessage ->
                        listOf(Message.User(content = userMessage, metaInfo = RequestMetaInfo.Empty))
                    }

                val applyRequestToSession by
                    node<List<Message.Request>, List<Message.Request>> { requests ->
                        llm.writeSession {
                            appendPrompt { requests.filterIsInstance<Message.User>().forEach { user(it.content) } }
                            requests
                        }
                    }

                edge(nodeStart forwardTo mapInputToRequests)
                edge(mapInputToRequests forwardTo applyRequestToSession)
                edge(applyRequestToSession forwardTo nodeStreaming)
                edge(
                    nodeStreaming forwardTo
                        nodeFinish onCondition
                        {
                            it.filterIsInstance<Message.Tool.Call>().isEmpty()
                        }
                )
            }

        // Create the Koog AI agent with system prompt and streaming configuration
        val agent =
            AIAgent(
                promptExecutor = executor,
                strategy = streamingStrategy,
                llmModel = resolveLLMModel(),
                systemPrompt = buildSystemPrompt(),
                temperature = llmTemperature.toDouble()
            ) {
                handleEvents {
                    onLLMStreamingFrameReceived { context ->
                        when (val frame = context.streamFrame) {
                            is StreamFrame.Append -> {
                                // Stream response chunks to WebSocket via callback
                                onStreamChunk?.onChunk(frame.text)
                                Log.debug("Streaming frame: ${frame.text}")
                            }
                            is StreamFrame.ToolCall -> {
                                // Handle tool call frame
                                Log.info(
                                    "Tool call received - ID: ${frame.id}, Name: ${frame.name}, Content: ${frame.content}"
                                )
                                // Optional: Stream tool call info to client
                                onStreamChunk?.onChunk("[Tool: ${frame.name}]")
                            }
                            is StreamFrame.End -> {
                                // Handle end of stream
                                Log.info("Stream ended - Reason: ${frame.finishReason}, MetaInfo: ${frame.metaInfo}")
                                // Optional: Notify client of completion
                                onStreamChunk?.onChunk("[DONE]")
                            }
                        }
                    }
                    onLLMStreamingCompleted { Log.info("LLM streaming completed") }
                    onLLMStreamingFailed { Log.error("LLM streaming failed: ${it.error}") }
                    onAgentExecutionFailed { context ->
                        Log.error("Agent execution failed: ${context.throwable.message}", context.throwable)
                    }
                }
            }

        // Build the user message from transcription and context
        val userMessage = buildUserMessage(transcribedText, cursorContext)

        // Execute the agent
        Log.info("Executing Koog agent with transcribed input")
        agent.run(userMessage)
    }

    /**
     * Build system prompt for the agent
     *
     * This defines the agent's role and capabilities for processing audio transcriptions and generating contextual
     * responses.
     */
    private fun buildSystemPrompt(): String {
        return """
            You are an intelligent AI assistant that helps users with their tasks based on audio input and visual context.
            
            You receive:
            1. Transcribed text from user's audio recording
            2. User's cursor context (e.g., drawing path, position on canvas)
            
            Your role is to:
            - Understand the user's intent from their speech
            - Consider the visual context provided (cursor position, drawn paths)
            - Generate helpful, contextual responses
            - Provide actionable suggestions when appropriate
            
            Be concise, helpful, and contextually aware. If the audio transcription is unclear or incomplete, 
            ask for clarification.
        """
            .trimIndent()
    }

    /**
     * Build user message combining transcription and cursor context
     *
     * @param transcribedText The transcribed audio text
     * @param cursorContext Optional cursor/drawing context
     * @return Formatted user message for the agent
     */
    private fun buildUserMessage(transcribedText: String, cursorContext: String?): String {
        val message = StringBuilder()
        message.append("User said: \"$transcribedText\"\n")

        if (!cursorContext.isNullOrBlank()) {
            message.append("\nVisual context: $cursorContext")
        }

        return message.toString()
    }
}
