package com.plugin.features.user

import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.quarkus.logging.Log
import io.smallrye.mutiny.Uni
import io.smallrye.mutiny.replaceWithUnit
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException
import org.eclipse.microprofile.config.inject.ConfigProperty
import java.time.Instant

/**
 * Repository implementation for user configurations using Panache
 */
@ApplicationScoped
class UserRepository(
    @ConfigProperty(name = "user.email-verification.code.max-generation-attempts", defaultValue = "5")
    private val maxEmailVerificationCodeGenerationAttempts: Int,
) : PanacheRepository<UserEntity>, IUserRepository {
    /**
     * Get user configuration by user ID
     * @param userId The ID of the user
     * @return The user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    override fun getUser(userId: String): Uni<GetUserResponse> {
        return UserEntity.find("id", userId)
            .project(GetUserResponse::class.java)
            .firstResult()
            .onItem().ifNull().failWith(NotFoundException("User $userId not found"))
            .map { it }
    }

    /**
     * Update user configuration
     * @param userId The id of the user
     * @param userUpdate The user configuration to update
     * @return The updated user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    override fun updateUser(userId: String, userUpdate: UpdateUserRequest): Uni<Unit> {
        return withTransaction {
            find("id", userId)
                .firstResult()
                .onItem().ifNull().failWith(NotFoundException("User $userId not found"))
                .chain { existingUser ->
                    val newUserEntity = existingUser as UserEntity

                    userUpdate.username?.let { newUserEntity.username = it }
                    userUpdate.name?.let { newUserEntity.name = it }
                    userUpdate.password?.let { newUserEntity.password = it }
                    userUpdate.companionAppConnected?.let { newUserEntity.companionAppConnected = it }
                    userUpdate.companionAppPort?.let { newUserEntity.companionAppPort = it }
                    userUpdate.allowSavingCompletions?.let { newUserEntity.allowSavingCompletions = it }

                    persistAndFlush(newUserEntity)
                }
                .map { it }.replaceWith(Unit)

        }
    }

    /**
     * Create user configuration (fails if user exists)
     * @param user The user configuration to create
     * @return The created user configuration
     */
    override fun createUser(user: CreateUserRequest): Uni<CreateUserResponse> {
        return withTransaction {
            find("username", user.username)
                .firstResult()
                .flatMap { existingUser ->
                    if (existingUser != null) {
                        Uni.createFrom().failure(IllegalArgumentException("User already exists"))
                    } else {
                        persistAndFlush(UserEntity().apply {
                            this.username = user.username
                            this.name = user.name
                            this.password = user.password
                            this.role = UserRoles.USER
                        }).map { it -> CreateUserResponse(it.id) }
                    }
                }
        }
    }

    override fun saveNewEmailVerificationCode(userId: String, verificationCode: String, expiredAt: Instant): Uni<Unit> {
        return withTransaction {
            find("id", userId).firstResult()
                .map { existingUser ->
                    if (existingUser == null) {
                        Log.warn("User $userId not found while saving email verification code.")
                        Uni.createFrom().failure(
                            NotFoundException(
                                "Maximum number of email verification code generation attempts reached"
                            )
                        )
                    } else {
                        if (existingUser.numberOfEmailVerificationCodeGenerated > maxEmailVerificationCodeGenerationAttempts) {
                            Log.warn("Maximum number of email verification code generation attempts reached for user $userId.")
                            Uni.createFrom().failure(
                                IllegalStateException(
                                    "Maximum number of email verification code generation attempts reached"
                                )
                            )
                        } else {
                            existingUser.numberOfEmailVerificationCodeGenerated++
                            existingUser.emailVerificationCode = verificationCode
                            existingUser.emailVerificationCodeExpiresAt = expiredAt
                            existingUser.emailVerificationFailedAttempts = 0
                            persist(existingUser)
                        }
                    }
                }.replaceWithUnit()
        }
    }

    override fun isVerificationCodeValid(userId: String, code: String): Uni<Boolean> {
        return withTransaction {
            find("id", userId).firstResult()
                .onItem().transformToUni { existingUser ->
                    if (existingUser == null) {
                        Uni.createFrom().failure(
                            NotFoundException("User not found")
                        )
                    } else if (existingUser.emailVerificationCode != code) {
                        Log.info("User $userId submitted $code while it should be ${existingUser.emailVerificationCode}.")
                        existingUser.emailVerificationFailedAttempts++
                        persist(existingUser).replaceWith(false)
                    } else {
                        Uni.createFrom().item(true)
                    }
                }
        }
    }
}
