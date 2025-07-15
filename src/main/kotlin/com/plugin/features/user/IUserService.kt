package com.plugin.features.user

/**
 * Interface for the user service (business logic)
 */
interface IUserService {
    /**
     * Get user configuration by user ID
     * @param userId The ID of the user
     * @return The user configuration
     */
    suspend fun getUser(userId: String): GetUserResponse

    /**
     * Create or update user configuration
     * @param userId The user configuration to create or update
     */
    suspend fun updateUser(userId: String, userUpdate: UpdateUserRequest)

    /**
     * Create user configuration (fails if user exists)
     * @param user The user configuration to create
     * @return The created user configuration
     */
    suspend fun createUser(user: CreateUserRequest): CreateUserResponse
}