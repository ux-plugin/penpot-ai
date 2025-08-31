package com.plugin.features.user

import io.smallrye.mutiny.Uni
import jakarta.ws.rs.NotFoundException

/** Interface for the user repository (database access) */
interface IUserRepository {
    /**
     * Get user configuration by user ID
     *
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
     * @return The updated user configuration
     * @throws NotFoundException if the user configuration is not found
     */
    fun updateUser(userId: String, userUpdate: UpdateUserRequest): Uni<Unit>

    fun deleteUser(userId: String): Uni<Unit>

    fun getSocialLogins(userId: String): Uni<GetSocialLoginsResponse>
}
