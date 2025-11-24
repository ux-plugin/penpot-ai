package com.plugin.features.completions.pipeline

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.features.completions.koog.FireworksTranscriptionService
import com.plugin.infrastructure.websocket.CompletionAction
import com.plugin.infrastructure.websocket.CompletionResponse
import com.plugin.infrastructure.websocket.CompletionResponsePayload
import io.quarkiverse.langchain4j.runtime.aiservice.ChatEvent
import io.quarkus.logging.Log
import io.quarkus.websockets.next.WebSocketConnection
import io.smallrye.mutiny.coroutines.asFlow
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import java.io.File
import kotlinx.coroutines.flow.collect

/**
 * Data class representing the input to the agent pipeline
 *
 * @param audioFile The complete recorded audio file to transcribe
 * @param cursorContext User cursor context (e.g., drawn path, position)
 * @param feId Frontend identifier for tracking the request
 */
data class AgentPipelineInput(val audioFile: File, val cursorContext: String?, val feId: String)

/**
 * LangChain4j-based agent pipeline for processing audio and generating responses
 *
 * This service orchestrates a two-step pipeline:
 * 1. Transcribe audio using Fireworks AI Whisper v3 Large
 * 2. Generate agent response based on transcription and cursor context using LangChain4j
 *
 * This implementation uses Quarkus LangChain4j's declarative approach for comparison with the imperative Koog-based
 * pipeline. It sends CompletionResponse messages directly to the WebSocket connection.
 */
@ApplicationScoped
class LangChain4jAgentPipeline {

    @Inject lateinit var transcriptionService: FireworksTranscriptionService

    @Inject lateinit var figmaDesignAiService: FigmaDesignAiService

    @Inject lateinit var objectMapper: ObjectMapper

    /**
     * Execute the complete agent pipeline: transcription + LLM response
     *
     * @param input Pipeline input containing audio file, cursor context, and feId
     * @param connection WebSocket connection to send streaming responses
     * @param requestId Optional request ID for tracking
     */
    suspend fun executePipeline(input: AgentPipelineInput, connection: WebSocketConnection, requestId: String? = null) {
        Log.info("Starting LangChain4j agent pipeline execution for fe_id: ${input.feId}")

        try {
            // Step 1: Transcribe audio using Fireworks AI Whisper
            Log.info("Pipeline Step 1: Transcribing audio with Fireworks AI Whisper v3 Large")
            val transcribedText = transcriptionService.transcribeAudio(input.audioFile)
            Log.info("Transcription completed: ${transcribedText.take(100)}...")

            // Step 2: Generate response using LangChain4j declarative AI service
            Log.info("Pipeline Step 2: Generating response with LangChain4j AI service")
            generateAgentResponse(transcribedText, input.cursorContext, input.feId, connection, requestId)

            Log.info("LangChain4j agent pipeline execution completed successfully")
        } catch (e: Exception) {
            Log.error("Pipeline execution failed", e)
            // Send error as CompletionResponse
            sendCompletionResponse(
                connection = connection,
                feId = input.feId,
                text = "ERROR: ${e.message}",
                requestId = requestId
            )
            throw e
        }
    }

    /**
     * Generate agent response based on transcribed text and cursor context
     *
     * This uses the declarative FigmaDesignAiService with streaming support via Kotlin Flow.
     */
    private suspend fun generateAgentResponse(
        transcribedText: String,
        cursorContext: String?,
        feId: String,
        connection: WebSocketConnection,
        requestId: String?
    ) {
        Log.info("Executing LangChain4j AI service with transcribed input")

        try {
            // Use streaming version with asFlow()
            figmaDesignAiService.generateDesignStreaming(transcribedText).asFlow().collect { event ->
                // Check ChatEvent type and send appropriate CompletionResponse
                when (event) {
                    is ChatEvent.PartialResponseEvent -> {
                        Log.debug("Streaming content chunk: ${event.chunk.take(50)}...")
                        sendCompletionResponse(
                            connection = connection,
                            feId = feId,
                            text = event.chunk,
                            requestId = requestId
                        )
                    }
                    is ChatEvent.PartialThinkingEvent -> {
                        sendCompletionResponse(
                            connection = connection,
                            feId = feId,
                            reasoning = event.text,
                            requestId = requestId
                        )
                    }
                    is ChatEvent.BeforeToolExecutionEvent -> {
                        Log.info("Tool execution: ${event.request}")
                    }
                    else -> {
                        Log.debug("Received ChatEvent with no content or tool execution")
                    }
                }
            }

            Log.info("LangChain4j streaming completed successfully")
        } catch (e: Exception) {
            Log.error("LangChain4j execution failed: ${e.message}", e)
            throw e
        }
    }

    /**
     * Send a CompletionResponse to the WebSocket connection
     *
     * @param connection WebSocket connection
     * @param feId Frontend identifier
     * @param action Optional action details
     * @param reasoning Optional reasoning text
     * @param text Optional text content
     * @param requestId Optional request ID
     */
    private suspend fun sendCompletionResponse(
        connection: WebSocketConnection,
        feId: String,
        action: CompletionAction? = null,
        reasoning: String? = null,
        text: String? = null,
        requestId: String? = null
    ) {
        val response =
            CompletionResponse(
                payload = CompletionResponsePayload(fe_id = feId, action = action, reasoning = reasoning, text = text),
                requestId = requestId
            )

        try {
            connection.sendText(objectMapper.writeValueAsString(response)).awaitSuspending()
        } catch (e: Exception) {
            Log.error("Failed to send CompletionResponse to WebSocket", e)
            throw e
        }
    }
}
