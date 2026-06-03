package com.plugin.api.dev

import java.time.Instant

/**
 * Represents an outgoing HTTP exchange (request/response) made by the application to external APIs. This is used for
 * debugging and monitoring outgoing API calls in development.
 */
data class OutgoingHttpExchange(
    val timestamp: Instant,
    val method: String,
    val uri: String,
    val statusCode: Int?,
    val timeTaken: Long, // milliseconds
    val requestHeaders: Map<String, List<String>>?,
    val responseHeaders: Map<String, List<String>>?,
    val requestBody: String? = null,
    val responseBody: String? = null,
    val requestBodyTruncated: Boolean = false,
    val responseBodyTruncated: Boolean = false,
    val error: String? = null,
)

/** Repository for storing outgoing HTTP exchanges in memory. Thread-safe implementation with a fixed capacity. */
class OutgoingHttpExchangeRepository(private val capacity: Int = 100) {
    private val exchanges = mutableListOf<OutgoingHttpExchange>()

    @Synchronized
    fun add(exchange: OutgoingHttpExchange) {
        exchanges.add(0, exchange) // Add to front
        if (exchanges.size > capacity) {
            exchanges.removeAt(exchanges.size - 1) // Remove oldest
        }
    }

    @Synchronized
    fun getAll(): List<OutgoingHttpExchange> = exchanges.toList()

    @Synchronized
    fun clear() {
        exchanges.clear()
    }
}
