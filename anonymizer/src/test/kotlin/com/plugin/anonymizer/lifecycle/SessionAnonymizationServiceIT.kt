package com.plugin.anonymizer.lifecycle

import com.plugin.anonymizer.rules.AnonymizerRules
import com.plugin.anonymizer.rules.RrwebTransformer
import com.plugin.anonymizer.testsupport.AnonymizerTestInfra
import com.plugin.anonymizer.testsupport.AnonymizerTestInfra.anonKey
import com.plugin.anonymizer.testsupport.AnonymizerTestInfra.chunkWithPii
import com.plugin.anonymizer.testsupport.AnonymizerTestInfra.rawKey
import com.plugin.core.config.properties.AnonymizerProperties
import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.core.testfixtures.IngestPipelineContainers
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.connection.stream.ReadOffset
import org.springframework.data.redis.connection.stream.StreamOffset
import reactor.core.publisher.Flux
import software.amazon.awssdk.services.s3.model.GetObjectRequest
import software.amazon.awssdk.services.s3.model.HeadObjectRequest
import software.amazon.awssdk.services.s3.model.NoSuchKeyException
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.util.UUID
import java.util.zip.GZIPInputStream

class SessionAnonymizationServiceIT {

    private val anonStreamName = "test.anon.${UUID.randomUUID().toString().take(8)}"
    private val rawProcessedStreamName = "test.rawproc.${UUID.randomUUID().toString().take(8)}"
    private lateinit var service: SessionAnonymizationService

    @BeforeEach
    fun setUp() = runBlocking {
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().awaitFirstOrNull()
        val anonProps = AnonymizerProperties(enabled = true)
        val rules = AnonymizerRules(anonProps)
        val transformer = RrwebTransformer(rules)
        service = SessionAnonymizationService(
            objectStore = objectStore,
            transformer = transformer,
            anonStreamPublisher = AnonStreamPublisher(IngestStreamPublisher(redis, propsFor(anonStreamName))),
            rawProcessedStreamPublisher = RawProcessedStreamPublisher(IngestStreamPublisher(redis, propsFor(rawProcessedStreamName))),
            props = anonProps,
        )
    }

    @Test
    fun `writes anon keys with scrubbed content and emits both events`(): Unit = runBlocking {
        val sessionId = "sess-${UUID.randomUUID().toString().take(8)}"
        seed("org-A", sessionId, seqs = (0L..2L).toList())

        service.anonymize("org-A", sessionId, firstSeq = 0, lastSeq = 2)

        for (seq in 0L..2L) {
            assertThat(s3HasKey(anonKey("org-A", sessionId, seq))).isTrue
            val body = readAnonNdjson(anonKey("org-A", sessionId, seq))
            assertThat(body).doesNotContain("alice@example.com")
            assertThat(body).doesNotContain("415-555-1234")
            assertThat(body).doesNotContain("\"source\":5")  // Input event dropped
            assertThat(body).doesNotContain("?utm=foo")       // query string stripped
        }

        val anonRecords = streamRecords(anonStreamName)
        assertThat(anonRecords).hasSize(1)
        val anonEvent = IngestEvent.fromRedisFields(anonRecords.single().value)
        assertThat(anonEvent.type).isEqualTo(IngestEvent.Type.SESSION_ANONYMIZED)
        assertThat(anonEvent.sessionId).isEqualTo(sessionId)
        assertThat(anonEvent.firstSeq).isEqualTo(0L)
        assertThat(anonEvent.lastSeq).isEqualTo(2L)
        assertThat(anonEvent.chunkCount).isEqualTo(3L)

        val rpRecords = streamRecords(rawProcessedStreamName)
        assertThat(rpRecords).hasSize(1)
        val rpEvent = IngestEvent.fromRedisFields(rpRecords.single().value)
        assertThat(rpEvent.type).isEqualTo(IngestEvent.Type.RAW_PROCESSED)
        assertThat(rpEvent.sessionId).isEqualTo(sessionId)
    }

    @Test
    fun `re-running yields identical anon content idempotent`(): Unit = runBlocking {
        val sessionId = "sess-${UUID.randomUUID().toString().take(8)}"
        seed("org-A", sessionId, seqs = (0L..1L).toList())

        service.anonymize("org-A", sessionId, 0, 1)
        val firstRun = readAnonNdjson(anonKey("org-A", sessionId, 0))

        service.anonymize("org-A", sessionId, 0, 1)
        val secondRun = readAnonNdjson(anonKey("org-A", sessionId, 0))

        assertThat(secondRun).isEqualTo(firstRun)
    }

    @Test
    fun `skips missing raw chunks and processes the rest`(): Unit = runBlocking {
        val sessionId = "sess-${UUID.randomUUID().toString().take(8)}"
        // Seed seqs 0 and 2 only — sanitizer normally guarantees contiguity but we
        // want to verify the anonymizer doesn't crash on an absent key.
        seed("org-A", sessionId, seqs = listOf(0L, 2L))

        service.anonymize("org-A", sessionId, firstSeq = 0, lastSeq = 2)

        assertThat(s3HasKey(anonKey("org-A", sessionId, 0))).isTrue
        assertThat(s3HasKey(anonKey("org-A", sessionId, 1))).isFalse
        assertThat(s3HasKey(anonKey("org-A", sessionId, 2))).isTrue
        // Both events still emitted — downstream eviction depends on it.
        assertThat(streamRecords(anonStreamName)).hasSize(1)
        assertThat(streamRecords(rawProcessedStreamName)).hasSize(1)
    }

    private suspend fun seed(orgId: String, sessionId: String, seqs: List<Long>) {
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

    private suspend fun readAnonNdjson(key: String): String {
        val bytes = s3.getObject(GetObjectRequest.builder().bucket(BUCKET).key(key).build(),
            software.amazon.awssdk.core.async.AsyncResponseTransformer.toBytes()).get().asByteArray()
        return GZIPInputStream(ByteArrayInputStream(bytes)).bufferedReader().use { it.readText() }
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
        private const val BUCKET = "anonymizer-svc-test"
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
