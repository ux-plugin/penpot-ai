package com.plugin.sanitizer.config

import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.ingest.IngestStreamPublisher
import com.plugin.sanitizer.lifecycle.QuarantineStreamPublisher
import com.plugin.sanitizer.lifecycle.SanitizedStreamPublisher
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

/**
 * Wires sanitizer-specific output stream publishers. The api app already publishes to
 * `ingest.raw`; sanitizer publishes to `ingest.sanitized` and `ingest.quarantine` —
 * different streams, same publisher impl, separate properties instances per stream.
 */
@Configuration
@EnableConfigurationProperties(IngestProperties::class)
class SanitizerConfig {

    @Bean
    fun sanitizedStreamPublisher(redis: ReactiveStringRedisTemplate): SanitizedStreamPublisher {
        val props = IngestProperties(
            enabled = true,
            stream = IngestProperties.StreamProperties(name = "ingest.sanitized"),
        )
        return SanitizedStreamPublisher(IngestStreamPublisher(redis, props))
    }

    @Bean
    fun quarantineStreamPublisher(redis: ReactiveStringRedisTemplate): QuarantineStreamPublisher {
        val props = IngestProperties(
            enabled = true,
            stream = IngestProperties.StreamProperties(name = "ingest.quarantine"),
        )
        return QuarantineStreamPublisher(IngestStreamPublisher(redis, props))
    }
}
