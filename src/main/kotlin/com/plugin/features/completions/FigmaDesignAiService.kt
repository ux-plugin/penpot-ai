package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.infrastructure.websocket.CompletionResponse
import com.plugin.infrastructure.websocket.CompletionResponseEnd
import com.plugin.infrastructure.websocket.CompletionResponseEndPayload
import com.plugin.infrastructure.websocket.CompletionResponsePayload
import dev.langchain4j.model.chat.ChatLanguageModel
import dev.langchain4j.model.openai.OpenAiChatModel
import kotlinx.coroutines.reactive.awaitFirst
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Mono
import java.io.File

@Service
class FigmaDesignAiService(
    private val transcriptionService: FireworksTranscriptionService,
    private val objectMapper: ObjectMapper,
    @Value("\${openai.api-key}") private val openAiApiKey: String
) {
    
    private val chatModel: ChatLanguageModel by lazy {
        OpenAiChatModel.builder()
            .apiKey(openAiApiKey)
            .modelName("gpt-4")
            .temperature(0.7)
            .build()
    }
    
    suspend fun executePipeline(
        input: AgentPipelineInput,
        session: WebSocketSession,
        requestId: String?
    ) {
        try {
            // Step 1: Transcribe audio
            println("Transcribing audio for FE ID: ${input.feId}")
            val transcription = transcriptionService.transcribe(input.audioFile)
            
            if (transcription.isBlank()) {
                println("No transcription available")
                sendCompletionResponse(
                    session,
                    input.feId,
                    text = "Could not transcribe audio",
                    requestId
                )
                sendCompletionEnd(session, input.feId, requestId)
                return
            }
            
            println("Transcription: $transcription")
            
            // Step 2: Build context with cursor information
            val contextPrompt = buildContextPrompt(transcription, input.cursorContext)
            
            // Step 3: Get design suggestion from LLM
            println("Getting design suggestion from LLM")
            val responseText = chatModel.generate(contextPrompt)
            
            // Step 4: Send response  
            println("LLM Response: $responseText")
            
            sendCompletionResponse(
                session,
                input.feId,
                text = responseText,
                requestId
            )
            
            // Send completion end signal
            sendCompletionEnd(session, input.feId, requestId)
            
        } catch (e: Exception) {
            println("Error in AI pipeline: ${e.message}")
            e.printStackTrace()
            sendCompletionResponse(
                session,
                input.feId,
                text = "Error processing request: ${e.message}",
                requestId
            )
            sendCompletionEnd(session, input.feId, requestId)
        }
    }
    
    private fun buildContextPrompt(transcription: String, cursorContext: String?): String {
        return buildString {
            appendLine("You are a Figma design assistant. Help users create and modify designs based on voice commands.")
            appendLine()
            appendLine("User's voice command: $transcription")
            
            if (!cursorContext.isNullOrBlank()) {
                appendLine()
                appendLine("Current cursor context: $cursorContext")
            }
            
            appendLine()
            appendLine("Provide a concise, actionable response to help the user accomplish their design goal.")
            appendLine("If they're asking to create something, suggest specific design actions.")
            appendLine("Keep your response brief and focused.")
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
                payload = CompletionResponsePayload(
                    fe_id = feId,
                    text = text
                ),
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
