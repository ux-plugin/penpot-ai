package com.plugin.processor.testsupport

import com.plugin.core.testfixtures.IngestPipelineContainers
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

/**
 * Mirror of `SanitizerTestInfra` / `AnonymizerTestInfra` for processor ITs. Processor
 * does not touch S3 in v0 — only Redis streams — so the helper is intentionally minimal.
 */
object ProcessorTestInfra {

    fun buildRedisTemplate(): ReactiveStringRedisTemplate {
        val cfg = RedisStandaloneConfiguration(IngestPipelineContainers.redisHost(), IngestPipelineContainers.redisPort())
        val factory = LettuceConnectionFactory(cfg).also { it.afterPropertiesSet() }
        return ReactiveStringRedisTemplate(factory)
    }
}
