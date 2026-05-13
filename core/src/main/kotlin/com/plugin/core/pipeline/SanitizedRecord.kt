package com.plugin.core.pipeline

import java.time.Instant

/**
 * Schema for [Topics.CHUNKS_SANITIZED]. Emitted per chunk after sanitizer-side
 * classification. v1 forwards every CHUNK input straight through with
 * [classification] = SANITIZED — full per-chunk classification logic is a
 * follow-up (see FOLLOWUP.md).
 *
 * QUARANTINE and DROP paths from the legacy `SessionLifecycleService` are not
 * yet implemented in the topology; chunks that would have been quarantined
 * currently flow through as SANITIZED.
 */
data class SanitizedRecord(
    val orgId: String,
    val sessionId: String,
    val seq: Long,
    val s3Key: String,
    val sizeBytes: Long,
    val classification: Classification = Classification.SANITIZED,
    val capturedAt: Instant = Instant.now(),
) {
    enum class Classification { SANITIZED, QUARANTINE, DROP }
}
