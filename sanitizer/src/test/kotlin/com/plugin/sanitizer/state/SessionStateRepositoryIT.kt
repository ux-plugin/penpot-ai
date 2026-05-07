package com.plugin.sanitizer.state

import com.plugin.core.config.properties.WorkerProperties
import com.plugin.core.testfixtures.IngestPipelineContainers
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.reactive.awaitFirstOrNull
import kotlinx.coroutines.runBlocking
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference

class SessionStateRepositoryIT {
    private lateinit var repo: SessionStateRepository
    private val now = AtomicReference(Instant.parse("2026-05-07T12:00:00Z"))

    @BeforeEach
    fun setUp() = runBlocking {
        redis.connectionFactory.reactiveConnection.serverCommands().flushAll().awaitFirstOrNull()
        val props = WorkerProperties(
            enabled = true,
            session = WorkerProperties.SessionProperties(idleTimeoutSec = 600, stateTtlSec = 1_200),
        )
        repo = SessionStateRepository(redis, props, clock = now::get)
    }

    @Test
    fun `recordChunk creates state and seq set with sliding TTL`() = runBlocking {
        repo.recordChunk("org-A", "sess-1", chunkSeq = 0, sizeBytes = 100)
        repo.recordChunk("org-A", "sess-1", chunkSeq = 1, sizeBytes = 200)

        val state = repo.getState("sess-1")!!
        assertThat(state.orgId).isEqualTo("org-A")
        assertThat(state.chunkSeqs).containsExactly(0L, 1L)
        assertThat(state.totalSizeBytes).isEqualTo(300L)
        assertThat(state.closing).isFalse

        // Both keys carry the configured TTL.
        val stateTtl = redis.getExpire("session:sess-1:state").awaitFirstOrNull()!!
        val seqsTtl = redis.getExpire("session:sess-1:seqs").awaitFirstOrNull()!!
        assertThat(stateTtl).isBetween(Duration.ofSeconds(1_180), Duration.ofSeconds(1_200))
        assertThat(seqsTtl).isBetween(Duration.ofSeconds(1_180), Duration.ofSeconds(1_200))
    }

    @Test
    fun `firstSeenAt is preserved across multiple recordChunks while lastSeenAt advances`() = runBlocking {
        now.set(Instant.parse("2026-05-07T12:00:00Z"))
        repo.recordChunk("org-A", "sess-1", 0, 100)
        now.set(Instant.parse("2026-05-07T12:01:30Z"))
        repo.recordChunk("org-A", "sess-1", 1, 100)

        val state = repo.getState("sess-1")!!
        assertThat(state.firstSeenAt).isEqualTo(Instant.parse("2026-05-07T12:00:00Z"))
        assertThat(state.lastSeenAt).isEqualTo(Instant.parse("2026-05-07T12:01:30Z"))
    }

    @Test
    fun `markClosing returns true on first call and false on the second`() = runBlocking {
        repo.recordChunk("org-A", "sess-1", 0, 100)
        assertThat(repo.markClosing("sess-1")).isTrue
        assertThat(repo.markClosing("sess-1")).isFalse
        assertThat(repo.getState("sess-1")!!.closing).isTrue
    }

    @Test
    fun `findIdleSessions returns sessions past threshold and ignores closing sessions`() = runBlocking {
        now.set(Instant.parse("2026-05-07T12:00:00Z"))
        repo.recordChunk("org-A", "old-sess", 0, 100)
        repo.recordChunk("org-A", "old-closing", 0, 100)
        repo.markClosing("old-closing")
        now.set(Instant.parse("2026-05-07T12:11:00Z")) // 11min later
        repo.recordChunk("org-A", "new-sess", 0, 100)

        val idle = repo.findIdleSessions(thresholdSec = 600).toList()
        assertThat(idle).containsExactly("old-sess")
    }

    @Test
    fun `delete clears both state hash and seqs sorted set`() = runBlocking {
        repo.recordChunk("org-A", "sess-1", 0, 100)
        repo.delete("sess-1")
        assertThat(repo.getState("sess-1")).isNull()
        assertThat(redis.opsForZSet().size("session:sess-1:seqs").awaitFirstOrNull()).isEqualTo(0L)
    }

    @Test
    fun `gaps and contiguous detection work for out-of-order delivery`() = runBlocking {
        listOf(2L, 0L, 1L, 4L, 3L).forEach { repo.recordChunk("org-A", "sess-1", it, 100) }
        val state = repo.getState("sess-1")!!
        assertThat(state.chunkSeqs).containsExactly(0L, 1L, 2L, 3L, 4L)
        assertThat(state.gaps()).isEmpty()

        repo.recordChunk("org-A", "sess-2", 0, 100)
        repo.recordChunk("org-A", "sess-2", 2, 100)
        repo.recordChunk("org-A", "sess-2", 4, 100)
        assertThat(repo.getState("sess-2")!!.gaps()).containsExactly(1L, 3L)
    }

    companion object {
        private val redis: ReactiveStringRedisTemplate by lazy {
            val cfg = RedisStandaloneConfiguration(IngestPipelineContainers.redisHost(), IngestPipelineContainers.redisPort())
            val factory = LettuceConnectionFactory(cfg).also { it.afterPropertiesSet() }
            connectionFactory = factory
            ReactiveStringRedisTemplate(factory)
        }
        private lateinit var connectionFactory: LettuceConnectionFactory

        @BeforeAll
        @JvmStatic
        fun bootContainers() {
            IngestPipelineContainers.redis
        }

        @AfterAll
        @JvmStatic
        fun shutdown() {
            if (::connectionFactory.isInitialized) connectionFactory.destroy()
        }
    }
}
