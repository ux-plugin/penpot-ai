package com.plugin.api.config.properties

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties(prefix = "auth0")
data class Auth0Properties(
    val issuer: String? = null,
    val audience: String? = null,
    val jwkSetUri: String? = null,
    val oauth: OAuthProperties = OAuthProperties(),
) {
    fun resolvedJwkSetUri(): String? = jwkSetUri ?: issuer?.let { "${it.trimEnd('/')}/.well-known/jwks.json" }

    fun resolvedTokenUrl(): String? = issuer?.let { "${it.trimEnd('/')}/oauth/token" }

    fun resolvedAuthorizeUrl(): String? = issuer?.let { "${it.trimEnd('/')}/authorize" }

    data class OAuthProperties(
        val clientId: String? = null,
        val clientSecret: String? = null,
        val loginRedirectUri: String? = null,
        val scope: String = "openid profile email offline_access",
        val refreshTokenLifetimeSec: Long = 2592000,
        val login: LoginProperties = LoginProperties(),
        val readToken: RedisKeyPrefixProperties = RedisKeyPrefixProperties("auth0-read-token:"),
        val writeToken: RedisKeyPrefixProperties = RedisKeyPrefixProperties("auth0-write-token:"),
        val tokens: RedisKeyPrefixProperties = RedisKeyPrefixProperties("auth0-tokens:"),
    ) {
        data class LoginProperties(val randomKey: RandomKeyProperties = RandomKeyProperties(), val timeoutSec: Long = 60) {
            data class RandomKeyProperties(val maxRetries: Int = 3)
        }

        data class RedisKeyPrefixProperties(val redisKeyPrefix: String)
    }
}
