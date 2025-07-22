package com.plugin.features.auth

/**
 * Interface for the authentication service (business logic)
 */
interface IAuthService {
    /**
     * Refresh an access token using a refresh token
     * @param refreshTokenRequest The request containing the refresh token
     * @return A new access token
     */
    suspend fun refreshToken(refreshTokenRequest: RefreshTokenRequest): String
    suspend fun getRefreshToken(userId: String): String
}
