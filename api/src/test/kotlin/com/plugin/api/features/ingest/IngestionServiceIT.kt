package com.plugin.api.features.ingest

import com.plugin.api.testsupport.IngestTestInfra
import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.ingest.BackpressureGuard
import com.plugin.core.ingest.IngestBackpressureException
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.core.testfixtures.IngestPipelineContainers
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.data.redis.connection.stream.ReadOffset
import org.springframework.data.redis.connection.stream.StreamOffset
import reactor.core.publisher.Mono
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import java.nio.ByteBuffer
import java.util.UUID

class IngestionServiceIT {
    private lateinit var service: IngestionService
    private val streamName = "test.ingest.raw.${UUID.randomUUID().toString().take(8)}"

    @BeforeEach
    fun setUp() = runBlocking {
        redis.delete(streamName).awaitFirstOrNull()

        val publisher = IngestStreamPublisher(redis, propsWith(maxPending = 100_000))
        val guard = BackpressureGuard(redis, propsWith(maxPending = 100_000))
        service = IngestionService(objectStore, publisher, guard, propsWith(maxPending = 100_000))
    }

    @Test
    fun `acceptChunk writes the chunk to S3 and publishes a CHUNK event with the right key`() = runBlocking {
        val payload = "chunk-bytes-${UUID.randomUUID()}".toByteArray()
        val response = service.acceptChunk(
            orgId = "org-A",
            sessionId = "sess-1",
            chunkSeq = 7,
            contentLength = payload.size.toLong(),
            body = Mono.just(ByteBuffer.wrap(payload)),
            contentType = "application/x-ndjson",
        )

        assertThat(response.key).isEqualTo("raw/org-A/sess-1/0000000007.ndjson.gz")
        assertThat(response.sizeBytes).isEqualTo(payload.size.toLong())

        // Object actually present in MinIO with the same bytes.
        val getResponse = s3.getObject(
            GetObjectRequest.builder().bucket("ingest-test").key(response.key).build(),
            software.amazon.awssdk.core.async.AsyncResponseTransformer.toBytes(),
        ).get()
        assertThat(getResponse.asByteArray()).isEqualTo(payload)

        // Redis stream has exactly one CHUNK event matching our coordinates.
        val records = redis.opsForStream<String, String>()
            .read(StreamOffset.create(streamName, ReadOffset.from("0")))
            .collectList().block()!!
        assertThat(records).hasSize(1)
        val decoded = IngestEvent.fromRedisFields(records[0].value)
        assertThat(decoded.type).isEqualTo(IngestEvent.Type.CHUNK)
        assertThat(decoded.orgId).isEqualTo("org-A")
        assertThat(decoded.sessionId).isEqualTo("sess-1")
        assertThat(decoded.chunkSeq).isEqualTo(7L)
        assertThat(decoded.s3Key).isEqualTo(response.key)
    }

    @Test
    fun `acceptChunk throws IngestBackpressureException when stream depth is over threshold`() = runBlocking {
        // Pre-fill the stream past a tight maxPending so the next chunk fails fast.
        val ops = redis.opsForStream<String, String>()
        repeat(5) {
            val record = org.springframework.data.redis.connection.stream.StreamRecords.newRecord()
                .ofMap(mapOf("filler" to "x"))
                .withStreamKey(streamName)
            ops.add(record).awaitFirstOrNull()
        }
        val tightProps = propsWith(maxPending = 3)
        val guardedService = IngestionService(
            objectStore,
            IngestStreamPublisher(redis, tightProps),
            BackpressureGuard(redis, tightProps),
            tightProps,
        )

        val payload = "x".toByteArray()
        assertThatThrownBy {
            runBlocking {
                guardedService.acceptChunk(
                    orgId = "org-A",
                    sessionId = "sess-1",
                    chunkSeq = 0,
                    contentLength = payload.size.toLong(),
                    body = Mono.just(ByteBuffer.wrap(payload)),
                )
            }
        }.isInstanceOf(IngestBackpressureException::class.java)
    }

    @Test
    fun `acceptCloseHint publishes a CLOSE_HINT event with no chunk fields`() = runBlocking {
        val response = service.acceptCloseHint(orgId = "org-A", sessionId = "sess-9")
        assertThat(response.sessionId).isEqualTo("sess-9")

        val records = redis.opsForStream<String, String>()
            .read(StreamOffset.create(streamName, ReadOffset.from("0")))
            .collectList().block()!!
        assertThat(records).hasSize(1)
        val decoded = IngestEvent.fromRedisFields(records[0].value)
        assertThat(decoded.type).isEqualTo(IngestEvent.Type.CLOSE_HINT)
        assertThat(decoded.orgId).isEqualTo("org-A")
        assertThat(decoded.sessionId).isEqualTo("sess-9")
        assertThat(decoded.chunkSeq).isNull()
        assertThat(decoded.s3Key).isNull()
        assertThat(decoded.sizeBytes).isNull()
    }

    @Test
    fun `acceptChunk pads chunkSeq to 10 digits in the S3 key`() = runBlocking {
        val payload = "y".toByteArray()
        val response = service.acceptChunk(
            orgId = "org-A",
            sessionId = "sess-1",
            chunkSeq = 42,
            contentLength = payload.size.toLong(),
            body = Mono.just(ByteBuffer.wrap(payload)),
        )
        assertThat(response.key).isEqualTo("raw/org-A/sess-1/0000000042.ndjson.gz")
    }

    private fun propsWith(maxPending: Long): IngestProperties = IngestProperties(
        enabled = true,
        stream = IngestProperties.StreamProperties(name = streamName, maxPending = maxPending),
    )

    companion object {
        private val objectStore by lazy { IngestTestInfra.buildObjectStore("ingest-test") }
        private val s3 by lazy { IngestTestInfra.s3Client(IngestTestInfra.objectStoreProperties("ingest-test")) }
        private val redis by lazy { IngestTestInfra.buildRedisTemplate() }

        @BeforeAll
        @JvmStatic
        fun bootContainers() {
            IngestPipelineContainers.minio
            IngestPipelineContainers.redis
        }

        @AfterAll
        @JvmStatic
        fun closeS3() {
            s3.close()
        }
    }
}
