package com.plugin.core.pipeline

import java.time.Instant

/**
 * Schema for [Topics.CHUNKS_RAW]. The API produces these as chunks are uploaded.
 *
 * Two variants distinguished by [type]:
 *  - [Type.CHUNK]: a new raw chunk has landed in S3 at [s3Key]. [seq] + [sizeBytes]
 *    are required.
 *  - [Type.CLOSE_HINT]: client explicitly closed the session (sendBeacon path).
 *    [seq], [s3Key], [sizeBytes] are null.
 *
 * Kafka key is `sessionId` (set by the producer via message headers) so all records
 * for a session land on one partition — sanitizer's session-window aggregate then
 * sees them in order.
 *
 * Note: CLOSE_HINT handling in the topology is a follow-up (see FOLLOWUP.md). For
 * v1 the sanitizer only relies on the inactivity-gap window for close detection,
 * so CLOSE_HINTs flowing through the stream are tolerated but don't trigger early
 * close.
 */
data class RawRecord(
    val type: Type = Type.CHUNK,
    val orgId: String,
    val sessionId: String,
    val seq: Long? = null,
    val s3Key: String? = null,
    val sizeBytes: Long? = null,
    val capturedAt: Instant = Instant.now(),
) {
    enum class Type { CHUNK, CLOSE_HINT }
}
