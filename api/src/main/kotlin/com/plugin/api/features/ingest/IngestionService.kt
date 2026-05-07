package com.plugin.api.features.ingest

import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.ingest.BackpressureGuard
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.core.storage.ObjectStore
import org.reactivestreams.Publisher
import org.springframework.stereotype.Service
import java.nio.ByteBuffer
import java.time.Instant

/**
 * Ingest pipeline entry point. Stateless: every chunk is treated as new.
 * Sanitizer (Ticket #46) owns dedup, gap detection and lifecycle — this service is a
 * dumb passthrough that streams the chunk to S3 and announces it on the Redis stream.
 */
@Service
class IngestionService(
    private val objectStore: ObjectStore,
    private val streamPublisher: IngestStreamPublisher,
    private val backpressureGuard: BackpressureGuard,
    private val props: IngestProperties,
) {

    suspend fun acceptChunk(
        orgId: String,
        sessionId: String,
        chunkSeq: Long,
        contentLength: Long,
        body: Publisher<ByteBuffer>,
        contentType: String? = "application/x-ndjson",
    ): IngestAcceptResponse {
        backpressureGuard.assertCapacity()

        val key = chunkKey(orgId, sessionId, chunkSeq)
        val putResult = objectStore.put(key, body, contentLength, contentType)
        streamPublisher.publish(
            IngestEvent(
                type = IngestEvent.Type.CHUNK,
                orgId = orgId,
                sessionId = sessionId,
                chunkSeq = chunkSeq,
                s3Key = key,
                sizeBytes = contentLength,
                receivedAt = Instant.now(),
            ),
        )

        return IngestAcceptResponse(key = key, etag = putResult.etag, sizeBytes = contentLength)
    }

    suspend fun acceptCloseHint(orgId: String, sessionId: String): CloseSessionResponse {
        streamPublisher.publish(
            IngestEvent(
                type = IngestEvent.Type.CLOSE_HINT,
                orgId = orgId,
                sessionId = sessionId,
                receivedAt = Instant.now(),
            ),
        )
        return CloseSessionResponse(sessionId = sessionId)
    }

    /**
     * Key layout: `[<configurablePrefix>/]raw/<orgId>/<sessionId>/<chunkSeq.zeroPad(10)>.ndjson.gz`.
     *
     * The `raw/` segment is reserved by the data-protection layout (see Notion design contracts):
     * sanitizer + lifecycle policy both target this prefix for short-retention eviction. Anonymizer
     * later writes under `anon/`, sanitizer moves quarantine sessions under `quarantine/`.
     */
    private fun chunkKey(orgId: String, sessionId: String, chunkSeq: Long): String =
        buildString {
            if (props.s3KeyPrefix.isNotEmpty()) append(props.s3KeyPrefix.trimEnd('/')).append('/')
            append("raw/").append(orgId)
            append('/').append(sessionId)
            append('/').append(chunkSeq.toString().padStart(10, '0'))
            append(".ndjson.gz")
        }
}
