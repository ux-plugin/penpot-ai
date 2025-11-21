package com.plugin.features.completions.koog

import io.quarkus.test.junit.QuarkusTest
import jakarta.inject.Inject
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable

/**
 * Tests for Koog AI Agent Pipeline
 *
 * Note: Most tests require valid API keys and are disabled by default. Enable them by setting the appropriate
 * environment variables.
 */
@QuarkusTest
class KoogAgentPipelineTest {

    @Inject lateinit var koogAgentPipeline: KoogAgentPipeline

    @Inject lateinit var transcriptionService: FireworksTranscriptionService

    @Test
    fun testKoogAgentPipelineInjection() {
        assertNotNull(koogAgentPipeline, "KoogAgentPipeline should be injected")
    }

    @Test
    fun testFireworksTranscriptionServiceInjection() {
        assertNotNull(transcriptionService, "FireworksTranscriptionService should be injected")
    }

    @Test
    fun testAgentPipelineInputCreation() {
        val testFile = File("test.wav")
        val input = AgentPipelineInput(audioFile = testFile, cursorContext = "M 0 0 L 100 100")

        assertEquals(testFile, input.audioFile)
        assertEquals("M 0 0 L 100 100", input.cursorContext)
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIREWORKS_API_KEY", matches = ".+")
    @EnabledIfEnvironmentVariable(named = "OPENAI_API_KEY", matches = ".+")
    fun testPipelineWithRealAudio() = runBlocking {
        // This test requires:
        // 1. Valid FIREWORKS_API_KEY environment variable
        // 2. Valid OPENAI_API_KEY environment variable
        // 3. A real audio file

        val audioFile = File("audio-recordings/test_audio.wav")
        if (!audioFile.exists()) {
            println("Skipping test: test audio file not found at ${audioFile.absolutePath}")
            return@runBlocking
        }

        val input = AgentPipelineInput(audioFile = audioFile, cursorContext = "User is drawing a rectangle")
        val receivedChunks = mutableListOf<String>()

        try {
            // Capture streaming responses using callback
            koogAgentPipeline.executePipeline(input) { chunk ->
                receivedChunks.add(chunk)
                println("Received chunk: $chunk")
            }
            println("Pipeline execution completed successfully")
            println("Total chunks received: ${receivedChunks.size}")
        } catch (e: Exception) {
            fail<Unit>("Pipeline should not throw exception: ${e.message}")
        }
    }

    @Test
    @EnabledIfEnvironmentVariable(named = "FIREWORKS_API_KEY", matches = ".+")
    fun testTranscriptionWithRealAudio() = runBlocking {
        // This test requires:
        // 1. Valid FIREWORKS_API_KEY environment variable
        // 2. A real audio file

        val audioFile = File("audio-recordings/test_audio.wav")
        if (!audioFile.exists()) {
            println("Skipping test: test audio file not found at ${audioFile.absolutePath}")
            return@runBlocking
        }

        try {
            val transcription = transcriptionService.transcribeAudio(audioFile)
            assertNotNull(transcription, "Transcription should not be null")
            assertTrue(transcription.isNotBlank(), "Transcription should not be blank")
            println("Transcription result: $transcription")
        } catch (e: Exception) {
            fail<Unit>("Transcription should not throw exception: ${e.message}")
        }
    }
}
