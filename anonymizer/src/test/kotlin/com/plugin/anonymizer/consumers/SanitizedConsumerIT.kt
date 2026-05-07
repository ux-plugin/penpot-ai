package com.plugin.anonymizer.consumers

import com.plugin.anonymizer.lifecycle.AnonStreamPublisher
import com.plugin.anonymizer.lifecycle.RawProcessedStreamPublisher
import com.plugin.anonymizer.lifecycle.SessionAnonymizationService
import com.plugin.anonymizer.rules.AnonymizerRules
import com.plugin.anonymizer.rules.RrwebTransformer
import com.plugin.anonymizer.testsupport.AnonymizerTestInfra
import com.plugin.anonymizer.testsupport.AnonymizerTestInfra.anonKey
import com.plugin.anonymizer.testsupport.AnonymizerTestInfra.chunkWithPii
import com.plugin.anonymizer.testsupport.AnonymizerTestInfra.rawKey
import com.plugin.core.config.properties.AnonymizerProperties
import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.core.testfixtures.IngestPipelineContainers
import com.plugin.core.worker.WorkerHeartbeat
import kotlinx.coroutines.delay
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.connection.stream.ReadOffset
import org.springframework.data.redis.connection.stream.StreamOffset
import reactor.core.publisher.Flux
import software.amazon.awssdk.services.s3.model.HeadObjectRequest
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import java.nio.ByteBuffer
import java.util.UUID

class SanitizedConsumerIT {

    private lateinit var consumer: SanitizedConsumer
    private val groupName = "test-anon-grp-${UUID.randomUUID().toString().take(6)}"
    private val inputStreamName = "test.sanitized.${UUID.randomUUID().toString().take(6)}"
    private val anonStreamName = "test.anon.${UUID.randomUUID().toString().take(6)}"
    private val rawProcessedStreamName = "test.rawproc.${UUID.randomUUID().toString().take(6)}"

    @BeforeEach
    fun setUp() = runBlocking {
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().awaitFirstOrNull()

        val workerProps = WorkerProperties(
            enabled = true,
            stream = WorkerProperties.StreamProperties(consumerGroup = groupName, pollTimeoutMs = 500),
        )
        val anonProps = AnonymizerProperties(
            enabled = true,
            inputStream = inputStreamName,
            anonStream = anonStreamName,
            rawProcessedStream = rawProcessedStreamName,
        )
        val rules = AnonymizerRules(anonProps)
        val transformer = RrwebTransformer(rules)
        val service = SessionAnonymizationService(
            objectStore = objectStore,
            transformer = transformer,
            anonStreamPublisher = AnonStreamPublisher(IngestStreamPublisher(redis, propsFor(anonStreamName))),
            rawProcessedStreamPublisher = RawProcessedStreamPublisher(IngestStreamPublisher(redis, propsFor(rawProcessedStreamName))),
            props = anonProps,
        )

        consumer = SanitizedConsumer(redis, connectionFactory, workerProps, anonProps, service, WorkerHeartbeat())
        consumer.start()
    }

    @AfterEach
    fun tearDown() {
        consumer.stop()
    }

    @Test
    fun `SESSION_SANITIZED event triggers anonymization end-to-end`() = runBlocking {
        val sessionId = "sess-${UUID.randomUUID().toString().take(8)}"
        seedRaw("org-A", sessionId, seqs = 0L..1L)

        publishInput(IngestEvent(
            type = IngestEvent.Type.SESSION_SANITIZED,
            orgId = "org-A",
            sessionId = sessionId,
            firstSeq = 0L,
            lastSeq = 1L,
            chunkCount = 2L,
        ))

        eventually(seconds = 10) {
            for (seq in 0L..1L) assertThat(s3HasKey(anonKey("org-A", sessionId, seq))).isTrue
            assertThat(streamRecords(anonStreamName)).hasSize(1)
            assertThat(streamRecords(rawProcessedStreamName)).hasSize(1)
        }
    }

    @Test
    fun `unexpected event type lands in DLQ`() = runBlocking {
        publishInput(IngestEvent(type = IngestEvent.Type.CHUNK, orgId = "org-A", sessionId = "x", chunkSeq = 0))

        eventually(seconds = 5) {
            val dlq = redis.opsForStream<String, String>()
                .read(StreamOffset.create("$inputStreamName.dlq", ReadOffset.from("0")))
                .collectList().awaitFirstOrNull().orEmpty()
            assertThat(dlq).hasSize(1)
        }
    }

    @Test
    fun `SESSION_SANITIZED missing firstSeq lands in DLQ`() = runBlocking {
        publishInput(IngestEvent(
            type = IngestEvent.Type.SESSION_SANITIZED,
            orgId = "org-A",
            sessionId = "no-firstseq",
            // firstSeq deliberately omitted
            lastSeq = 5L,
        ))

        eventually(seconds = 5) {
            val dlq = redis.opsForStream<String, String>()
                .read(StreamOffset.create("$inputStreamName.dlq", ReadOffset.from("0")))
                .collectList().awaitFirstOrNull().orEmpty()
            assertThat(dlq).hasSize(1)
        }
    }

    private suspend fun publishInput(event: IngestEvent) {
        IngestStreamPublisher(redis, propsFor(inputStreamName)).publish(event)
    }

    private suspend fun seedRaw(orgId: String, sessionId: String, seqs: LongRange) {
        for (seq in seqs) {
            val bytes = chunkWithPii()
            objectStore.put(
                key = rawKey(orgId, sessionId, seq),
                body = Flux.just(ByteBuffer.wrap(bytes)),
                contentLength = bytes.size.toLong(),
                contentType = "application/x-ndjson",
            )
        }
    }

    private suspend fun s3HasKey(key: String): Boolean = try {
        s3.headObject(HeadObjectRequest.builder().bucket(BUCKET).key(key).build()).get()
        true
    } catch (e: Exception) {
        if ((e.cause ?: e) is NoSuchKeyException) false else throw e
    }

    private suspend fun streamRecords(streamName: String) =
        redis.opsForStream<String, String>()
            .read(StreamOffset.create(streamName, ReadOffset.from("0")))
            .collectList().awaitFirstOrNull().orEmpty()

    private suspend fun eventually(seconds: Int, block: suspend () -> Unit) {
        val deadline = System.currentTimeMillis() + seconds * 1_000L
        var lastError: Throwable? = null
        while (System.currentTimeMillis() < deadline) {
            try {
                block()
                return
            } catch (e: AssertionError) {
                lastError = e
                delay(100)
            }
        }
        throw AssertionError("eventually() failed after ${seconds}s", lastError)
    }

    private fun propsFor(streamName: String): IngestProperties = IngestProperties(
        enabled = true,
        stream = IngestProperties.StreamProperties(name = streamName),
    )

    companion object {
        private const val BUCKET = "anonymizer-consumer-test"
        private val redis = AnonymizerTestInfra.buildRedisTemplate()
        private val connectionFactory = (redis.connectionFactory as LettuceConnectionFactory)
        private val objectStore = AnonymizerTestInfra.buildObjectStore(BUCKET)
        private val s3 = AnonymizerTestInfra.s3Client(AnonymizerTestInfra.objectStoreProperties(BUCKET))

        @BeforeAll
        @JvmStatic
        fun bootContainers() {
            IngestPipelineContainers.redis
            IngestPipelineContainers.minio
        }

        @AfterAll
        @JvmStatic
        fun shutdown() {
            connectionFactory.destroy()
            s3.close()
        }
    }
}
