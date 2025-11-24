package com.plugin.features.auth.core

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseCookie
import org.springframework.http.ResponseEntity
import org.springframework.http.server.reactive.ServerHttpResponse
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.*
import java.time.Duration

@RestController
@RequestMapping("/auth")
class AuthResource(
    private val authService: AuthService
) {
    
    @PostMapping("/access-token/refresh")
    suspend fun refreshAccessToken(
        @CookieValue(name = "refresh_token", required = false) refreshTokenCookie: String?,
        @RequestParam userId: String
    ): ResponseEntity<*> {
        if (refreshTokenCookie.isNullOrEmpty()) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(AuthErrorResponse("Missing refresh token"))
        }

        val refreshTokenRequest = RefreshTokenRequest(refreshTokenCookie, userId)

        return try {
            val accessToken = authService.refreshToken(refreshTokenRequest)
            ResponseEntity.ok(RefreshAccessTokenResponse(accessToken))
        } catch (e: SecurityException) {
            ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(AuthErrorResponse())
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(AuthErrorResponse())
        }
    }

    @GetMapping("/refresh-token")
    suspend fun getRefreshToken(
        @AuthenticationPrincipal jwt: Jwt,
        response: ServerHttpResponse
    ): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val refreshToken = authService.getRefreshToken(userId)

            val cookie = ResponseCookie.from("refresh_token", refreshToken.refreshToken)
                .path("/")
                .maxAge(Duration.between(java.time.Instant.now(), refreshToken.refreshTokenExpiresAt))
                .httpOnly(true)
                .secure(true)
                .build()
            
            response.addCookie(cookie)
            ResponseEntity.ok().build<Unit>()
        } catch (e: NotFoundException) {
            ResponseEntity.status(HttpStatus.UNAUTHORIZED).build<Unit>()
        } catch (e: SecurityException) {
            ResponseEntity.status(HttpStatus.UNAUTHORIZED).build<Unit>()
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        }
    }

    @GetMapping("/plugin-ui/refresh-token")
    suspend fun getFigmaPluginRefreshToken(
        @AuthenticationPrincipal jwt: Jwt
    ): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val refreshToken = authService.getRefreshToken(userId)
            ResponseEntity.ok(refreshToken)
        } catch (e: NotFoundException) {
            ResponseEntity.status(HttpStatus.UNAUTHORIZED).build<Unit>()
        } catch (e: SecurityException) {
            ResponseEntity.status(HttpStatus.UNAUTHORIZED).build<Unit>()
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        }
    }

    @PostMapping("/plugin-ui/access-token/refresh")
    suspend fun figmaPluginRefreshAccessToken(
        @RequestBody request: FigmaPluginRefreshAccessTokenRequest
    ): ResponseEntity<*> {
        val refreshTokenRequest = RefreshTokenRequest(request.refreshToken, request.userId)

        return try {
            val accessToken = authService.refreshToken(refreshTokenRequest)
            ResponseEntity.ok(RefreshAccessTokenResponse(accessToken))
        } catch (e: SecurityException) {
            ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(AuthErrorResponse())
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(AuthErrorResponse())
        }
    }

    @DeleteMapping("/socials/{id}/delete")
    suspend fun deleteSocialLogin(
        @AuthenticationPrincipal jwt: Jwt,
        @RequestParam id: String
    ): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            authService.deleteSocialLogin(userId, id)
            ResponseEntity.ok().build<Unit>()
        } catch (e: NotAllowedException) {
            ResponseEntity.status(HttpStatus.FORBIDDEN)
                .body(AuthErrorResponse("Operation not allowed"))
        } catch (e: NotFoundException) {
            ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(AuthErrorResponse("Could not find socialLogin"))
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(AuthErrorResponse("Could not delete socialLogin"))
        }
    }
}
