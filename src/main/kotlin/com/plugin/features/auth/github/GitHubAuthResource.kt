package com.plugin.features.auth.github

import com.plugin.features.auth.core.ReadTokenResponse
import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import io.quarkus.security.identity.SecurityIdentity
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response

/**
 * REST resource for handling GitHub OAuth authentication.
 */
@Path("/auth/github")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
class GitHubAuthResource @Inject constructor(
    private val githubAuthService: GitHubAuthService,
    private val securityIdentity: SecurityIdentity,
) {

    @GET
    @Path("/login")
    suspend fun login(): Response {
        return try {
            val response = githubAuthService.login()
            Response.ok(response).build()
        } catch (e: Exception) {
            Log.error("Failed to login", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity("Failed to login").build()
        }
    }

    @GET
    @Path("/callback")
    suspend fun callback(@QueryParam("code") code: String, @QueryParam("state") state: String): Response {
        return try {
            githubAuthService.authenticateUser(state, code)
            Response.ok().build()
        } catch (e: Exception) {
            Log.error("Failed to authenticate", e)
            Response.status(Response.Status.BAD_REQUEST).entity("Failed to authenticate").build()
        }
    }

    @GET
    @Path("/access-token")
    @Authenticated
    open suspend fun getAppAccessToken(): Response {
        val readToken = securityIdentity.principal.name
        val token = githubAuthService.readAccessToken(readToken)
        return if (token == null || token.value == null) {
            Log.error("Produced access token is null")
            Response.status(Response.Status.REQUEST_TIMEOUT).build()
        } else {
            Response.ok(ReadTokenResponse(token.value)).build()
        }
    }
}