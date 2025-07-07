package com.plugin.features.user

import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.security.Authenticated
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.jwt.JsonWebToken
import org.eclipse.microprofile.openapi.annotations.Operation
import org.eclipse.microprofile.openapi.annotations.media.Content
import org.eclipse.microprofile.openapi.annotations.media.Schema
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
    override fun getUser(userId: String): Uni<GetUserResponse> {
        return userRepository.getUser(userId)
    }

    /**
     * Create or update user configuration
     * @param userId The user configuration to create or update
     * @return The updated user configuration
     */
    override fun updateUser(userId: String, userUpdate: UpdateUserRequest): Uni<Unit> {
        return userRepository.updateUser(userId, userUpdate)
    }

    /**
     * Create user configuration (fails if user exists)
     * @param user The user configuration to create
     * @return The created user configuration
     */
    override fun createUser(user: CreateUserRequest): Uni<CreateUserResponse> {
        return userRepository.createUser(user)
    }
}

@Path("/user")
@Produces(MediaType.APPLICATION_JSON)
@ApplicationScoped
class UserResource @Inject constructor(
    private val userService: IUserService,
    private val jwt: JsonWebToken  // Inject the JWT
) {

    @GET
    @Path("/{userId}")
    @Authenticated
    @WithSession
    fun getUser(
        @PathParam("userId") userId: String
    ): Uni<Response> {
        // Enforce user identity by comparing JWT "sub" (subject) to the path param
        if (jwt.subject != userId) {
            return Uni.createFrom().item(Response.status(Response.Status.FORBIDDEN).build())
        }
        return userService.getUser(userId)
            .onItem().transform { user ->
                Response.ok(user).build()
            }
            .onFailure().recoverWithItem { _: Throwable -> Response.status(Response.Status.NOT_FOUND).build() }
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
                content = [Content(schema = Schema(implementation = CreateUserResponse::class))]
            ),
            APIResponse(responseCode = "409", description = "User already exists"),
            APIResponse(responseCode = "500", description = "Internal server error")
        ]
    )
    @WithSession
    fun createUser(
        @RequestBody(
            required = true,
            content = [Content(schema = Schema(implementation = CreateUserRequest::class))]
        )
        user: CreateUserRequest
    ): Uni<Response> {
        return userService.createUser(user)
            .map { created -> Response.status(Response.Status.CREATED).entity(created).build() }
            .onFailure().recoverWithItem { e ->
                Response.status(Response.Status.CONFLICT)
                    .entity("${user.username} already exists")
                    .build()
            }
    }

    /**
     * Update user configuration
     */
    @POST
    @Path("/{userId}/update")
    @Authenticated
    @WithSession
    fun updateUser(
        @PathParam("userId") userId: String,
        userUpdate: UpdateUserRequest
    ): Uni<Response> {
        if (jwt.subject != userId) {
            return Uni.createFrom().item(Response.status(Response.Status.FORBIDDEN).build())
        }
        return userService.updateUser(userId, userUpdate)
            .onItem().transform {
                Response.ok().build()
            }
            .onFailure().recoverWithItem { _: Throwable -> Response.status(Response.Status.NOT_FOUND).build() }
    }
}