package com.plugin.api.security

import com.plugin.api.config.properties.ApiKeyProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.mock.http.server.reactive.MockServerHttpRequest
import org.springframework.mock.web.server.MockServerWebExchange

class ApiKeyAuthenticationConverterTest {
    private val props = ApiKeyProperties(prefix = "pk_test_")
    private val converter = ApiKeyAuthenticationConverter(props)

    @Test
    fun `Authorization Bearer with matching prefix yields an unverified authentication`() {
        val token = "pk_test_abc123"
        val exchange = exchangeWith(HttpHeaders.AUTHORIZATION to "Bearer $token")

        val result = converter.convert(exchange).block()

        assertThat(result).isInstanceOf(UnverifiedApiKeyAuthentication::class.java)
        assertThat((result as UnverifiedApiKeyAuthentication).plaintext).isEqualTo(token)
    }

    @Test
    fun `X-Api-Key header is recognised when Authorization is absent`() {
        val token = "pk_test_xyz"
        val exchange = exchangeWith("X-Api-Key" to token)
        assertThat(converter.convert(exchange).block())
            .isInstanceOf(UnverifiedApiKeyAuthentication::class.java)
    }

    @Test
    fun `Bearer JWTs without the api-key prefix fall through to the JWT chain`() {
        val exchange = exchangeWith(HttpHeaders.AUTHORIZATION to "Bearer eyJraWQiOiJhYmMifQ.x.y")
        assertThat(converter.convert(exchange).blockOptional()).isEmpty
    }

    @Test
    fun `requests with no Authorization or X-Api-Key header pass through`() {
        val exchange = exchangeWith()
        assertThat(converter.convert(exchange).blockOptional()).isEmpty
    }

    private fun exchangeWith(vararg headers: Pair<String, String>): MockServerWebExchange {
        val builder = MockServerHttpRequest.get("/api/orgs")
        headers.forEach { (k, v) -> builder.header(k, v) }
        return MockServerWebExchange.from(builder)
    }
}
