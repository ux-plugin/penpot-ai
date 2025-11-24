package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.infrastructure.websocket.CompletionResponse
import com.plugin.infrastructure.websocket.CompletionResponseEnd
import com.plugin.infrastructure.websocket.CompletionResponseEndPayload
import com.plugin.infrastructure.websocket.CompletionResponsePayload
import dev.langchain4j.service.SystemMessage
import dev.langchain4j.service.UserMessage
import dev.langchain4j.service.V
import dev.langchain4j.service.spring.AiService
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.reactive.asFlow
import kotlinx.coroutines.reactive.awaitFirst
import org.springframework.stereotype.Service
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Flux
import reactor.core.publisher.Mono
import java.io.File

/**
 * High-level AI Service interface for generating Figma design components from voice commands
 * 
 * This uses LangChain4j Spring Boot integration with declarative AI service pattern.
 * Streaming is enabled via Flux<String> return type.
 */
@AiService
interface FigmaDesignAssistant {
    @SystemMessage("You are a Figma design assistant. Help users create and modify designs based on voice commands. Provide concise, actionable responses to help the user accomplish their design goal. If they're asking to create something, suggest specific design actions. Keep your response brief and focused.")
    @UserMessage("User's voice command: {{transcribedText}}")
    fun generateDesignStreaming(@V("transcribedText") transcribedText: String): Flux<String>
}

@Service
class FigmaDesignAiService(
    private val transcriptionService: FireworksTranscriptionService,
    private val figmaDesignAssistant: FigmaDesignAssistant,
    private val objectMapper: ObjectMapper
) {
    
    suspend fun executePipeline(
        input: AgentPipelineInput,
        session: WebSocketSession,
        requestId: String?
    ) {
        println("Starting AI pipeline execution for fe_id: ${input.feId}")
        
        try {
            // Step 1: Transcribe audio using Fireworks AI
            println("Pipeline Step 1: Transcribing audio with Fireworks AI")
            val transcribedText = transcriptionService.transcribe(input.audioFile)
            
            if (transcribedText.isBlank()) {
                println("No transcription available")
                sendCompletionResponse(session, input.feId, "Could not transcribe audio", requestId)
                sendCompletionEnd(session, input.feId, requestId)
                return
            }
            
            println("Transcription completed: ${transcribedText.take(100)}...")
            
            // Step 2: Generate streaming response using LangChain4j AI service
            println("Pipeline Step 2: Generating streaming response with LangChain4j")
            generateStreamingResponse(transcribedText, input.feId, session, requestId)
            
            // Send completion end signal
            sendCompletionEnd(session, input.feId, requestId)
            
            println("AI pipeline execution completed successfully")
        } catch (e: Exception) {
            println("Pipeline execution failed: ${e.message}")
            e.printStackTrace()
            sendCompletionResponse(session, input.feId, "ERROR: ${e.message}", requestId)
            sendCompletionEnd(session, input.feId, requestId)
        }
    }
    
    private suspend fun generateStreamingResponse(
        transcribedText: String,
        feId: String,
        session: WebSocketSession,
        requestId: String?
    ) {
        try {
            // Use streaming version with Flux
            figmaDesignAssistant.generateDesignStreaming(transcribedText)
                .asFlow()
                .collect { chunk ->
                    println("Streaming content chunk: ${chunk.take(50)}...")
                    sendCompletionResponse(session, feId, chunk, requestId)
                }
            
            println("LangChain4j streaming completed successfully")
        } catch (e: Exception) {
            println("LangChain4j execution failed: ${e.message}")
            throw e
        }
    }
    
    private suspend fun sendCompletionResponse(
        session: WebSocketSession,
        feId: String,
        text: String,
        requestId: String?
    ) {
        try {
            val response = CompletionResponse(
                payload = CompletionResponsePayload(fe_id = feId, text = text),
                requestId = requestId
            )
            val json = objectMapper.writeValueAsString(response)
            session.send(Mono.just(session.textMessage(json))).awaitFirst()
        } catch (e: Exception) {
            println("Failed to send completion response: ${e.message}")
        }
    }
    
    private suspend fun sendCompletionEnd(
        session: WebSocketSession,
        feId: String,
        requestId: String?
    ) {
        try {
            val endResponse = CompletionResponseEnd(
                payload = CompletionResponseEndPayload(fe_id = feId),
                requestId = requestId
            )
            val json = objectMapper.writeValueAsString(endResponse)
            session.send(Mono.just(session.textMessage(json))).awaitFirst()
        } catch (e: Exception) {
            println("Failed to send completion end: ${e.message}")
        }
    }
}
