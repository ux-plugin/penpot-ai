package com.plugin.features.completions.koog

import com.fasterxml.jackson.databind.ObjectMapper
import io.quarkus.logging.Log
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.eclipse.microprofile.config.inject.ConfigProperty

/** Response structure from Fireworks AI transcription API */
data class FireworksTranscriptionResponse(val text: String)

/**
 * Service for transcribing audio files using Fireworks AI's Whisper v3 Large model
 *
 * This service integrates with Fireworks AI to provide high-quality audio transcription as part of the Koog agent
 * pipeline.
 */
@ApplicationScoped
class FireworksTranscriptionService {

    @Inject @ConfigProperty(name = "koog.fireworks.api-key") lateinit var fireworksApiKey: String

    @Inject lateinit var objectMapper: ObjectMapper

    private val httpClient: OkHttpClient by lazy {
        OkHttpClient.Builder().connectTimeout(30, TimeUnit.SECONDS).readTimeout(120, TimeUnit.SECONDS).build()
    }

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

            val requestBody =
                MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("file", audioFile.name, audioFile.asRequestBody("audio/wav".toMediaType()))
                    .addFormDataPart("model", "whisper-v3-large")
                    .build()

            val request =
                Request.Builder()
                    .url("https://api.fireworks.ai/inference/v1/audio/transcriptions")
                    .addHeader("Authorization", "Bearer $fireworksApiKey")
                    .post(requestBody)
                    .build()

            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    val errorBody = response.body?.string() ?: "No error body"
                    Log.error("Fireworks transcription failed: ${response.code} - $errorBody")
                    throw RuntimeException("Transcription failed with status ${response.code}: $errorBody")
                }

                val responseBody =
                    response.body?.string() ?: throw RuntimeException("Empty response from Fireworks API")

                // Parse the JSON response using Jackson to properly handle escaped characters
                val transcriptionResponse =
                    objectMapper.readValue(responseBody, FireworksTranscriptionResponse::class.java)
                val transcribedText = transcriptionResponse.text

                Log.info("Successfully transcribed ${audioFile.name}: ${transcribedText.length} characters")
                transcribedText
            }
        }
}
