package com.plugin.config

import com.plugin.config.properties.Auth0Properties
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2Error
import org.springframework.security.oauth2.core.OAuth2TokenValidator
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.security.oauth2.jwt.JwtValidators
import org.springframework.security.oauth2.jwt.NimbusReactiveJwtDecoder
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder
import java.security.interfaces.RSAPublicKey

internal const val SELF_HOSTED_ISSUER = "ux-plugin"

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

internal fun selfHostedJwtDecoder(publicKey: RSAPublicKey): ReactiveJwtDecoder = NimbusReactiveJwtDecoder
    .withPublicKey(publicKey)
    .build()
    .apply { setJwtValidator(JwtValidators.createDefaultWithIssuer(SELF_HOSTED_ISSUER)) }

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
