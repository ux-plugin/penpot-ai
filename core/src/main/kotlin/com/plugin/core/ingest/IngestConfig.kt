package com.plugin.core.ingest

import com.plugin.core.config.properties.IngestProperties
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.data.redis.core.ReactiveStringRedisTemplate

/**
 * Wires ingest pipeline beans (publisher, backpressure guard) when `ingest.enabled=true`.
 * Worker apps without ingest config boot cleanly because this @Configuration stays inert.
 */
@Configuration
@ConditionalOnProperty(prefix = "ingest", name = ["enabled"], havingValue = "true")
@EnableConfigurationProperties(IngestProperties::class)
class IngestConfig {

    @Bean
    fun ingestStreamPublisher(redis: ReactiveStringRedisTemplate, props: IngestProperties): IngestStreamPublisher =
        IngestStreamPublisher(redis, props)

    @Bean
    fun backpressureGuard(redis: ReactiveStringRedisTemplate, props: IngestProperties): BackpressureGuard =
        BackpressureGuard(redis, props)
}
