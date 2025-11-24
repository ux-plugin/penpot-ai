package com.plugin.features.completions

import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import org.springframework.web.reactive.function.client.WebClient
import org.springframework.web.reactive.function.client.awaitBody
import java.io.File
import java.util.Base64

@Service
class FireworksTranscriptionService(
    private val webClientBuilder: WebClient.Builder,
    @Value("\${fireworks.api-key}") private val apiKey: String
) {
    
    private val webClient = webClientBuilder.baseUrl("https://api.fireworks.ai").build()
    
    suspend fun transcribe(audioFile: File): String {
        return try {
            // Read audio file and encode as base64
            val audioBytes = audioFile.readBytes()
            val base64Audio = Base64.getEncoder().encodeToString(audioBytes)
            
            val request = mapOf(
                "model" to "whisper-v3",
                "audio" to base64Audio
            )
            
            val response = webClient.post()
                .uri("/inference/v1/audio/transcriptions")
                .header("Authorization", "Bearer $apiKey")
                .bodyValue(request)
                .retrieve()
                .awaitBody<Map<String, Any>>()
            
            response["text"] as? String ?: ""
        } catch (e: Exception) {
            println("Transcription failed: ${e.message}")
            ""
        }
    }
}
