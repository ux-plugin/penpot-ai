package com.plugin.config

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.security.oauth2.jwt.Jwt
import java.time.Instant

class JwtDecodersTest {
    private fun jwt(audiences: List<String>?): Jwt {
        val builder = Jwt
            .withTokenValue("token")
            .header("alg", "RS256")
            .issuer("https://test.auth0.local/")
            .subject("auth0|abc")
            .issuedAt(Instant.now())
            .expiresAt(Instant.now().plusSeconds(60))
        if (audiences != null) builder.audience(audiences)
        return builder.build()
    }

    @Test
    fun `passes when expected audience is present`() {
        val result = AudienceValidator("figma-plugin").validate(jwt(listOf("figma-plugin", "other")))
        assertFalse(result.hasErrors())
    }

    @Test
    fun `fails when expected audience is absent`() {
        val result = AudienceValidator("figma-plugin").validate(jwt(listOf("other")))
        assertTrue(result.hasErrors())
    }

    @Test
    fun `fails when audience claim is missing entirely`() {
        val result = AudienceValidator("figma-plugin").validate(jwt(null))
        assertTrue(result.hasErrors())
    }
}
