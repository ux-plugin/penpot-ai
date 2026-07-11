package com.plugin.api.dev

import com.plugin.api.config.auth0JwtDecoder
import com.plugin.api.config.properties.Auth0Properties
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

/**
 * Integration test for the dev Auth0 mock: proves a token minted by [DevAuth0Mock] validates
 * through the REAL prod decoder (`auth0JwtDecoder`) — signature via the mock's JWKS + issuer +
 * audience — and carries the claims `Auth0UserProvisioner` needs. The JWKS is served over HTTP
 * via MockWebServer (same approach as `Auth0UserSyncIT`), so the whole verification path is real.
 */
class DevAuth0MockIT {
    private val issuer = "http://localhost/dev"
    private val audience = "penpot-ai-dev"

    private fun mock() = DevAuth0Mock(Auth0Properties(issuer = issuer, audience = audience))

    @Test
    fun `a dev-minted token validates through the real auth0 decoder`() {
        val mock = mock()
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody(mock.jwks()).setHeader("Content-Type", "application/json"))
        server.start()
        try {
            val decoder = auth0JwtDecoder(
                Auth0Properties(issuer = issuer, audience = audience, jwkSetUri = server.url("/jwks").toString()),
            )

            val jwt = decoder.decode(mock.token()["access_token"]!!).block()!!

            assertThat(jwt.subject).isEqualTo("auth0|dev")
            assertThat(jwt.issuer.toString()).isEqualTo(issuer)
            assertThat(jwt.audience).contains(audience)
            assertThat(jwt.getClaimAsString("email")).isEqualTo("dev@localhost")
            assertThat(jwt.expiresAt).isNotNull()
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun `the keypair is deterministic so a pasted token survives backend restarts`() {
        // Two fresh instances (= two boots) must expose the same JWKS, so a token minted before a
        // restart still verifies after it — that's what makes VITE_AI_BACKEND_KEY "always valid".
        assertThat(mock().jwks()).isEqualTo(mock().jwks())
    }
}
