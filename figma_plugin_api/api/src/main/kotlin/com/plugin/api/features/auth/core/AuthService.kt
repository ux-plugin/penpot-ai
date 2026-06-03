package com.plugin.api.features.auth.core

import org.springframework.stereotype.Service

@Service
class AuthService(private val authRepository: AuthRepository) {
    suspend fun deleteSocialLogin(userId: String, socialLoginId: String) {
        authRepository.deleteSocialLogin(userId, socialLoginId)
    }
}
