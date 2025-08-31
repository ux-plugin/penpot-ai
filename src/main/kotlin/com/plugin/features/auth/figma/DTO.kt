package com.plugin.features.auth.figma

import com.fasterxml.jackson.annotation.JsonProperty

/** Data Transfer Objects for Figma authentication */

/** Figma OAuth token response */
data class FigmaOAuthTokenResponse(
    @JsonProperty("user_id_string") val userIdString: String?,
    @JsonProperty("user_id") val userId: Long,
    @JsonProperty("access_token") val accessToken: String,
    @JsonProperty("token_type") val tokenType: String,
    @JsonProperty("expires_in") val expiresIn: Long,
    @JsonProperty("refresh_token") val refreshToken: String,
)

/** Figma refresh token response */
data class FigmaRefreshTokenResponse(
    val access_token: String,
    val token_type: String,
    val expires_in: Int,
)

/** Figma user information */
data class FigmaUser(
    val id: String,
    val handle: String,
    val img_url: String,
    val email: String, // Email associated with the user's account (only present on /v1/me endpoint)
)
