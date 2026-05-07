package com.plugin.sanitizer.classify

import com.fasterxml.jackson.databind.ObjectMapper
import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.storage.ObjectStore
import com.plugin.core.util.logger
import com.plugin.sanitizer.state.SessionState
import kotlinx.coroutines.reactive.awaitFirstOrNull
import org.springframework.stereotype.Component
import reactor.core.publisher.Flux
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.zip.GZIPInputStream

/**
 * Decides what happens to a closed session: DROP, SANITIZED, or QUARANTINE. Pure
 * decision logic except for one IO read — verifying the first chunk contains an rrweb
 * FullSnapshot (event type 2). Without that the session can't be replayed even if all
 * subsequent chunks are present.
 */
@Component
class ChunkClassifier(
    private val objectStore: ObjectStore,
    private val props: WorkerProperties,
    private val mapper: ObjectMapper = ObjectMapper(),
) {
    private val log = logger()

    suspend fun classify(state: SessionState): ClassificationResult {
        if (state.chunkCount < props.session.minChunksToKeep) {
            return ClassificationResult(Classification.DROP, "chunk_count_below_threshold")
        }
        val gaps = state.gaps()
        if (gaps.isNotEmpty()) {
            return ClassificationResult(Classification.QUARANTINE, "gaps_at:$gaps")
        }
        if (!hasFullSnapshot(state)) {
            return ClassificationResult(Classification.QUARANTINE, "missing_full_snapshot")
        }
        return ClassificationResult(Classification.SANITIZED, "ok")
    }

    /**
     * Reads the session's first chunk from S3 (`raw/<orgId>/<sessionId>/0000000000.ndjson.gz`),
     * gunzips it, scans line-by-line for an rrweb event with `type=2` (FullSnapshot).
     * Returns false if the chunk is missing, malformed, or never contains a FullSnapshot.
     */
    private suspend fun hasFullSnapshot(state: SessionState): Boolean {
        val firstSeq = state.firstSeq() ?: return false
        val key = firstChunkKey(state.orgId, state.sessionId, firstSeq)
        val getResult = objectStore.get(key) ?: run {
            log.warn("classifier: first chunk missing for {} ({}). Treating as no FullSnapshot.", state.sessionId, key)
            return false
        }

        val bytes = collect(getResult.body)
        val decoded = try {
            gunzip(bytes)
        } catch (e: Exception) {
            log.warn("classifier: gunzip failed for {} ({}): {}", state.sessionId, key, e.message)
            return false
        }
        return decoded.lineSequence().any { line ->
            if (line.isBlank()) return@any false
            runCatching { mapper.readTree(line).get("type")?.asInt() == FULL_SNAPSHOT_EVENT_TYPE }
                .getOrDefault(false)
        }
    }

    private suspend fun collect(publisher: org.reactivestreams.Publisher<ByteBuffer>): ByteArray {
        val flux: Flux<ByteBuffer> = if (publisher is Flux<*>) {
            @Suppress("UNCHECKED_CAST") publisher as Flux<ByteBuffer>
        } else {
            Flux.from(publisher)
        }
        val out = ByteArrayOutputStream()
        flux.collectList().awaitFirstOrNull().orEmpty().forEach { buf ->
            val arr = ByteArray(buf.remaining())
            buf.get(arr)
            out.write(arr)
        }
        return out.toByteArray()
    }

    private fun gunzip(bytes: ByteArray): String =
        GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader(Charsets.UTF_8).use { it.readText() }

    private fun firstChunkKey(orgId: String, sessionId: String, seq: Long): String =
        "raw/$orgId/$sessionId/${seq.toString().padStart(10, '0')}.ndjson.gz"

    companion object {
        /** rrweb event type for FullSnapshot. See https://github.com/rrweb-io/rrweb/blob/master/packages/types/src/index.ts */
        private const val FULL_SNAPSHOT_EVENT_TYPE = 2
    }
}
