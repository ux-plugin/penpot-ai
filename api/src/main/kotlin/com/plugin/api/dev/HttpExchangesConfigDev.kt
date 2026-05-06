package com.plugin.api.dev

import org.springframework.boot.actuate.web.exchanges.HttpExchangeRepository
import org.springframework.boot.actuate.web.exchanges.InMemoryHttpExchangeRepository
import org.springframework.boot.web.reactive.function.client.WebClientCustomizer
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Profile

/**
 * Configuration for HTTP exchanges tracing in development environment. This enables both incoming and outgoing HTTP
 * request/response monitoring.
 *
 * Endpoints:
 * - /actuator/httpexchanges - Incoming requests to the backend
 * - /actuator/outhttpexchanges - Outgoing requests to external APIs
 *
 * Only active when 'dev' profile is enabled for security reasons.
 */
@Configuration
@Profile("dev")
class HttpExchangesConfigDev {
    /**
     * Creates an in-memory repository to store incoming HTTP request/response exchanges. Stores the last 100 HTTP
     * exchanges by default.
     *
     * @return HttpExchangeRepository configured for development
     */
    @Bean
    fun httpExchangeRepository(): HttpExchangeRepository = InMemoryHttpExchangeRepository()

    /**
     * Creates a repository to store outgoing HTTP exchanges (to external APIs). Stores the last 100 outgoing API calls.
     *
     * @return OutgoingHttpExchangeRepository configured for development
     */
    @Bean
    fun outgoingHttpExchangeRepository(): OutgoingHttpExchangeRepository = OutgoingHttpExchangeRepository(capacity = 100)

    /**
     * Creates a filter to capture all outgoing HTTP requests/responses. Captures response bodies up to 10KB by default.
     *
     * @param repository The repository to store exchanges
     * @return OutgoingHttpExchangeFilter configured for development
     */
    @Bean
    fun outgoingHttpExchangeFilter(repository: OutgoingHttpExchangeRepository): OutgoingHttpExchangeFilter {
        return OutgoingHttpExchangeFilter(repository, maxBodySize = 10240) // 10KB
    }

    /**
     * Customizes all WebClient instances to include the outgoing exchange filter. This automatically captures all HTTP
     * requests made by WebClient throughout the application.
     *
     * @param filter The filter to add to WebClient
     * @return WebClientCustomizer that adds the filter
     */
    @Bean
    fun outgoingHttpExchangeWebClientCustomizer(filter: OutgoingHttpExchangeFilter): WebClientCustomizer =
        WebClientCustomizer { builder -> builder.filter(filter) }
}
