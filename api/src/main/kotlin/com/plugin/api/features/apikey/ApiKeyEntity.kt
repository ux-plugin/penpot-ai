package com.plugin.api.features.apikey

import com.plugin.api.features.organization.OrganizationsTable
import com.plugin.api.features.user.UsersTable
import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.javatime.timestamp
import java.time.Instant
import java.util.UUID

data class ApiKeyEntity(
    val id: String = UUID.randomUUID().toString(),
    val orgId: String = "",
    val createdByUserId: String = "",
    val name: String = "",
    val prefix: String = "",
    val keyHash: String = "",
    val lastUsedAt: Instant? = null,
    val revokedAt: Instant? = null,
    val createdAt: Instant = Instant.now(),
)

object ApiKeysTable : Table("api_keys") {
    val id = varchar("id", 255)
    val orgId = varchar("org_id", 255).references(OrganizationsTable.id)
    val createdByUserId = varchar("created_by_user_id", 255).references(UsersTable.id)
    val name = varchar("name", 255)
    val prefix = varchar("prefix", 255)
    val keyHash = varchar("key_hash", 255).uniqueIndex()
    val lastUsedAt = timestamp("last_used_at").nullable()
    val revokedAt = timestamp("revoked_at").nullable()
    val createdAt = timestamp("created_at")

    override val primaryKey = PrimaryKey(id)
}
