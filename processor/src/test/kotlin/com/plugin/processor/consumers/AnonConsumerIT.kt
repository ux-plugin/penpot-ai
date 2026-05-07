package com.plugin.processor.consumers

import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.config.properties.ProcessorProperties
import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.core.testfixtures.IngestPipelineContainers
import com.plugin.core.worker.WorkerHeartbeat
import com.plugin.processor.processing.ChunkProcessor
import com.plugin.processor.testsupport.ProcessorTestInfra
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
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.ConcurrentLinkedQueue

class AnonConsumerIT {

    private lateinit var consumer: AnonConsumer
    private lateinit var capturingProcessor: CapturingChunkProcessor
    private val groupName = "test-proc-grp-${UUID.randomUUID().toString().take(6)}"
    private val inputStreamName = "test.anon.${UUID.randomUUID().toString().take(6)}"

    @BeforeEach
    fun setUp(): Unit = runBlocking {
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().awaitFirstOrNull()

        val workerProps = WorkerProperties(
            enabled = true,
            stream = WorkerProperties.StreamProperties(consumerGroup = groupName, pollTimeoutMs = 500),
        )
        val processorProps = ProcessorProperties(
            enabled = true,
            inputStream = inputStreamName,
            mode = ProcessorProperties.Mode.NOOP,
        )
        capturingProcessor = CapturingChunkProcessor()
        consumer = AnonConsumer(redis, connectionFactory, workerProps, processorProps, capturingProcessor, WorkerHeartbeat())
        consumer.start()
    }

    @AfterEach
    fun tearDown() {
        consumer.stop()
    }

    @Test
    fun `SESSION_ANONYMIZED event invokes ChunkProcessor`(): Unit = runBlocking {
        val sessionId = "sess-${UUID.randomUUID().toString().take(8)}"
        publishInput(IngestEvent(
            type = IngestEvent.Type.SESSION_ANONYMIZED,
            orgId = "org-A",
            sessionId = sessionId,
            firstSeq = 0L,
            lastSeq = 4L,
            chunkCount = 5L,
        ))

        eventually(seconds = 5) {
            val calls = capturingProcessor.captured()
            assertThat(calls).hasSize(1)
            val (orgId, sid, first, last) = calls.single()
            assertThat(orgId).isEqualTo("org-A")
            assertThat(sid).isEqualTo(sessionId)
            assertThat(first).isEqualTo(0L)
            assertThat(last).isEqualTo(4L)
        }
    }

    @Test
    fun `unexpected event type lands in DLQ`(): Unit = runBlocking {
        publishInput(IngestEvent(type = IngestEvent.Type.CHUNK, orgId = "org-A", sessionId = "x", chunkSeq = 0))

        eventually(seconds = 5) {
            val dlq = redis.opsForStream<String, String>()
                .read(StreamOffset.create("$inputStreamName.dlq", ReadOffset.from("0")))
                .collectList().awaitFirstOrNull().orEmpty()
            assertThat(dlq).hasSize(1)
        }
        assertThat(capturingProcessor.invocationCount()).isZero()
    }

    @Test
    fun `processor exception leaves message in PEL`(): Unit = runBlocking {
        capturingProcessor.failNext(RuntimeException("simulated"))

        publishInput(IngestEvent(
            type = IngestEvent.Type.SESSION_ANONYMIZED,
            orgId = "org-A",
            sessionId = "sess-fail",
            firstSeq = 0L,
            lastSeq = 0L,
        ))

        // Wait long enough that the dispatch could have ACK'ed if it were going to.
        delay(1_500)

        // Record stayed in PEL — pending entries list non-empty.
        val pending = redis.opsForStream<String, String>()
            .pending(inputStreamName, groupName)
            ?.awaitFirstOrNull()
        assertThat(pending?.totalPendingMessages ?: 0L).isGreaterThanOrEqualTo(1L)
    }

    private suspend fun publishInput(event: IngestEvent) {
        IngestStreamPublisher(redis, IngestProperties(
            enabled = true,
            stream = IngestProperties.StreamProperties(name = inputStreamName),
        )).publish(event)
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

    /** Test double — captures invocations and optionally throws on the next call. */
    private class CapturingChunkProcessor : ChunkProcessor {
        private val calls = ConcurrentLinkedQueue<Invocation>()
        private val count = AtomicInteger(0)
        @Volatile private var nextException: Throwable? = null

        fun failNext(t: Throwable) { nextException = t }
        fun captured(): List<Invocation> = calls.toList()
        fun invocationCount(): Int = count.get()

        override suspend fun process(orgId: String, sessionId: String, firstSeq: Long, lastSeq: Long) {
            count.incrementAndGet()
            nextException?.let {
                nextException = null
                throw it
            }
            calls.add(Invocation(orgId, sessionId, firstSeq, lastSeq))
        }

        data class Invocation(val orgId: String, val sessionId: String, val firstSeq: Long, val lastSeq: Long)
    }

    companion object {
        private val redis = ProcessorTestInfra.buildRedisTemplate()
        private val connectionFactory = (redis.connectionFactory as LettuceConnectionFactory)

        @BeforeAll
        @JvmStatic
        fun bootContainers() {
            IngestPipelineContainers.redis
        }

        @AfterAll
        @JvmStatic
        fun shutdown() {
            connectionFactory.destroy()
        }
    }
}
