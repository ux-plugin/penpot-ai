package com.plugin.api.features.auth.auth0

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty
import java.time.Instant

@JsonInclude(JsonInclude.Include.NON_NULL)
data class Auth0OAuthTokenResponse(
    @JsonProperty("access_token") val accessToken: String,
    @JsonProperty("refresh_token") val refreshToken: String? = null,
    @JsonProperty("id_token") val idToken: String? = null,
    @JsonProperty("expires_in") val expiresIn: Long,
    @JsonProperty("scope") val scope: String? = null,
    @JsonProperty("token_type") val tokenType: String = "Bearer",
)

data class Auth0PluginTokensResponse(val accessToken: String, val refreshToken: String, val refreshTokenExpiresAt: Instant)

data class Auth0RefreshRequest(val refreshToken: String)
