package com.plugin.features.user

import com.plugin.features.auth.core.SocialProvider
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import io.quarkus.security.jpa.Username
import jakarta.persistence.*
import java.time.Instant
import javax.annotation.concurrent.Immutable

/** Database entity for user configuration */
@Entity
@Table(name = "Users")
class UserEntity : PanacheEntityBase {

    @Id @GeneratedValue(strategy = GenerationType.UUID) lateinit var id: String

    @Column(nullable = true, unique = true) @Username lateinit var username: String

    @Column(nullable = false) lateinit var name: String

    @Column(nullable = false) @Enumerated(EnumType.STRING) lateinit var role: UserRole

    @Column(nullable = false) var allowSavingCompletions: Boolean = false

    @Column(nullable = false) var createdAt: Instant = Instant.now()

    companion object : PanacheCompanion<UserEntity> {}
}

@Entity
@Immutable
@Table(name = "SocialLogins")
class SocialLogins : PanacheEntityBase {
    @Id lateinit var id: String
    @Column(nullable = false) lateinit var userId: String
    @Column(nullable = false, unique = true) lateinit var providerUserId: String
    @Column(nullable = false) @Enumerated(EnumType.STRING) lateinit var provider: SocialProvider

    companion object : PanacheCompanion<SocialLogins> {}
}

enum class UserRole {
    ADMIN,
    USER,
}
