package com.plugin.api.features.organization

import com.plugin.api.features.auth.core.NotFoundException
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
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/orgs")
class OrganizationController(private val service: OrganizationService) {

    @PostMapping
    suspend fun create(
        @AuthenticationPrincipal jwt: Jwt,
        @RequestBody req: CreateOrganizationRequest,
    ): ResponseEntity<*> = try {
        ResponseEntity.status(HttpStatus.CREATED).body(service.create(jwt.subject, req))
    } catch (e: OrganizationSlugTakenException) {
        ResponseEntity.status(HttpStatus.CONFLICT).body(mapOf("error" to "slug_taken", "slug" to e.slug))
    }

    @GetMapping
    suspend fun list(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<ListOrganizationsResponse> =
        ResponseEntity.ok(service.listForUser(jwt.subject))

    @GetMapping("/{orgId}")
    suspend fun get(
        @AuthenticationPrincipal jwt: Jwt,
        @PathVariable orgId: String,
    ): ResponseEntity<*> = try {
        ResponseEntity.ok(service.get(orgId, jwt.subject))
    } catch (_: NotFoundException) {
        ResponseEntity.status(HttpStatus.NOT_FOUND).build<Unit>()
    }

    @DeleteMapping("/{orgId}")
    suspend fun delete(
        @AuthenticationPrincipal jwt: Jwt,
        @PathVariable orgId: String,
    ): ResponseEntity<Unit> = try {
        service.delete(orgId, jwt.subject)
        ResponseEntity.noContent().build()
    } catch (_: NotFoundException) {
        ResponseEntity.status(HttpStatus.NOT_FOUND).build()
    } catch (_: OrganizationForbiddenException) {
        ResponseEntity.status(HttpStatus.FORBIDDEN).build()
    }
}
