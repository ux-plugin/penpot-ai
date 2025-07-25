package com.plugin.features.auth.github

import com.fasterxml.jackson.annotation.JsonInclude
import com.fasterxml.jackson.annotation.JsonProperty

/**
 * Data Transfer Objects for GitHub authentication
 */

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