package com.plugin.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "auth0")
data class Auth0Properties(val issuer: String? = null, val audience: String? = null, val jwkSetUri: String? = null) {
    fun resolvedJwkSetUri(): String? = jwkSetUri ?: issuer?.let { "${it.trimEnd('/')}/.well-known/jwks.json" }
}
