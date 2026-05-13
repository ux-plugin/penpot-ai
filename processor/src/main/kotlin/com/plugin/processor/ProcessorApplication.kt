package com.plugin.processor

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

/**
 * Processor worker — pipeline tail.
 *
 * Kafka Streams topology:
 *  - Aggregates `chunks.anonymized` per session into a running metadata KTable
 *    (state-store-backed, recoverable via changelog).
 *  - Joins `sessions.closed` with that table to flush the final
 *    [com.plugin.core.replay.SessionMetadata] row to Postgres via R2DBC.
 *
 * R2DBC autoconfig is enabled here (unlike the other workers) since the
 * processor writes to `session_metadata`. See `config/R2dbcConfig.kt`.
 */
@SpringBootApplication(scanBasePackages = ["com.plugin.core", "com.plugin.processor"])
@ConfigurationPropertiesScan(basePackages = ["com.plugin.core", "com.plugin.processor"])
class ProcessorApplication

fun main(args: Array<String>) {
    runApplication<ProcessorApplication>(*args)
}
