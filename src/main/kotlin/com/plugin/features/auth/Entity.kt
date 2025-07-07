package com.plugin.features.auth

import com.plugin.features.user.UserRoles
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import io.quarkus.security.jpa.Password
import io.quarkus.security.jpa.Username
import jakarta.persistence.*
import org.hibernate.annotations.Immutable

/**
 * Database entity for user credentials
 */
@Entity
@Immutable
@Table(name = "Users")
class AuthEntity : PanacheEntityBase {

    @Id
    lateinit var id: String

    @Column(nullable = false, unique = true)
    @Username
    lateinit var username: String

    @Column(nullable = false)
    @Password
    lateinit var password: String

    @Column(nullable = false)
    @Enumerated(EnumType.STRING)
    lateinit var role: UserRoles

    companion object : PanacheCompanion<AuthEntity> {}
}