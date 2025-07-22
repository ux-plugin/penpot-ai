package com.plugin.features.user

import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
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
    lateinit var name: String

    @Column(nullable = false)
    var companionAppConnected: Boolean = false

    @Column(nullable = false)
    var companionAppPort: Int = 64032

    @Column(nullable = false)
    @Enumerated(EnumType.STRING)
    lateinit var role: UserRole

    @Column(nullable = false)
    var allowSavingCompletions: Boolean = false

    @Column(nullable = false)
    var createdAt: Instant = Instant.now()

    companion object : PanacheCompanion<UserEntity> {}
}

enum class UserRole {
    ADMIN, USER
}
