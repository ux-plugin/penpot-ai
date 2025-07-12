package com.plugin.features.auth

/**
 * Data Transfer Objects for authentication
 */

/**
 * Request for user authentication
 */
data class LoginRequest(
    val username: String,
    val password: String
)

data class LoginResponse(
    val accessToken: String
)

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
