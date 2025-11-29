package com.plugin.features.completions

import dev.langchain4j.reactor.*
import dev.langchain4j.service.SystemMessage
import dev.langchain4j.service.UserMessage
import dev.langchain4j.service.V
import dev.langchain4j.service.spring.AiService
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.reactive.asFlow
import org.springframework.stereotype.Service
import reactor.core.publisher.Flux

/**
 * High-level AI Service interface for generating Figma design components from voice commands
 *
 * This uses LangChain4j Spring Boot integration with declarative AI service pattern. Streaming is enabled via
 * Flux<String> return type.
 */
@AiService
interface FigmaDesignAssistant {
    @SystemMessage(
        "You are a Figma design assistant. Help users create and modify designs based on voice commands. Provide concise, actionable responses to help the user accomplish their design goal. If they're asking to create something, suggest specific design actions. Keep your response brief and focused."
    )
    @UserMessage("User's voice command: {{transcribedText}}")
    fun generateDesignStreaming(@V("transcribedText") transcribedText: String): Flux<String>
}

@Service
class FigmaDesignAiService(
    private val transcriptionService: FireworksTranscriptionService,
    private val figmaDesignAssistant: FigmaDesignAssistant,
) {

    /** Transcribe the provided audio file and return an AI-generated streaming response. */
    suspend fun streamDesignFromAudio(input: AgentPipelineInput): Flow<String> {
        println("Starting AI pipeline (RSocket) for audio file: ${input.audioFile.name}")

        // Step 1: Transcribe audio using Fireworks AI (suspending)
        val transcribedText = transcriptionService.transcribe(input.audioFile)

        if (transcribedText.isBlank()) {
            println("No transcription available")
            return emptyFlow()
        }

        println("Transcription completed: ${transcribedText.take(100)}...")
        // Step 2: Generate streaming response using LangChain4j AI service
        return figmaDesignAssistant.generateDesignStreaming(transcribedText).asFlow()
    }
}
