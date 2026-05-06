package com.plugin.processor

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@SpringBootApplication(scanBasePackages = ["com.plugin.core", "com.plugin.processor"])
@ConfigurationPropertiesScan(basePackages = ["com.plugin.core", "com.plugin.processor"])
class ProcessorApplication

fun main(args: Array<String>) {
    runApplication<ProcessorApplication>(*args)
}
