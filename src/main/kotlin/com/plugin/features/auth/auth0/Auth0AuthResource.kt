package com.plugin.features.auth.auth0

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
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
    suspend fun callback(@RequestParam code: String, @RequestParam state: String): ResponseEntity<*> = try {
        auth0AuthService.authenticateUser(state, code)
        ResponseEntity.ok().build<Unit>()
    } catch (e: Exception) {
        ResponseEntity.status(HttpStatus.BAD_REQUEST).body("Failed to authenticate")
    }

    @GetMapping("/access-token")
    suspend fun getTokens(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val readToken = jwt.subject
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
