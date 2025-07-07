package com.plugin.features.auth

/**
 * Response for successful authentication
 */
data class LoginCredentials(
    val accessToken: String,
    val refreshToken: String
)