package com.plugin.api.features.completions

import com.plugin.api.config.properties.FireworksProperties
import org.springframework.core.io.FileSystemResource
import org.springframework.http.MediaType
import org.springframework.http.client.MultipartBodyBuilder
import org.springframework.stereotype.Service
import org.springframework.web.reactive.function.BodyInserters
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody
import java.io.File

data class FireworksTranscriptionResponse(val text: String)

@Service
class FireworksTranscriptionService(
    private val webClientBuilder: WebClient.Builder,
    private val fireworksProperties: FireworksProperties,
) {
    private val webClient: WebClient by lazy { webClientBuilder.baseUrl(fireworksProperties.api.baseUrl).build() }

    suspend fun transcribe(audioFile: File): String {
        if (!audioFile.exists()) {
            throw IllegalArgumentException("Audio file does not exist: ${audioFile.absolutePath}")
        }

        println("Transcribing audio file: ${audioFile.name} (${audioFile.length()} bytes)")

        return try {
            val bodyBuilder = MultipartBodyBuilder()
            bodyBuilder.part("file", FileSystemResource(audioFile)).contentType(MediaType.APPLICATION_OCTET_STREAM)
            bodyBuilder.part("model", fireworksProperties.whisper.model)

            val response =
                webClient
                    .post()
                    .uri("/v1/audio/transcriptions")
                    .header("Authorization", "Bearer ${fireworksProperties.api.key}")
                    .contentType(MediaType.MULTIPART_FORM_DATA)
                    .body(BodyInserters.fromMultipartData(bodyBuilder.build()))
                    .retrieve()
                    .awaitBody<FireworksTranscriptionResponse>()

            println("Successfully transcribed ${audioFile.name}: ${response.text.length} characters")
            response.text
        } catch (e: Exception) {
            println("Fireworks transcription error: ${e.message}")
            e.printStackTrace()
            throw RuntimeException("Transcription failed: ${e.message}", e)
        }
    }
}
