package com.plugin.processor.topology

import com.plugin.core.pipeline.SessionClosedRecord
import com.plugin.core.replay.SessionMetadata
import com.plugin.core.replay.SessionMetadataRepository
import com.plugin.core.storage.ObjectStore
import com.plugin.core.util.logger
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import org.apache.kafka.streams.kstream.KStream
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import reactor.core.publisher.Flux
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.time.Instant
import java.util.function.Consumer
import java.util.zip.GZIPInputStream

/**
 * Final stage. Triggered on every [SessionClosedRecord], walks all anonymized
 * chunks for the session range, derives metadata, upserts the
 * [SessionMetadata] row in Postgres.
 *
 * v1 is intentionally non-incremental: it reads all the anon chunks for the
 * session in one pass after the session closes. The incremental design — a
 * KTable running aggregate over `chunks.anonymized` joined with
 * `sessions.closed` for finalization — is a follow-up (see FOLLOWUP.md).
 *
 * Idempotent: re-delivery from a rebalance re-reads the same S3 keys and the
 * `SessionMetadataRepository.upsert` is delete-then-insert.
 */
@Configuration
class ProcessorTopology(
    private val objectStore: ObjectStore,
    private val repository: SessionMetadataRepository,
) {

    private val log = logger()
    private val json = Json { ignoreUnknownKeys = true }

    @Bean
    fun finalize(): Consumer<KStream<String, SessionClosedRecord>> = Consumer { input ->
        input.foreach { _, value -> runBlocking { process(value) } }
    }

    private suspend fun process(closed: SessionClosedRecord) {
        log.info(
            "processor: finalize session={} org={} seqs={}..{} count={}",
            closed.sessionId, closed.orgId, closed.firstSeq, closed.lastSeq, closed.chunkCount,
        )

        var eventCount = 0L
        var pageTransitions = 0
        var firstTs: Long? = null
        var lastTs: Long? = null
        var chunksRead = 0L

        if (closed.firstSeq <= closed.lastSeq) {
            for (seq in closed.firstSeq..closed.lastSeq) {
                val key = anonKey(closed.orgId, closed.sessionId, seq)
                val bytes = readKey(key)
                if (bytes == null) {
                    log.warn("processor: missing anon chunk {}; skipping", key)
                    continue
                }
                chunksRead++
                val ndjson = GZIPInputStream(bytes.inputStream()).readBytes().toString(Charsets.UTF_8)
                ndjson.lineSequence().forEach line@{ line ->
                    if (line.isBlank()) return@line
                    val obj = try {
                        json.parseToJsonElement(line).jsonObject
                    } catch (e: Exception) {
                        log.warn("processor: bad ndjson in {}: {}", key, line.take(120))
                        return@line
                    }
                    eventCount++
                    val type = obj["type"]?.jsonPrimitive?.longOrNull
                    val ts = obj["timestamp"]?.jsonPrimitive?.longOrNull
                    if (type == 4L) pageTransitions++
                    if (ts != null) {
                        if (firstTs == null || ts < firstTs!!) firstTs = ts
                        if (lastTs == null || ts > lastTs!!) lastTs = ts
                    }
                }
            }
        }

        val duration = if (firstTs != null && lastTs != null) (lastTs!! - firstTs!!) else 0L
        repository.upsert(
            SessionMetadata(
                sessionId = closed.sessionId,
                orgId = closed.orgId,
                firstSeq = closed.firstSeq,
                lastSeq = closed.lastSeq,
                chunkCount = chunksRead,
                eventCount = eventCount,
                durationMs = duration,
                pageTransitions = pageTransitions,
                firstEventAt = firstTs?.let { Instant.ofEpochMilli(it) },
                lastEventAt = lastTs?.let { Instant.ofEpochMilli(it) },
            ),
        )
        log.info(
            "processor: done session={} chunks={} events={} dur={}ms pages={}",
            closed.sessionId, chunksRead, eventCount, duration, pageTransitions,
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
}
