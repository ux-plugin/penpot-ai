package com.plugin.core.pipeline

import java.time.Instant

/**
 * Schema for [Topics.SESSIONS_CLOSED]. Emitted by the sanitizer when a session
 * window closes (inactivity gap expires). The processor consumes this to know
 * a session is complete and metadata can be finalized.
 *
 * Carries the seq range so the processor can iterate the anonymized chunks for
 * the session. In a future, more reactive design the processor maintains a
 * running per-session aggregate from [Topics.CHUNKS_ANONYMIZED] and just stamps
 * it `finalized=true` on this record (see FOLLOWUP.md).
 */
data class SessionClosedRecord(
    val orgId: String,
    val sessionId: String,
    val firstSeq: Long,
    val lastSeq: Long,
    val chunkCount: Long,
    val reason: Reason,
    val closedAt: Instant = Instant.now(),
) {
    enum class Reason {
        /** Client called the explicit close-hint endpoint. Not yet wired in v1. */
        CLIENT_HINT,

        /** Session window's inactivity gap expired without further chunks. */
        IDLE_TIMEOUT,
    }
}
