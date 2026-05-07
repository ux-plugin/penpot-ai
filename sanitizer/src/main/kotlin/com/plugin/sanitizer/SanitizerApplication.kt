package com.plugin.sanitizer

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

/**
 * Sanitizer worker — consumes [com.plugin.core.ingest.IngestEvent]s from `ingest.raw`,
 * accumulates per-session state in Redis, classifies sessions on close (explicit
 * CLOSE_HINT or idle timeout), and publishes downstream events on `ingest.sanitized`
 * or `ingest.quarantine`. Owns raw-data eviction once anonymizer signals via
 * `ingest.raw.processed`.
 */
@SpringBootApplication(scanBasePackages = ["com.plugin.core", "com.plugin.sanitizer"])
@ConfigurationPropertiesScan(basePackages = ["com.plugin.core", "com.plugin.sanitizer"])
@EnableScheduling
class SanitizerApplication

fun main(args: Array<String>) {
    runApplication<SanitizerApplication>(*args)
}
