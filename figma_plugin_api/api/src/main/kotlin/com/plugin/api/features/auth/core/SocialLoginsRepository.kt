package com.plugin.api.features.auth.core

import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.singleOrNull
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.deleteWhere
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import org.springframework.stereotype.Repository

/** Repository for social login operations using Exposed R2DBC */
@Repository
class SocialLoginsRepository(private val database: R2dbcDatabase) {
    /** Find by ID */
    suspend fun findById(id: String): SocialLoginEntity? = suspendTransaction(database) {
        SocialLoginsTable
            .selectAll()
            .where { SocialLoginsTable.id eq id }
            .map { it.toSocialLoginEntity() }
            .singleOrNull()
    }

    /** Find social login by provider user ID and provider */
    suspend fun findByProviderUserIdAndProvider(providerUserId: String, provider: SocialProvider): SocialLoginEntity? =
        suspendTransaction(database) {
            SocialLoginsTable
                .selectAll()
                .where {
                    (SocialLoginsTable.providerUserId eq providerUserId) and (SocialLoginsTable.provider eq provider)
                }.map { it.toSocialLoginEntity() }
                .singleOrNull()
        }

    /** Find social login by user ID and social login ID */
    suspend fun findByUserIdAndId(userId: String, id: String): SocialLoginEntity? = suspendTransaction(database) {
        SocialLoginsTable
            .selectAll()
            .where { (SocialLoginsTable.userId eq userId) and (SocialLoginsTable.id eq id) }
            .map { it.toSocialLoginEntity() }
            .singleOrNull()
    }

    /** Save (insert or update) a social login */
    suspend fun save(entity: SocialLoginEntity): SocialLoginEntity = suspendTransaction(database) {
        val existing =
            SocialLoginsTable
                .selectAll()
                .where { SocialLoginsTable.id eq entity.id }
                .map { it.toSocialLoginEntity() }
                .singleOrNull()

        if (existing == null) {
            // Insert new social login
            SocialLoginsTable.insert {
                it[id] = entity.id
                it[userId] = entity.userId
                it[providerUserId] = entity.providerUserId
                it[provider] = entity.provider
                it[refreshToken] = entity.refreshToken
                it[main] = entity.main
                it[refreshTokenExpiresAt] = entity.refreshTokenExpiresAt
            }
        } else {
            // Update existing social login
            SocialLoginsTable.update({ SocialLoginsTable.id eq entity.id }) {
                it[userId] = entity.userId
                it[providerUserId] = entity.providerUserId
                it[provider] = entity.provider
                it[refreshToken] = entity.refreshToken
                it[main] = entity.main
                it[refreshTokenExpiresAt] = entity.refreshTokenExpiresAt
            }
        }
        entity
    }

    /** Delete by ID */
    suspend fun deleteById(id: String): Int = suspendTransaction(database) { SocialLoginsTable.deleteWhere { SocialLoginsTable.id eq id } }

    /** Convert ResultRow to SocialLoginEntity */
    private fun ResultRow.toSocialLoginEntity() = SocialLoginEntity(
        id = this[SocialLoginsTable.id],
        userId = this[SocialLoginsTable.userId],
        providerUserId = this[SocialLoginsTable.providerUserId],
        provider = this[SocialLoginsTable.provider],
        refreshToken = this[SocialLoginsTable.refreshToken],
        main = this[SocialLoginsTable.main],
        refreshTokenExpiresAt = this[SocialLoginsTable.refreshTokenExpiresAt],
    )
}
