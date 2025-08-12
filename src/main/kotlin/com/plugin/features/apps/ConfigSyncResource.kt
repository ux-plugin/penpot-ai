package com.plugin.features.apps

import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.Consumes
import jakarta.ws.rs.GET
import jakarta.ws.rs.NotFoundException
import jakarta.ws.rs.POST
import jakarta.ws.rs.Path
import jakarta.ws.rs.Produces
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import org.eclipse.microprofile.jwt.JsonWebToken

data class AppState(val port: Int?)
data class GenerateKeyResponse(val key: String)
data class GetKeyResponse(val key: String?)

@Path("/sync")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
@ApplicationScoped
@Authenticated
class ConfigSyncResource @Inject constructor(
    private val configSyncService: ConfigSyncService,
    private val jsonWebToken: JsonWebToken
) {
    @Path("/app/updates")
    @GET
    @Produces(MediaType.SERVER_SENT_EVENTS)
    open suspend fun listenToAppConfigUpdates(): Flow<AppState> {
        val userId = jsonWebToken.subject
        return flow {
            while(true) {
                val newConfig = configSyncService.listenToAppConfigUpdate(userId)
                emit(newConfig)
            }
        }
    }

    @Path("/app/update")
    @POST
    open suspend fun updateAppConfig(newConfig: AppState) : Response {
        val userId = jsonWebToken.subject
        return try {
            configSyncService.updateAppConfig(userId, newConfig)
            Response.ok().build()
        } catch (e: Exception) {
            Log.error("Failed to update app config", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }

    @Path("/key/generate")
    @POST
    @Consumes(MediaType.WILDCARD)
    open suspend fun generateKey(): Response {
        val userId = jsonWebToken.subject
        return try {
            val key = configSyncService.createEncryptionKey(userId)
            Response.ok(GenerateKeyResponse(key)).build()
        } catch (t: Throwable) {
            if (t is NotFoundException) {
                Response.status(Response.Status.NOT_FOUND).entity("User not found").build()
            } else {
                Log.error("Error generating encryption key", t)
                Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity("Internal server error").build()
            }
        }
    }

    @Path("/key/get")
    @GET
    @Consumes(MediaType.WILDCARD)
    open suspend fun getKey(): Response {
        val userId = jsonWebToken.subject
        return try {
            val key = configSyncService.getEncryptionKey(userId)
            Response.ok(GetKeyResponse(key)).build()
        } catch (t: Throwable) {
            Log.error("error getting encryption key", t)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity("Internal server error").build()
        }
    }
}