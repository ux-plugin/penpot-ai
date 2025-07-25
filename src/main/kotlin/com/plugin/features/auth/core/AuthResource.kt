package com.plugin.features.auth.core

import io.quarkus.logging.Log
import io.quarkus.security.Authenticated
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.Cookie
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.NewCookie
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.jwt.JsonWebToken
import org.eclipse.microprofile.openapi.annotations.Operation
import org.eclipse.microprofile.openapi.annotations.media.Content
import org.eclipse.microprofile.openapi.annotations.media.Schema
import org.eclipse.microprofile.openapi.annotations.responses.APIResponse
import org.eclipse.microprofile.openapi.annotations.responses.APIResponses

@Path("/auth")
@Produces(MediaType.APPLICATION_JSON)
@ApplicationScoped
class AuthResource @Inject constructor(
    private val authService: IAuthService,
    private val jsonWebToken: JsonWebToken
) {
    /**
     * Refresh an access token
     */
    @POST
    @Path("/access-token/refresh")
    @Operation(
        summary = "Refresh access token",
        description = "Generates a new access token using a refresh token"
    )
    @APIResponses(
        value = [
            APIResponse(
                responseCode = "200",
                description = "Token refresh successful",
                content = [Content(schema = Schema(implementation = RefreshTokenResponse::class))]
            ),
            APIResponse(responseCode = "401", description = "Invalid refresh token")
        ]
    )
    suspend fun refreshToken(
        @CookieParam("refresh_token") refreshTokenCookie: Cookie?,
        @QueryParam("userId") userId: String,
    ): Response {
        // Check if a refresh token cookie exists
        if (refreshTokenCookie == null || refreshTokenCookie.value.isNullOrEmpty()) {
            return Response.status(Response.Status.UNAUTHORIZED)
                .entity(AuthErrorResponse("Missing refresh token"))
                .build()
        }

        val refreshTokenRequest = RefreshTokenRequest(refreshTokenCookie.value, userId)

        return try {
            val accessToken = authService.refreshToken(refreshTokenRequest)
            Response.ok()
                .entity(RefreshTokenResponse(accessToken))
                .build()
        } catch (e: Exception) {
            when (e) {
                is SecurityException -> {
                    Log.debug(e)
                    Response.status(Response.Status.UNAUTHORIZED)
                        .entity(AuthErrorResponse())
                        .build()
                }

                else -> {
                    Log.error("Token refresh error", e)
                    Response.status(Response.Status.INTERNAL_SERVER_ERROR)
                        .entity(AuthErrorResponse())
                        .build()
                }
            }
        }
    }

    @GET
    @Path("/refresh-token")
    @Authenticated
    open suspend fun refreshToken(): Response {
        val userId: String = jsonWebToken.subject
        return try {
            val refreshToken = authService.getRefreshToken(userId)

            val refreshTokenCookie = NewCookie.Builder("refresh_token")
                .value(refreshToken)
                .path("/")
                .maxAge(30 * 24 * 60 * 60) // 30 days in seconds
                .httpOnly(true)
                .secure(true) // Requires HTTPS
                .build()

            Response.ok()
                .cookie(refreshTokenCookie)
                .build()
        } catch (e: Exception) {
            when (e) {
                is NotFoundException, is SecurityException -> Response.status(Response.Status.UNAUTHORIZED).build()
                else -> {
                    Log.error("Failed to get refresh token", e)
                    Response.status(Response.Status.INTERNAL_SERVER_ERROR).build()
                }
            }
        }

    }
}