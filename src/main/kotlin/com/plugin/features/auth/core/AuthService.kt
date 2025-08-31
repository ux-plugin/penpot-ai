package com.plugin.features.auth.core

import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject

/**
 * Service for authentication
 */
@ApplicationScoped
class AuthService @Inject constructor(
    private val authRepository: IAuthRepository
) : IAuthService {
    /**
     * Refresh an access token using a refresh token
     * @param refreshTokenRequest The request containing the refresh token
     * @return A new access token
     */
    override suspend fun refreshToken(refreshTokenRequest: RefreshTokenRequest): String {
        return authRepository.refreshAccessToken(refreshTokenRequest).awaitSuspending()
    }

    override suspend fun getRefreshToken(userId: String): String {
        return authRepository.getRefreshToken(userId).awaitSuspending()
    }
}