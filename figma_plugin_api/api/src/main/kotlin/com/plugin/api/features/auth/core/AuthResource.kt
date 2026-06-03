package com.plugin.api.features.auth.core

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/auth")
class AuthResource(private val authService: AuthService) {
    @DeleteMapping("/socials/{id}/delete")
    suspend fun deleteSocialLogin(@AuthenticationPrincipal jwt: Jwt, @RequestParam id: String): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            authService.deleteSocialLogin(userId, id)
            ResponseEntity.ok().build<Unit>()
        } catch (e: NotAllowedException) {
            ResponseEntity.status(HttpStatus.FORBIDDEN).body(AuthErrorResponse("Operation not allowed"))
        } catch (e: NotFoundException) {
            ResponseEntity.status(HttpStatus.NOT_FOUND).body(AuthErrorResponse("Could not find socialLogin"))
        } catch (e: Exception) {
            ResponseEntity
                .status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(AuthErrorResponse("Could not delete socialLogin"))
        }
    }
}
