package com.plugin.anonymizer.lifecycle

import com.plugin.anonymizer.rules.RrwebTransformer
import com.plugin.core.config.properties.AnonymizerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.storage.ObjectStore
import com.plugin.core.util.logger
import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.springframework.stereotype.Service
import reactor.core.publisher.Flux
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/**
 * Per-session orchestration triggered by a `SESSION_SANITIZED` event:
 *
 *   for seq in firstSeq..lastSeq:
 *     read raw/<orgId>/<sessionId>/<seq>.ndjson.gz
 *     transform via RrwebTransformer (drop Input events, scrub PII, strip query strings)
 *     write anon/<orgId>/<sessionId>/<seq>.ndjson.gz
 *   publish SESSION_ANONYMIZED → ingest.anon
 *   publish RAW_PROCESSED      → ingest.raw.processed (sanitizer eviction trigger)
 *
 * Idempotent: re-running overwrites the same anon keys with identical content (transformer
 * is deterministic) and re-emits the same events. Downstream dedup is the consumer group's
 * job; we do not track per-session state here.
 *
 * Failure modes:
 *  - Missing raw key → log + skip that seq. The sanitizer guarantees contiguity at this
 *    point, so a missing key implies a race with a redelivered eviction; safer to continue
 *    with the available chunks than to retry forever.
 *  - Transformer throws → bubbles up to the consumer, which leaves the message in PEL for
 *    XAUTOCLAIM to retry.
 *  - Publish fails after some writes succeeded → message stays in PEL; on retry the writes
 *    are no-ops (server-side overwrite) and the publish reruns. No leakage.
 */
@Service
class SessionAnonymizationService(
    private val objectStore: ObjectStore,
    private val transformer: RrwebTransformer,
    private val anonStreamPublisher: AnonStreamPublisher,
    private val rawProcessedStreamPublisher: RawProcessedStreamPublisher,
    private val props: AnonymizerProperties,
) {
    private val log = logger()

    suspend fun anonymize(orgId: String, sessionId: String, firstSeq: Long, lastSeq: Long) {
        if (firstSeq > lastSeq) {
            log.warn("anonymize: empty seq range for {} ({}..{}); nothing to do", sessionId, firstSeq, lastSeq)
            return
        }

        var written = 0
        for (seq in firstSeq..lastSeq) {
            val raw = rawKey(orgId, sessionId, seq)
            val rawBytes = readKey(raw)
            if (rawBytes == null) {
                log.warn("anonymize: raw chunk missing {}; skipping", raw)
                continue
            }
            val anonBytes = transformer.transformGzipped(rawBytes)
            val anon = anonKey(orgId, sessionId, seq)
            objectStore.put(
                anon,
                Flux.just(ByteBuffer.wrap(anonBytes)),
                anonBytes.size.toLong(),
                "application/x-ndjson",
            )
            written++
        }

        val chunkCount = (lastSeq - firstSeq + 1)
        anonStreamPublisher.publish(
            IngestEvent(
                type = IngestEvent.Type.SESSION_ANONYMIZED,
                orgId = orgId,
                sessionId = sessionId,
                chunkCount = chunkCount,
                firstSeq = firstSeq,
                lastSeq = lastSeq,
            ),
        )
        rawProcessedStreamPublisher.publish(
            IngestEvent(
                type = IngestEvent.Type.RAW_PROCESSED,
                orgId = orgId,
                sessionId = sessionId,
            ),
        )
        log.info("anonymize: {} → {} chunks written under anon/{}/{}/", sessionId, written, orgId, sessionId)
    }

    private suspend fun readKey(key: String): ByteArray? {
        val getResult = objectStore.get(key) ?: return null
        val flux: Flux<ByteBuffer> = if (getResult.body is Flux<*>) {
            @Suppress("UNCHECKED_CAST") getResult.body as Flux<ByteBuffer>
        } else {
            Flux.from(getResult.body)
        }
        val out = ByteArrayOutputStream()
        flux.collectList().awaitFirstOrNull().orEmpty().forEach { buf ->
            val arr = ByteArray(buf.remaining())
            buf.get(arr)
            out.write(arr)
        }
        return out.toByteArray()
    }

    private fun rawKey(orgId: String, sessionId: String, seq: Long): String =
        prefixed("raw/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz")

    private fun anonKey(orgId: String, sessionId: String, seq: Long): String =
        prefixed("anon/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz")

    private fun prefixed(key: String): String =
        if (props.s3KeyPrefix.isEmpty()) key else "${props.s3KeyPrefix.trimEnd('/')}/$key"
}
