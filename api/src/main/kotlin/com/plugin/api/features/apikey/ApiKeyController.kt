package com.plugin.api.features.apikey

import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/api-keys")
class ApiKeyController(private val service: ApiKeyService) {

    @PostMapping
    suspend fun create(
        @AuthenticationPrincipal jwt: Jwt,
        @RequestBody req: CreateApiKeyRequest,
    ): ResponseEntity<*> = try {
        ResponseEntity.status(HttpStatus.CREATED).body(service.create(jwt.subject, req))
    } catch (_: ApiKeyForbiddenException) {
        ResponseEntity.status(HttpStatus.FORBIDDEN).build<Unit>()
    }

    @GetMapping
    suspend fun list(
        @AuthenticationPrincipal jwt: Jwt,
        @RequestParam orgId: String,
    ): ResponseEntity<*> = try {
        ResponseEntity.ok(service.list(jwt.subject, orgId))
    } catch (_: ApiKeyForbiddenException) {
        ResponseEntity.status(HttpStatus.FORBIDDEN).build<Unit>()
    }

    @DeleteMapping("/{id}")
    suspend fun revoke(
        @AuthenticationPrincipal jwt: Jwt,
        @PathVariable id: String,
    ): ResponseEntity<Unit> = try {
        if (service.revoke(jwt.subject, id)) ResponseEntity.noContent().build()
        else ResponseEntity.status(HttpStatus.NOT_MODIFIED).build()
    } catch (_: ApiKeyNotFoundException) {
        ResponseEntity.status(HttpStatus.NOT_FOUND).build()
    } catch (_: ApiKeyForbiddenException) {
        ResponseEntity.status(HttpStatus.FORBIDDEN).build()
    }
}
