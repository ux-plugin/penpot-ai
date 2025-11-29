package com.plugin.util

import org.slf4j.Logger
import org.slf4j.LoggerFactory

/**
 * Extension function to easily create a logger for any class.
 *
 * Usage:
 * ```kotlin
 * @Service
 * class MyService {
 *     private val log = logger()
 *
 *     fun doSomething() {
 *         log.info("Doing something...")
 *     }
 * }
 * ```
 */
inline fun <reified T> T.logger(): Logger {
    return LoggerFactory.getLogger(T::class.java)
}

/**
 * Create a logger for a specific class.
 *
 * Usage:
 * ```kotlin
 * @Service
 * class MyService {
 *     companion object {
 *         private val log = logger<MyService>()
 *     }
 * }
 * ```
 */
inline fun <reified T> logger(): Logger {
    return LoggerFactory.getLogger(T::class.java)
}
