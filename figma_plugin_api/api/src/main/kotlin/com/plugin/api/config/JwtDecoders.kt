package com.plugin.api.config

import com.plugin.api.config.properties.Auth0Properties
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2Error
import org.springframework.security.oauth2.core.OAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtValidators
import org.springframework.security.oauth2.jwt.NimbusReactiveJwtDecoder
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder

internal class AudienceValidator(private val expected: String) : OAuth2TokenValidator<Jwt> {
    override fun validate(jwt: Jwt): OAuth2TokenValidatorResult {
        val audiences = jwt.audience ?: emptyList()
        return if (expected in audiences) {
            OAuth2TokenValidatorResult.success()
        } else {
            OAuth2TokenValidatorResult.failure(
                OAuth2Error("invalid_token", "Required audience '$expected' not present", null),
            )
        }
    }
}

internal fun auth0JwtDecoder(properties: Auth0Properties): ReactiveJwtDecoder {
    val issuer = requireNotNull(properties.issuer) { "auth0.issuer must be set" }
    val audience = requireNotNull(properties.audience) { "auth0.audience must be set when auth0.issuer is set" }
    val jwkSetUri = requireNotNull(properties.resolvedJwkSetUri()) { "auth0.jwk-set-uri could not be resolved" }
    return NimbusReactiveJwtDecoder
        .withJwkSetUri(jwkSetUri)
        .build()
        .apply {
            setJwtValidator(
                DelegatingOAuth2TokenValidator(
                    JwtValidators.createDefaultWithIssuer(issuer),
                    AudienceValidator(audience),
                ),
            )
        }
}
