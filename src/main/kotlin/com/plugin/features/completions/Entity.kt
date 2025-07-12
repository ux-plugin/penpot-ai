package com.plugin.features.completions

import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import jakarta.persistence.*
import org.hibernate.annotations.CreationTimestamp
import org.hibernate.annotations.Immutable
import java.time.Instant

@Entity
@Table(name = "ComponentCompletions")
class ComponentCompletionEntity : PanacheEntityBase {

    @Column(name = "userId", nullable = false)
    lateinit var userId: String

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    @Column(nullable = false)
    lateinit var id: String

    @Column(nullable = false, columnDefinition = "TEXT")
    lateinit var prompt: String

    @Column(nullable = false, columnDefinition = "TEXT")
    lateinit var aiCompletion: String

    @CreationTimestamp
    @Column(nullable = false)
    var createdAt: Instant = Instant.now()

    companion object : PanacheCompanion<ComponentCompletionEntity> {}
}

@Entity
@Immutable
@Table(name = "Users")
class UserPermissions : PanacheEntityBase {
    @Id
    lateinit var id: String

    @Column(nullable = false)
    var allowSavingCompletions: Boolean = false

    companion object : PanacheCompanion<UserPermissions> {}
}
