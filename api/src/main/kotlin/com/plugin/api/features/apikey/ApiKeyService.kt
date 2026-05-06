package com.plugin.api.features.apikey

import com.plugin.api.features.organization.OrgMemberRole
import com.plugin.api.features.organization.OrganizationService
import org.springframework.stereotype.Service
import java.time.Instant

@Service
class ApiKeyService(
    private val repository: ApiKeyRepository,
    private val generator: ApiKeyGenerator,
    private val organizationService: OrganizationService,
) {

    suspend fun create(userId: String, req: CreateApiKeyRequest): CreateApiKeyResponse {
        requireRole(req.orgId, userId, OrgMemberRole.OWNER, OrgMemberRole.ADMIN)
        val key = generator.generate()
        val entity = ApiKeyEntity(
            orgId = req.orgId,
            createdByUserId = userId,
            name = req.name,
            prefix = key.displayPrefix,
            keyHash = key.hash,
            createdAt = Instant.now(),
        )
        val saved = repository.insert(entity)
        return CreateApiKeyResponse(
            id = saved.id,
            orgId = saved.orgId,
            name = saved.name,
            prefix = saved.prefix,
            plaintext = key.plaintext,
            createdAt = saved.createdAt,
        )
    }

    suspend fun list(userId: String, orgId: String): ListApiKeysResponse {
        requireRole(orgId, userId, OrgMemberRole.OWNER, OrgMemberRole.ADMIN, OrgMemberRole.MEMBER)
        val rows = repository.listByOrg(orgId)
        return ListApiKeysResponse(rows.map { it.toSummary() })
    }

    suspend fun revoke(userId: String, id: String): Boolean {
        val key = repository.findById(id) ?: throw ApiKeyNotFoundException(id)
        requireRole(key.orgId, userId, OrgMemberRole.OWNER, OrgMemberRole.ADMIN)
        if (key.revokedAt != null) return false
        return repository.revoke(id, Instant.now()) > 0
    }

    private suspend fun requireRole(orgId: String, userId: String, vararg allowed: OrgMemberRole) {
        val role = organizationService.roleOf(orgId, userId) ?: throw ApiKeyForbiddenException(orgId)
        if (role !in allowed) throw ApiKeyForbiddenException(orgId)
    }

    private fun ApiKeyEntity.toSummary() = ApiKeySummary(
        id = id, orgId = orgId, name = name, prefix = prefix,
        lastUsedAt = lastUsedAt, revokedAt = revokedAt, createdAt = createdAt,
    )
}

class ApiKeyNotFoundException(val id: String) : RuntimeException("ApiKey $id not found")

class ApiKeyForbiddenException(val orgId: String) : RuntimeException("Not authorized for org $orgId")
