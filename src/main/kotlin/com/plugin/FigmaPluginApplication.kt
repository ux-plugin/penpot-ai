package com.plugin

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@SpringBootApplication @ConfigurationPropertiesScan
class FigmaPluginApplication

fun main(args: Array<String>) {
    runApplication<FigmaPluginApplication>(*args)
}
