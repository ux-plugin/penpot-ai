package com.plugin.api.features.replay

import com.fasterxml.jackson.databind.JsonNode
import com.plugin.core.replay.SessionMetadata
import java.time.Instant

data class SessionSummary(
    val sessionId: String,
    val orgId: String,
    val chunkCount: Long,
    val eventCount: Long,
    val durationMs: Long,
    val pageTransitions: Int,
    val firstEventAt: Instant?,
    val lastEventAt: Instant?,
    val processedAt: Instant,
) {
    companion object {
        fun from(m: SessionMetadata) = SessionSummary(
            sessionId = m.sessionId,
            orgId = m.orgId,
            chunkCount = m.chunkCount,
            eventCount = m.eventCount,
            durationMs = m.durationMs,
            pageTransitions = m.pageTransitions,
            firstEventAt = m.firstEventAt,
            lastEventAt = m.lastEventAt,
            processedAt = m.processedAt,
        )
    }
}

data class ReplayPayload(
    val sessionId: String,
    val eventCount: Int,
    val events: List<JsonNode>,
)
