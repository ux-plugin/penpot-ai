package com.plugin.features.completions.koog

import io.quarkus.logging.Log
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.WebApplicationException
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.eclipse.microprofile.rest.client.inject.RestClient

/**
 * Service for transcribing audio files using Fireworks AI's Whisper v3 Large model
 *
 * This service integrates with Fireworks AI to provide high-quality audio transcription as part of the Koog agent
 * pipeline.
 */
@ApplicationScoped
class FireworksTranscriptionService {

    @Inject @ConfigProperty(name = "koog.fireworks.api-key") lateinit var fireworksApiKey: String

    @Inject @RestClient lateinit var fireworksRestClient: FireworksRestClient

    /**
     * Transcribe an audio file using Fireworks AI Whisper v3 Large model
     *
     * @param audioFile The audio file to transcribe (WAV format)
     * @return The transcribed text
     */
    suspend fun transcribeAudio(audioFile: File): String =
        withContext(Dispatchers.IO) {
            if (!audioFile.exists()) {
                throw IllegalArgumentException("Audio file does not exist: ${audioFile.absolutePath}")
            }

            Log.info("Transcribing audio file: ${audioFile.name} (${audioFile.length()} bytes)")

            try {
                val request = TranscriptionRequest(file = audioFile, model = "whisper-v3-large")

                val response =
                    fireworksRestClient.transcribeAudio(authorization = "Bearer $fireworksApiKey", request = request)

                val transcribedText = response.text
                Log.info("Successfully transcribed ${audioFile.name}: ${transcribedText.length} characters")
                transcribedText
            } catch (e: WebApplicationException) {
                val statusCode = e.response?.status ?: 0
                val errorBody = e.response?.readEntity(String::class.java) ?: "No error body"
                Log.error("Fireworks transcription failed: $statusCode - $errorBody")
                throw RuntimeException("Transcription failed with status $statusCode: $errorBody", e)
            } catch (e: Exception) {
                Log.error("Fireworks transcription error: ${e.message}", e)
                throw RuntimeException("Transcription failed: ${e.message}", e)
            }
        }
}
