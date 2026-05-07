package com.plugin.core.ingest

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.time.Instant

class IngestEventTest {

    @Test
    fun `CHUNK round-trips through Redis fields`() {
        val original = IngestEvent(
            type = IngestEvent.Type.CHUNK,
            orgId = "org-A",
            sessionId = "sess-1",
            chunkSeq = 7,
            s3Key = "raw/org-A/sess-1/0000000007.ndjson.gz",
            sizeBytes = 1234L,
            receivedAt = Instant.ofEpochMilli(1_700_000_000_000L),
        )
        assertThat(IngestEvent.fromRedisFields(original.toRedisFields())).isEqualTo(original)
    }

    @Test
    fun `SESSION_SANITIZED carries chunkCount, firstSeq, lastSeq, classification`() {
        val original = IngestEvent(
            type = IngestEvent.Type.SESSION_SANITIZED,
            orgId = "org-A",
            sessionId = "sess-1",
            chunkCount = 5,
            firstSeq = 0,
            lastSeq = 4,
            classification = "ok",
            receivedAt = Instant.ofEpochMilli(1_700_000_000_000L),
        )
        assertThat(IngestEvent.fromRedisFields(original.toRedisFields())).isEqualTo(original)
    }

    @Test
    fun `every Type value can round-trip with its minimum field set`() {
        // Pin receivedAt to ms precision since the Redis codec serializes via toEpochMilli().
        val timestamp = Instant.ofEpochMilli(1_700_000_000_000L)
        IngestEvent.Type.entries.forEach { type ->
            val event = IngestEvent(type = type, orgId = "org-A", sessionId = "sess-1", receivedAt = timestamp)
            assertThat(IngestEvent.fromRedisFields(event.toRedisFields())).isEqualTo(event)
        }
    }
}
