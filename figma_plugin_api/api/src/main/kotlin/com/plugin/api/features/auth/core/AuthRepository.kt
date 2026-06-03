package com.plugin.api.features.auth.core

import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Repository
import java.time.Instant

@Repository
class AuthRepository(
    private val authUserRepository: AuthUserRepository,
    private val socialLoginRepository: SocialLoginsRepository,
    private val database: R2dbcDatabase,
) {
    private val logger = LoggerFactory.getLogger(AuthRepository::class.java)

    suspend fun addUser(): AuthUserEntity {
        logger.debug("Creating new user")
        return try {
            val newUser = AuthUserEntity()
            val savedUser = authUserRepository.save(newUser)
            logger.debug("Successfully created user with ID: ${savedUser.id}")
            savedUser
        } catch (e: Exception) {
            logger.error("Failed to create new user", e)
            throw e
        }
    }

    suspend fun getSocialLogin(providerUserId: String, provider: SocialProvider): SocialLoginEntity? =
        socialLoginRepository.findByProviderUserIdAndProvider(providerUserId, provider)

    suspend fun updateSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String?,
        refreshTokenExpiresAt: Instant?,
    ) {
        logger.debug("Updating social login for provider: {}, providerUserId: {}", provider, providerUserId)
        return try {
            val entity = socialLoginRepository.findByProviderUserIdAndProvider(providerUserId, provider)

            if (entity != null) {
                if (refreshToken != null) {
                    entity.refreshToken = refreshToken
                }
                if (refreshTokenExpiresAt != null) {
                    entity.refreshTokenExpiresAt = refreshTokenExpiresAt
                }
                socialLoginRepository.save(entity)
                logger.debug("Successfully updated social login for providerUserId: {}", providerUserId)
            } else {
                logger.error("Social login not found for provider: {}, providerUserId: {}", provider, providerUserId)
                throw NotFoundException("Social login not found for user: $providerUserId")
            }
        } catch (e: Exception) {
            logger.error(
                "Failed to update social login for provider: {}, providerUserId: {}",
                provider,
                providerUserId,
                e,
            )
            throw e
        }
    }

    suspend fun insertSocialLogin(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String,
        main: Boolean = false,
    ): SocialLoginEntity {
        logger.debug(
            "Inserting social login for provider: {}, providerUserId: {}, userId: {}",
            provider,
            providerUserId,
            userId,
        )
        return try {
            authUserRepository.findById(userId) ?: throw NotFoundException("User $userId not found")

            val socialLoginEntity =
                SocialLoginEntity(
                    userId = userId,
                    provider = provider,
                    providerUserId = providerUserId,
                    refreshToken = refreshToken,
                    refreshTokenExpiresAt = refreshTokenExpiresAt,
                    main = main,
                )

            val savedEntity = socialLoginRepository.save(socialLoginEntity)
            logger.debug("Successfully inserted social login with ID: {} for userId: {}", savedEntity.id, userId)
            savedEntity
        } catch (e: Exception) {
            logger.error(
                "Failed to insert social login for provider: {}, providerUserId: {}, userId: {}",
                provider,
                providerUserId,
                userId,
                e,
            )
            throw e
        }
    }

    suspend fun deleteSocialLogin(userId: String, socialLoginId: String) = suspendTransaction(database) {
        val entity =
            socialLoginRepository.findByUserIdAndId(userId, socialLoginId)
                ?: throw NotFoundException("Social login not found for user: $userId")

        if (entity.main) {
            throw NotAllowedException("Cannot delete main social login")
        }

        socialLoginRepository.deleteById(socialLoginId)
    }

    suspend fun associateUserWithSocialProvider(
        provider: SocialProvider,
        providerUserId: String,
        refreshToken: String,
        refreshTokenExpiresAt: Instant,
        userId: String? = null,
    ): AuthUserEntity = suspendTransaction(database) {
        logger.debug(
            "Associating user with social provider: {}, providerUserId: {}, userId: {}",
            provider,
            providerUserId,
            userId,
        )
        try {
            val socialLoginEntity = getSocialLogin(providerUserId, provider)

            if (socialLoginEntity != null) {
                logger.debug("Case 1: Social login exists for providerUserId: {}", providerUserId)
                updateSocialLogin(
                    provider = provider,
                    providerUserId = providerUserId,
                    refreshToken = refreshToken,
                    refreshTokenExpiresAt = refreshTokenExpiresAt,
                )

                val user =
                    authUserRepository.findById(socialLoginEntity.userId)
                        ?: throw NotFoundException(
                            "Associated user not found for social login with ID: ${socialLoginEntity.id}",
                        )
                logger.debug("Successfully associated existing user: {} with social provider", user.id)
                user
            } else {
                if (userId != null) {
                    logger.debug("Case 2a: Creating social login for existing userId: {}", userId)
                    val user =
                        authUserRepository.findById(userId) ?: throw NotFoundException("User $userId not found")

                    insertSocialLogin(
                        provider = provider,
                        providerUserId = providerUserId,
                        refreshToken = refreshToken,
                        refreshTokenExpiresAt = refreshTokenExpiresAt,
                        userId = user.id,
                    )
                    logger.debug("Successfully associated userId: {} with new social login", user.id)
                    user
                } else {
                    logger.debug("Case 2b: Creating new user and social login")
                    val newUser = addUser()
                    logger.debug("Created new user with ID: {}, now creating social login", newUser.id)
                    insertSocialLogin(
                        provider = provider,
                        providerUserId = providerUserId,
                        refreshToken = refreshToken,
                        refreshTokenExpiresAt = refreshTokenExpiresAt,
                        userId = newUser.id,
                        main = true,
                    )
                    logger.debug(
                        "Successfully created new user: {} and associated with social provider",
                        newUser.id,
                    )
                    newUser
                }
            }
        } catch (e: Exception) {
            logger.error(
                "Failed to associate user with social provider: {}, providerUserId: {}, userId: {}",
                provider,
                providerUserId,
                userId,
                e,
            )
            throw e
        }
    }
}
