package com.plugin.api.features.completions

import dev.langchain4j.service.SystemMessage
import dev.langchain4j.service.TokenStream
import dev.langchain4j.service.UserMessage
import dev.langchain4j.service.V
import dev.langchain4j.service.spring.AiService
import org.springframework.stereotype.Service

/**
 * High-level AI Service interface for generating Figma design components from voice commands
 *
 * This uses LangChain4j Spring Boot integration with declarative AI service pattern. Streaming is enabled via
 * Flux<String> return type.
 */
@AiService(
    chatModel = "figmaDesignChatModel",
    streamingChatModel = "figmaDesignStreamingChatModel",
)
interface FigmaDesignAssistant {
    @SystemMessage(
        "You are a Figma design assistant. Help users create and modify designs based on voice commands." +
            "Provide concise, actionable responses to help the user accomplish their design goal. If they're asking" +
            "to create something, suggest specific design actions. Keep your response brief and focused.",
    )
    @UserMessage("User's voice command: {{transcribedText}}")
    fun generateDesignStreaming(@V("transcribedText") transcribedText: String): TokenStream
}

@Service
class FigmaDesignAiService(
    private val transcriptionService: FireworksTranscriptionService,
    private val figmaDesignAssistant: FigmaDesignAssistant,
) {
    /** Transcribe the provided audio file and return an AI-generated streaming response. */
    suspend fun streamDesignFromAudio(input: AgentPipelineInput): TokenStream {
        println("Starting AI pipeline (RSocket) for audio file: ${input.audioFile.name}")

        // Step 1: Transcribe audio using Fireworks AI (suspending)
        val transcribedText = transcriptionService.transcribe(input.audioFile)

        if (transcribedText.isBlank()) {
            println("No transcription available")
            throw IllegalStateException("Transcription returned empty text")
        }

        println("Transcription completed: ${transcribedText.take(100)}...")
        // Step 2: Generate a streaming response using LangChain4j AI service
        return figmaDesignAssistant.generateDesignStreaming(transcribedText)
    }
}
