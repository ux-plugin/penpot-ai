package com.plugin.processor

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

/**
 * Processor worker — pipeline tail. Consumes
 * [com.plugin.core.ingest.IngestEvent.Type.SESSION_ANONYMIZED] events from
 * `ingest.anon` and dispatches each to a [com.plugin.processor.processing.ChunkProcessor].
 *
 * v0 ships with [com.plugin.processor.processing.NoopChunkProcessor]; the AI ticket
 * replaces the bean wired by [com.plugin.processor.config.ProcessorConfig] without
 * touching the consumer/ACK plumbing.
 */
@SpringBootApplication(scanBasePackages = ["com.plugin.core", "com.plugin.processor"])
@ConfigurationPropertiesScan(basePackages = ["com.plugin.core", "com.plugin.processor"])
@EnableScheduling
class ProcessorApplication

fun main(args: Array<String>) {
    runApplication<ProcessorApplication>(*args)
}
