package com.plugin.features.auth

import com.fasterxml.jackson.annotation.JsonProperty

/**
 * Data Transfer Objects for authentication
 */

/**
 * Request for token refresh
 */
data class RefreshTokenRequest(
    val refreshToken: String,
    val userId: String
)

data class RefreshTokenResponse(
    val accessToken: String
)

data class FigmaOAuthTokenResponse(
    @JsonProperty("user_id_string") val userIdString: String?,
    @JsonProperty("user_id") val userId: Long,
    @JsonProperty("access_token") val accessToken: String,
    @JsonProperty("token_type") val tokenType: String,
    @JsonProperty("expires_in") val expiresIn: Long,
    @JsonProperty("refresh_token") val refreshToken: String
)

data class OAuthInitResponse(
    val readTokenJwt: String,
    val loginUrl: String,
)

data class ReadTokenResponse(
    val accessToken: String
)