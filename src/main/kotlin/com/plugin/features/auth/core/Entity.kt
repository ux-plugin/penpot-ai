package com.plugin.features.auth.core

import com.plugin.features.user.UserRole
import org.springframework.data.annotation.Id
import org.springframework.data.relational.core.mapping.Column
import org.springframework.data.relational.core.mapping.Table
import java.time.Instant
import java.util.UUID

@Table("users")
data class AuthUserEntity(
    @Id
    @Column("id")
    var id: String = UUID.randomUUID().toString(),
    
    @Column("username")
    var username: String? = null,
    
    @Column("role")
    var role: UserRole = UserRole.USER,
    
    @Column("refresh_token")
    var refreshToken: String = "",
    
    @Column("refresh_token_expires_at")
    var refreshTokenExpiresAt: Instant = Instant.now()
)

@Table("social_logins")
data class SocialLoginEntity(
    @Id
    @Column("id")
    var id: String = UUID.randomUUID().toString(),
    
    @Column("user_id")
    var userId: String = "",
    
    @Column("provider_user_id")
    var providerUserId: String = "",
    
    @Column("provider")
    var provider: SocialProvider = SocialProvider.GITHUB,
    
    @Column("refresh_token")
    var refreshToken: String = "",
    
    @Column("main")
    var main: Boolean = false,
    
    @Column("refresh_token_expires_at")
    var refreshTokenExpiresAt: Instant = Instant.now()
)

enum class SocialProvider {
    GOOGLE,
    GITHUB,
    FIGMA,
}
