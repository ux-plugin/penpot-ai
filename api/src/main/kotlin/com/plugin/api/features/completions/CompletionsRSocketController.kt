package com.plugin.api.features.completions

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.withContext
import org.springframework.messaging.handler.annotation.MessageMapping
import org.springframework.stereotype.Controller
import java.io.ByteArrayOutputStream
import java.util.*

data class CompletionStreamChunk(val drawnPath: String? = null, val audioChunkBase64: String, val timestamp: Long)

@Controller
class CompletionsRSocketController(private val ai: FigmaDesignAiService, private val audioFileStrategy: AudioFileStrategy) {
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

        // Stream results using TokenStream callbacks with callbackFlow for proper async bridging
        return callbackFlow {
            val tokenStream = ai.streamDesignFromAudio(input)

            tokenStream
                .onPartialResponse { partialResponse ->
                    trySend(CompletionStreamEvent(text = partialResponse))
                }.onPartialThinking { reasoning ->
                    trySend(CompletionStreamEvent(reasoning = reasoning.text()))
                }.beforeToolExecution { toolExecution ->
                    val toolRequest = toolExecution.request()
                    trySend(
                        CompletionStreamEvent(
                            action =
                            CompletionAction(
                                action = toolRequest.name(),
                                target = toolRequest.id(),
                                params = toolRequest.arguments(),
                            ),
                        ),
                    )
                }.onError { error ->
                    // Propagate the error and close the flow
                    close(error)
                }.onCompleteResponse { response ->
                    // Successfully complete the flow
                    close()
                }.start()

            // TokenStream doesn't provide a cancel method, so cleanup is minimal
            awaitClose {
                // The stream will naturally stop when the flow is cancelled
            }
        }.onCompletion {
            if (audioFileStrategy.shouldCleanup()) {
                withContext(Dispatchers.IO) {
                    try {
                        input.audioFile.delete()
                    } catch (_: Exception) {
                    }
                }
            }
        }
    }
}
