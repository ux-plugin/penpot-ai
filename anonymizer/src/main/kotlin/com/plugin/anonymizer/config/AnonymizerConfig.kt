package com.plugin.anonymizer.config

import com.plugin.anonymizer.lifecycle.AnonStreamPublisher
import com.plugin.anonymizer.lifecycle.RawProcessedStreamPublisher
import com.plugin.core.config.properties.AnonymizerProperties
import com.plugin.core.config.properties.IngestProperties
import com.plugin.core.ingest.IngestStreamPublisher
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

/**
 * Wires anonymizer-specific output stream publishers. Same pattern as the sanitizer:
 * each output stream gets its own `IngestProperties` instance bound to a different
 * `stream.name` so the underlying [IngestStreamPublisher] writes to the right key.
 */
@Configuration
@EnableConfigurationProperties(AnonymizerProperties::class, IngestProperties::class)
class AnonymizerConfig {

    @Bean
    fun anonStreamPublisher(redis: ReactiveStringRedisTemplate, anonProps: AnonymizerProperties): AnonStreamPublisher {
        val props = IngestProperties(
            enabled = true,
            stream = IngestProperties.StreamProperties(name = anonProps.anonStream),
        )
        return AnonStreamPublisher(IngestStreamPublisher(redis, props))
    }

    @Bean
    fun rawProcessedStreamPublisher(redis: ReactiveStringRedisTemplate, anonProps: AnonymizerProperties): RawProcessedStreamPublisher {
        val props = IngestProperties(
            enabled = true,
            stream = IngestProperties.StreamProperties(name = anonProps.rawProcessedStream),
        )
        return RawProcessedStreamPublisher(IngestStreamPublisher(redis, props))
    }
}
