package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.features.completions.pipeline.AudioAgentPipelineOrchestrator
import com.plugin.infrastructure.websocket.WebSocketMessage
import com.plugin.infrastructure.websocket.WebSocketMessageHandler
import com.plugin.infrastructure.websocket.WebSocketMessageType
import com.plugin.infrastructure.websocket.WebSocketResponse
import io.quarkus.logging.Log
import io.quarkus.websockets.next.WebSocketConnection
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Handler for completions-related WebSocket messages
 *
 * This handler manages completion requests using the new message schema.
 *
 * Migrated to Quarkus WebSocket Next API with thread-safe audio buffer handling for parallel message processing.
 */
@ApplicationScoped
class CompletionsMessageHandler
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val pipelineOrchestrator: AudioAgentPipelineOrchestrator,
) : WebSocketMessageHandler {

    // Store audio buffers per connection for recording (thread-safe)
    private val audioBuffers = ConcurrentHashMap<String, ByteArrayOutputStream>()

    // Store drawn path and cursor context per connection
    private val connectionContexts = ConcurrentHashMap<String, ConnectionContext>()

    data class ConnectionContext(
        var drawnPath: String? = null,
        var cursorContext: String? = null,
        var feId: String? = null
    )

    override fun getMessageTypePrefix(): String = "completions:"

    override suspend fun handleMessage(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse? {
        return try {
            when (message.type) {
                WebSocketMessageType.COMPLETIONS_REQUEST -> handleCompletionRequest(message, connection, userId)
                WebSocketMessageType.COMPLETIONS_REQUEST_END -> handleCompletionRequestEnd(message, connection, userId)
                WebSocketMessageType.COMPLETIONS_RESPONSE -> handleCompletionResponse(message, connection, userId)
                WebSocketMessageType.COMPLETIONS_RESPONSE_END ->
                    handleCompletionResponseEnd(message, connection, userId)
                else -> {
                    Log.warn("Unknown completions message type: ${message.type}")
                    WebSocketResponse(
                        type = "error",
                        payload = emptyMap(),
                        requestId = message.requestId,
                        error = "Unsupported message type: ${message.type}"
                    )
                }
            }
        } catch (e: Exception) {
            Log.error("Error handling completions message", e)
            WebSocketResponse(
                type = "error",
                payload = emptyMap(),
                requestId = message.requestId,
                error = e.message ?: "Unknown error"
            )
        }
    }

    private fun handleCompletionRequest(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse {
        val feId = message.payload["fe_id"] as? String
        val drawnPath = message.payload["drawn_path"] as? String
        val audioChunk = message.payload["audio_chunk"] as? String
        val timestamp = message.payload["timestamp"] as? Number

        Log.info("Handling completion_request:")
        Log.info("  FE ID: $feId")
        Log.info("  Timestamp: $timestamp")
        Log.info("  Drawn Path: ${drawnPath?.take(100)}${if ((drawnPath?.length ?: 0) > 100) "..." else ""}")
        Log.info("  Audio Chunk Size: ${audioChunk?.length ?: 0} base64 chars")

        // Store context for this connection
        val context = connectionContexts.getOrPut(connection.id()) { ConnectionContext() }
        if (feId != null) context.feId = feId
        if (drawnPath != null) context.drawnPath = drawnPath

        // Accumulate audio chunks
        if (audioChunk != null) {
            try {
                val decodedAudio = Base64.getDecoder().decode(audioChunk)
                val buffer = audioBuffers.getOrPut(connection.id()) { ByteArrayOutputStream() }
                synchronized(buffer) { buffer.write(decodedAudio) }
                Log.debug("Accumulated audio: ${buffer.size()} bytes")
            } catch (e: Exception) {
                Log.error("Failed to decode audio chunk", e)
            }
        }

        return WebSocketResponse(
            type = message.type,
            payload = mapOf("status" to "ok", "fe_id" to feId),
            requestId = message.requestId
        )
    }

    private suspend fun handleCompletionRequestEnd(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse {
        val feId = message.payload["fe_id"] as? String
        Log.info("Handling completion_request_end for FE ID: $feId")

        // Get accumulated audio and context
        val audioBuffer = audioBuffers[connection.id()]
        val context = connectionContexts[connection.id()]

        if (audioBuffer == null || audioBuffer.size() == 0) {
            Log.warn("No audio data accumulated for connection ${connection.id()}")
            return WebSocketResponse(
                type = message.type,
                payload = mapOf("status" to "error", "message" to "No audio data"),
                requestId = message.requestId,
                error = "No audio data available"
            )
        }

        // Save audio to file
        val timestamp = System.currentTimeMillis()
        val connectionIdShort = connection.id().take(8)
        val outputDir = File("audio-recordings")
        val audioFile = File(outputDir, "audio_${timestamp}_${connectionIdShort}.wav")

        try {
            val audioData = synchronized(audioBuffer) { audioBuffer.toByteArray() }
            WavFileWriter.writeWavFile(audioData, audioFile)
            Log.info("Audio file saved: ${audioFile.absolutePath} (${audioFile.length()} bytes)")

            // Process audio through the pipeline asynchronously
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    Log.info("Starting audio pipeline processing...")
                    val frameNode =
                        pipelineOrchestrator.processAudio(audioFile, context?.cursorContext, context?.drawnPath)

                    // Stream response back through WebSocket
                    val responsePayload =
                        mapOf(
                            "fe_id" to feId,
                            "response" to objectMapper.writeValueAsString(frameNode),
                            "status" to "completed"
                        )

                    val responseMessage =
                        WebSocketResponse(
                            type = WebSocketMessageType.COMPLETIONS_RESPONSE,
                            payload = responsePayload,
                            requestId = message.requestId
                        )

                    connection.sendTextAndAwait(objectMapper.writeValueAsString(responseMessage))
                    Log.info("Agent response streamed to client for FE ID: $feId")
                } catch (e: Exception) {
                    Log.error("Error processing audio through pipeline", e)
                    val errorResponse =
                        WebSocketResponse(
                            type = "error",
                            payload = mapOf("fe_id" to feId),
                            requestId = message.requestId,
                            error = "Pipeline processing failed: ${e.message}"
                        )
                    connection.sendTextAndAwait(objectMapper.writeValueAsString(errorResponse))
                }
            }

            // Return immediate acknowledgment
            return WebSocketResponse(
                type = message.type,
                payload = mapOf("status" to "processing", "fe_id" to feId),
                requestId = message.requestId
            )
        } catch (e: Exception) {
            Log.error("Error saving audio file", e)
            return WebSocketResponse(
                type = message.type,
                payload = mapOf("status" to "error", "fe_id" to feId),
                requestId = message.requestId,
                error = "Failed to save audio: ${e.message}"
            )
        }
    }

    private fun handleCompletionResponse(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse {
        val feId = message.payload["fe_id"] as? String
        val action = message.payload["action"] as? String
        val target = message.payload["target"] as? String
        val params = message.payload["params"] as? String

        Log.info("Handling completion_response:")
        Log.info("  FE ID: $feId")
        Log.info("  Action: $action")
        Log.info("  Target: $target")
        Log.info("  Params: $params")

        // TODO: Process the completion response
        return WebSocketResponse(
            type = message.type,
            payload = mapOf("status" to "ok", "fe_id" to feId),
            requestId = message.requestId
        )
    }

    private fun handleCompletionResponseEnd(
        message: WebSocketMessage,
        connection: WebSocketConnection,
        userId: String
    ): WebSocketResponse {
        val feId = message.payload["fe_id"] as? String
        Log.info("Handling completion_response_end for FE ID: $feId")

        // TODO: Finalize completion response processing
        return WebSocketResponse(
            type = message.type,
            payload = mapOf("status" to "ok", "fe_id" to feId),
            requestId = message.requestId
        )
    }

    override suspend fun onOpen(connection: WebSocketConnection, userId: String) {
        Log.debug("CompletionsMessageHandler: Connection opened for user $userId")
        audioBuffers[connection.id()] = ByteArrayOutputStream()
        connectionContexts[connection.id()] = ConnectionContext()
    }

    override suspend fun onClose(connection: WebSocketConnection, userId: String) {
        Log.debug("CompletionsMessageHandler: Connection closed for user $userId")

        // Clean up resources
        audioBuffers.remove(connection.id())
        connectionContexts.remove(connection.id())
    }

    override suspend fun onError(connection: WebSocketConnection, userId: String, error: Throwable) {
        Log.error("CompletionsMessageHandler: Error for user $userId", error)
        // Clean up resources
        audioBuffers.remove(connection.id())
        connectionContexts.remove(connection.id())
    }
}

/** Audio recording configuration */
object AudioConfig {
    const val SAMPLE_RATE = 16000 // Hz - 16kHz sample rate
    const val CHANNELS = 1 // Mono
    const val BITS_PER_SAMPLE = 16 // I16 format
}

/** Helper class to write WAV files */
object WavFileWriter {
    fun writeWavFile(audioData: ByteArray, outputFile: File, sampleRate: Int = AudioConfig.SAMPLE_RATE) {
        val channels = AudioConfig.CHANNELS
        val bitsPerSample = AudioConfig.BITS_PER_SAMPLE
        val byteRate = sampleRate * channels * bitsPerSample / 8
        val blockAlign = channels * bitsPerSample / 8
        val dataSize = audioData.size

        outputFile.parentFile?.mkdirs()

        outputFile.outputStream().use { out ->
            // RIFF header
            out.write("RIFF".toByteArray())
            out.write(intToLittleEndian(36 + dataSize))
            out.write("WAVE".toByteArray())

            // fmt chunk
            out.write("fmt ".toByteArray())
            out.write(intToLittleEndian(16)) // fmt chunk size
            out.write(shortToLittleEndian(1)) // audio format (1 = PCM)
            out.write(shortToLittleEndian(channels))
            out.write(intToLittleEndian(sampleRate))
            out.write(intToLittleEndian(byteRate))
            out.write(shortToLittleEndian(blockAlign))
            out.write(shortToLittleEndian(bitsPerSample))

            // data chunk
            out.write("data".toByteArray())
            out.write(intToLittleEndian(dataSize))
            out.write(audioData)
        }
    }

    private fun intToLittleEndian(value: Int): ByteArray {
        return byteArrayOf(
            (value and 0xFF).toByte(),
            (value shr 8 and 0xFF).toByte(),
            (value shr 16 and 0xFF).toByte(),
            (value shr 24 and 0xFF).toByte()
        )
    }

    private fun shortToLittleEndian(value: Int): ByteArray {
        return byteArrayOf((value and 0xFF).toByte(), (value shr 8 and 0xFF).toByte())
    }
}
