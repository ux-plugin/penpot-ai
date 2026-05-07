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
import reactor.core.Disposable
import reactor.core.publisher.Mono
import java.nio.ByteBuffer
import java.util.UUID

class IngestRawConsumerIT {

    private lateinit var consumer: IngestRawConsumer
    private val streamName = "ingest.raw"
    private val groupName = "test-grp-${UUID.randomUUID().toString().take(6)}"
    private val consumerName = "test-consumer-1"

    @BeforeEach
    fun setUp() = runBlocking {
        // Fresh redis state per test.
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().awaitFirstOrNull()

        val workerProps = WorkerProperties(
            enabled = true,
            stream = WorkerProperties.StreamProperties(consumerGroup = groupName, consumerName = consumerName, pollTimeoutMs = 500),
            session = WorkerProperties.SessionProperties(idleTimeoutSec = 600, stateTtlSec = 1_200, minChunksToKeep = 3),
        )
        val repo = SessionStateRepository(redis, workerProps)
        val classifier = ChunkClassifier(objectStore, workerProps)
        val sanitized = SanitizedStreamPublisher(IngestStreamPublisher(redis, propsFor("test.sanitized")))
        val quarantine = QuarantineStreamPublisher(IngestStreamPublisher(redis, propsFor("test.quarantine")))
        val lifecycle = SessionLifecycleService(repo, classifier, objectStore, sanitized, quarantine, workerProps)

        consumer = IngestRawConsumer(redis, connectionFactory, workerProps, repo, lifecycle, WorkerHeartbeat())
        consumer.start()
    }

    @AfterEach
    fun tearDown() {
        consumer.stop()
    }

    @Test
    fun `CHUNK event records state and ACKs the message`(): Unit = runBlocking {
        val sessionId = "sess-${UUID.randomUUID().toString().take(8)}"
        val publisher = IngestStreamPublisher(redis, propsFor(streamName))
        publisher.publish(IngestEvent(
            type = IngestEvent.Type.CHUNK,
            orgId = "org-A",
            sessionId = sessionId,
            chunkSeq = 0,
            s3Key = rawKey("org-A", sessionId, 0),
            sizeBytes = 100,
        ))

        eventually(seconds = 5) {
            val workerProps = WorkerProperties(enabled = true)
            val state = SessionStateRepository(redis, workerProps).getState(sessionId)
            assertThat(state).isNotNull
            assertThat(state!!.chunkSeqs).containsExactly(0L)
            assertThat(state.totalSizeBytes).isEqualTo(100L)
        }

        // ACKed → no PEL entry.
        val pending = redis.opsForStream<String, String>().pending(streamName, groupName).awaitFirstOrNull()!!
        assertThat(pending.totalPendingMessages).isEqualTo(0L)
    }

    @Test
    fun `CLOSE_HINT event triggers session close and publishes downstream event`(): Unit = runBlocking {
        val sessionId = "sess-${UUID.randomUUID().toString().take(8)}"
        val workerProps = WorkerProperties(enabled = true)
        val repo = SessionStateRepository(redis, workerProps)

        // Pre-seed S3 + state for a SANITIZED session.
        seedSanitizedSession("org-A", sessionId, repo)

        val publisher = IngestStreamPublisher(redis, propsFor(streamName))
        publisher.publish(IngestEvent(
            type = IngestEvent.Type.CLOSE_HINT,
            orgId = "org-A",
            sessionId = sessionId,
        ))

        eventually(seconds = 5) {
            val records = redis.opsForStream<String, String>()
                .read(org.springframework.data.redis.connection.stream.StreamOffset.create(
                    "test.sanitized",
                    org.springframework.data.redis.connection.stream.ReadOffset.from("0"),
                ))
                .collectList().awaitFirstOrNull().orEmpty()
            assertThat(records).hasSize(1)
            val event = IngestEvent.fromRedisFields(records.single().value)
            assertThat(event.sessionId).isEqualTo(sessionId)
            assertThat(event.type).isEqualTo(IngestEvent.Type.SESSION_SANITIZED)
        }
    }

    @Test
    fun `malformed message is routed to DLQ and ACKed`(): Unit = runBlocking {
        val record = org.springframework.data.redis.connection.stream.StreamRecords.newRecord()
            .ofMap(mapOf("garbage" to "x"))
            .withStreamKey(streamName)
        redis.opsForStream<String, String>().add(record).awaitFirstOrNull()

        eventually(seconds = 5) {
            val dlqRecords = redis.opsForStream<String, String>()
                .read(org.springframework.data.redis.connection.stream.StreamOffset.create(
                    "ingest.raw.dlq",
                    org.springframework.data.redis.connection.stream.ReadOffset.from("0"),
                ))
                .collectList().awaitFirstOrNull().orEmpty()
            assertThat(dlqRecords).hasSize(1)
            assertThat(dlqRecords.single().value).containsKey("_originalStream")
        }

        val pending = redis.opsForStream<String, String>().pending(streamName, groupName).awaitFirstOrNull()!!
        assertThat(pending.totalPendingMessages).isEqualTo(0L)
    }

    private suspend fun seedSanitizedSession(orgId: String, sessionId: String, repo: SessionStateRepository) {
        for (seq in 0L..2L) {
            val bytes = if (seq == 0L) firstChunkWithFullSnapshot() else SanitizerTestInfra.followupChunk()
            objectStore.put(
                key = rawKey(orgId, sessionId, seq),
                body = Mono.just(ByteBuffer.wrap(bytes)),
                contentLength = bytes.size.toLong(),
            )
            repo.recordChunk(orgId, sessionId, seq, bytes.size.toLong())
        }
    }

    private fun propsFor(name: String): IngestProperties = IngestProperties(
        enabled = true,
        stream = IngestProperties.StreamProperties(name = name),
    )

    /** Polls assertion until it passes or the deadline expires. */
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
        }
    }
}
