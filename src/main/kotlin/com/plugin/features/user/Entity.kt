package com.plugin.features.user

import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table

/**
 * Database entity for user configuration
 */
@Entity
@Table(name = "Users")
class UserEntity : PanacheEntityBase {

    @Id
    @Column(nullable = false, unique = true)
    lateinit var userId: String

    @Column(nullable = false)
    var companionAppConnected: Boolean = false

    @Column(nullable = false)
    var companionAppPort: Int = 64032

}
