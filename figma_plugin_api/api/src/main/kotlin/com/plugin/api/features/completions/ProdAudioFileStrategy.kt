package com.plugin.api.features.completions

import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import java.io.File

/**
 * Production audio file strategy that uses temporary files. Files are automatically cleaned up after processing to
 * avoid storage buildup.
 */
@Component
@Profile("!dev")
class ProdAudioFileStrategy : AudioFileStrategy {
    override fun createAudioFile(audioData: ByteArray, timestamp: Long): File {
        // Create a temporary file that will be automatically managed by the OS
        val file = File.createTempFile("audio_${timestamp}_", ".wav")
        WavFileWriter.writeWavFile(audioData, file)
        return file
    }

    override fun shouldCleanup(): Boolean {
        // Always cleanup in production
        return true
    }
}
