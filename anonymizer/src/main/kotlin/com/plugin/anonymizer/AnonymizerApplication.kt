package com.plugin.anonymizer

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

/**
 * Anonymizer worker — consumes [com.plugin.core.ingest.IngestEvent.Type.SESSION_SANITIZED]
 * events from `ingest.sanitized`, reads `raw/<orgId>/<sessionId>/...` keys, applies
 * PII-scrubbing rules, writes `anon/<orgId>/<sessionId>/...`, and publishes both
 * `SESSION_ANONYMIZED` (→ `ingest.anon`, processor consumer) and `RAW_PROCESSED`
 * (→ `ingest.raw.processed`, sanitizer eviction trigger).
 */
@SpringBootApplication(scanBasePackages = ["com.plugin.core", "com.plugin.anonymizer"])
@ConfigurationPropertiesScan(basePackages = ["com.plugin.core", "com.plugin.anonymizer"])
@EnableScheduling
class AnonymizerApplication

fun main(args: Array<String>) {
    runApplication<AnonymizerApplication>(*args)
}
