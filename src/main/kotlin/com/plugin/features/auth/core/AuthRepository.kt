package com.plugin.features.auth.core

import com.plugin.config.JwtService
import com.plugin.features.user.UserRole
import kotlinx.coroutines.reactor.awaitSingle
import kotlinx.coroutines.reactor.awaitSingleOrNull
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.*

@Repository
class AuthRepositorySpring(
    private val authUserRepository: AuthUserR2dbcRepository,
    private val socialLoginRepository: SocialLoginR2dbcRepository,
    private val jwtService: JwtService,
    @Value("\${auth.access-token-ttl-s}") private val accessTokenExpirationSeconds: Long,
    @Value("\${auth.refresh-token-ttl-s}") private val refreshTokenExpirationSeconds: Long,
) {

    suspend fun getRefreshToken(userId: String): FigmaPluginGetRefreshTokenResponse {
        val entity = authUserRepository.findById(userId).awaitSingleOrNull()
            ?: throw NotFoundException("User not found with ID: $userId")
        
        if (entity.refreshToken.isNotEmpty() && entity.refreshTokenExpiresAt.isAfter(Instant.now())) {
            return FigmaPluginGetRefreshTokenResponse(entity.refreshToken, entity.refreshTokenExpiresAt)
        } else {
            throw SecurityException("Invalid or expired refresh token")
        }
    }

    suspend fun createTokensForUser(id: String, role: UserRole): LoginCredentials {
        val accessToken = createAccessToken(id, role)
        val refreshTokenInfo = createRefreshToken(id)
        return LoginCredentials(
            accessToken = accessToken,
            refreshToken = refreshTokenInfo.refreshToken,
            refreshTokenExpiresAt = refreshTokenInfo.expiresAt,
        )
    }

    private fun createAccessToken(id: String, role: UserRole): String {
        return jwtService.createToken(id, role.name, accessTokenExpirationSeconds)
    }

    @Transactional
    suspend fun createRefreshToken(userId: String): RefreshTokenInfo {
        val refreshToken = UUID.randomUUID().toString()
        val refreshTokenExpiresAt = Instant.now().plusSeconds(refreshTokenExpirationSeconds)

        val entity = authUserRepository.findById(userId).awaitSingleOrNull()
            ?: throw NotFoundException("User not found with ID: $userId")
        
        entity.refreshToken = refreshToken
        entity.refreshTokenExpiresAt = refreshTokenExpiresAt
        authUserRepository.save(entity).awaitSingle()
        
        return RefreshTokenInfo(refreshToken, refreshTokenExpiresAt)
    }

    suspend fun refreshAccessToken(refreshTokenRequest: RefreshTokenRequest): String {
        val entity = authUserRepository.findByIdAndRefreshToken(
            refreshTokenRequest.userId,
            refreshTokenRequest.refreshToken
        ).awaitSingleOrNull()

        if (entity == null || entity.refreshTokenExpiresAt.isBefore(Instant.now())) {
            throw SecurityException(
                "Invalid or expired refresh token for user with ID: ${refreshTokenRequest.userId}"
            )
        }
        
        return createAccessToken(id = entity.id, role = entity.role)
    }

    @Transactional
    suspend fun addUser(): AuthUserEntity {
        val newUser = AuthUserEntity(
            role = UserRole.USER
        )
        return authUserRepository.save(newUser).awaitSingle()
    }

    suspend fun getSocialLogin(
        providerUserId: String,
        provider: SocialProvider,
    ): SocialLoginEntity? {
        return socialLoginRepository.findByProviderUserIdAndProvider(
            providerUserId,
            provider.name
        ).awaitSingleOrNull()
    }

    @Transactional
    suspend fun updateSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String?,
        refreshTokenExpiresAt: Instant?,
    ) {
        val entity = socialLoginRepository.findByProviderUserIdAndProvider(
            providerUserId,
            provider.name
        ).awaitSingleOrNull()

        if (entity != null) {
            if (refreshToken != null) {
                entity.refreshToken = refreshToken
            }
            if (refreshTokenExpiresAt != null) {
                entity.refreshTokenExpiresAt = refreshTokenExpiresAt
            }
            socialLoginRepository.save(entity).awaitSingle()
        } else {
            throw NotFoundException("Social login not found for user: $providerUserId")
        }
    }

    @Transactional
    suspend fun insertSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String,
        main: Boolean = false,
    ): SocialLoginEntity {
        authUserRepository.findById(userId).awaitSingleOrNull()
            ?: throw NotFoundException("User $userId not found")

        val socialLoginEntity = SocialLoginEntity(
            userId = userId,
            provider = provider,
            providerUserId = providerUserId,
            refreshToken = refreshToken,
            refreshTokenExpiresAt = refreshTokenExpiresAt,
            main = main
        )
        
        return socialLoginRepository.save(socialLoginEntity).awaitSingle()
    }

    @Transactional
    suspend fun upsertSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String,
    ) {
        val socialLoginEntity = getSocialLogin(providerUserId, provider)
        if (socialLoginEntity == null) {
            insertSocialLogin(
                provider,
                providerUserId,
                refreshToken,
                refreshTokenExpiresAt,
                userId,
            )
        } else {
            updateSocialLogin(
                provider,
                providerUserId,
                refreshToken,
                refreshTokenExpiresAt,
            )
        }
    }

    @Transactional
    suspend fun deleteSocialLogin(userId: String, socialLoginId: String) {
        val entity = socialLoginRepository.findByUserIdAndId(userId, socialLoginId).awaitSingleOrNull()
            ?: throw NotFoundException("Social login not found for user: $userId")
        
        if (entity.main) {
            throw NotAllowedException("Cannot delete main social login")
        }
        
        socialLoginRepository.deleteByIdCustom(socialLoginId).awaitSingleOrNull()
    }

    @Transactional
    suspend fun associateUserWithSocialProvider(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String? = null,
    ): AuthUserEntity {
        val socialLoginEntity = getSocialLogin(providerUserId, provider)
        
        return if (socialLoginEntity != null) {
            // Case 1: Social login exists. Return the associated user and update the refresh token.
            updateSocialLogin(
                provider = provider,
                providerUserId = providerUserId,
                refreshToken = refreshToken,
                refreshTokenExpiresAt = refreshTokenExpiresAt,
            )
            
            authUserRepository.findById(socialLoginEntity.userId).awaitSingleOrNull()
                ?: throw NotFoundException("Associated user not found for social login with ID: ${socialLoginEntity.id}")
        } else {
            // Case 2: Social login does not exist.
            if (userId != null) {
                // Case 2a: An existing userId is provided. Associate the new social login with this user.
                val user = authUserRepository.findById(userId).awaitSingleOrNull()
                    ?: throw NotFoundException("User $userId not found")
                
                insertSocialLogin(
                    provider = provider,
                    providerUserId = providerUserId,
                    refreshToken = refreshToken,
                    refreshTokenExpiresAt = refreshTokenExpiresAt,
                    userId = user.id,
                )
                user
            } else {
                // Case 2b: No userId is provided. Create a new user and associate the social login with it.
                val newUser = addUser()
                insertSocialLogin(
                    provider = provider,
                    providerUserId = providerUserId,
                    refreshToken = refreshToken,
                    refreshTokenExpiresAt = refreshTokenExpiresAt,
                    userId = newUser.id,
                    main = true,
                )
                newUser
            }
        }
    }
}
