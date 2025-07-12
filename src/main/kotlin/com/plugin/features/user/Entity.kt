package com.plugin.features.user

import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import io.quarkus.security.jpa.Password
import io.quarkus.security.jpa.Username
import jakarta.persistence.*
import java.time.Instant

/**
 * Database entity for user configuration
 */
@Entity
@Table(name = "Users")
class UserEntity : PanacheEntityBase {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    lateinit var id: String

    @Column(nullable = false, unique = true)
    @Username
    lateinit var username: String

    @Column(nullable = false)
    @Password
    lateinit var password: String

    @Column(nullable = false)
    lateinit var name: String

    @Column(nullable = false)
    var companionAppConnected: Boolean = false

    @Column(nullable = false)
    var companionAppPort: Int = 64032

    @Column(nullable = false)
    @Enumerated(EnumType.STRING)
    lateinit var role: UserRoles

    @Column(nullable = false)
    var allowSavingCompletions: Boolean = false

    @Column(nullable = false)
    var createdAt: Instant = Instant.now()

    @Column(nullable = false)
    var verified: Boolean = false

    @Column(nullable = false)
    var emailVerificationFailedAttempts: Int = 0

    @Column(nullable = false)
    var numberOfEmailVerificationCodeGenerated: Int = 0

    @Column(nullable = true)
    var emailVerificationCodeExpiresAt: Instant? = null

    @Column(nullable = true)
    var emailVerificationCode: String? = null

    companion object : PanacheCompanion<UserEntity> {}
}

enum class UserRoles(val value: String) {
    ADMIN("admin"), USER("user")
}
