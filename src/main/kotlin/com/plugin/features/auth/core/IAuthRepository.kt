package com.plugin.features.auth.core

import com.plugin.features.user.UserRole
import io.smallrye.mutiny.Uni
import java.time.Instant

/**
 * Interface for the authentication repository (database access)
 */
interface IAuthRepository {

    fun refreshAccessToken(refreshTokenRequest: RefreshTokenRequest): Uni<String>

    fun getRefreshToken(userId: String): Uni<String>

    fun upsertSocialLogin(
        provider: SocialProvider,
        refreshToken: String,
        userId: String,
        refreshTokenExpiresAt: Instant
    ): Uni<Unit>

    fun getOrAddUser(username: String): Uni<AuthUserEntity>

    fun createTokensForUser(id: String, username: String, role: UserRole): Uni<LoginCredentials>
}