package com.plugin.features.auth.core

import org.springframework.stereotype.Service

@Service
class AuthService(private val authRepository: AuthRepository) {

    suspend fun refreshToken(refreshTokenRequest: RefreshTokenRequest): String {
        return authRepository.refreshAccessToken(refreshTokenRequest)
    }

    suspend fun getRefreshToken(userId: String): FigmaPluginGetRefreshTokenResponse {
        return authRepository.getRefreshToken(userId)
    }

    suspend fun deleteSocialLogin(userId: String, socialLoginId: String) {
        authRepository.deleteSocialLogin(userId, socialLoginId)
    }
}
