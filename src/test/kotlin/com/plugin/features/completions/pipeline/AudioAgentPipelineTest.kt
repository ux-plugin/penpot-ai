package com.plugin.features.completions.pipeline

import io.quarkus.test.junit.QuarkusTest
import jakarta.inject.Inject
import java.io.File
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * Tests for the Audio Agent Pipeline Orchestrator
 *
 * Note: These tests verify the pipeline structure and logic. Actual API calls to Fireworks AI and OpenAI are not made
 * in tests.
 */
@QuarkusTest
class AudioAgentPipelineOrchestratorTest {

    @Inject lateinit var orchestrator: AudioAgentPipelineOrchestrator

    @Test
    fun `test orchestrator is injected correctly`() {
        assertNotNull(orchestrator)
    }

    @Test
    fun `test audio pipeline input creation`() {
        val tempFile = File.createTempFile("test_audio", ".wav")
        tempFile.deleteOnExit()

        val input = AudioPipelineInput(tempFile, "cursor context", "M 0 0 L 100 100")

        assertEquals(tempFile, input.audioFile)
        assertEquals("cursor context", input.cursorContext)
        assertEquals("M 0 0 L 100 100", input.drawnPath)
    }

    @Test
    fun `test audio pipeline input with minimal data`() {
        val tempFile = File.createTempFile("test_audio", ".wav")
        tempFile.deleteOnExit()

        val input = AudioPipelineInput(tempFile)

        assertEquals(tempFile, input.audioFile)
        assertNull(input.cursorContext)
        assertNull(input.drawnPath)
    }
}

/**
 * Tests for the Audio Transcription Service
 *
 * Note: These tests verify basic functionality without making actual API calls. Integration tests with a mock Fireworks
 * AI server should be added separately.
 */
@QuarkusTest
class AudioTranscriptionServiceTest {

    @Test
    fun `test audio transcription request creation`() {
        val tempFile = File.createTempFile("test_audio", ".wav")
        tempFile.deleteOnExit()

        val request = AudioTranscriptionRequest(tempFile, "en")

        assertEquals(tempFile, request.audioFile)
        assertEquals("en", request.language)
    }

    @Test
    fun `test audio transcription request without language`() {
        val tempFile = File.createTempFile("test_audio", ".wav")
        tempFile.deleteOnExit()

        val request = AudioTranscriptionRequest(tempFile)

        assertEquals(tempFile, request.audioFile)
        assertNull(request.language)
    }

    @Test
    fun `test transcription result creation`() {
        val tempFile = File.createTempFile("test_audio", ".wav")
        tempFile.deleteOnExit()

        val result = TranscriptionResult("transcribed text", tempFile)

        assertEquals("transcribed text", result.text)
        assertEquals(tempFile, result.audioFile)
    }
}

/** Tests for the Agent Response Service */
@QuarkusTest
class AgentResponseServiceTest {

    @Test
    fun `test agent input creation with all parameters`() {
        val input = AgentInput("Hello world", "cursor at position X", "M 0 0 L 100 100")

        assertEquals("Hello world", input.transcribedText)
        assertEquals("cursor at position X", input.cursorContext)
        assertEquals("M 0 0 L 100 100", input.drawnPath)
    }

    @Test
    fun `test agent input creation with minimal parameters`() {
        val input = AgentInput("Hello world")

        assertEquals("Hello world", input.transcribedText)
        assertNull(input.cursorContext)
        assertNull(input.drawnPath)
    }

    @Test
    fun `test agent output creation`() {
        val frameNode =
            com.plugin.features.completions.FrameNode(id = "test-frame", name = "Test Frame", width = 100, height = 100)

        val output = AgentOutput(frameNode)

        assertEquals("test-frame", output.response.id)
        assertEquals("Test Frame", output.response.name)
        assertEquals(100, output.response.width)
        assertEquals(100, output.response.height)
    }
}
