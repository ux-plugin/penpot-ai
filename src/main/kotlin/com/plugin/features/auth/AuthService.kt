package com.plugin.features.auth

import io.quarkus.logging.Log
import io.smallrye.mutiny.coroutines.awaitSuspending
import jakarta.enterprise.context.ApplicationScoped
import jakarta.inject.Inject
import jakarta.ws.rs.*
import jakarta.ws.rs.core.Cookie
import jakarta.ws.rs.core.MediaType
import jakarta.ws.rs.core.NewCookie
import jakarta.ws.rs.core.Response
import org.eclipse.microprofile.openapi.annotations.Operation
import org.eclipse.microprofile.openapi.annotations.media.Content
import org.eclipse.microprofile.openapi.annotations.media.Schema
import org.eclipse.microprofile.openapi.annotations.parameters.RequestBody
import org.eclipse.microprofile.openapi.annotations.responses.APIResponse
import org.eclipse.microprofile.openapi.annotations.responses.APIResponses

/**
 * Service for authentication
 */
@ApplicationScoped
class AuthService @Inject constructor(
    private val authRepository: IAuthRepository
) : IAuthService {
    /**
     * Authenticate a user with a username and password
     * @param loginRequest The authentication request containing a username and password
     * @return The authentication response containing access and refresh tokens
     */
    override suspend fun authenticate(loginRequest: LoginRequest): LoginCredentials {
        return authRepository.authenticate(loginRequest.username, loginRequest.password).awaitSuspending()
    }

    /**
     * Refresh an access token using a refresh token
     * @param refreshTokenRequest The request containing the refresh token
     * @return A new access token
     */
    override suspend fun refreshToken(refreshTokenRequest: RefreshTokenRequest): String {
        return authRepository.refreshAccessToken(refreshTokenRequest).awaitSuspending()
    }
}

@Path("/auth")
@Produces(MediaType.APPLICATION_JSON)
@ApplicationScoped
class AuthResource @Inject constructor(
    private val authService: IAuthService
) {
    /**
     * Authenticate a user
     */
    @POST
    @Path("/login")
    @Consumes(MediaType.APPLICATION_JSON)
    @Operation(
        summary = "Authenticate user",
        description = "Authenticates a user with username and password"
    )
    @APIResponses(
        value = [
            APIResponse(
                responseCode = "200",
                description = "Authentication successful",
                content = [Content(schema = Schema(implementation = LoginResponse::class))]
            ),
            APIResponse(responseCode = "401", description = "Authentication failed")
        ]
    )
    suspend fun login(
        @RequestBody(
            required = true,
            content = [Content(schema = Schema(implementation = LoginRequest::class))]
        )
        loginRequest: LoginRequest
    ): Response {
        return try {
            val authResponse = authService.authenticate(loginRequest)

            // Create an HTTP-only cookie for refresh token
            val refreshTokenCookie = NewCookie.Builder("refresh_token")
                .value(authResponse.refreshToken)
                .path("/")
                .maxAge(30 * 24 * 60 * 60) // 30 days in seconds
                .httpOnly(true)
                .secure(true) // Requires HTTPS
                .build()

            // Return only the access token in the response body
            Response.ok()
                .entity(LoginResponse(authResponse.accessToken))
                .cookie(refreshTokenCookie)
                .build()
        } catch (e: Exception) {
            when (e) {
                is NotFoundException, is SecurityException -> {
                    Response.status(Response.Status.UNAUTHORIZED)
                        .entity(AuthErrorResponse())
                        .build()
                }

                else -> {
                    Log.error("Authentication error", e)
                    Response.status(Response.Status.UNAUTHORIZED)
                        .entity(AuthErrorResponse())
                        .build()
                }
            }
        }
    }

    /**
     * Refresh an access token
     */
    @POST
    @Path("/refresh-token")
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
                    Response.status(Response.Status.UNAUTHORIZED)
                        .entity(AuthErrorResponse())
                        .build()
                }
            }
        }
    }
}
