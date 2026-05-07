package com.plugin.core.ingest

import com.plugin.core.config.properties.IngestProperties
import io.lettuce.core.RedisClient
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.assertj.core.api.Assertions.assertThatThrownBy
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.testcontainers.containers.GenericContainer
import java.util.concurrent.atomic.AtomicLong

class BackpressureGuardTest {

    private lateinit var redis: ReactiveStringRedisTemplate
    private val streamName = "test.ingest.raw"
    private val time = AtomicLong(0)

    @BeforeEach
    fun setUp() = runBlocking {
        redis = template
        // Drain the stream between tests.
        redis.delete(streamName).awaitFirstOrNull()
        time.set(1_000)
    }

    @Test
    fun `assertCapacity passes when stream depth is under maxPending`() = runBlocking {
        appendStreamEntries(50)
        val guard = guardWithMaxPending(100)
        guard.assertCapacity()
    }

    @Test
    fun `assertCapacity throws IngestBackpressureException when depth exceeds maxPending`() = runBlocking {
        appendStreamEntries(150)
        val guard = guardWithMaxPending(100)
        assertThatThrownBy { runBlocking { guard.assertCapacity() } }
            .isInstanceOf(IngestBackpressureException::class.java)
            .hasMessageContaining("150")
            .hasMessageContaining("100")
    }

    @Test
    fun `currentLength is cached within TTL and refetched after expiry`() = runBlocking {
        appendStreamEntries(50)
        val guard = BackpressureGuard(redis, propsWith(maxPending = 1_000, cacheTtlMs = 1_000), clock = time::get)

        assertThat(guard.currentLength()).isEqualTo(50L)

        // Append more entries while still within TTL — guard should return cached value.
        appendStreamEntries(100)
        time.addAndGet(500)
        assertThat(guard.currentLength()).isEqualTo(50L)

        // Past TTL — refetch picks up the appended entries.
        time.addAndGet(1_001)
        assertThat(guard.currentLength()).isEqualTo(150L)
    }

    private suspend fun appendStreamEntries(count: Int) {
        val ops = redis.opsForStream<String, String>()
        repeat(count) { i ->
            val record = org.springframework.data.redis.connection.stream.StreamRecords.newRecord()
                .ofMap(mapOf("seq" to i.toString()))
                .withStreamKey(streamName)
            ops.add(record).awaitFirstOrNull()
        }
    }

    private fun guardWithMaxPending(maxPending: Long): BackpressureGuard =
        BackpressureGuard(redis, propsWith(maxPending = maxPending), clock = time::get)

    private fun propsWith(maxPending: Long, cacheTtlMs: Long = 0): IngestProperties = IngestProperties(
        enabled = true,
        stream = IngestProperties.StreamProperties(name = streamName, maxPending = maxPending, backpressureCacheTtlMs = cacheTtlMs),
    )

    companion object {
        private val redisContainer: GenericContainer<*> by lazy {
            GenericContainer<Nothing>("redis:7-alpine").apply {
                withExposedPorts(6379)
                start()
            }
        }
        private lateinit var connectionFactory: LettuceConnectionFactory
        private lateinit var template: ReactiveStringRedisTemplate

        @BeforeAll
        @JvmStatic
        fun bootRedis() {
            redisContainer
            connectionFactory = LettuceConnectionFactory(
                RedisStandaloneConfiguration(redisContainer.host, redisContainer.firstMappedPort),
            ).also { it.afterPropertiesSet() }
            template = ReactiveStringRedisTemplate(connectionFactory)
        }

        @AfterAll
        @JvmStatic
        fun shutdownRedis() {
            connectionFactory.destroy()
        }
    }
}
