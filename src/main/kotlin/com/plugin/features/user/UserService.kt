package com.plugin.features.user

import com.fasterxml.jackson.databind.ObjectMapper
import io.quarkus.logging.Log
import io.quarkus.redis.datasource.ReactiveRedisDataSource
import io.quarkus.redis.datasource.pubsub.ReactivePubSubCommands
import io.quarkus.security.Authenticated
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import java.util.*
import javax.crypto.KeyGenerator
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.Channel.Factory.UNLIMITED
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import org.eclipse.microprofile.config.inject.ConfigProperty
import org.eclipse.microprofile.jwt.JsonWebToken

/** Service for managing user configurations */
@ApplicationScoped
class UserService
@Inject
constructor(
    private val userRepository: UserRepository,
    val redis: ReactiveRedisDataSource,
) {

    @ConfigProperty(name = "user.companion-app-key-prefix") lateinit var companionAppKeyPrefix: String

    val portConfigPubSub: ReactivePubSubCommands<PortState> = redis.pubsub(PortState::class.java)

    suspend fun getUser(userId: String): GetUserResponse {
        return userRepository.getUser(userId).awaitSuspending()
    }

    suspend fun updateUser(userId: String, userUpdate: UpdateUserRequest) {
        userRepository.updateUser(userId, userUpdate).awaitSuspending()
    }

    suspend fun deleteUser(userId: String) {
        userRepository.deleteUser(userId).awaitSuspending()
    }

    suspend fun getSocialProfiles(userId: String): GetSocialLoginsResponse {
        return userRepository.getSocialLogins(userId).awaitSuspending()
    }

    suspend fun getCurrentPort(userId: String): PortState? {
        return userRepository.getPort(userId).awaitSuspending()
    }

    suspend fun updatePort(userId: String, portState: PortState) {
        // First, persist to database
        userRepository.savePort(userId, portState).awaitSuspending()

        // Then broadcast to Redis using pub/sub
        portConfigPubSub.publish(companionAppKeyPrefix + userId, portState).awaitSuspending()
    }

    suspend fun getEncryptionKey(userId: String): EncryptionKeyResponse? {
        return userRepository.getEncryptionKey(userId).awaitSuspending()
    }

    suspend fun createEncryptionKey(userId: String): EncryptionKeyResponse {
        val keyGenerator = KeyGenerator.getInstance("AES")
        keyGenerator.init(256)
        val secretKey = keyGenerator.generateKey()

        val encryptionKey = Base64.getEncoder().encodeToString(secretKey.encoded)

        return userRepository.saveEncryptionKey(userId, encryptionKey).awaitSuspending()
    }
}

@Path("/user")
@Produces(MediaType.APPLICATION_JSON)
@ApplicationScoped
@Authenticated
class UserResource
@Inject
constructor(
    private val userService: UserService,
    private val jsonWebToken: JsonWebToken,
    val objectMapper: ObjectMapper
) {

    @GET
    @Path("/info")
    suspend fun getUser(): Response {
        val userId = jsonWebToken.subject

        return try {
            val user = userService.getUser(userId)
            Response.ok(user).build()
        } catch (e: NotFoundException) {
            Log.error("Error $userId not found. $e")
            Response.status(Response.Status.NOT_FOUND).build()
        } catch (e: Exception) {
            Log.error("Failed to get user info.", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }

    /** Update user configuration */
    @POST
    @Path("/update")
    suspend fun updateUser(userUpdate: UpdateUserRequest): Response {
        val userId = jsonWebToken.subject

        return try {
            userService.updateUser(userId, userUpdate)
            Response.ok().build()
        } catch (e: NotFoundException) {
            Response.status(Response.Status.NOT_FOUND).build()
        } catch (e: Exception) {
            Log.error("Failed to update user info.", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }

    @DELETE
    @Path("/delete")
    suspend fun deleteUser(): Response {
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

    @Path("/key")
    @POST
    @Consumes(MediaType.WILDCARD)
    suspend fun generateKey(): Response {
        val userId = jsonWebToken.subject
        return try {
            val key = userService.createEncryptionKey(userId)
            Response.ok(key).build()
        } catch (t: Throwable) {
            if (t is NotFoundException) {
                Response.status(Response.Status.NOT_FOUND).entity("User not found").build()
            } else {
                Log.error("Error generating encryption key", t)
                Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity("Internal server error").build()
            }
        }
    }

    @Path("/key")
    @GET
    @Consumes(MediaType.WILDCARD)
    suspend fun getKey(): Response {
        val userId = jsonWebToken.subject
        return try {
            val key = userService.getEncryptionKey(userId)
            Response.ok(key).build()
        } catch (t: Throwable) {
            Log.error("Error getting encryption key", t)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity("Internal server error").build()
        }
    }

    @Path("/port")
    @POST
    suspend fun updatePort(portState: PortState): Response {
        val userId = jsonWebToken.subject
        return try {
            userService.updatePort(userId, portState)
            Response.ok().build()
        } catch (e: Exception) {
            Log.error("Failed to update port", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }

    @Path("/port/listen")
    @GET
    @Produces(MediaType.SERVER_SENT_EVENTS)
    @Deprecated(
        message = "Use WebSocket at /ws with message type 'user:subscribe_ports' instead",
        replaceWith = ReplaceWith("WebSocket at /ws"),
        level = DeprecationLevel.WARNING
    )
    suspend fun listenToPortUpdates(): Flow<String> {
        val userId = jsonWebToken.subject
        return flow {
            // Emit current port once
            val currentPort = userService.getCurrentPort(userId)
            currentPort?.let { emit(objectMapper.writeValueAsString(it)) }

            // Create a single subscription for updates
            val channel = Channel<PortState>(UNLIMITED)
            val subscriber =
                userService.portConfigPubSub
                    .subscribe(userService.companionAppKeyPrefix + userId) { portState -> channel.trySend(portState) }
                    .awaitSuspending()

            try {
                // Emit all updates from the channel
                for (update in channel) {
                    emit(objectMapper.writeValueAsString(update))
                }
            } finally {
                subscriber.unsubscribe().awaitSuspending()
                channel.close()
            }
        }
    }
}
