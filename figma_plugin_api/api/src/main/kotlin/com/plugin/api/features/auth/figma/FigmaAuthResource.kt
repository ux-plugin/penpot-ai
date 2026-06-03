package com.plugin.api.features.auth.figma

import com.plugin.api.features.auth.core.AccountAlreadyLinkedException
import com.plugin.api.features.auth.core.ConnectSocialProviderResponse
import com.plugin.api.features.auth.core.ConnectSocialProviderResult
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/auth/figma")
class FigmaAuthResource(private val figmaAuthService: FigmaAuthService) {
    @GetMapping("/connect/init")
    suspend fun connectInit(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val connectResponse = figmaAuthService.connectInitiate(userId)
            ResponseEntity.ok(connectResponse)
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Failed to authenticate")
        }
    }

    @GetMapping("/connect/callback")
    suspend fun connectCallback(@RequestParam code: String, @RequestParam state: String): ResponseEntity<*> = try {
        figmaAuthService.connectSocialProfile(code = code, state = state)
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
            val result = figmaAuthService.getConnectResult(userId)
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
