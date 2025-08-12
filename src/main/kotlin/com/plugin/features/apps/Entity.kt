package com.plugin.features.apps

import com.plugin.features.auth.core.AuthUserEntity
import com.plugin.features.user.UserRole
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import io.quarkus.security.jpa.Password
import io.quarkus.security.jpa.Username
import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.EnumType
import jakarta.persistence.Enumerated
import jakarta.persistence.GeneratedValue
import jakarta.persistence.GenerationType
import jakarta.persistence.Id
import jakarta.persistence.Table
import java.time.Instant

@Entity
@Table(name = "Users")
class ConfigUser : PanacheEntityBase {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    lateinit var id: String

    @Column(nullable = true)
    @Password
    lateinit var encryptionKey: String

    companion object : PanacheCompanion<ConfigUser>
}