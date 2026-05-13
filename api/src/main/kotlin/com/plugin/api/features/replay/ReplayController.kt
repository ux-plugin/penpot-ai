package com.plugin.api.features.replay

import com.plugin.api.security.AuthorizationService
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

/**
 * Replay read API. Lists sessions and streams anonymized event payloads back to the
 * demo-app player. All endpoints require an [com.plugin.api.security.ApiKeyAuthentication]
 * in the reactive security context — orgId comes from the API key, not from the path.
 */
@RestController
@RequestMapping("/api/replay")
class ReplayController(
    private val service: ReplayService,
    private val authorizationService: AuthorizationService,
) {

    @GetMapping("/sessions")
    suspend fun listSessions(): ResponseEntity<*> {
        val auth = authorizationService.currentApiKeyAuthentication() ?: return unauthorized()
        val sessions = service.list(auth.orgId)
        return ResponseEntity.ok(mapOf("sessions" to sessions))
    }

    @GetMapping("/sessions/{sessionId}")
    suspend fun getSession(@PathVariable sessionId: String): ResponseEntity<*> {
        val auth = authorizationService.currentApiKeyAuthentication() ?: return unauthorized()
        val meta = service.getMetadata(auth.orgId, sessionId)
            ?: return ResponseEntity.status(HttpStatus.NOT_FOUND).body(error("not_found"))
        return ResponseEntity.ok(SessionSummary.from(meta))
    }

    @GetMapping("/sessions/{sessionId}/events")
    suspend fun getReplay(@PathVariable sessionId: String): ResponseEntity<*> {
        val auth = authorizationService.currentApiKeyAuthentication() ?: return unauthorized()
        val payload = service.getReplay(auth.orgId, sessionId)
            ?: return ResponseEntity.status(HttpStatus.NOT_FOUND).body(error("not_found"))
        return ResponseEntity.ok(payload)
    }

    private fun unauthorized(): ResponseEntity<Map<String, Any>> =
        ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(error("api_key_required"))

    private fun error(code: String): Map<String, Any> = mapOf("error" to code)
}
