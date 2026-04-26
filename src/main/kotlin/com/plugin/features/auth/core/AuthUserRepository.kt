package com.plugin.features.auth.core

import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.singleOrNull
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.and
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import org.springframework.stereotype.Repository

/** Repository for authentication-related operations using Exposed R2DBC */
@Repository
class AuthUserRepository(private val database: R2dbcDatabase) {
    /** Find a user by ID */
    suspend fun findById(id: String): AuthUserEntity? = suspendTransaction(database) {
        UsersTable
            .selectAll()
            .where { UsersTable.id eq id }
            .map { it.toAuthUserEntity() }
            .singleOrNull()
    }

    /** Find a user by ID and refresh token */
    suspend fun findByIdAndRefreshToken(id: String, refreshToken: String): AuthUserEntity? = suspendTransaction(database) {
        UsersTable
            .selectAll()
            .where { (UsersTable.id eq id) and (UsersTable.refreshToken eq refreshToken) }
            .map { it.toAuthUserEntity() }
            .singleOrNull()
    }

    /** Save (insert or update) a user */
    suspend fun save(entity: AuthUserEntity): AuthUserEntity = suspendTransaction(database) {
        val existingUser =
            UsersTable
                .selectAll()
                .where { UsersTable.id eq entity.id }
                .map { it.toAuthUserEntity() }
                .singleOrNull()

        if (existingUser == null) {
            // Insert new user
            UsersTable.insert {
                it[id] = entity.id
                it[username] = entity.username
                it[email] = entity.email
                it[name] = entity.name
                it[role] = entity.role
                it[refreshToken] = entity.refreshToken
                it[refreshTokenExpiresAt] = entity.refreshTokenExpiresAt
                it[createdAt] = entity.createdAt
                it[allowSavingCompletions] = entity.allowSavingCompletions
                it[encryptionKey] = entity.encryptionKey
                it[encryptionKeyExpiresAt] = entity.encryptionKeyExpiresAt
                it[port] = entity.port
                it[auth0Sub] = entity.auth0Sub
            }
        } else {
            // Update existing user
            UsersTable.update({ UsersTable.id eq entity.id }) {
                it[username] = entity.username
                it[email] = entity.email
                it[name] = entity.name
                it[role] = entity.role
                it[refreshToken] = entity.refreshToken
                it[refreshTokenExpiresAt] = entity.refreshTokenExpiresAt
                it[allowSavingCompletions] = entity.allowSavingCompletions
                it[encryptionKey] = entity.encryptionKey
                it[encryptionKeyExpiresAt] = entity.encryptionKeyExpiresAt
                it[port] = entity.port
                it[auth0Sub] = entity.auth0Sub
            }
        }
        entity
    }

    /** Convert ResultRow to AuthUserEntity */
    private fun ResultRow.toAuthUserEntity() = AuthUserEntity(
        id = this[UsersTable.id],
        username = this[UsersTable.username],
        email = this[UsersTable.email],
        name = this[UsersTable.name],
        role = this[UsersTable.role],
        refreshToken = this[UsersTable.refreshToken],
        refreshTokenExpiresAt = this[UsersTable.refreshTokenExpiresAt],
        createdAt = this[UsersTable.createdAt],
        allowSavingCompletions = this[UsersTable.allowSavingCompletions],
        encryptionKey = this[UsersTable.encryptionKey],
        encryptionKeyExpiresAt = this[UsersTable.encryptionKeyExpiresAt],
        port = this[UsersTable.port],
        auth0Sub = this[UsersTable.auth0Sub],
    )
}
