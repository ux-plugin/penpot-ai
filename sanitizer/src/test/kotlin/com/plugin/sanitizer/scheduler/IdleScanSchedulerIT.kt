package com.plugin.sanitizer.scheduler

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
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import reactor.core.publisher.Mono
import java.nio.ByteBuffer
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

class IdleScanSchedulerIT {

    private val now = AtomicReference<Instant>(Instant.parse("2026-05-07T12:00:00Z"))
    private lateinit var scheduler: IdleScanScheduler
    private lateinit var repo: SessionStateRepository
    private lateinit var lifecycle: SessionLifecycleService
    private val sanitizedStreamName = "test.sanitized.${UUID.randomUUID().toString().take(6)}"

    @BeforeEach
    fun setUp() = runBlocking {
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().awaitFirstOrNull()
        val workerProps = WorkerProperties(
            enabled = true,
            session = WorkerProperties.SessionProperties(idleTimeoutSec = 600, stateTtlSec = 1_200, minChunksToKeep = 3),
        )
        repo = SessionStateRepository(redis, workerProps, clock = now::get)
        val classifier = ChunkClassifier(objectStore, workerProps)
        val sanitized = SanitizedStreamPublisher(IngestStreamPublisher(redis, IngestProperties(enabled = true,
            stream = IngestProperties.StreamProperties(name = sanitizedStreamName))))
        val quarantine = QuarantineStreamPublisher(IngestStreamPublisher(redis, IngestProperties(enabled = true,
            stream = IngestProperties.StreamProperties(name = "test.quarantine"))))
        lifecycle = SessionLifecycleService(repo, classifier, objectStore, sanitized, quarantine, workerProps)
        scheduler = IdleScanScheduler(repo, lifecycle, workerProps, WorkerHeartbeat())
    }

    @Test
    fun `idle session past threshold is closed and publishes downstream event`(): Unit = runBlocking {
        val sessionId = "abandoned-${UUID.randomUUID().toString().take(8)}"
        seedSession("org-A", sessionId, seqs = (0L..3L).toList(), withFullSnapshot = true)
        // 11 minutes after seed — past the 10 min idle threshold.
        now.set(Instant.parse("2026-05-07T12:11:00Z"))

        scheduler.scanIdleSessions()

        val records = redis.opsForStream<String, String>()
            .read(org.springframework.data.redis.connection.stream.StreamOffset.create(
                sanitizedStreamName,
                org.springframework.data.redis.connection.stream.ReadOffset.from("0"),
            ))
            .collectList().awaitFirstOrNull().orEmpty()
        assertThat(records.map { IngestEvent.fromRedisFields(it.value).sessionId }).contains(sessionId)
    }

    @Test
    fun `non-idle session is left alone`(): Unit = runBlocking {
        val sessionId = "active-${UUID.randomUUID().toString().take(8)}"
        seedSession("org-A", sessionId, seqs = (0L..3L).toList(), withFullSnapshot = true)
        // 5 minutes after seed — well within the 10 min idle window.
        now.set(Instant.parse("2026-05-07T12:05:00Z"))

        scheduler.scanIdleSessions()

        val records = redis.opsForStream<String, String>()
            .read(org.springframework.data.redis.connection.stream.StreamOffset.create(
                sanitizedStreamName,
                org.springframework.data.redis.connection.stream.ReadOffset.from("0"),
            ))
            .collectList().awaitFirstOrNull().orEmpty()
        assertThat(records).isEmpty()
        assertThat(repo.getState(sessionId)).isNotNull
    }

    private suspend fun seedSession(orgId: String, sessionId: String, seqs: List<Long>, withFullSnapshot: Boolean) {
        for (seq in seqs) {
            val bytes = if (seq == seqs.first() && withFullSnapshot) firstChunkWithFullSnapshot() else followupChunk()
            objectStore.put(rawKey(orgId, sessionId, seq), Mono.just(ByteBuffer.wrap(bytes)), bytes.size.toLong())
            repo.recordChunk(orgId, sessionId, seq, bytes.size.toLong())
        }
    }

    companion object {
        private val redis = SanitizerTestInfra.buildRedisTemplate()
        private val connectionFactory = (redis.connectionFactory as LettuceConnectionFactory)
        private val objectStore = SanitizerTestInfra.buildObjectStore("sanitizer-scheduler-test")

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
