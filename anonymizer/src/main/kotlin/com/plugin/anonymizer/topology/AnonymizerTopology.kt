package com.plugin.anonymizer.topology

import com.plugin.anonymizer.rules.RrwebTransformer
import com.plugin.core.config.properties.AnonymizerProperties
import com.plugin.core.pipeline.AnonymizedRecord
import com.plugin.core.pipeline.SanitizedRecord
import com.plugin.core.storage.ObjectStore
import com.plugin.core.util.logger
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import org.apache.kafka.streams.kstream.KStream
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import reactor.core.publisher.Flux
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.time.Instant
import java.util.function.Function

/**
 * Per-chunk anonymizer. Consumes `chunks.sanitized`, for each SANITIZED chunk:
 *
 *   1. Read `raw/<orgId>/<sessionId>/<seq>.ndjson.gz` from S3.
 *   2. Apply [RrwebTransformer] (stateless — drop Input events, strip query
 *      strings, regex-scrub text).
 *   3. PUT `anon/<orgId>/<sessionId>/<seq>.ndjson.gz`.
 *   4. Forward [AnonymizedRecord] to `chunks.anonymized`.
 *
 * Side effects (S3 reads/writes) happen inside `mapValues`. Idempotent because
 * S3 PUT with the same key is a deterministic overwrite — re-processing the
 * same chunk (rebalance, retry) just rewrites the same bytes.
 *
 * QUARANTINE / DROP classifications are filtered out — only SANITIZED chunks
 * are anonymized. v1 always classifies as SANITIZED upstream, so this filter
 * is a no-op until per-chunk classification is added (see FOLLOWUP.md).
 *
 * `runBlocking` bridges Kafka Streams' synchronous mapValues to the suspend
 * `objectStore` API. Acceptable here because each stream thread processes
 * records serially. A non-blocking variant is a follow-up.
 */
@Configuration
class AnonymizerTopology(
    private val objectStore: ObjectStore,
    private val transformer: RrwebTransformer,
    private val props: AnonymizerProperties,
) {

    private val log = logger()

    @Bean
    fun anonymize(): Function<KStream<String, SanitizedRecord>, KStream<String, AnonymizedRecord>> = Function { input ->
        input
            .filter { _, value -> value.classification == SanitizedRecord.Classification.SANITIZED }
            .mapValues { _, value -> anonymizeChunk(value) }
            .filter { _, value -> value != null }
            .mapValues { _, value -> value!! }
    }

    private fun anonymizeChunk(rec: SanitizedRecord): AnonymizedRecord? = runBlocking {
        val rawKey = prefixed(rec.s3Key)
        val anonKey = prefixed(anonKey(rec.orgId, rec.sessionId, rec.seq))

        val rawBytes = readKey(rawKey)
        if (rawBytes == null) {
            log.warn("anonymize: raw chunk missing {}; dropping", rawKey)
            return@runBlocking null
        }

        val anonBytes = transformer.transformGzipped(rawBytes)
        objectStore.put(
            anonKey,
            Flux.just(ByteBuffer.wrap(anonBytes)),
            anonBytes.size.toLong(),
            "application/x-ndjson",
        )

        log.debug("anonymize: session={} seq={} raw={}→{} bytes", rec.sessionId, rec.seq, rawBytes.size, anonBytes.size)

        AnonymizedRecord(
            orgId = rec.orgId,
            sessionId = rec.sessionId,
            seq = rec.seq,
            anonKey = anonKey,
            capturedAt = Instant.now(),
        )
    }

    private suspend fun readKey(key: String): ByteArray? {
        val r = objectStore.get(key) ?: return null
        val flux: Flux<ByteBuffer> = if (r.body is Flux<*>) {
            @Suppress("UNCHECKED_CAST") r.body as Flux<ByteBuffer>
        } else {
            Flux.from(r.body)
        }
        val out = ByteArrayOutputStream()
        flux.collectList().awaitFirstOrNull().orEmpty().forEach { buf ->
            val arr = ByteArray(buf.remaining()); buf.get(arr); out.write(arr)
        }
        return out.toByteArray()
    }

    private fun anonKey(orgId: String, sessionId: String, seq: Long): String =
        "anon/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz"

    private fun prefixed(key: String): String =
        if (props.s3KeyPrefix.isEmpty()) key else "${props.s3KeyPrefix.trimEnd('/')}/$key"
}
