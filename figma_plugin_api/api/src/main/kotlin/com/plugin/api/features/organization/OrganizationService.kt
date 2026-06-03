package com.plugin.api.features.organization

import com.plugin.api.features.auth.core.NotFoundException
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.stereotype.Service
import java.time.Instant
import java.util.UUID

@Service
class OrganizationService(private val repository: OrganizationRepository) {

    suspend fun create(userId: String, req: CreateOrganizationRequest): OrganizationResponse {
        val slug = (req.slug ?: slugify(req.name)).take(64).ifBlank { error("slug cannot be empty") }
        val org = OrganizationEntity(
            id = UUID.randomUUID().toString(),
            slug = slug,
            name = req.name,
            createdAt = Instant.now(),
        )
        try {
            repository.create(org, userId)
        } catch (e: DataIntegrityViolationException) {
            throw OrganizationSlugTakenException(slug, e)
        }
        return OrganizationResponse(org.id, org.slug, org.name, OrgMemberRole.OWNER, org.createdAt)
    }

    suspend fun listForUser(userId: String): ListOrganizationsResponse {
        val rows = repository.listForUser(userId)
        return ListOrganizationsResponse(rows.map { (org, role) ->
            OrganizationResponse(org.id, org.slug, org.name, role, org.createdAt)
        })
    }

    suspend fun get(orgId: String, userId: String): OrganizationResponse {
        val membership = repository.findMembership(orgId, userId)
            ?: throw NotFoundException("Organization $orgId not found")
        val org = repository.findById(orgId) ?: throw NotFoundException("Organization $orgId not found")
        return OrganizationResponse(org.id, org.slug, org.name, membership.role, org.createdAt)
    }

    // Only OWNERs may delete an org. Throws NotFoundException if the caller isn't a member
    // (or the org doesn't exist) — we don't leak existence to non-members. Cascade FKs
    // drop members + api_keys.
    suspend fun delete(orgId: String, userId: String) {
        val membership = repository.findMembership(orgId, userId)
            ?: throw NotFoundException("Organization $orgId not found")
        if (membership.role != OrgMemberRole.OWNER) throw OrganizationForbiddenException(orgId)
        repository.delete(orgId)
    }

    suspend fun roleOf(orgId: String, userId: String): OrgMemberRole? = repository.findMembership(orgId, userId)?.role

    private fun slugify(name: String): String =
        name.trim().lowercase()
            .replace(Regex("[^a-z0-9]+"), "-")
            .trim('-')
            .ifBlank { UUID.randomUUID().toString().take(8) }
}

class OrganizationSlugTakenException(val slug: String, cause: Throwable? = null) :
    RuntimeException("Organization slug '$slug' already taken", cause)

class OrganizationForbiddenException(val orgId: String) :
    RuntimeException("Not authorized to modify org $orgId")
