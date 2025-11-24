package com.plugin.features.user

import com.plugin.features.auth.core.SocialProvider
import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Column
import org.springframework.data.relational.core.mapping.Table
import java.time.Instant
import java.util.UUID

@Table("users")
data class UserEntity(
    @Id
    @Column("id")
    var id: String = UUID.randomUUID().toString(),
    
    @Column("username")
    var username: String = "",
    
    @Column("name")
    var name: String = "",
    
    @Column("role")
    var role: UserRole = UserRole.USER,
    
    @Column("allow_saving_completions")
    var allowSavingCompletions: Boolean = false,
    
    @Column("created_at")
    var createdAt: Instant = Instant.now(),
    
    @Column("encryption_key")
    var encryptionKey: String? = null,
    
    @Column("encryption_key_expires_at")
    var encryptionKeyExpiresAt: Instant? = null,
    
    @Column("port")
    var port: Int? = null
)

@Table("social_logins")
data class SocialLogins(
    @Id
    @Column("id")
    var id: String = UUID.randomUUID().toString(),
    
    @Column("user_id")
    var userId: String = "",
    
    @Column("provider_user_id")
    var providerUserId: String = "",
    
    @Column("provider")
    var provider: SocialProvider = SocialProvider.GITHUB
)

enum class UserRole {
    ADMIN,
    USER,
    GUEST
}
