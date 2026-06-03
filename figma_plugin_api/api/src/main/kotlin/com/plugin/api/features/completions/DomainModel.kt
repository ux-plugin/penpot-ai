package com.plugin.api.features.completions

import java.io.File

/** Input for the AI agent pipeline */
data class AgentPipelineInput(val audioFile: File, val cursorContext: String?)

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

    private fun intToLittleEndian(value: Int): ByteArray = byteArrayOf(
        (value and 0xFF).toByte(),
        (value shr 8 and 0xFF).toByte(),
        (value shr 16 and 0xFF).toByte(),
        (value shr 24 and 0xFF).toByte(),
    )

    private fun shortToLittleEndian(value: Int): ByteArray = byteArrayOf((value and 0xFF).toByte(), (value shr 8 and 0xFF).toByte())
}
