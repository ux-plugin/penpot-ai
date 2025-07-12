package com.plugin.features.user

import io.smallrye.mutiny.Uni
import jakarta.ws.rs.NotFoundException
import java.time.Instant

/**
 * Interface for the user repository (database access)
 */
interface IUserRepository {
    /**
     * Get user configuration by user ID
     * @param userId The ID of the user
     * @return The user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    fun getUser(userId: String): Uni<GetUserResponse>

    /**
     * Update user configuration
     *
     * @param userId The ID of the user whose configuration to update
     * @param userUpdate The new configuration to update the user with
     *
     * @return The updated user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    fun updateUser(userId: String, userUpdate: UpdateUserRequest): Uni<Unit>

    /**
     * Create user configuration (fails if user exists)
     * @param user The user configuration to create
     * @return The created user configuration
     */
    fun createUser(user: CreateUserRequest): Uni<CreateUserResponse>

    /**
     * Create user verification code and increment the number of codes created.
     * @param userId the user id
     * @return the code created
     */
    fun saveNewEmailVerificationCode(userId: String, verificationCode: String, expiredAt: Instant): Uni<Unit>

    /**
     * check if verification code is right or not, if not increment the failed attempts
     * @param userId the user id
     * @param code the code supplied by the user
     * @return true or false.
     */
    fun isVerificationCodeValid(userId: String, code: String): Uni<Boolean>
}
