package com.plugin.sanitizer.lifecycle

import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.core.testfixtures.IngestPipelineContainers
import com.plugin.sanitizer.classify.ChunkClassifier
import com.plugin.sanitizer.state.SessionStateRepository
import com.plugin.sanitizer.testsupport.SanitizerTestInfra
import com.plugin.sanitizer.testsupport.SanitizerTestInfra.firstChunkWithFullSnapshot
import com.plugin.sanitizer.testsupport.SanitizerTestInfra.firstChunkWithoutFullSnapshot
import com.plugin.sanitizer.testsupport.SanitizerTestInfra.followupChunk
import com.plugin.sanitizer.testsupport.SanitizerTestInfra.quarantineKey
import com.plugin.sanitizer.testsupport.SanitizerTestInfra.rawKey
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.data.redis.connection.stream.ReadOffset
import org.springframework.data.redis.connection.stream.StreamOffset
import reactor.core.publisher.Mono
import software.amazon.awssdk.services.s3.model.HeadObjectRequest
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import java.nio.ByteBuffer
import java.util.UUID

class SessionLifecycleServiceIT {

    private lateinit var repo: SessionStateRepository
    private lateinit var service: SessionLifecycleService
    private val sanitizedStreamName = "test.sanitized.${UUID.randomUUID().toString().take(8)}"
    private val quarantineStreamName = "test.quarantine.${UUID.randomUUID().toString().take(8)}"

    @BeforeEach
    fun setUp() = runBlocking {
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().awaitFirstOrNull()
        // Wipe S3 keys from previous tests with same orgId/sessionId is unnecessary —
        // each test uses a fresh sessionId, and S3 PUT overwrites in-place.

        val workerProps = WorkerProperties(
            enabled = true,
            session = WorkerProperties.SessionProperties(idleTimeoutSec = 600, stateTtlSec = 1_200, minChunksToKeep = 3),
        )
        repo = SessionStateRepository(redis, workerProps)
        val classifier = ChunkClassifier(objectStore, workerProps)

        service = SessionLifecycleService(
            repository = repo,
            classifier = classifier,
            objectStore = objectStore,
            sanitizedStreamPublisher = SanitizedStreamPublisher(IngestStreamPublisher(redis, propsFor(sanitizedStreamName))),
            quarantineStreamPublisher = QuarantineStreamPublisher(IngestStreamPublisher(redis, propsFor(quarantineStreamName))),
            workerProps = workerProps,
        )
    }

    @Test
    fun `DROP path deletes raw S3 keys, no downstream event`() = runBlocking {
        val sessionId = "sess-tiny-${UUID.randomUUID().toString().take(8)}"
        seedSession("org-A", sessionId, seqs = listOf(0L, 1L), withFullSnapshot = true)

        service.closeSession(sessionId)

        assertThat(s3HasKey(rawKey("org-A", sessionId, 0))).isFalse
        assertThat(s3HasKey(rawKey("org-A", sessionId, 1))).isFalse
        assertThat(repo.getState(sessionId)).isNull()
        assertThat(streamRecords(sanitizedStreamName)).isEmpty()
        assertThat(streamRecords(quarantineStreamName)).isEmpty()
    }

    @Test
    fun `SANITIZED path publishes event and retains raw + state for later eviction`() = runBlocking {
        val sessionId = "sess-good-${UUID.randomUUID().toString().take(8)}"
        seedSession("org-A", sessionId, seqs = (0L..4L).toList(), withFullSnapshot = true)

        service.closeSession(sessionId)

        for (seq in 0L..4L) assertThat(s3HasKey(rawKey("org-A", sessionId, seq))).isTrue
        assertThat(repo.getState(sessionId)).isNotNull

        val records = streamRecords(sanitizedStreamName)
        assertThat(records).hasSize(1)
        val event = IngestEvent.fromRedisFields(records.single().value)
        assertThat(event.type).isEqualTo(IngestEvent.Type.SESSION_SANITIZED)
        assertThat(event.sessionId).isEqualTo(sessionId)
        assertThat(event.chunkCount).isEqualTo(5L)
        assertThat(event.firstSeq).isEqualTo(0L)
        assertThat(event.lastSeq).isEqualTo(4L)
        assertThat(event.classification).isEqualTo("ok")
    }

