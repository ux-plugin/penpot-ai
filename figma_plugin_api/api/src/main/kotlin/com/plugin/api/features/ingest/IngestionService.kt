package com.plugin.api.features.ingest

import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.pipeline.RawRecord
import com.plugin.core.storage.ObjectStore
import org.reactivestreams.Publisher
import org.springframework.cloud.stream.function.StreamBridge
import org.springframework.kafka.support.KafkaHeaders
import org.springframework.messaging.support.MessageBuilder
import org.springframework.stereotype.Service
import java.nio.ByteBuffer
import java.time.Instant

/**
 * Ingest pipeline entry point. Stateless: every chunk is treated as new.
 *
 * Uploads the chunk to S3 then publishes a [RawRecord] to Kafka via the SCS output
 * binding `chunkProducer-out-0` → `chunks.raw`. The `sessionId` is set as the Kafka
 * message key so downstream Kafka Streams stages see per-session ordering.
 *
 * The XLEN-based backpressure that used to wrap each call is gone — Kafka producer
 * has its own buffer + send timeout. Sustained overload now surfaces as a producer
 * buffer-full exception on send rather than a pre-flight 503.
 */
@Service
class IngestionService(
    private val objectStore: ObjectStore,
    private val streamBridge: StreamBridge,
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
        val key = chunkKey(orgId, sessionId, chunkSeq)
        val putResult = objectStore.put(key, body, contentLength, contentType)

        sendKeyed(
            sessionId,
            RawRecord(
                type = RawRecord.Type.CHUNK,
                orgId = orgId,
                sessionId = sessionId,
                seq = chunkSeq,
                s3Key = key,
                sizeBytes = contentLength,
                capturedAt = Instant.now(),
            ),
        )

        return IngestAcceptResponse(key = key, etag = putResult.etag, sizeBytes = contentLength)
    }

    suspend fun acceptCloseHint(orgId: String, sessionId: String): CloseSessionResponse {
        sendKeyed(
            sessionId,
            RawRecord(
                type = RawRecord.Type.CLOSE_HINT,
                orgId = orgId,
                sessionId = sessionId,
                capturedAt = Instant.now(),
            ),
        )
        return CloseSessionResponse(sessionId = sessionId)
    }

    private fun sendKeyed(sessionId: String, record: RawRecord) {
        val msg = MessageBuilder.withPayload(record)
            .setHeader(KafkaHeaders.KEY, sessionId)
            .build()
        streamBridge.send(CHUNK_PRODUCER_BINDING, msg)
    }

    /**
     * Key layout: `[<configurablePrefix>/]raw/<orgId>/<sessionId>/<chunkSeq.zeroPad(10)>.ndjson.gz`.
     */
    private fun chunkKey(orgId: String, sessionId: String, chunkSeq: Long): String =
        buildString {
            if (props.s3KeyPrefix.isNotEmpty()) append(props.s3KeyPrefix.trimEnd('/')).append('/')
            append("raw/").append(orgId)
            append('/').append(sessionId)
            append('/').append(chunkSeq.toString().padStart(10, '0'))
            append(".ndjson.gz")
        }

    companion object {
        /** Matches the binding name in `application.yaml`: `chunkProducer-out-0`. */
        const val CHUNK_PRODUCER_BINDING = "chunkProducer-out-0"
    }
}
