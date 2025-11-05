package com.plugin.features.completions.pipeline

import io.quarkus.logging.Log
import jakarta.enterprise.context.ApplicationScoped
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.time.Duration
import org.eclipse.microprofile.config.inject.ConfigProperty

/** Data class for transcription request */
data class AudioTranscriptionRequest(val audioFile: File, val language: String? = null)

/** Data class for transcription result */
data class TranscriptionResult(val text: String, val audioFile: File)

/**
 * Audio transcription service using Fireworks AI Whisper v3 Large model
 *
 * This service transcribes audio files to text using the Fireworks AI API.
 */
@ApplicationScoped
class AudioTranscriptionService {
    @ConfigProperty(name = "fireworks.api.key") private lateinit var apiKey: String

    @ConfigProperty(name = "fireworks.api.base-url") private lateinit var baseUrl: String

    @ConfigProperty(name = "fireworks.whisper.model", defaultValue = "whisper-v3-large")
    private lateinit var whisperModel: String

    private val httpClient: HttpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(30)).build()

    /**
     * Transcribe audio file to text
     *
     * @param audioFile The audio file to transcribe
     * @param language Optional language code (e.g., "en" for English)
     * @return The transcribed text
     */
    suspend fun transcribe(audioFile: File, language: String? = null): String {
        if (!audioFile.exists()) {
            throw IllegalArgumentException("Audio file does not exist: ${audioFile.absolutePath}")
        }

        Log.info("Transcribing audio file: ${audioFile.name} using Fireworks AI Whisper v3 Large")

        val boundary = "----WebKitFormBoundary${System.currentTimeMillis()}"
        val body = buildMultipartBody(audioFile, language, boundary)

        val request =
            HttpRequest.newBuilder()
                .uri(URI.create("$baseUrl/inference/v1/audio/transcriptions"))
                .timeout(Duration.ofMinutes(5))
                .header("Authorization", "Bearer $apiKey")
                .header("Content-Type", "multipart/form-data; boundary=$boundary")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())

        if (response.statusCode() != 200) {
            throw RuntimeException(
                "Fireworks AI transcription failed with status ${response.statusCode()}: ${response.body()}"
            )
        }

        // Parse JSON response to extract text
        val transcriptionText = parseTranscriptionResponse(response.body())
        Log.info("Audio transcription completed: ${transcriptionText.take(100)}...")

        return transcriptionText
    }

    /** Build multipart form data body for audio transcription request */
    private fun buildMultipartBody(audioFile: File, language: String?, boundary: String): ByteArray {
        val lineBreak = "\r\n"
        val builder = StringBuilder()

        // Add model field
        builder.append("--$boundary$lineBreak")
        builder.append("Content-Disposition: form-data; name=\"model\"$lineBreak$lineBreak")
        builder.append("$whisperModel$lineBreak")

        // Add language field if provided
        if (language != null) {
            builder.append("--$boundary$lineBreak")
            builder.append("Content-Disposition: form-data; name=\"language\"$lineBreak$lineBreak")
            builder.append("$language$lineBreak")
        }

        // Detect content type from file extension
        val contentType = detectContentType(audioFile)

        // Add file field header
        builder.append("--$boundary$lineBreak")
        builder.append("Content-Disposition: form-data; name=\"file\"; filename=\"${audioFile.name}\"$lineBreak")
        builder.append("Content-Type: $contentType$lineBreak$lineBreak")

        val headerBytes = builder.toString().toByteArray(Charsets.UTF_8)
        val fileBytes = Files.readAllBytes(audioFile.toPath())
        val footerBytes = "$lineBreak--$boundary--$lineBreak".toByteArray(Charsets.UTF_8)

        // Combine all parts
        return headerBytes + fileBytes + footerBytes
    }

    /** Detect content type from file extension */
    private fun detectContentType(file: File): String {
        return when (file.extension.lowercase()) {
            "wav" -> "audio/wav"
            "mp3" -> "audio/mpeg"
            "m4a" -> "audio/mp4"
            "flac" -> "audio/flac"
            "ogg" -> "audio/ogg"
            "webm" -> "audio/webm"
            else -> "audio/wav" // Default to WAV
        }
    }

    /** Parse the transcription response JSON to extract the text */
    private fun parseTranscriptionResponse(responseBody: String): String {
        // Simple JSON parsing for the "text" field
        // Response format: {"text": "transcribed text here"}
        val textPattern = """"text"\s*:\s*"([^"]*)"""".toRegex()
        val match = textPattern.find(responseBody)
        return match?.groupValues?.get(1) ?: throw RuntimeException("Could not parse transcription response")
    }
}

/**
 * Pipeline step for audio transcription
 *
 * This step transcribes audio files to text as part of a pipeline.
 */
@ApplicationScoped
class AudioTranscriptionStep(private val transcriptionService: AudioTranscriptionService) :
    PipelineStep<AudioTranscriptionRequest, TranscriptionResult> {

    override suspend fun execute(input: AudioTranscriptionRequest, context: PipelineContext): TranscriptionResult {
        Log.info("Pipeline step: ${getName()}")
        val transcribedText = transcriptionService.transcribe(input.audioFile, input.language)
        context.put("transcription", transcribedText)
        context.put("audioFile", input.audioFile)
        return TranscriptionResult(transcribedText, input.audioFile)
    }

    override fun getName(): String = "AudioTranscription"
}
