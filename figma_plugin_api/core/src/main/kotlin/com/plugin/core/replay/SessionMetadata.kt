package com.plugin.core.replay

import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.javatime.timestamp
import java.time.Instant

data class SessionMetadata(
    val sessionId: String,
    val orgId: String,
    val firstSeq: Long,
    val lastSeq: Long,
    val chunkCount: Long,
    val eventCount: Long,
    val durationMs: Long,
    val pageTransitions: Int,
    val firstEventAt: Instant?,
    val lastEventAt: Instant?,
    val processedAt: Instant = Instant.now(),
)

object SessionMetadataTable : Table("session_metadata") {
    val sessionId = varchar("session_id", 255)
    val orgId = varchar("org_id", 255)
    val firstSeq = long("first_seq")
    val lastSeq = long("last_seq")
    val chunkCount = long("chunk_count")
    val eventCount = long("event_count")
    val durationMs = long("duration_ms")
    val pageTransitions = integer("page_transitions")
    val firstEventAt = timestamp("first_event_at").nullable()
    val lastEventAt = timestamp("last_event_at").nullable()
    val processedAt = timestamp("processed_at")

    override val primaryKey = PrimaryKey(sessionId)
}
