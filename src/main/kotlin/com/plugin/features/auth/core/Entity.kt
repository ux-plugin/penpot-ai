package com.plugin.features.auth.core

import com.plugin.features.user.UserRole
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import io.quarkus.security.jpa.Password
import io.quarkus.security.jpa.Username
import jakarta.persistence.*
import java.time.Instant

/**
 * Database entity for user credentials
 */
@Entity
@Table(name = "Users")
class AuthUserEntity : PanacheEntityBase {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    lateinit var id: String

    @Column(nullable = false, unique = true)
    @Username
    lateinit var username: String

    @Column(nullable = false)
    @Enumerated(EnumType.STRING)
    lateinit var role: UserRole

    @Column(nullable = true)
    @Password
    lateinit var refreshToken: String

    @Column(nullable = true)
    lateinit var refreshTokenExpiresAt: Instant

    companion object : PanacheCompanion<AuthUserEntity>
}

@Entity
@Table(name = "SocialLogins")
class SocialLoginEntity : PanacheEntityBase {
    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    lateinit var id: String

    @Column(nullable = false)
    lateinit var userId: String

    @Column(nullable = false, unique = true)
    lateinit var providerUserId: String

    @Column(nullable = false)
    @Enumerated(EnumType.STRING)
    lateinit var provider: SocialProvider

    @Column(nullable = false)
    @Password
    lateinit var refreshToken: String

    @Column(nullable = false)
    lateinit var refreshTokenExpiresAt: Instant

    companion object : PanacheCompanion<SocialLoginEntity>
}

enum class SocialProvider {
    GOOGLE, GITHUB, FIGMA
}