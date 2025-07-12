package com.plugin.features.auth

import io.smallrye.mutiny.Uni
import jakarta.ws.rs.NotFoundException

/**
 * Interface for the authentication repository (database access)
 */
interface IAuthRepository {
    /**
     * Authenticate a user with username and password
     * @param username The username of the user
     * @param password The password of the user
     * @return The authentication response containing access and refresh tokens
     * @throws NotFoundException if the user is not found
     * @throws SecurityException if the password is incorrect
     */
    fun authenticate(username: String, password: String): Uni<LoginCredentials>

    /**
     * Refresh an access token using a refresh token
     * @param refreshTokenRequest The refresh token with the user id
     * @return A new access token
     * @throws SecurityException if the refresh token is invalid or expired
     */
    fun refreshAccessToken(refreshTokenRequest: RefreshTokenRequest): Uni<String>

    /**
     * Validate a refresh token
     * @param refreshTokenRequest The refresh token to validate with the user id
     * @return The user ID associated with the refresh token
     * @throws SecurityException if the refresh token is invalid or expired
     */
    fun validateRefreshToken(refreshTokenRequest: RefreshTokenRequest): Uni<String>
}
