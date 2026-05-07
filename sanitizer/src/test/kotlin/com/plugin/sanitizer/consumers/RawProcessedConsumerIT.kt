package com.plugin.sanitizer.consumers

import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.core.testfixtures.IngestPipelineContainers
import com.plugin.core.worker.WorkerHeartbeat
import com.plugin.sanitizer.classify.ChunkClassifier
import com.plugin.sanitizer.lifecycle.QuarantineStreamPublisher
import com.plugin.sanitizer.lifecycle.SanitizedStreamPublisher
import com.plugin.sanitizer.lifecycle.SessionLifecycleService
import com.plugin.sanitizer.state.SessionStateRepository
import com.plugin.sanitizer.testsupport.SanitizerTestInfra
import com.plugin.sanitizer.testsupport.SanitizerTestInfra.firstChunkWithFullSnapshot
import com.plugin.sanitizer.testsupport.SanitizerTestInfra.followupChunk
import com.plugin.sanitizer.testsupport.SanitizerTestInfra.rawKey
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
import reactor.core.publisher.Mono
import software.amazon.awssdk.services.s3.model.HeadObjectRequest
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import java.nio.ByteBuffer
import java.util.UUID

class RawProcessedConsumerIT {

    private lateinit var consumer: RawProcessedConsumer
    private lateinit var repo: SessionStateRepository
    private lateinit var lifecycle: SessionLifecycleService
    private val groupName = "test-grp-${UUID.randomUUID().toString().take(6)}"

    @BeforeEach
    fun setUp() = runBlocking {
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().awaitFirstOrNull()

        val workerProps = WorkerProperties(
            enabled = true,
            stream = WorkerProperties.StreamProperties(consumerGroup = groupName, pollTimeoutMs = 500),
            session = WorkerProperties.SessionProperties(idleTimeoutSec = 600, stateTtlSec = 1_200, minChunksToKeep = 3),
        )
        repo = SessionStateRepository(redis, workerProps)
        val classifier = ChunkClassifier(objectStore, workerProps)
        val sanitized = SanitizedStreamPublisher(IngestStreamPublisher(redis, IngestProperties(enabled = true,
            stream = IngestProperties.StreamProperties(name = "test.sanitized"))))
        val quarantine = QuarantineStreamPublisher(IngestStreamPublisher(redis, IngestProperties(enabled = true,
            stream = IngestProperties.StreamProperties(name = "test.quarantine"))))
        lifecycle = SessionLifecycleService(repo, classifier, objectStore, sanitized, quarantine, workerProps)

        consumer = RawProcessedConsumer(redis, connectionFactory, workerProps, lifecycle, WorkerHeartbeat())
        consumer.start()
    }

    @AfterEach
    fun tearDown() {
        consumer.stop()
    }

    @Test
    fun `RAW_PROCESSED event evicts raw S3 keys and clears state`(): Unit = runBlocking {
        val sessionId = "sess-${UUID.randomUUID().toString().take(8)}"
        seedSanitizedAndCloseSession("org-A", sessionId)
        // Sanity: raw keys present, state alive (sanitized but awaiting eviction).
        for (seq in 0L..2L) assertThat(s3HasKey(rawKey("org-A", sessionId, seq))).isTrue
        assertThat(repo.getState(sessionId)).isNotNull

        IngestStreamPublisher(redis, IngestProperties(enabled = true,
            stream = IngestProperties.StreamProperties(name = "ingest.raw.processed"))).publish(
            IngestEvent(type = IngestEvent.Type.RAW_PROCESSED, orgId = "org-A", sessionId = sessionId),
        )

        eventually(seconds = 5) {
            for (seq in 0L..2L) assertThat(s3HasKey(rawKey("org-A", sessionId, seq))).isFalse
            assertThat(repo.getState(sessionId)).isNull()
        }
    }

    @Test
    fun `unexpected event type lands in DLQ`(): Unit = runBlocking {
        val publisher = IngestStreamPublisher(redis, IngestProperties(enabled = true,
            stream = IngestProperties.StreamProperties(name = "ingest.raw.processed")))
        publisher.publish(IngestEvent(type = IngestEvent.Type.CHUNK, orgId = "org-A", sessionId = "x", chunkSeq = 0))

        eventually(seconds = 5) {
            val dlq = redis.opsForStream<String, String>()
                .read(org.springframework.data.redis.connection.stream.StreamOffset.create(
                    "ingest.raw.processed.dlq",
                    org.springframework.data.redis.connection.stream.ReadOffset.from("0"),
                ))
                .collectList().awaitFirstOrNull().orEmpty()
            assertThat(dlq).hasSize(1)
        }
    }

    private suspend fun seedSanitizedAndCloseSession(orgId: String, sessionId: String) {
        for (seq in 0L..2L) {
            val bytes = if (seq == 0L) firstChunkWithFullSnapshot() else followupChunk()
            objectStore.put(rawKey(orgId, sessionId, seq), Mono.just(ByteBuffer.wrap(bytes)), bytes.size.toLong())
            repo.recordChunk(orgId, sessionId, seq, bytes.size.toLong())
        }
        lifecycle.closeSession(sessionId)
    }

    private suspend fun s3HasKey(key: String): Boolean = try {
        s3.headObject(HeadObjectRequest.builder().bucket("sanitizer-consumer-test").key(key).build()).get()
        true
    } catch (e: Exception) {
        if ((e.cause ?: e) is NoSuchKeyException) false else throw e
    }

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

    companion object {
        private val redis = SanitizerTestInfra.buildRedisTemplate()
        private val connectionFactory = (redis.connectionFactory as LettuceConnectionFactory)
        private val objectStore = SanitizerTestInfra.buildObjectStore("sanitizer-consumer-test")
        private val s3 = SanitizerTestInfra.s3Client(SanitizerTestInfra.objectStoreProperties("sanitizer-consumer-test"))

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
