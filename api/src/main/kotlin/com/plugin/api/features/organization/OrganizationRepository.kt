package com.plugin.api.features.organization

import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.singleOrNull
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.innerJoin
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.deleteWhere
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.springframework.stereotype.Repository
import java.time.Instant

@Repository
class OrganizationRepository(private val database: R2dbcDatabase) {

    suspend fun create(org: OrganizationEntity, ownerUserId: String): OrganizationEntity = suspendTransaction(database) {
        OrganizationsTable.insert {
            it[id] = org.id
            it[slug] = org.slug
            it[name] = org.name
            it[createdAt] = org.createdAt
        }
        OrganizationMembersTable.insert {
            it[orgId] = org.id
            it[userId] = ownerUserId
            it[role] = OrgMemberRole.OWNER
            it[createdAt] = Instant.now()
        }
        org
    }

    suspend fun findById(id: String): OrganizationEntity? = suspendTransaction(database) {
        OrganizationsTable.selectAll().where { OrganizationsTable.id eq id }
            .map { it.toEntity() }.singleOrNull()
    }

    suspend fun findBySlug(slug: String): OrganizationEntity? = suspendTransaction(database) {
        OrganizationsTable.selectAll().where { OrganizationsTable.slug eq slug }
            .map { it.toEntity() }.singleOrNull()
    }

    suspend fun listForUser(userId: String): List<Pair<OrganizationEntity, OrgMemberRole>> = suspendTransaction(database) {
        OrganizationsTable.innerJoin(OrganizationMembersTable, { OrganizationsTable.id }, { OrganizationMembersTable.orgId })
            .selectAll()
            .where { OrganizationMembersTable.userId eq userId }
            .map { it.toEntity() to it[OrganizationMembersTable.role] }
            .toList()
    }

    // Cascade FKs on organization_members and api_keys clean up dependent rows.
    suspend fun delete(id: String): Int = suspendTransaction(database) {
        OrganizationsTable.deleteWhere { OrganizationsTable.id eq id }
    }

    suspend fun findMembership(orgId: String, userId: String): OrganizationMemberEntity? = suspendTransaction(database) {
        OrganizationMembersTable.selectAll()
            .where { (OrganizationMembersTable.orgId eq orgId) and (OrganizationMembersTable.userId eq userId) }
            .map {
                OrganizationMemberEntity(
                    orgId = it[OrganizationMembersTable.orgId],
                    userId = it[OrganizationMembersTable.userId],
                    role = it[OrganizationMembersTable.role],
                    createdAt = it[OrganizationMembersTable.createdAt],
                )
            }
            .firstOrNull()
    }

    private fun ResultRow.toEntity() = OrganizationEntity(
        id = this[OrganizationsTable.id],
        slug = this[OrganizationsTable.slug],
        name = this[OrganizationsTable.name],
        createdAt = this[OrganizationsTable.createdAt],
    )
}
