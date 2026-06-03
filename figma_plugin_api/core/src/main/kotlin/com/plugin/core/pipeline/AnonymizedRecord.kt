package com.plugin.core.pipeline

import java.time.Instant

/**
 * Schema for [Topics.CHUNKS_ANONYMIZED]. One record per chunk after the anonymizer
 * has written the scrubbed copy to S3 under `anon/<orgId>/<sessionId>/<seq>`.
 */
data class AnonymizedRecord(
    val orgId: String,
    val sessionId: String,
    val seq: Long,
    val anonKey: String,
    val capturedAt: Instant = Instant.now(),
)
