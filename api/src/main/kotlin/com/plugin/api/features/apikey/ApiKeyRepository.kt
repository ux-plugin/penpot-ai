package com.plugin.api.features.apikey

import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.core.isNull
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import org.springframework.stereotype.Repository
import java.time.Instant

@Repository
class ApiKeyRepository(private val database: R2dbcDatabase) {

    suspend fun insert(entity: ApiKeyEntity): ApiKeyEntity = suspendTransaction(database) {
        ApiKeysTable.insert {
            it[id] = entity.id
            it[orgId] = entity.orgId
            it[createdByUserId] = entity.createdByUserId
            it[name] = entity.name
            it[prefix] = entity.prefix
            it[keyHash] = entity.keyHash
            it[lastUsedAt] = entity.lastUsedAt
            it[revokedAt] = entity.revokedAt
            it[createdAt] = entity.createdAt
        }
        entity
    }

    suspend fun findActiveByHash(keyHash: String): ApiKeyEntity? = suspendTransaction(database) {
        ApiKeysTable.selectAll()
            .where { (ApiKeysTable.keyHash eq keyHash) and ApiKeysTable.revokedAt.isNull() }
            .map { it.toEntity() }
            .firstOrNull()
    }

    suspend fun findById(id: String): ApiKeyEntity? = suspendTransaction(database) {
        ApiKeysTable.selectAll().where { ApiKeysTable.id eq id }
            .map { it.toEntity() }.firstOrNull()
    }

    suspend fun listByOrg(orgId: String): List<ApiKeyEntity> = suspendTransaction(database) {
        ApiKeysTable.selectAll().where { ApiKeysTable.orgId eq orgId }
            .map { it.toEntity() }.toList()
    }

    suspend fun revoke(id: String, at: Instant): Int = suspendTransaction(database) {
        ApiKeysTable.update({ (ApiKeysTable.id eq id) and ApiKeysTable.revokedAt.isNull() }) {
            it[revokedAt] = at
        }
    }

    suspend fun touchLastUsed(id: String, at: Instant): Int = suspendTransaction(database) {
        ApiKeysTable.update({ ApiKeysTable.id eq id }) {
            it[lastUsedAt] = at
        }
    }

    private fun ResultRow.toEntity() = ApiKeyEntity(
        id = this[ApiKeysTable.id],
        orgId = this[ApiKeysTable.orgId],
        createdByUserId = this[ApiKeysTable.createdByUserId],
        name = this[ApiKeysTable.name],
        prefix = this[ApiKeysTable.prefix],
        keyHash = this[ApiKeysTable.keyHash],
        lastUsedAt = this[ApiKeysTable.lastUsedAt],
        revokedAt = this[ApiKeysTable.revokedAt],
        createdAt = this[ApiKeysTable.createdAt],
    )
}
