package com.plugin.features.auth.core

import com.plugin.features.user.UserRole
import java.time.Instant
import java.util.UUID
import org.jetbrains.exposed.v1.core.Table
import org.jetbrains.exposed.v1.javatime.timestamp

/** Exposed entities and tables for auth/core */

/** Social providers supported by the system */
enum class SocialProvider {
    GITHUB,
    FIGMA,
    GOOGLE,
}

/** Kotlin data entity representing a row in users table */
data class AuthUserEntity(
    var id: String = UUID.randomUUID().toString(),
    var username: String? = null,
    var name: String = "",
    var role: UserRole = UserRole.USER,
    var refreshToken: String = "",
    var refreshTokenExpiresAt: Instant = Instant.now(),
    var createdAt: Instant = Instant.now(),
    var allowSavingCompletions: Boolean = false,
    var encryptionKey: String? = null,
    var encryptionKeyExpiresAt: Instant? = null,
    var port: Int? = null,
)

/** Kotlin data entity representing a row in social_logins table */
data class SocialLoginEntity(
    var id: String = UUID.randomUUID().toString(),
    var userId: String = "",
    var providerUserId: String = "",
    var provider: SocialProvider = SocialProvider.GITHUB,
    var refreshToken: String = "",
    var main: Boolean = false,
    var refreshTokenExpiresAt: Instant = Instant.now(),
)

/** Exposed table definition for users table */
object UsersTable : Table("users") {
    val id = varchar("id", 255)
    val username = varchar("username", 255).nullable()
    val name = varchar("name", 255)
    val role = customEnumeration("role", "user_roles", { value -> UserRole.valueOf(value as String) }, { it })
    val refreshToken = varchar("refresh_token", 255)
    val refreshTokenExpiresAt = timestamp("refresh_token_expires_at")
    val createdAt = timestamp("created_at")
    val allowSavingCompletions = bool("allow_saving_completions")
    val encryptionKey = varchar("encryption_key", 255).nullable()
    val encryptionKeyExpiresAt = timestamp("encryption_key_expires_at").nullable()
    val port = integer("port").nullable()

    override val primaryKey = PrimaryKey(id)
}

/** Exposed table definition for social_logins table */
object SocialLoginsTable : Table("social_logins") {
    val id = varchar("id", 255)
    val userId = varchar("user_id", 255).references(UsersTable.id)
    val providerUserId = varchar("provider_user_id", 255)
    val provider =
        customEnumeration("provider", "social_providers", { value -> SocialProvider.valueOf(value as String) }, { it })
    val refreshToken = varchar("refresh_token", 255)
    val main = bool("main")
    val refreshTokenExpiresAt = timestamp("refresh_token_expires_at")

    override val primaryKey = PrimaryKey(id)
}
