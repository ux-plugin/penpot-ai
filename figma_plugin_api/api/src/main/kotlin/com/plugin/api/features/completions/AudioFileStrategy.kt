package com.plugin.api.features.completions

import java.io.File

/**
 * Strategy interface for handling audio file creation and lifecycle. Different implementations can be provided based on
 * Spring profiles.
 */
interface AudioFileStrategy {
    /**
     * Create an audio file from the provided audio data.
     *
     * @param audioData Raw audio bytes
     * @param timestamp Timestamp to use in filename
     * @return File object representing the created audio file
     */
    fun createAudioFile(audioData: ByteArray, timestamp: Long): File

    /**
     * Determines if the audio file should be cleaned up after processing.
     *
     * @return true if the file should be deleted, false to keep it
     */
    fun shouldCleanup(): Boolean
}
