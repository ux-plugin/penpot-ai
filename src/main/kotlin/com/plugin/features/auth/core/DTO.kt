package com.plugin.features.auth.core

import java.time.Instant

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

data class RefreshTokenInfo(
    val refreshToken: String,
    val expiresAt: Instant
)

data class RefreshTokenResponse(
    val accessToken: String
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

/**
 * Error response for authentication failures
 */
data class AuthErrorResponse(val message: String = "Invalid username or password.")