package com.plugin.api.dev

import org.springframework.core.io.buffer.DataBufferFactory
import org.springframework.core.io.buffer.DefaultDataBufferFactory
import org.springframework.http.MediaType
import org.springframework.web.reactive.function.client.ClientRequest
import org.springframework.web.reactive.function.client.ClientResponse
import org.springframework.web.reactive.function.client.ExchangeFilterFunction
import org.springframework.web.reactive.function.client.ExchangeFunction
import reactor.core.publisher.Flux
import reactor.core.publisher.Mono
import java.nio.charset.StandardCharsets
import java.time.Instant

/**
 * WebClient filter that captures all outgoing HTTP requests and responses including request/response bodies for
 * monitoring and debugging purposes in development.
 */
class OutgoingHttpExchangeFilter(
    private val repository: OutgoingHttpExchangeRepository,
    private val maxBodySize: Int = 10240, // 10KB default
) : ExchangeFilterFunction {

    private val dataBufferFactory: DataBufferFactory = DefaultDataBufferFactory()

    override fun filter(request: ClientRequest, next: ExchangeFunction): Mono<ClientResponse> {
        val startTime = System.currentTimeMillis()
        val timestamp = Instant.now()
        val method = request.method().name()
        val uri = request.url().toString()
        val requestHeaders = request.headers().toSingleValueMap().mapValues { listOf(it.value) }

        // Capture request body if present
        val requestBodyMono = captureRequestBody(request)

        return requestBodyMono.flatMap { requestBodyInfo ->
            next
                .exchange(request)
                .flatMap { response ->
                    captureResponse(
                        response = response,
                        timestamp = timestamp,
                        method = method,
                        uri = uri,
                        requestHeaders = requestHeaders,
                        requestBodyInfo = requestBodyInfo,
                        startTime = startTime,
                    )
                }
                .onErrorResume { error ->
                    val timeTaken = System.currentTimeMillis() - startTime
                    val exchange =
                        OutgoingHttpExchange(
                            timestamp = timestamp,
                            method = method,
                            uri = uri,
                            statusCode = null,
                            timeTaken = timeTaken,
                            requestHeaders = requestHeaders,
                            responseHeaders = null,
                            requestBody = requestBodyInfo.body,
                            responseBody = null,
                            requestBodyTruncated = requestBodyInfo.truncated,
                            responseBodyTruncated = false,
                            error = error.message ?: error::class.simpleName,
                        )
                    repository.add(exchange)
                    Mono.error(error)
                }
        }
    }

    private fun captureRequestBody(request: ClientRequest): Mono<BodyInfo> {
        // Check if should capture body based on content type
        val contentType = request.headers().contentType
        if (!shouldCaptureBody(contentType)) {
            return Mono.just(BodyInfo(null, false))
        }

        // For form data or other body inserters, we can't easily capture without consuming
        // So we'll skip request body capture for now and focus on response bodies
        return Mono.just(BodyInfo(null, false))
    }

    private fun captureResponse(
        response: ClientResponse,
        timestamp: Instant,
        method: String,
        uri: String,
        requestHeaders: Map<String, List<String>>?,
        requestBodyInfo: BodyInfo,
        startTime: Long,
    ): Mono<ClientResponse> {
        val timeTaken = System.currentTimeMillis() - startTime
        val statusCode = response.statusCode().value()
        val responseHeaders = response.headers().asHttpHeaders().toSingleValueMap().mapValues { listOf(it.value) }

        val contentType = response.headers().contentType().orElse(null)

        // Check if we should capture the response body
        if (!shouldCaptureBody(contentType)) {
            val exchange =
                OutgoingHttpExchange(
                    timestamp = timestamp,
                    method = method,
                    uri = uri,
                    statusCode = statusCode,
                    timeTaken = timeTaken,
                    requestHeaders = requestHeaders,
                    responseHeaders = responseHeaders,
                    requestBody = requestBodyInfo.body,
                    responseBody = null,
                    requestBodyTruncated = requestBodyInfo.truncated,
                    responseBodyTruncated = false,
                    error = null,
                )
            repository.add(exchange)
            return Mono.just(response)
        }

        // Buffer and capture the response body
        return response
            .bodyToMono(String::class.java)
            .defaultIfEmpty("")
            .flatMap { bodyString ->
                val (capturedBody, truncated) = truncateIfNeeded(bodyString)

                val exchange =
                    OutgoingHttpExchange(
                        timestamp = timestamp,
                        method = method,
                        uri = uri,
                        statusCode = statusCode,
                        timeTaken = timeTaken,
                        requestHeaders = requestHeaders,
                        responseHeaders = responseHeaders,
                        requestBody = requestBodyInfo.body,
                        responseBody = capturedBody,
                        requestBodyTruncated = requestBodyInfo.truncated,
                        responseBodyTruncated = truncated,
                        error = null,
                    )
                repository.add(exchange)

                // Rebuild the response with the same body
                Mono.just(
                    ClientResponse.create(response.statusCode())
                        .headers { headers -> headers.addAll(response.headers().asHttpHeaders()) }
                        .body(
                            Flux.just(bodyString)
                                .map { it.toByteArray(StandardCharsets.UTF_8) }
                                .map { bytes -> dataBufferFactory.wrap(bytes) },
                        )
                        .build(),
                )
            }
            .onErrorResume { error ->
                // If body reading fails, still record the exchange without the body
                val exchange =
                    OutgoingHttpExchange(
                        timestamp = timestamp,
                        method = method,
                        uri = uri,
                        statusCode = statusCode,
                        timeTaken = timeTaken,
                        requestHeaders = requestHeaders,
                        responseHeaders = responseHeaders,
                        requestBody = requestBodyInfo.body,
                        responseBody = "[Failed to capture body: ${error.message}]",
                        requestBodyTruncated = requestBodyInfo.truncated,
                        responseBodyTruncated = false,
                        error = null,
                    )
                repository.add(exchange)
                Mono.just(response)
            }
    }

    private fun shouldCaptureBody(contentType: MediaType?): Boolean {
        if (contentType == null) return false

        // Capture text-based content types
        return contentType.type == "text" ||
            contentType.type == "application" &&
            (
                contentType.subtype == "json" ||
                    contentType.subtype == "xml" ||
                    contentType.subtype == "x-www-form-urlencoded" ||
                    contentType.subtype.contains("json") ||
                    contentType.subtype.contains("xml")
                )
    }

    private fun truncateIfNeeded(body: String): Pair<String, Boolean> = if (body.length > maxBodySize) {
        Pair(body.substring(0, maxBodySize) + "\n... [truncated]", true)
    } else {
        Pair(body, false)
    }

    private data class BodyInfo(val body: String?, val truncated: Boolean)
}
