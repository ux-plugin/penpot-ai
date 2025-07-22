package com.plugin.features.auth

import com.fasterxml.jackson.annotation.JsonInclude
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

/**
 * Figma OAuth token response
 */
data class FigmaOAuthTokenResponse(
    @JsonProperty("user_id_string") val userIdString: String?,
    @JsonProperty("user_id") val userId: Long,
    @JsonProperty("access_token") val accessToken: String,
    @JsonProperty("token_type") val tokenType: String,
    @JsonProperty("expires_in") val expiresIn: Long,
    @JsonProperty("refresh_token") val refreshToken: String
)

/**
 * Figma refresh token response
 */
data class FigmaRefreshTokenResponse(
    val access_token: String,
    val token_type: String,
    val expires_in: Int
)

/**
 * Figma user information
 */
data class FigmaUser(
    val id: String,
    val handle: String,
    val img_url: String,
    val email: String // Email associated with the user's account (only present on /v1/me endpoint)
)

/**
 * GitHub OAuth token response
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
data class GitHubOAuthTokenResponse(
    @JsonProperty("access_token") val accessToken: String,
    @JsonProperty("expires_in") val expiresIn: Int,
    @JsonProperty("refresh_token") val refreshToken: String,
    @JsonProperty("refresh_token_expires_in") val refreshTokenExpiresIn: Int,
    @JsonProperty("scope") val scope: String = "",
    @JsonProperty("token_type") val tokenType: String = "bearer"
)

/**
 * GitHub user information
 */
data class GitHubUser(
    val id: Long,
    val login: String,
    @JsonProperty("avatar_url") val avatarUrl: String,
    val email: String?,
    val name: String?
)

/**
 * OAuth initialization response
 */
data class OAuthInitResponse(
    val readTokenJwt: String,
    val loginUrl: String,
)

/**
 * Read token response
 */
data class ReadTokenResponse(
    val accessToken: String
)