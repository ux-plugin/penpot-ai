package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.features.completions.koog.KoogAgentPipeline
import com.plugin.features.completions.pipeline.AgentPipelineInput
import com.plugin.features.completions.pipeline.LangChain4jAgentPipeline
import com.plugin.infrastructure.websocket.*
import io.quarkus.logging.Log
import io.quarkus.websockets.next.WebSocketConnection
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.reflect.KClass

/**
 * Handler for completions-related WebSocket messages
 *
 * This handler manages completion requests using the new message schema and integrates with Koog agent pipeline for
 * audio transcription and LLM response generation.
 *
 * Migrated to Quarkus WebSocket Next API with thread-safe audio buffer handling for parallel message processing.
 */
@ApplicationScoped
class CompletionsMessageHandler
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val koogAgentPipeline: KoogAgentPipeline,
    private val langChain4jAgentPipeline: LangChain4jAgentPipeline,
) : WebSocketMessageHandler {

    // Store audio buffers per connection for recording (thread-safe)
    private val audioBuffers = ConcurrentHashMap<String, ByteArrayOutputStream>()

    // Store accumulated drawn paths per connection
    private val drawnPaths = ConcurrentHashMap<String, StringBuilder>()

    override fun getHandledMessageTypes(): List<KClass<out WebSocketMessage>> =
        listOf(
            CompletionRequest::class,
            CompletionRequestEnd::class,
            CompletionResponse::class,
            CompletionResponseEnd::class
        )

    override suspend fun handleMessage(message: WebSocketMessage, connection: WebSocketConnection, userId: String) {
        try {
            when (message) {
                is CompletionRequest -> handleCompletionRequest(message, connection, userId)
                is CompletionRequestEnd -> handleCompletionRequestEnd(message, connection, userId)
                else -> {
                    Log.warn("Unexpected message type in CompletionsMessageHandler: ${message::class.simpleName}")
                    sendErrorResponse(connection, "Unsupported message type", message.requestId, 4003)
                }
            }
        } catch (e: Exception) {
            Log.error("Error handling completions message", e)
            sendErrorResponse(connection, e.message ?: "Unknown error", message.requestId, 5000)
        }
    }

    private suspend fun handleCompletionRequest(
        message: CompletionRequest,
        connection: WebSocketConnection,
        userId: String
    ) {
        val feId = message.payload.fe_id
        val drawnPath = message.payload.drawn_path
        val audioChunk = message.payload.audio_chunk
        val timestamp = message.payload.timestamp

        Log.info("Handling completion_request:")
        Log.info("  FE ID: $feId")
        Log.info("  Timestamp: $timestamp")
        Log.info("  Drawn Path: ${drawnPath.take(100)}${if (drawnPath.length > 100) "..." else ""}")
        Log.info("  Audio Chunk Size: ${audioChunk.length} base64 chars")

        // Accumulate drawn path for context
        if (drawnPath.isNotBlank()) {
            drawnPaths.getOrPut(connection.id()) { StringBuilder() }.append(drawnPath).append(" ")
        }

        // Accumulate audio chunk
        if (audioChunk.isNotBlank()) {
            try {
                val decodedAudio = Base64.getDecoder().decode(audioChunk)
                audioBuffers[connection.id()]?.let { buffer ->
                    synchronized(buffer) { buffer.write(decodedAudio) }
                    Log.debug("Accumulated audio: ${buffer.size()} bytes")
                }
            } catch (e: Exception) {
                Log.error("Failed to decode audio chunk", e)
            }
        }

        // Send acknowledgment response
        val response =
            CompletionRequest(
                payload =
                    CompletionRequestPayload(fe_id = feId, drawn_path = "", audio_chunk = "", timestamp = timestamp),
                requestId = message.requestId
            )
        connection.sendText(objectMapper.writeValueAsString(response)).awaitSuspending()
    }

    private suspend fun handleCompletionRequestEnd(
        message: CompletionRequestEnd,
        connection: WebSocketConnection,
        userId: String
    ) {
        val feId = message.payload.fe_id
        Log.info("Handling completion_request_end for FE ID: $feId")

        // Process accumulated audio and generated response using a Koog pipeline
        val audioBuffer = audioBuffers[connection.id()]
        val cursorContext = drawnPaths[connection.id()]?.toString()

        if (audioBuffer != null && audioBuffer.size() > 0) {
            try {
                // Save audio to a temporary file
                val timestamp = System.currentTimeMillis()
                val connectionIdShort = connection.id().take(8)
                val audioFile = File("audio-recordings", "audio_${timestamp}_${connectionIdShort}.wav")
                audioFile.parentFile?.mkdirs()

                val audioData = synchronized(audioBuffer) { audioBuffer.toByteArray() }
                WavFileWriter.writeWavFile(audioData, audioFile)
                Log.info("Saved audio for processing: ${audioFile.absolutePath}")

                langChain4jAgentPipeline.executePipeline(
                    input = AgentPipelineInput(audioFile = audioFile, cursorContext = cursorContext, feId = feId),
                    connection = connection,
                    requestId = message.requestId
                )

                // Send completion signal
                val endResponse =
                    CompletionResponseEnd(
                        payload = CompletionResponseEndPayload(fe_id = feId),
                        requestId = message.requestId
                    )
                connection.sendText(objectMapper.writeValueAsString(endResponse)).awaitSuspending()

                // Clear buffers after processing completes
                audioBuffers[connection.id()]?.reset()
                drawnPaths[connection.id()]?.clear()
            } catch (e: Exception) {
                Log.error("Failed to process audio with Koog pipeline", e)
                sendErrorResponse(connection, e.message ?: "Unknown error", message.requestId, 5000)
                return
            }
        } else {
            Log.warn("No audio data received for processing")
        }

        // Send acknowledgment response
        val response =
            CompletionRequestEnd(payload = CompletionRequestEndPayload(fe_id = feId), requestId = message.requestId)
        connection.sendText(objectMapper.writeValueAsString(response)).awaitSuspending()
    }

    private suspend fun sendErrorResponse(
        connection: WebSocketConnection,
        message: String,
        requestId: String?,
        errorCode: Int
    ) {
        try {
            val error =
                CompletionRequest(
                    payload = CompletionRequestPayload(fe_id = "", drawn_path = "", audio_chunk = "", timestamp = 0),
                    requestId = requestId,
                    error = WebSocketError(code = errorCode, message = message)
                )
            connection.sendText(objectMapper.writeValueAsString(error)).awaitSuspending()
        } catch (e: Exception) {
            Log.error("Failed to send error response", e)
        }
    }

    override suspend fun onOpen(connection: WebSocketConnection, userId: String) {
        Log.debug("CompletionsMessageHandler: Connection opened for user $userId")
        audioBuffers[connection.id()] = ByteArrayOutputStream()
        drawnPaths[connection.id()] = StringBuilder()
    }

    override suspend fun onClose(connection: WebSocketConnection, userId: String) {
        Log.debug("CompletionsMessageHandler: Connection closed for user $userId")

        // Clean up buffers
        audioBuffers.remove(connection.id())
        drawnPaths.remove(connection.id())
    }

    override suspend fun onError(connection: WebSocketConnection, userId: String, error: Throwable) {
        Log.error("CompletionsMessageHandler: Error for user $userId", error)
        // Clean up buffers
        audioBuffers.remove(connection.id())
        drawnPaths.remove(connection.id())
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
