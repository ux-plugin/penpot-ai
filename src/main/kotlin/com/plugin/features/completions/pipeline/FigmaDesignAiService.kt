package com.plugin.features.completions.pipeline

import dev.langchain4j.service.SystemMessage
import dev.langchain4j.service.UserMessage
import io.quarkiverse.langchain4j.RegisterAiService
import io.quarkiverse.langchain4j.runtime.aiservice.ChatEvent
import io.smallrye.mutiny.Multi

/**
 * AI Service for generating Figma design components from voice commands
 *
 * This service uses Quarkus LangChain4j with OpenAI to generate structured FrameNode responses based on user input.
 */
@RegisterAiService(
    modelName = "figma-design-ai",
)
interface FigmaDesignAiService {
    /**
     * Generate a Figma design component with streaming output
     *
     * This method streams tokens as they are generated, useful for real-time UI updates.
     *
     * @param transcribedText The voice command transcribed to text
     * @param cursorContext Optional cursor position context
     * @param drawnPath Optional path drawn by user
     * @return Multi stream of string chunks as they are generated
     */
    @SystemMessage("""You are a helpful AI assistant""")
    @UserMessage("""User voice command: "{transcribedText}"""")
    fun generateDesignStreaming(transcribedText: String): Multi<ChatEvent>
}
