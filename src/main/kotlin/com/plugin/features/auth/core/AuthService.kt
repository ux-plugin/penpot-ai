package com.plugin.features.auth.core

import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject

/** Service for authentication */
@ApplicationScoped
class AuthService @Inject constructor(private val authRepository: AuthRepository) {
    /**
     * Refresh an access token using a refresh token
     *
     * @param refreshTokenRequest The request containing the refresh token
     * @return A new access token
     */
    suspend fun refreshToken(refreshTokenRequest: RefreshTokenRequest): String {
        return authRepository.refreshAccessToken(refreshTokenRequest).awaitSuspending()
    }

    suspend fun getRefreshToken(userId: String): FigmaPluginGetRefreshTokenResponse {
        return authRepository.getRefreshToken(userId).awaitSuspending()
    }

    suspend fun deleteSocialLogin(userId: String, socialLoginId: String) {
        authRepository.deleteSocialLogin(userId, socialLoginId).awaitSuspending()
    }
}
