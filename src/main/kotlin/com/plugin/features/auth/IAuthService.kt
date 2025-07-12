package com.plugin.features.auth

import io.smallrye.mutiny.Uni

/**
 * Interface for the authentication service (business logic)
 */
interface IAuthService {
    /**
     * Authenticate a user with username and password
     * @param loginRequest The authentication request containing username and password
     * @return The authentication response containing access and refresh tokens
     */
    fun authenticate(loginRequest: LoginRequest): Uni<LoginCredentials>

    /**
     * Refresh an access token using a refresh token
     * @param refreshTokenRequest The request containing the refresh token
     * @return A new access token
     */
    fun refreshToken(refreshTokenRequest: RefreshTokenRequest): Uni<String>
}
