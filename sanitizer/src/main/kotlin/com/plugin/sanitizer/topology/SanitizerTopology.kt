package com.plugin.sanitizer.topology

import com.plugin.core.pipeline.RawRecord
import com.plugin.core.pipeline.SanitizedRecord
import com.plugin.core.pipeline.SessionClosedRecord
import com.plugin.core.pipeline.Topics
import com.plugin.core.util.logger
import org.apache.kafka.streams.kstream.KStream
import org.apache.kafka.streams.kstream.Materialized
import org.apache.kafka.streams.kstream.SessionWindows
import org.apache.kafka.streams.kstream.Suppressed
import org.apache.kafka.streams.kstream.Suppressed.BufferConfig
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.time.Duration
import java.util.function.Consumer

/**
 * Two parallel walks of `chunks.raw`:
 *
 *  1. Per-chunk forward — CHUNK records flow through with a default
 *     [SanitizedRecord.Classification.SANITIZED]. Real classification (DROP /
 *     QUARANTINE / SANITIZED) is a follow-up; the legacy `ChunkClassifier`
 *     ran against the whole session, which doesn't map cleanly to per-chunk.
 *
 *  2. Session window aggregate — chunks grouped by `sessionId` into a session
 *     window of [INACTIVITY_GAP] inactivity. When the window closes, we emit one
 *     [SessionClosedRecord] to `sessions.closed` with the seq range + count.
 *
 * The `suppress(untilWindowCloses)` operator buffers the running aggregate in a
 * changelog-backed store so only the final per-session record is emitted, not
 * one update per chunk.
 *
 * CLOSE_HINT records (from the client `sendBeacon` path) currently flow through
 * the same stream. The aggregate filters them out so they don't extend the
 * window. Immediate close on CLOSE_HINT (latency-sensitive path) needs a
 * Transformer with a custom punctuator — see FOLLOWUP.md.
 */
@Configuration
class SanitizerTopology {

    private val log = logger()

    @Bean
    fun sanitize(): Consumer<KStream<String, RawRecord>> = Consumer { input ->
        // Branch 1: forward every CHUNK record to chunks.sanitized.
        input
            .filter { _, value -> value.type == RawRecord.Type.CHUNK && value.seq != null && value.s3Key != null }
            .mapValues { _, value ->
                SanitizedRecord(
                    orgId = value.orgId,
                    sessionId = value.sessionId,
                    seq = value.seq!!,
                    s3Key = value.s3Key!!,
                    sizeBytes = value.sizeBytes ?: 0L,
                    classification = SanitizedRecord.Classification.SANITIZED,
                    capturedAt = value.capturedAt,
                )
            }
            .peek { key, value ->
                log.debug("sanitize → chunks.sanitized: session={} seq={} s3Key={}", key, value.seq, value.s3Key)
            }
            .to(Topics.CHUNKS_SANITIZED)

        // Branch 2: aggregate per session into a session window. Close when no
        // chunks arrive for INACTIVITY_GAP. Suppress until window closes so we
        // emit exactly one SessionClosedRecord per session.
        input
            .filter { _, value -> value.type == RawRecord.Type.CHUNK && value.seq != null }
            .groupByKey()
            .windowedBy(SessionWindows.ofInactivityGapWithNoGrace(INACTIVITY_GAP))
            .aggregate(
                /* initializer = */ { SessionAggregate("", 0L, Long.MAX_VALUE, Long.MIN_VALUE) },
                /* aggregator  = */ { _, value, agg ->
                    val seq = value.seq!!
                    SessionAggregate(
                        orgId = value.orgId,    // every chunk carries it; safe to overwrite
                        count = agg.count + 1,
                        firstSeq = minOf(agg.firstSeq, seq),
                        lastSeq = maxOf(agg.lastSeq, seq),
                    )
                },
                /* merger      = */ { _, a, b ->
                    SessionAggregate(
                        orgId = a.orgId.ifEmpty { b.orgId },
                        count = a.count + b.count,
                        firstSeq = minOf(a.firstSeq, b.firstSeq),
                        lastSeq = maxOf(a.lastSeq, b.lastSeq),
                    )
                },
                Materialized.`as`<String, SessionAggregate, org.apache.kafka.streams.state.SessionStore<org.apache.kafka.common.utils.Bytes, ByteArray>>("session-aggregate-store")
                    .withKeySerde(com.plugin.core.pipeline.JsonSerdes.stringSerde)
                    .withValueSerde(com.plugin.core.pipeline.JsonSerdes.of<SessionAggregate>()),
            )
            .suppress(Suppressed.untilWindowCloses(BufferConfig.unbounded()))
            .toStream()
            .map { windowedKey, agg ->
                val sessionId = windowedKey.key()
                val record = SessionClosedRecord(
                    orgId = agg.orgId,
                    sessionId = sessionId,
                    firstSeq = agg.firstSeq,
                    lastSeq = agg.lastSeq,
                    chunkCount = agg.count,
                    reason = SessionClosedRecord.Reason.IDLE_TIMEOUT,
                )
                org.apache.kafka.streams.KeyValue.pair(sessionId, record)
            }
            .peek { key, value ->
                log.info(
                    "sanitize → sessions.closed: session={} count={} seqs={}..{} reason={}",
                    key, value.chunkCount, value.firstSeq, value.lastSeq, value.reason,
                )
            }
            .to(Topics.SESSIONS_CLOSED)
    }

    /**
     * Running per-session aggregate kept in a RocksDB session-store, replicated
     * via a Kafka changelog topic for crash recovery. Only carries the fields
     * the processor strictly needs; org id is recovered downstream by joining
     * with chunks.anonymized.
     *
     * Kept public so the JsonSerde can reflect over it.
     */
    data class SessionAggregate(
        val orgId: String,
        val count: Long,
        val firstSeq: Long,
        val lastSeq: Long,
    )

    companion object {
        /**
         * Matches the legacy `worker.session.idle-timeout-sec: 600`. Sessions
         * with no chunks for 10 minutes are considered closed.
         */
        val INACTIVITY_GAP: Duration = Duration.ofMinutes(10)
    }
}
