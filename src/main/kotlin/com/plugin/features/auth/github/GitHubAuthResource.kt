package com.plugin.features.auth.github

import com.plugin.features.auth.core.AccessTokenResponse
import com.plugin.features.auth.core.AccountAlreadyLinkedException
import com.plugin.features.auth.core.ConnectSocialProviderResponse
import com.plugin.features.auth.core.ConnectSocialProviderResult
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/auth/github")
class GitHubAuthResource(private val githubAuthService: GitHubAuthService) {
    @GetMapping("/login")
    suspend fun login(): ResponseEntity<*> = try {
        val response = githubAuthService.login()
        ResponseEntity.ok(response)
    } catch (e: Exception) {
        ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Failed to login")
    }

    @GetMapping("/callback")
    suspend fun callback(@RequestParam code: String, @RequestParam state: String): ResponseEntity<*> = try {
        githubAuthService.authenticateUser(state, code)
        ResponseEntity.ok().build<Unit>()
    } catch (e: Exception) {
        ResponseEntity.status(HttpStatus.BAD_REQUEST).body("Failed to authenticate")
    }

    @GetMapping("/access-token")
    suspend fun getAppAccessToken(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val readToken = jwt.subject
        val token = githubAuthService.readAccessToken(readToken)
        return if (token == null || token.second.isEmpty()) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        } else {
            ResponseEntity.ok(AccessTokenResponse(token.second))
        }
    }

    @GetMapping("/connect/init")
    suspend fun connectInit(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val connectResponse = githubAuthService.connectInitiate(userId)
            ResponseEntity.ok(connectResponse)
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Failed to authenticate")
        }
    }

    @GetMapping("/connect/callback")
    suspend fun connectCallback(@RequestParam code: String, @RequestParam state: String): ResponseEntity<*> = try {
        githubAuthService.connectSocialProfile(code = code, state = state)
        ResponseEntity.ok().build<Unit>()
    } catch (e: AccountAlreadyLinkedException) {
        ResponseEntity.status(HttpStatus.CONFLICT).body("Account already linked.")
    } catch (e: Exception) {
        ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Failed to link account")
    }

    @GetMapping("/connect/result")
    suspend fun connectResult(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val result = githubAuthService.getConnectResult(userId)
            if (result == null || result.second != ConnectSocialProviderResult.SUCCESS.value) {
                ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
            } else {
                ResponseEntity.ok(ConnectSocialProviderResponse(result = ConnectSocialProviderResult.SUCCESS.value))
            }
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        }
    }
}
