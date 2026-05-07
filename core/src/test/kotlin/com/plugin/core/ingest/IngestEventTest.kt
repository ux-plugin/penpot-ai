package com.plugin.core.ingest

import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import java.time.Instant

class IngestEventTest {

    @Test
    fun `CHUNK event round-trips through Redis field map`() {
        val original = IngestEvent(
            type = IngestEvent.Type.CHUNK,
            orgId = "org-A",
            sessionId = "sess-1",
            chunkSeq = 7,
            s3Key = "org/org-A/sess/sess-1/0000000007.ndjson.gz",
            sizeBytes = 1234L,
            receivedAt = Instant.ofEpochMilli(1_700_000_000_000L),
        )
        val fields = original.toRedisFields()
        val decoded = IngestEvent.fromRedisFields(fields)
        assertThat(decoded).isEqualTo(original)
    }

    @Test
    fun `CLOSE_HINT event omits chunk-specific fields`() {
        val original = IngestEvent(
            type = IngestEvent.Type.CLOSE_HINT,
            orgId = "org-B",
            sessionId = "sess-2",
            receivedAt = Instant.ofEpochMilli(1_700_000_000_000L),
        )
        val fields = original.toRedisFields()
        assertThat(fields).doesNotContainKeys("chunkSeq", "s3Key", "sizeBytes")
        val decoded = IngestEvent.fromRedisFields(fields)
        assertThat(decoded).isEqualTo(original)
    }

    @Test
    fun `Redis field map carries the type as a string compatible with Type valueOf`() {
        val event = IngestEvent(type = IngestEvent.Type.CHUNK, orgId = "o", sessionId = "s")
        assertThat(event.toRedisFields()["type"]).isEqualTo("CHUNK")
    }
}
