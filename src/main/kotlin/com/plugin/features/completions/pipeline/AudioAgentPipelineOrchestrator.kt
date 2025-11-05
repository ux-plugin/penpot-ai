package com.plugin.features.completions.pipeline

import com.plugin.features.completions.FrameNode
import io.quarkus.logging.Log
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import java.io.File

/** Data class for pipeline input */
data class AudioPipelineInput(val audioFile: File, val cursorContext: String? = null, val drawnPath: String? = null)

/**
 * Orchestrator for the audio processing agent pipeline
 *
 * This class coordinates the complete pipeline:
 * 1. Audio transcription using Fireworks AI Whisper v3 Large
 * 2. Agent response generation using LangChain4j
 */
@ApplicationScoped
class AudioAgentPipelineOrchestrator
@Inject
constructor(
    private val audioTranscriptionStep: AudioTranscriptionStep,
    private val agentResponseStep: AgentResponseStep,
) {

    /**
     * Process audio through the complete pipeline and generate AI response
     *
     * @param audioFile The audio file to process
     * @param cursorContext Optional user cursor context
     * @param drawnPath Optional drawn path from user
     * @return The generated FrameNode response
     */
    suspend fun processAudio(audioFile: File, cursorContext: String? = null, drawnPath: String? = null): FrameNode {
        Log.info("Starting audio agent pipeline for file: ${audioFile.name}")

        // Step 1: Transcribe audio to text
        val transcriptionRequest = AudioTranscriptionRequest(audioFile, language = null)
        val transcriptionResult = audioTranscriptionStep.execute(transcriptionRequest, PipelineContext())

        Log.info("Transcription complete: ${transcriptionResult.text.take(100)}...")

        // Step 2: Generate agent response from transcribed text
        val agentInput = AgentInput(transcriptionResult.text, cursorContext, drawnPath)
        val agentOutput = agentResponseStep.execute(agentInput, PipelineContext())

        Log.info("Agent response generated: ${agentOutput.response.id}")

        return agentOutput.response
    }

    /**
     * Process audio using the modular pipeline architecture
     *
     * This demonstrates the extensible pipeline pattern for future enhancements
     */
    suspend fun processAudioWithPipeline(input: AudioPipelineInput): FrameNode {
        Log.info("Starting modular audio pipeline for file: ${input.audioFile.name}")

        val cursorContext = input.cursorContext
        val drawnPath = input.drawnPath

        // Create a pipeline with transcription and agent response steps
        val pipeline =
            pipeline<AudioTranscriptionRequest>()
                .withName("AudioAgentPipeline")
                .addStep(audioTranscriptionStep)
                .addStep(
                    object : PipelineStep<TranscriptionResult, AgentInput> {
                        override suspend fun execute(
                            transcriptionInput: TranscriptionResult,
                            context: PipelineContext
                        ): AgentInput {
                            Log.info("Pipeline step: TransformToAgentInput")
                            return AgentInput(transcriptionInput.text, cursorContext, drawnPath)
                        }

                        override fun getName(): String = "TransformToAgentInput"
                    }
                )
                .addStep(agentResponseStep)
                .build()

        // Execute the pipeline
        val initialInput = AudioTranscriptionRequest(input.audioFile, language = null)
        val result = pipeline.execute(initialInput)

        Log.info("Modular pipeline complete: ${result.response.id}")
        return result.response
    }
}
