package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.infrastructure.websocket.*
import kotlinx.coroutines.reactive.awaitFirst
import org.springframework.stereotype.Component
import org.springframework.web.reactive.socket.WebSocketSession
import reactor.core.publisher.Mono
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.reflect.KClass

@Component
class CompletionsWebSocketMessageHandler(
    private val objectMapper: ObjectMapper,
    private val figmaDesignAiService: FigmaDesignAiService,
) : WebSocketMessageHandler {

    private val audioBuffers = ConcurrentHashMap<String, ByteArrayOutputStream>()
    private val drawnPaths = ConcurrentHashMap<String, StringBuilder>()

    override fun getHandledMessageTypes(): List<KClass<out WebSocketMessage>> =
        listOf(
            CompletionRequest::class,
            CompletionRequestEnd::class
        )

    override suspend fun handleMessage(message: WebSocketMessage, session: WebSocketSession, userId: String) {
        try {
            when (message) {
                is CompletionRequest -> handleCompletionRequest(message, session, userId)
                is CompletionRequestEnd -> handleCompletionRequestEnd(message, session, userId)
                else -> {
                    println("Unexpected message type in CompletionsWebSocketMessageHandler: ${message::class.simpleName}")
                    sendErrorResponse(session, "Unsupported message type", message.requestId, 4003)
                }
            }
        } catch (e: Exception) {
            println("Error handling completions message: ${e.message}")
            sendErrorResponse(session, e.message ?: "Unknown error", message.requestId, 5000)
        }
    }

    private suspend fun handleCompletionRequest(
        message: CompletionRequest,
        session: WebSocketSession,
        userId: String
    ) {
        val feId = message.payload.fe_id
        val drawnPath = message.payload.drawn_path
        val audioChunk = message.payload.audio_chunk
        val timestamp = message.payload.timestamp

        println("Handling completion_request:")
        println("  FE ID: $feId")
        println("  Timestamp: $timestamp")
        println("  Drawn Path: ${drawnPath.take(100)}${if (drawnPath.length > 100) "..." else ""}")
        println("  Audio Chunk Size: ${audioChunk.length} base64 chars")

        // Accumulate drawn path for context
        if (drawnPath.isNotBlank()) {
            drawnPaths.getOrPut(session.id) { StringBuilder() }.append(drawnPath).append(" ")
        }

        // Accumulate audio chunk
        if (audioChunk.isNotBlank()) {
            try {
                val decodedAudio = Base64.getDecoder().decode(audioChunk)
                audioBuffers.getOrPut(session.id) { ByteArrayOutputStream() }.write(decodedAudio)
                println("Accumulated audio: ${audioBuffers[session.id]?.size() ?: 0} bytes")
            } catch (e: Exception) {
                println("Failed to decode audio chunk: ${e.message}")
            }
        }

        // Send acknowledgment response
        val response = CompletionRequest(
            payload = CompletionRequestPayload(
                fe_id = feId,
                drawn_path = "",
                audio_chunk = "",
                timestamp = timestamp
            ),
            requestId = message.requestId
        )
        sendMessage(session, response)
    }

    private suspend fun handleCompletionRequestEnd(
        message: CompletionRequestEnd,
        session: WebSocketSession,
        userId: String
    ) {
        val feId = message.payload.fe_id
        println("Handling completion_request_end for FE ID: $feId")

        // Process accumulated audio and generate response
        val audioBuffer = audioBuffers[session.id]
        val cursorContext = drawnPaths[session.id]?.toString()

        if (audioBuffer != null && audioBuffer.size() > 0) {
            try {
                // Save audio to a temporary file
                val timestamp = System.currentTimeMillis()
                val sessionIdShort = session.id.take(8)
                val audioFile = File("audio-recordings", "audio_${timestamp}_${sessionIdShort}.wav")
                audioFile.parentFile?.mkdirs()

                val audioData = audioBuffer.toByteArray()
                WavFileWriter.writeWavFile(audioData, audioFile)
                println("Saved audio for processing: ${audioFile.absolutePath}")

                // Execute AI pipeline
                figmaDesignAiService.executePipeline(
                    input = AgentPipelineInput(
                        audioFile = audioFile,
                        cursorContext = cursorContext,
                        feId = feId
                    ),
                    session = session,
                    requestId = message.requestId
                )

                // Clear buffers after processing
                audioBuffers[session.id]?.reset()
                drawnPaths[session.id]?.clear()
            } catch (e: Exception) {
                println("Failed to process audio: ${e.message}")
                e.printStackTrace()
                sendErrorResponse(session, e.message ?: "Unknown error", message.requestId, 5000)
                return
            }
        } else {
            println("No audio data received for processing")
        }

        // Send acknowledgment response
        val response = CompletionRequestEnd(
            payload = CompletionRequestEndPayload(fe_id = feId),
            requestId = message.requestId
        )
        sendMessage(session, response)
    }

    private suspend fun sendMessage(session: WebSocketSession, message: Any) {
        try {
            val json = objectMapper.writeValueAsString(message)
            session.send(Mono.just(session.textMessage(json))).awaitFirst()
        } catch (e: Exception) {
            println("Failed to send message: ${e.message}")
        }
    }

    private suspend fun sendErrorResponse(
        session: WebSocketSession,
        message: String,
        requestId: String?,
        errorCode: Int
    ) {
        try {
            val error = CompletionRequest(
                payload = CompletionRequestPayload(
                    fe_id = "",
                    drawn_path = "",
                    audio_chunk = "",
                    timestamp = 0
                ),
                requestId = requestId,
                error = WebSocketError(code = errorCode, message = message)
            )
            sendMessage(session, error)
        } catch (e: Exception) {
            println("Failed to send error response: ${e.message}")
        }
    }

    override suspend fun onOpen(session: WebSocketSession, userId: String) {
        println("CompletionsWebSocketMessageHandler: Connection opened for user $userId")
        audioBuffers[session.id] = ByteArrayOutputStream()
        drawnPaths[session.id] = StringBuilder()
    }

    override suspend fun onClose(session: WebSocketSession, userId: String) {
        println("CompletionsWebSocketMessageHandler: Connection closed for user $userId")
        audioBuffers.remove(session.id)
        drawnPaths.remove(session.id)
    }

    override suspend fun onError(session: WebSocketSession, userId: String, error: Throwable) {
        println("CompletionsWebSocketMessageHandler: Error for user $userId - ${error.message}")
        audioBuffers.remove(session.id)
        drawnPaths.remove(session.id)
    }
}
