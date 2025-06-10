package com.plugin.features.user

import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.openapi.annotations.Operation
import org.eclipse.microprofile.openapi.annotations.media.Content
import org.eclipse.microprofile.openapi.annotations.media.Schema
import org.eclipse.microprofile.openapi.annotations.parameters.Parameter
import org.eclipse.microprofile.openapi.annotations.parameters.RequestBody
import org.eclipse.microprofile.openapi.annotations.responses.APIResponse
import org.eclipse.microprofile.openapi.annotations.responses.APIResponses

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
    override fun getUser(userId: String): Uni<User> {
        return userRepository.getUser(userId)
    }

    /**
     * Create or update user configuration
     * @param user The user configuration to create or update
     * @return The updated user configuration
     */
    override fun updateUser(user: User): Uni<User> {
        return userRepository.updateUser(user)
    }

    /**
     * Create user configuration (fails if user exists)
     * @param user The user configuration to create
     * @return The created user configuration
     */
    override fun createUser(user: User): Uni<User> {
        return userRepository.createUser(user)
    }
}

/**
 * REST resource for user configuration endpoints.
 * Uses CDI for dependency injection of services.
 */
@Path("/user")
@Produces(MediaType.APPLICATION_JSON)
@ApplicationScoped
class ConfigResource @Inject constructor(
    private val userService: IUserService
) {
    /**
     * Get user configuration
     */
    @GET
    @Path("/{userId}")
    @Operation(
        summary = "Get user configuration",
        description = "Returns the configuration for the specified user"
    )
    @APIResponses(
        value = [
            APIResponse(
                responseCode = "200",
                description = "User configuration",
                content = [Content(schema = Schema(implementation = User::class))]
            ),
            APIResponse(responseCode = "404", description = "User configuration not found"),
            APIResponse(responseCode = "500", description = "Internal server error")
        ]
    )
    fun getUser(
        @Parameter(
            description = "The ID of the user",
            required = true
        )
        @PathParam("userId")
        userId: String
    ): Uni<Response> {
        return userService.getUser(userId)
            .map { user -> Response.ok(user).build() }
            .onFailure().recoverWithItem { e ->
                Response.status(Response.Status.NOT_FOUND)
                    .entity("User configuration not found for user: $userId")
                    .build()
            }
    }

    /**
     * Create user configuration
     */
    @POST
    @Path("/create")
    @Operation(
        summary = "Create user configuration",
        description = "Creates a new user configuration; fails if user already exists"
    )
    @APIResponses(
        value = [
            APIResponse(
                responseCode = "201",
                description = "User created",
                content = [Content(schema = Schema(implementation = User::class))]
            ),
            APIResponse(responseCode = "409", description = "User already exists"),
            APIResponse(responseCode = "500", description = "Internal server error")
        ]
    )
    fun createUser(
        @RequestBody(
            required = true,
            content = [Content(schema = Schema(implementation = User::class))]
        )
        user: User
    ): Uni<Response> {
        return userService.createUser(user)
            .map { created -> Response.status(Response.Status.CREATED).entity(created).build() }
    }

    /**
     * Update user configuration
     */
    @POST
    @Path("/update")
    @Operation(
        summary = "Update user configuration",
        description = "Creates or updates a user configuration"
    )
    @APIResponses(
        value = [
            APIResponse(
                responseCode = "200",
                description = "Updated user configuration",
                content = [Content(schema = Schema(implementation = User::class))]
            ),
            APIResponse(responseCode = "400", description = "Bad request"),
            APIResponse(responseCode = "500", description = "Internal server error")
        ]
    )
    @Consumes(MediaType.APPLICATION_JSON)
    fun updateUser(
        @RequestBody(
            required = true,
            content = [Content(schema = Schema(implementation = User::class))]
        )
        user: User
    ): Uni<Response> {
        return userService.updateUser(user)
            .map { updatedConfig -> Response.ok(updatedConfig).build() }
    }
}
