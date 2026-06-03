package com.plugin.sanitizer

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.autoconfigure.r2dbc.R2dbcAutoConfiguration
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

/**
 * Sanitizer worker — Kafka Streams topology that consumes [Topics.CHUNKS_RAW],
 * forwards CHUNK records to [Topics.CHUNKS_SANITIZED], and emits [SessionClosedRecord]
 * to [Topics.SESSIONS_CLOSED] when each session's window of inactivity expires.
 *
 * R2DBC autoconfig stays excluded — sanitizer doesn't touch Postgres. Kafka Streams
 * runs a non-daemon stream thread, so unlike the old design we don't need
 * `spring.main.keep-alive` or `@Scheduled` tricks to keep the JVM alive.
 */
@SpringBootApplication(
    scanBasePackages = ["com.plugin.core", "com.plugin.sanitizer"],
    exclude = [R2dbcAutoConfiguration::class],
)
@ConfigurationPropertiesScan(basePackages = ["com.plugin.core", "com.plugin.sanitizer"])
class SanitizerApplication

fun main(args: Array<String>) {
    runApplication<SanitizerApplication>(*args)
}