    @Test
    fun `QUARANTINE path on gaps moves raw keys to quarantine and publishes event`() = runBlocking {
        val sessionId = "sess-gap-${UUID.randomUUID().toString().take(8)}"
        seedSession("org-A", sessionId, seqs = listOf(0L, 1L, 3L, 4L), withFullSnapshot = true) // missing 2

        service.closeSession(sessionId)

        for (seq in listOf(0L, 1L, 3L, 4L)) {
            assertThat(s3HasKey(rawKey("org-A", sessionId, seq))).isFalse
            assertThat(s3HasKey(quarantineKey("org-A", sessionId, seq))).isTrue
        }

        val records = streamRecords(quarantineStreamName)
        assertThat(records).hasSize(1)
        val event = IngestEvent.fromRedisFields(records.single().value)
        assertThat(event.type).isEqualTo(IngestEvent.Type.SESSION_QUARANTINED)
        assertThat(event.classification).contains("gaps_at:[2]")
        assertThat(repo.getState(sessionId)).isNull()
    }

    @Test
    fun `QUARANTINE path on missing FullSnapshot moves raw keys + publishes event`() = runBlocking {
        val sessionId = "sess-no-fs-${UUID.randomUUID().toString().take(8)}"
        seedSession("org-A", sessionId, seqs = (0L..3L).toList(), withFullSnapshot = false)

        service.closeSession(sessionId)

        for (seq in 0L..3L) {
            assertThat(s3HasKey(rawKey("org-A", sessionId, seq))).isFalse
            assertThat(s3HasKey(quarantineKey("org-A", sessionId, seq))).isTrue
        }
        val event = IngestEvent.fromRedisFields(streamRecords(quarantineStreamName).single().value)
        assertThat(event.classification).isEqualTo("missing_full_snapshot")
    }

    @Test
    fun `closeSession is idempotent on retry`() = runBlocking {
        val sessionId = "sess-good-${UUID.randomUUID().toString().take(8)}"
        seedSession("org-A", sessionId, seqs = (0L..2L).toList(), withFullSnapshot = true)

        service.closeSession(sessionId)
        val firstCount = streamRecords(sanitizedStreamName).size

        service.closeSession(sessionId)
        assertThat(streamRecords(sanitizedStreamName).size).isEqualTo(firstCount)
    }

    @Test
    fun `handleRawProcessed evicts raw S3 keys and clears state`() = runBlocking {
        val sessionId = "sess-evict-${UUID.randomUUID().toString().take(8)}"
        seedSession("org-A", sessionId, seqs = (0L..2L).toList(), withFullSnapshot = true)
        service.closeSession(sessionId)
        assertThat(s3HasKey(rawKey("org-A", sessionId, 0))).isTrue

        service.handleRawProcessed("org-A", sessionId)

        for (seq in 0L..2L) assertThat(s3HasKey(rawKey("org-A", sessionId, seq))).isFalse
        assertThat(repo.getState(sessionId)).isNull()
    }

    @Test
    fun `handleRawProcessed is idempotent when state already cleared`() = runBlocking {
        // No state, no S3 keys. Should not throw.
        service.handleRawProcessed("org-A", "never-existed")
    }

    private suspend fun seedSession(orgId: String, sessionId: String, seqs: List<Long>, withFullSnapshot: Boolean) {
        for (seq in seqs) {
            val bytes = if (seq == seqs.first()) {
                if (withFullSnapshot) firstChunkWithFullSnapshot() else firstChunkWithoutFullSnapshot()
            } else {
                followupChunk()
            }
            objectStore.put(
                key = rawKey(orgId, sessionId, seq),
                body = Mono.just(ByteBuffer.wrap(bytes)),
                contentLength = bytes.size.toLong(),
                contentType = "application/x-ndjson",
            )
            repo.recordChunk(orgId, sessionId, seq, bytes.size.toLong())
        }
    }

    private suspend fun s3HasKey(key: String): Boolean = try {
        s3.headObject(HeadObjectRequest.builder().bucket("sanitizer-test").key(key).build()).get()
        true
    } catch (e: Exception) {
        if ((e.cause ?: e) is NoSuchKeyException) false else throw e
    }

    private suspend fun streamRecords(streamName: String) =
        redis.opsForStream<String, String>()
            .read(StreamOffset.create(streamName, ReadOffset.from("0")))
            .collectList().awaitFirstOrNull().orEmpty()

    private fun propsFor(streamName: String): IngestProperties = IngestProperties(
        enabled = true,
        stream = IngestProperties.StreamProperties(name = streamName),
    )

    companion object {
        private val redis by lazy { SanitizerTestInfra.buildRedisTemplate() }
        private val objectStore by lazy { SanitizerTestInfra.buildObjectStore("sanitizer-test") }
        private val s3 by lazy { SanitizerTestInfra.s3Client(SanitizerTestInfra.objectStoreProperties("sanitizer-test")) }

        @BeforeAll
        @JvmStatic
        fun bootContainers() {
            IngestPipelineContainers.redis
            IngestPipelineContainers.minio
        }

        @AfterAll
        @JvmStatic
        fun shutdown() {
            s3.close()
        }
    }
}
