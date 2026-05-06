package com.plugin.api.dev

import com.plugin.api.features.completions.AudioFileStrategy
import com.plugin.api.features.completions.WavFileWriter
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component
import java.io.File

/**
 * Development audio file strategy that persists files to disk for debugging. Files are saved in the 'audio-recordings'
 * directory and are NOT automatically cleaned up.
 */
@Component
@Profile("dev")
class DevAudioFileStrategy : AudioFileStrategy {
    override fun createAudioFile(audioData: ByteArray, timestamp: Long): File {
        val file = File("audio-recordings", "audio_$timestamp.wav")
        file.parentFile?.mkdirs()
        WavFileWriter.writeWavFile(audioData, file)
        return file
    }

    override fun shouldCleanup(): Boolean {
        // Keep files in dev mode for debugging
        return false
    }
}
