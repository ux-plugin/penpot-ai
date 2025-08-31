package com.plugin.features.auth.core

import java.time.Instant

/**
 * Response for successful authentication
 */
data class LoginCredentials(
    val accessToken: String,
    val refreshToken: String,
    val refreshTokenExpiresAt: Instant
)

enum class ConnectSocialProviderResult(val value: String) {
    SUCCESS("200"),
    FAILURE("500")
}