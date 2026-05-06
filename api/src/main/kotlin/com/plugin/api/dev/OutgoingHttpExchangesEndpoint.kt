package com.plugin.api.dev

import org.springframework.boot.actuate.endpoint.annotation.Endpoint
import org.springframework.boot.actuate.endpoint.annotation.ReadOperation
import org.springframework.context.annotation.Profile
import org.springframework.stereotype.Component

/**
 * Custom actuator endpoint that exposes outgoing HTTP exchanges (client requests to external APIs). Available at:
 * /actuator/outhttpexchanges Only enabled in development profile.
 */
@Component
@Profile("dev")
@Endpoint(id = "outhttpexchanges")
class OutgoingHttpExchangesEndpoint(private val repository: OutgoingHttpExchangeRepository) {
    @ReadOperation
    fun getExchanges(): Map<String, Any> {
        val exchanges = repository.getAll()
        return mapOf(
            "exchanges" to
                exchanges.map { exchange ->
                    mapOf(
                        "timestamp" to exchange.timestamp.toString(),
                        "request" to
                            mapOf(
                                "method" to exchange.method,
                                "uri" to exchange.uri,
                                "headers" to exchange.requestHeaders,
                                "body" to exchange.requestBody,
                                "bodyTruncated" to exchange.requestBodyTruncated,
                            ),
                        "response" to
                            mapOf(
                                "status" to exchange.statusCode,
                                "headers" to exchange.responseHeaders,
                                "body" to exchange.responseBody,
                                "bodyTruncated" to exchange.responseBodyTruncated,
                            ),
                        "timeTaken" to "${exchange.timeTaken}ms",
                        "error" to exchange.error,
                    )
                },
        )
    }
}
