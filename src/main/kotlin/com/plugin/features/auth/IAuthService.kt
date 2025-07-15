package com.plugin.features.auth

/**
 * Interface for the authentication service (business logic)
 */
interface IAuthService {
    /**
     * Authenticate a user with username and password
     * @param loginRequest The authentication request containing username and password
     * @return The authentication response containing access and refresh tokens
     */
    suspend fun authenticate(loginRequest: LoginRequest): LoginCredentials

    /**
     * Refresh an access token using a refresh token
     * @param refreshTokenRequest The request containing the refresh token
     * @return A new access token
     */
    suspend fun refreshToken(refreshTokenRequest: RefreshTokenRequest): String
}
