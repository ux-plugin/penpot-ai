package com.plugin.features.completions

import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.withContext
import org.springframework.messaging.handler.annotation.MessageMapping
import org.springframework.stereotype.Controller

data class CompletionStreamChunk(val drawnPath: String? = null, val audioChunkBase64: String, val timestamp: Long)

data class CompletionStreamEvent(val text: String? = null, val done: Boolean = false)

@Controller
class CompletionsRSocketController(
    private val ai: FigmaDesignAiService,
    private val audioFileStrategy: AudioFileStrategy
) {

    /** Request-Channel: client streams audio chunks, server streams AI response text. Route: "completions.stream" */
    @MessageMapping("completions.stream")
    suspend fun stream(request: Flow<CompletionStreamChunk>): Flow<CompletionStreamEvent> {
        val audioBuffer = ByteArrayOutputStream()
        val drawn = StringBuilder()

        // Collect all chunks
        request.collect { chunk ->
            if (!chunk.drawnPath.isNullOrBlank()) {
                drawn.append(chunk.drawnPath).append(' ')
            }
            if (chunk.audioChunkBase64.isNotBlank()) {
                val bytes = Base64.getDecoder().decode(chunk.audioChunkBase64)
                audioBuffer.write(bytes)
            }
        }

        // Process audio on IO dispatcher
        val input =
            withContext(Dispatchers.IO) {
                val timestamp = System.currentTimeMillis()
                val file = audioFileStrategy.createAudioFile(audioBuffer.toByteArray(), timestamp)
                AgentPipelineInput(audioFile = file, cursorContext = drawn.toString().ifBlank { null })
            }

        // Stream results
        return flow {
                ai.streamDesignFromAudio(input).collect { chunk ->
                    emit(CompletionStreamEvent(text = chunk, done = false))
                }
                emit(CompletionStreamEvent(text = null, done = true))
            }
            .onCompletion {
                if (audioFileStrategy.shouldCleanup()) {
                    withContext(Dispatchers.IO) {
                        try {
                            input.audioFile.delete()
                        } catch (_: Exception) {}
                    }
                }
            }
    }
}
