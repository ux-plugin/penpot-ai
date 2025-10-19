package com.plugin.features.completions

import com.fasterxml.jackson.databind.ObjectMapper
import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.websocket.CloseReason
import jakarta.websocket.OnClose
import jakarta.websocket.OnError
import jakarta.websocket.OnMessage
import jakarta.websocket.OnOpen
import jakarta.websocket.Session
import jakarta.websocket.server.ServerEndpoint
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.*
import java.util.concurrent.ConcurrentHashMap
import org.eclipse.microprofile.jwt.JsonWebToken

/** Service class for component-related operations. */
@ApplicationScoped
class ComponentService @Inject constructor(private val componentRepository: IComponentRepository) : IComponentService {

    @LangChain4JServer private lateinit var aiServerRepositoryLangChain: IAiServerService

    override suspend fun createComponentLangChain(prompt: String, userId: String): FrameNode {
        val completion = aiServerRepositoryLangChain.createCompletion(prompt)
        saveCompletion(userId, prompt, completion)
        return completion
    }

    override suspend fun saveCompletion(userId: String, prompt: String, aiCompletion: FrameNode) {
        componentRepository.saveCompletion(userId, prompt, aiCompletion).awaitSuspending()
    }

    override suspend fun getCompletions(userId: String): List<ComponentCompletion> {
        return componentRepository.getCompletions(userId).awaitSuspending()
    }

    override suspend fun getCompletion(userId: String, completionId: String): ComponentCompletion? {
        return componentRepository.getCompletion(userId, completionId).awaitSuspending()
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

/** WebSocket endpoint for streaming component creation data */
@ServerEndpoint("/completions/create")
@ApplicationScoped
@Authenticated
class ComponentStreamingWebSocket
@Inject
constructor(
    private val objectMapper: ObjectMapper,
    private val jsonWebToken: JsonWebToken,
    private val commandDispatcher: CommandDispatcher,
) {
    // Store audio buffers per session
    private val audioBuffers = ConcurrentHashMap<String, ByteArrayOutputStream>()

    // Store user IDs per session for authenticated users
    private val sessionUserIds = ConcurrentHashMap<String, String>()

    // Store JWT token expiration times per session
    private val sessionTokenExpirations = ConcurrentHashMap<String, Long>()

    @OnOpen
    fun onOpen(session: Session) {
        try {
            // Verify authentication - check if JWT token exists and has a subject
            val userId = jsonWebToken.subject
            Log.debug("User ID from JWT token: $userId")
            if (userId == null || userId.isBlank()) {
                Log.warn("Unauthenticated WebSocket connection attempt - no valid JWT subject")
                session.close(CloseReason(CloseReason.CloseCodes.VIOLATED_POLICY, "Authentication required"))
                return
            }

            // Cache the token expiration time
            val expirationTime = jsonWebToken.expirationTime
            if (expirationTime <= 0) {
                Log.warn("JWT token has no valid expiration time: $expirationTime")
                session.close(CloseReason(CloseReason.CloseCodes.VIOLATED_POLICY, "Invalid token"))
                return
            }

            sessionUserIds[session.id] = userId
            sessionTokenExpirations[session.id] = expirationTime

            Log.info("WebSocket connection opened: ${session.id} for user: $userId")
            Log.debug("Token expiration time: $expirationTime (${java.time.Instant.ofEpochSecond(expirationTime)})")
            audioBuffers[session.id] = ByteArrayOutputStream()
        } catch (e: Exception) {
            Log.error("Error during WebSocket authentication", e)
            session.close(CloseReason(CloseReason.CloseCodes.UNEXPECTED_CONDITION, "Authentication failed"))
        }
    }

    @OnMessage
    fun onMessage(message: String, session: Session): String {
        return try {
            // Check if token has expired
            val expirationTime = sessionTokenExpirations[session.id]
            val currentTime = System.currentTimeMillis() / 1000 // Convert to seconds

            if (expirationTime == null) {
                Log.error("No expiration time found for session: ${session.id}")
                session.close(CloseReason(CloseReason.CloseCodes.TRY_AGAIN_LATER, "Session not properly initialized"))
                return "ERROR: Session not initialized"
            }

            if (currentTime >= expirationTime) {
                Log.warn("Token expired for session: ${session.id}")
                // Use custom close code 4001 for token expiration
                session.close(CloseReason(CloseReason.CloseCode { 4001 }, "Token expired"))
                return "ERROR: Token expired"
            }

            val userId =
                sessionUserIds[session.id]
                    ?: run {
                        Log.error("No user ID found for session: ${session.id}")
                        session.close(CloseReason(CloseReason.CloseCodes.VIOLATED_POLICY, "Session not authenticated"))
                        return "ERROR: Not authenticated"
                    }

            // Parse the command
            val command = objectMapper.readValue(message, WebSocketCommand::class.java)

            Log.debug("Received command: ${command.event} for session: ${session.id}")

            // Dispatch to appropriate handler
            val response = kotlinx.coroutines.runBlocking { commandDispatcher.dispatch(command, session, userId) }

            response
        } catch (e: Exception) {
            Log.error("Error processing message", e)
            "ERROR: ${e.message}"
        }
    }

    @OnClose
    fun onClose(session: Session) {
        val userId = sessionUserIds[session.id]
        Log.info("WebSocket connection closed: ${session.id} for user: $userId")

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
            } finally {
                audioBuffers.remove(session.id)
                sessionUserIds.remove(session.id)
                sessionTokenExpirations.remove(session.id)
            }
        }
            ?: run {
                sessionUserIds.remove(session.id)
                sessionTokenExpirations.remove(session.id)
            }
    }

