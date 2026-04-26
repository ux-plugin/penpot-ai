package com.plugin.features.user

import com.plugin.config.properties.UserProperties
import com.plugin.features.auth.core.NotFoundException
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.singleOrNull
import kotlinx.coroutines.flow.toList
import org.jetbrains.exposed.v1.core.ResultRow
import org.jetbrains.exposed.v1.core.eq
import org.jetbrains.exposed.v1.r2dbc.R2dbcDatabase
import org.jetbrains.exposed.v1.r2dbc.deleteWhere
import org.jetbrains.exposed.v1.r2dbc.insert
import org.jetbrains.exposed.v1.r2dbc.selectAll
import org.jetbrains.exposed.v1.r2dbc.transactions.suspendTransaction
import org.jetbrains.exposed.v1.r2dbc.update
import org.springframework.stereotype.Repository
import java.time.Instant

@Repository
class UserRepository(private val database: R2dbcDatabase, private val userProperties: UserProperties) {
    suspend fun getUser(userId: String): GetUserResponse = suspendTransaction(database) {
        UsersTable
            .selectAll()
            .where { UsersTable.id eq userId }
            .map { it.toUserEntity() }
            .singleOrNull()
            ?.let {
                GetUserResponse(
                    id = it.id,
                    username = it.username,
                    name = it.name,
                    role = it.role,
                    allowSavingCompletions = it.allowSavingCompletions,
                    port = it.port,
                )
            } ?: throw NotFoundException("User $userId not found")
    }

    suspend fun updateUser(userId: String, userUpdate: UpdateUserRequest) = suspendTransaction(database) {
        val user =
            UsersTable
                .selectAll()
                .where { UsersTable.id eq userId }
                .map { it.toUserEntity() }
                .singleOrNull()
                ?: throw NotFoundException("User $userId not found")

        val newUsername = userUpdate.username ?: user.username
        val newName = userUpdate.name ?: user.name
        val newAllowSaving = userUpdate.allowSavingCompletions ?: user.allowSavingCompletions

        UsersTable.update({ UsersTable.id eq userId }) {
            it[username] = newUsername
            it[name] = newName
            it[allowSavingCompletions] = newAllowSaving
        }
    }

    suspend fun deleteUser(userId: String) = suspendTransaction(database) { UsersTable.deleteWhere { UsersTable.id eq userId } }

    suspend fun findByAuth0Sub(auth0Sub: String): UserEntity? = suspendTransaction(database) {
        UsersTable
            .selectAll()
            .where { UsersTable.auth0Sub eq auth0Sub }
            .map { it.toUserEntity() }
            .singleOrNull()
    }

    suspend fun getSocialLogins(userId: String): GetSocialLoginsResponse = suspendTransaction(database) {
        val logins =
            SocialLoginsTable
                .selectAll()
                .where { SocialLoginsTable.userId eq userId }
                .map { it.toSocialLoginEntity() }
                .toList()

        GetSocialLoginsResponse(logins.map { SocialLogin(it.id, it.provider) })
    }

    suspend fun getEncryptionKey(userId: String): EncryptionKeyResponse? = suspendTransaction(database) {
        UsersTable
            .selectAll()
            .where { UsersTable.id eq userId }
            .map { it.toUserEntity() }
            .singleOrNull()
            ?.let { user ->
                if (user.encryptionKey != null && user.encryptionKeyExpiresAt?.isAfter(Instant.now()) == true) {
                    EncryptionKeyResponse(user.encryptionKey!!, user.encryptionKeyExpiresAt!!)
                } else {
                    null
                }
            } ?: throw NotFoundException("User $userId not found")
    }

    suspend fun saveEncryptionKey(userId: String, encryptionKey: String): EncryptionKeyResponse = suspendTransaction(database) {
        val expiresAt = Instant.now().plusSeconds(userProperties.encryptionKeyTtlS)

        val updated =
            UsersTable.update({ UsersTable.id eq userId }) {
                it[UsersTable.encryptionKey] = encryptionKey
                it[UsersTable.encryptionKeyExpiresAt] = expiresAt
            }

        if (updated == 0) throw NotFoundException("User $userId not found")
        EncryptionKeyResponse(encryptionKey, expiresAt)
    }

    suspend fun getPort(userId: String): PortState? = suspendTransaction(database) {
        UsersTable
            .selectAll()
            .where { UsersTable.id eq userId }
            .map { it[UsersTable.port] }
            .singleOrNull()
            ?.let { port -> PortState(port) }
    }

    suspend fun savePort(userId: String, portState: PortState) = suspendTransaction(database) {
        val updated = UsersTable.update({ UsersTable.id eq userId }) { it[port] = portState.port }
        if (updated == 0) throw NotFoundException("User $userId not found")
    }

    // Utility: Insert or update a user (used in dev resource)
    suspend fun save(entity: UserEntity): UserEntity = suspendTransaction(database) {
        val existing =
            UsersTable
                .selectAll()
                .where { UsersTable.id eq entity.id }
                .map { it.toUserEntity() }
                .singleOrNull()

        if (existing == null) {
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

    // --------- Mappers ---------
    private fun ResultRow.toUserEntity() = UserEntity(
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
