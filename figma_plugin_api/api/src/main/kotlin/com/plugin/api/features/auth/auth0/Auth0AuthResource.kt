package com.plugin.api.features.auth.auth0

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/auth/auth0")
@ConditionalOnProperty(prefix = "auth0.oauth", name = ["client-id"])
class Auth0AuthResource(private val auth0AuthService: Auth0AuthService) {
    @GetMapping("/login")
    suspend fun login(): ResponseEntity<*> = try {
        ResponseEntity.ok(auth0AuthService.login())
    } catch (e: Exception) {
        ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Failed to initiate login")
    }

    @GetMapping("/callback")
    suspend fun callback(
        @RequestParam(required = false) code: String?,
        @RequestParam(required = false) state: String?,
        @RequestParam(required = false) error: String?,
        @RequestParam(required = false, name = "error_description") errorDescription: String?,
    ): ResponseEntity<*> {
        if (error != null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body("Auth0 error: $error - $errorDescription")
        }
        if (code == null || state == null) {
            return ResponseEntity.status(HttpStatus.BAD_REQUEST).body("Missing code or state")
        }
        return try {
            auth0AuthService.authenticateUser(state, code)
            ResponseEntity.ok().build<Unit>()
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.BAD_REQUEST).body("Failed to authenticate: ${e.message}")
        }
    }

    @GetMapping("/access-token")
    suspend fun getTokens(@RequestParam readToken: String): ResponseEntity<*> {
        val tokens = auth0AuthService.readTokens(readToken)
        return if (tokens == null) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        } else {
            ResponseEntity.ok(tokens)
        }
    }

    @PostMapping("/refresh")
    suspend fun refresh(@RequestBody request: Auth0RefreshRequest): ResponseEntity<*> = try {
        ResponseEntity.ok(auth0AuthService.refreshTokens(request.refreshToken))
    } catch (e: Exception) {
        ResponseEntity.status(HttpStatus.UNAUTHORIZED).body("Failed to refresh")
    }
}