    @OnError
    fun onError(throwable: Throwable, session: Session) {
        val userId = sessionUserIds[session.id]
        Log.error("WebSocket error on connection: ${session.id} for user: $userId", throwable)
        // Clean up buffers on error
        audioBuffers.remove(session.id)
        sessionUserIds.remove(session.id)
        sessionTokenExpirations.remove(session.id)
    }
}

/** REST resource for component-related endpoints. Uses CDI for dependency injection of services. */
@Path("/completions")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
@ApplicationScoped
@Authenticated
class ComponentResource
@Inject
constructor(
    private val componentService: IComponentService,
    private val jsonWebToken: JsonWebToken,
    private val objectMapper: ObjectMapper,
) {

    /** Get all completions for a user */
    @GET
    @Path("/")
    suspend fun getCompletions(): Response {
        val userId = jsonWebToken.subject
        return try {
            val completions = componentService.getCompletions(userId)
            val response =
                completions.map { completion ->
                    ComponentCompletionResponse(
                        id = completion.id,
                        prompt = completion.prompt,
                        aiCompletion = objectMapper.readValue(completion.aiCompletion, FrameNode::class.java),
                        createdAt = completion.createdAt,
                    )
                }
            Response.ok(response).build()
        } catch (throwable: Throwable) {
            Log.error("Failed to load completions", throwable)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity(CompletionsLoadFailedResponse()).build()
        }
    }

    /** Get a specific completion */
    @GET
    @Path("/{completionId}")
    suspend fun getCompletion(@PathParam("completionId") completionId: String): Response {
        val userId = jsonWebToken.subject
        return try {
            val completion = componentService.getCompletion(userId, completionId)
            if (completion == null) {
                return Response.status(Response.Status.NOT_FOUND).entity(CompletionNotFoundResponse()).build()
            }
            val response =
                ComponentCompletionResponse(
                    id = completion.id,
                    prompt = completion.prompt,
                    aiCompletion = objectMapper.readValue(completion.aiCompletion, FrameNode::class.java),
                    createdAt = completion.createdAt,
                )
            Response.ok(response).build()
        } catch (throwable: Throwable) {
            Log.error("Failed to get completion with ID: $completionId", throwable)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity(CompletionsLoadFailedResponse()).build()
        }
    }
}
