package com.plugin.features.auth.github

import com.plugin.features.auth.core.AccessTokenResponse
import com.plugin.features.auth.core.AccountAlreadyLinkedException
import com.plugin.features.auth.core.ConnectResultRequest
import com.plugin.features.auth.core.ConnectSocialProviderResponse
import com.plugin.features.auth.core.ConnectSocialProviderResult
import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.jwt.JsonWebToken

/**
 * REST resource for handling GitHub OAuth authentication.
 */
@Path("/auth/github")
@Produces(MediaType.APPLICATION_JSON)
@Consumes(MediaType.APPLICATION_JSON)
@ApplicationScoped
class GitHubAuthResource @Inject constructor(
    private val githubAuthService: GitHubAuthService,
    private val jsonWebToken: JsonWebToken
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
    suspend fun callback(
        @QueryParam("code") code: String, 
        @QueryParam("state") state: String
    ): Response {
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
        val readToken = jsonWebToken.subject
        val token = githubAuthService.readAccessToken(readToken)
        return if (token == null || token.value == null) {
            Log.error("Produced access token is null")
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        } else {
            Response.ok(AccessTokenResponse(token.value)).build()
        }
    }

    @GET
    @Path("/connect/init")
    @Authenticated
    open suspend fun connectInit(): Response {
        val userId = jsonWebToken.subject
        return try {
            val connectResponse = githubAuthService.connectInitiate(userId)
            Response.ok(connectResponse).build()
        } catch (e: Exception) {
            Log.error("Failed to authenticate", e)
            Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity("Failed to authenticate").build()
        }
    }

    @GET
    @Path("/connect/callback")
    open suspend fun connectCallback(
        @QueryParam("code") code: String,
        @QueryParam("state") state: String
    ): Response {
        return try {
            val connectResponse = githubAuthService.connectSocialProfile(code= code, state = state)
            Response.ok(connectResponse).build()
        } catch (e: Exception) {
            when (e) {
                is AccountAlreadyLinkedException -> Response.status(Response.Status.CONFLICT).entity("Account already linked.").build()
                else -> {
                    Log.error("Failed to link social login", e)
                    Response.status(Response.Status.INTERNAL_SERVER_ERROR).entity("Failed to link account").build()
                }
            }
        }
    }

    @GET
    @Path("/connect/result")
    @Authenticated
    open suspend fun connectResult(): Response {
        val userId = jsonWebToken.subject
        try {
            val result = githubAuthService.getConnectResult(userId)
            if (result == null || result.value != ConnectSocialProviderResult.SUCCESS.value) {
                return Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
            }
            return Response.ok(ConnectSocialProviderResponse(result = ConnectSocialProviderResult.SUCCESS.value)).build()
        } catch (e: Exception) {
            Log.error("Failed to get connect result", e)
            return Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
        }
    }
}