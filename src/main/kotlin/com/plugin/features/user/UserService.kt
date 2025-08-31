package com.plugin.features.user

import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.jwt.JsonWebToken

/**
 * Service for managing user configurations
 */
@ApplicationScoped
class UserService @Inject constructor(
    private val userRepository: IUserRepository
) : IUserService {
    /**
     * Get user by ID
     * @param userId The ID of the user
     * @return The user configuration
     */
    override suspend fun getUser(userId: String): GetUserResponse {
        return userRepository.getUser(userId).awaitSuspending()
    }

    /**
     * Create or update user configuration
     * @param userId The user configuration to create or update
     */
    override suspend fun updateUser(userId: String, userUpdate: UpdateUserRequest) {
        userRepository.updateUser(userId, userUpdate).awaitSuspending()
    }

    override suspend fun deleteUser(userId: String) {
        userRepository.deleteUser(userId).awaitSuspending()
    }

    override suspend fun getSocialProfiles(userId: String): GetSocialLoginsResponse {
        return userRepository.getSocialLogins(userId).awaitSuspending()
    }
}

@Path("/user")
@Produces(MediaType.APPLICATION_JSON)
@ApplicationScoped
@Authenticated
class UserResource @Inject constructor(
    private val userService: IUserService,
    private val jsonWebToken: JsonWebToken
) {

    @GET
    @Path("/info")
    suspend fun getUser(): Response {
        val userId = jsonWebToken.subject

        return try {
            val user = userService.getUser(userId)
            Response.ok(user).build()
        } catch (e: NotFoundException) {
            Response.status(Response.Status.NOT_FOUND).build()
        }
    }

    /**
     * Update user configuration
     */
    @POST
    @Path("/update")
    suspend fun updateUser(
        userUpdate: UpdateUserRequest
    ): Response {
        val userId = jsonWebToken.subject

        return try {
            userService.updateUser(userId, userUpdate)
            Response.ok().build()
        } catch (e: NotFoundException) {
            Response.status(Response.Status.NOT_FOUND).build()
        }
    }

    @DELETE
    @Path("/delete")
    suspend fun deleteUser(
    ): Response {
        val userId = jsonWebToken.subject

        return try {
            userService.deleteUser(userId)
            Response.ok().build()
        } catch (e: NotFoundException) {
            Response.status(Response.Status.NOT_FOUND).build()
        } catch (e: SecurityException) {
            Response.status(Response.Status.UNAUTHORIZED).build()
        } catch (e: Exception) {
            Log.error("Failed to delete user", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }

    @GET
    @Path("/socials")
    suspend fun getSocialUser(): Response {
        val userId = jsonWebToken.subject

        return try {
            val profiles = userService.getSocialProfiles(userId)
            Response.ok(profiles).build()
        } catch (e: Exception) {
            Log.error("Failed to get social profiles", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }


}