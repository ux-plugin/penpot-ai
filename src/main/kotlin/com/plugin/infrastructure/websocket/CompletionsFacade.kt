package com.plugin.infrastructure.websocket

import com.fasterxml.jackson.databind.ObjectMapper
import io.quarkus.logging.Log
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.websocket.Session
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Facade for handling completions-related WebSocket messages
 * 
 * This facade handles completion requests using the new message schema.
 */
@ApplicationScoped
class CompletionsFacade
@Inject
constructor(
    private val objectMapper: ObjectMapper,
) : WebSocketFacade {
    
    // Store audio buffers per session for recording
    private val audioBuffers = ConcurrentHashMap<String, ByteArrayOutputStream>()
    
    override fun getMessageTypePrefix(): String = "completions:"
    
    override suspend fun handleMessage(
        message: WebSocketMessage,
        session: Session,
        userId: String
    ): WebSocketResponse? {
        return try {
            when (message.type) {
                WebSocketMessageType.COMPLETIONS_REFRESH_TOKEN -> handleRefreshToken(message, session, userId)
                WebSocketMessageType.COMPLETIONS_REQUEST -> handleCompletionRequest(message, session, userId)
                WebSocketMessageType.COMPLETIONS_REQUEST_END -> handleCompletionRequestEnd(message, session, userId)
                WebSocketMessageType.COMPLETIONS_RESPONSE -> handleCompletionResponse(message, session, userId)
                WebSocketMessageType.COMPLETIONS_RESPONSE_END -> handleCompletionResponseEnd(message, session, userId)
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
    
    private fun handleRefreshToken(message: WebSocketMessage, session: Session, userId: String): WebSocketResponse {
        Log.debug("Handling refresh_token for user: $userId")
        // TODO: Implement token refresh logic
        return WebSocketResponse(
            type = message.type,
            payload = mapOf("status" to "ok", "message" to "Token refresh not yet implemented"),
            requestId = message.requestId
        )
    }
    
    private fun handleCompletionRequest(message: WebSocketMessage, session: Session, userId: String): WebSocketResponse {
        val feId = message.payload["fe_id"] as? String
        val drawnPath = message.payload["drawn_path"] as? String
        val audioChunk = message.payload["audio_chunk"] as? String
        val timestamp = message.payload["timestamp"] as? Number
        
        Log.info("Handling completion_request:")
        Log.info("  FE ID: $feId")
        Log.info("  Timestamp: $timestamp")
        Log.info("  Drawn Path: ${drawnPath?.take(100)}${if ((drawnPath?.length ?: 0) > 100) "..." else ""}")
        Log.info("  Audio Chunk Size: ${audioChunk?.length ?: 0} base64 chars")
        
        // TODO: Process the completion request
        return WebSocketResponse(
            type = message.type,
            payload = mapOf("status" to "ok", "fe_id" to feId),
            requestId = message.requestId
        )
    }
    
    private fun handleCompletionRequestEnd(message: WebSocketMessage, session: Session, userId: String): WebSocketResponse {
        val feId = message.payload["fe_id"] as? String
        Log.info("Handling completion_request_end for FE ID: $feId")
        
        // TODO: Finalize completion request processing
        return WebSocketResponse(
            type = message.type,
            payload = mapOf("status" to "ok", "fe_id" to feId),
            requestId = message.requestId
        )
    }
    
    private fun handleCompletionResponse(message: WebSocketMessage, session: Session, userId: String): WebSocketResponse {
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
    
    private fun handleCompletionResponseEnd(message: WebSocketMessage, session: Session, userId: String): WebSocketResponse {
        val feId = message.payload["fe_id"] as? String
        Log.info("Handling completion_response_end for FE ID: $feId")
        
        // TODO: Finalize completion response processing
        return WebSocketResponse(
            type = message.type,
            payload = mapOf("status" to "ok", "fe_id" to feId),
            requestId = message.requestId
        )
    }
    
    override suspend fun onOpen(session: Session, userId: String) {
        Log.debug("CompletionsFacade: Session opened for user $userId")
        audioBuffers[session.id] = ByteArrayOutputStream()
    }
    
    override suspend fun onClose(session: Session, userId: String) {
        Log.debug("CompletionsFacade: Session closed for user $userId")
        
        // Save accumulated audio to WAV file
        audioBuffers[session.id]?.let { buffer ->
            try {
                val timestamp = System.currentTimeMillis()
                val sessionIdShort = session.id.take(8)
                val outputDir = File("audio-recordings")
                val outputFile = File(outputDir, "audio_${timestamp}_${sessionIdShort}.wav")
                
                val audioData = buffer.toByteArray()
                if (audioData.isNotEmpty()) {
                    WavFileWriter.writeWavFile(audioData, outputFile)
                    Log.info("Audio saved to: ${outputFile.absolutePath}")
                    Log.info("Audio file size: ${outputFile.length()} bytes")
                    Log.info("Duration: ~${audioData.size / (AudioConfig.SAMPLE_RATE * 2)} seconds")
                } else {
                    Log.warn("No audio data to save for session ${session.id}")
                }
            } catch (e: Exception) {
                Log.error("Failed to save audio file", e)
            }
        }
        
        // Clean up audio buffers
        audioBuffers.remove(session.id)
    }
    
    override suspend fun onError(session: Session, userId: String, error: Throwable) {
        Log.error("CompletionsFacade: Error for user $userId", error)
        // Clean up audio buffers
        audioBuffers.remove(session.id)
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
