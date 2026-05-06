package com.plugin.api.features.organization

import com.plugin.api.features.user.UsersTable
import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.javatime.timestamp
import java.time.Instant
import java.util.UUID

data class OrganizationEntity(
    val id: String = UUID.randomUUID().toString(),
    val slug: String = "",
    val name: String = "",
    val createdAt: Instant = Instant.now(),
)

data class OrganizationMemberEntity(
    val orgId: String = "",
    val userId: String = "",
    val role: OrgMemberRole = OrgMemberRole.MEMBER,
    val createdAt: Instant = Instant.now(),
)

enum class OrgMemberRole {
    OWNER,
    ADMIN,
    MEMBER,
}

object OrganizationsTable : Table("organizations") {
    val id = varchar("id", 255)
    val slug = varchar("slug", 255).uniqueIndex()
    val name = varchar("name", 255)
    val createdAt = timestamp("created_at")

    override val primaryKey = PrimaryKey(id)
}

object OrganizationMembersTable : Table("organization_members") {
    val orgId = varchar("org_id", 255).references(OrganizationsTable.id)
    val userId = varchar("user_id", 255).references(UsersTable.id)
    val role = customEnumeration("role", "org_member_roles", { value -> OrgMemberRole.valueOf(value as String) }, { it })
    val createdAt = timestamp("created_at")

    override val primaryKey = PrimaryKey(orgId, userId)
}
