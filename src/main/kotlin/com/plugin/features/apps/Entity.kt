package com.plugin.features.apps

import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import io.quarkus.security.jpa.Password
import jakarta.persistence.*
import java.time.Instant

@Entity
@Table(name = "Users")
class ConfigUser : PanacheEntityBase {

    @Id @GeneratedValue(strategy = GenerationType.UUID) lateinit var id: String

    @Column(nullable = true) @Password lateinit var encryptionKey: String

    @Column(nullable = true) lateinit var encryptionKeyExpiresAt: Instant

    companion object : PanacheCompanion<ConfigUser>
}
