package com.plugin.dev

import com.plugin.features.user.UserRole
import io.quarkus.arc.profile.IfBuildProfile
import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.smallrye.jwt.build.Jwt
import io.smallrye.mutiny.Uni
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.persistence.*
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import java.time.Instant

data class AddUserRequest(
    val id: String,
    val username: String,
    val name: String,
    val role: UserRole,
    val refreshToken: String,
    val refreshTokenExpiresAt: Instant,
)

data class AddUserResponse(val accessToken: String)

data class GetJwtResponse(val accessToken: String)

@Entity
@Table(name = "Users")
@IfBuildProfile("dev")
class DevUserEntity : PanacheEntityBase {
    @Id lateinit var id: String
    var username: String? = null
    lateinit var name: String
    lateinit var refreshToken: String
    lateinit var refreshTokenExpiresAt: Instant
    @Enumerated(EnumType.STRING) lateinit var role: UserRole

    companion object : PanacheCompanion<DevUserEntity> {}
}

@IfBuildProfile("dev")
@ApplicationScoped
class UserManagementRepository : PanacheRepository<DevUserEntity> {
    @WithSession
    fun addUser(addUserRequest: AddUserRequest): Uni<AddUserResponse> {
        return withTransaction {
            val newUser =
                DevUserEntity().apply {
                    this.id = addUserRequest.id
                    this.username = addUserRequest.username
                    this.name = addUserRequest.name
                    this.role = addUserRequest.role
                    this.refreshToken = addUserRequest.refreshToken
                    this.refreshTokenExpiresAt = addUserRequest.refreshTokenExpiresAt
                }
            persistAndFlush(newUser).map { _ ->
                val token = getJWT(addUserRequest.id)
                AddUserResponse(token)
            }
        }
    }

    fun getJWT(userId: String): String {
        val token = Jwt.claims().subject(userId).issuer("ux-plugin").issuedAt(Instant.now()).sign()
        return token
    }
}

/** Resource for user registration & JWT issuance. */
@Path("/dev/user")
@Consumes(MediaType.APPLICATION_JSON)
@Produces(MediaType.APPLICATION_JSON)
@IfBuildProfile("dev")
@ApplicationScoped
class AuthResource @Inject constructor(private val userManagementRepository: UserManagementRepository) {

    @POST
    @Path("/add")
    suspend fun addUser(request: AddUserRequest): AddUserResponse {
        return userManagementRepository.addUser(request).awaitSuspending()
    }

    @GET
    @Path("/jwt")
    suspend fun getJWT(@QueryParam("userId") userId: String): GetJwtResponse {
        val token = userManagementRepository.getJWT(userId)
        return GetJwtResponse(token)
    }
}
