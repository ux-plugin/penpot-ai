package com.plugin.anonymizer

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@SpringBootApplication(scanBasePackages = ["com.plugin.core", "com.plugin.anonymizer"])
@ConfigurationPropertiesScan(basePackages = ["com.plugin.core", "com.plugin.anonymizer"])
class AnonymizerApplication

fun main(args: Array<String>) {
    runApplication<AnonymizerApplication>(*args)
}
