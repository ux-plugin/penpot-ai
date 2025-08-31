// Assuming this is in the same package as AuthRepository
package com.plugin.features.auth.core

import com.plugin.features.user.UserRole
import io.smallrye.mutiny.Uni
import java.time.Instant

interface IAuthRepository {
    // Existing methods (may vary in your implementation)
    fun getRefreshToken(userId: String): Uni<String>

    fun createTokensForUser(id: String, role: UserRole): Uni<LoginCredentials>

    fun refreshAccessToken(refreshTokenRequest: RefreshTokenRequest): Uni<String>

    fun addUser(): Uni<AuthUserEntity>

    fun getSocialLogin(providerUserId: String, provider: SocialProvider): Uni<SocialLoginEntity?>

    // Add these two methods from the implementation
    fun updateSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String?,
        refreshTokenExpiresAt: Instant?,
    ): Uni<Unit>

    fun insertSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String,
        main: Boolean = false,
    ): Uni<SocialLoginEntity>

    fun upsertSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String,
    ): Uni<Unit>

    /**
     * Creates or retrieves a user and associates them with a social provider in a single transaction.
     *
     * @param username The username of the user to create or retrieve
     * @param provider The social provider (e.g., FIGMA, GOOGLE)
     * @param providerUserId The user ID from the provider
     * @param refreshToken The refresh token from the provider
     * @param refreshTokenExpiresAt When the refresh token expires
     * @return The user entity that was created or retrieved
     */
    fun associateUserWithSocialProvider(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String? = null,
    ): Uni<AuthUserEntity>
}
