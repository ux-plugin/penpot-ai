package com.plugin.features.apps

import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.Consumes
import jakarta.ws.rs.GET
import jakarta.ws.rs.POST
import jakarta.ws.rs.Path
import jakarta.ws.rs.Produces
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import org.eclipse.microprofile.jwt.JsonWebToken

data class AppState(val port: Int?, val publicKey: String?)
data class PluginState(val publicKey: String)

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
    suspend fun getAppConfig(): Flow<AppState> {
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
    suspend fun updateAppConfig(newConfig: AppState) : Response {
        val userId = jsonWebToken.subject
        return try {
            configSyncService.updateAppConfig(userId, newConfig)
            Response.ok().build()
        } catch (e: Exception) {
            Log.error("Failed to update app config", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }

    @Path("/plugin-config/updates")
    @GET
    @Produces(MediaType.SERVER_SENT_EVENTS)
    suspend fun getPluginState() : Flow<PluginState>{
        val userId = jsonWebToken.subject
        return flow {
            while(true) {
                val pluginState = configSyncService.listenToPluginConfigUpdate(userId)
                emit(pluginState)
            }
        }
    }

    @Path("/plugin-config/update")
    @POST
    suspend fun updatePluginConfig(newConfig: PluginState): Response {
        val userId = jsonWebToken.subject
        return try {
            configSyncService.updatePluginConfig(userId, newConfig)
            Response.ok().build()
        } catch (e: Exception) {
            Log.error("Failed to update plugin config", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }
}