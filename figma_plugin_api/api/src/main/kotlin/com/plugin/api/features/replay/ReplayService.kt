package com.plugin.api.features.replay

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.core.replay.SessionMetadata
import com.plugin.core.replay.SessionMetadataRepository
import com.plugin.core.storage.ObjectStore
import com.plugin.core.util.logger
import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.springframework.stereotype.Service
import reactor.core.publisher.Flux
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.zip.GZIPInputStream

@Service
class ReplayService(
    private val repository: SessionMetadataRepository,
    private val objectStore: ObjectStore,
    private val mapper: ObjectMapper,
) {
    private val log = logger()

    suspend fun list(orgId: String): List<SessionSummary> =
        repository.listByOrg(orgId).map { SessionSummary.from(it) }

    suspend fun getMetadata(orgId: String, sessionId: String): SessionMetadata? {
        val meta = repository.findById(sessionId) ?: return null
        if (meta.orgId != orgId) return null
        return meta
    }

    /**
     * Fetches every anon chunk for [sessionId], gunzips, parses each NDJSON line into
     * a JsonNode, returns the concatenated event array for `rrweb-player`. Bounded by
     * `chunkCount × maxChunkSizeBytes` — fine for demo sessions, swap to streaming
     * if real workloads land here.
     */
    suspend fun getReplay(orgId: String, sessionId: String): ReplayPayload? {
        val meta = getMetadata(orgId, sessionId) ?: return null
        val events = ArrayList<JsonNode>(meta.eventCount.toInt().coerceAtLeast(0))
        for (seq in meta.firstSeq..meta.lastSeq) {
            val key = anonKey(orgId, sessionId, seq)
            val bytes = readKey(key)
            if (bytes == null) {
                log.warn("replay: missing anon chunk {}; skipping", key)
                continue
            }
            val ndjson = GZIPInputStream(bytes.inputStream()).readBytes().toString(Charsets.UTF_8)
            ndjson.lineSequence().forEach { line ->
                if (line.isBlank()) return@forEach
                try {
                    events.add(mapper.readTree(line))
                } catch (e: Exception) {
                    log.warn("replay: bad ndjson line in {}: {}", key, line.take(120))
                }
            }
        }
        return ReplayPayload(sessionId = sessionId, eventCount = events.size, events = events)
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
