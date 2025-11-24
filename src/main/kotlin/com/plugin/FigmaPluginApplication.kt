package com.plugin

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class FigmaPluginApplication

fun main(args: Array<String>) {
    runApplication<FigmaPluginApplication>(*args)
}
