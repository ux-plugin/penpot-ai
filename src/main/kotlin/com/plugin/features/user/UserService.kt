package com.plugin.features.user

import io.quarkus.security.Authenticated
import io.quarkus.security.identity.SecurityIdentity
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response

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
}

@Path("/user")
@Produces(MediaType.APPLICATION_JSON)
@ApplicationScoped
class UserResource @Inject constructor(
    private val userService: IUserService,
    private val securityIdentity: SecurityIdentity
) {

    @GET
    @Path("/{userId}")
    @Authenticated
    suspend fun getUser(
        @PathParam("userId") userId: String
    ): Response {
        if (securityIdentity.principal.name != userId) {
            return Response.status(Response.Status.FORBIDDEN).build()
        }
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
    @Path("/{userId}/update")
    @Authenticated
    suspend fun updateUser(
        @PathParam("userId") userId: String,
        userUpdate: UpdateUserRequest
    ): Response {
        if (securityIdentity.principal.name != userId) {
            return Response.status(Response.Status.FORBIDDEN).build()
        }
        return try {
            userService.updateUser(userId, userUpdate)
            Response.ok().build()
        } catch (e: NotFoundException) {
            Response.status(Response.Status.NOT_FOUND).build()
        }
    }
}