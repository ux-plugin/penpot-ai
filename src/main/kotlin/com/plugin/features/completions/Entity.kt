package com.plugin.features.completions

import io.quarkus.hibernate.reactive.panache.kotlin.PanacheCompanion
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheEntityBase
import jakarta.persistence.Column
import jakarta.persistence.Entity
import jakarta.persistence.Id
import jakarta.persistence.Table
import org.hibernate.annotations.CreationTimestamp
import java.time.Instant

@Entity
@Table(name = "ComponentCompletions")
class ComponentCompletionEntity : PanacheEntityBase {

    @Column(name = "user_id", nullable = false)
    lateinit var userId: String

    @Id
    @Column(nullable = false)
    lateinit var completionId: String

    @Column(nullable = false, columnDefinition = "TEXT")
    lateinit var prompt: String

    @Column(nullable = false, columnDefinition = "TEXT")
    lateinit var aiCompletion: String

    @CreationTimestamp
    @Column(nullable = false)
    var createdAt: Instant = Instant.now()

    companion object : PanacheCompanion<ComponentCompletionEntity> {
        fun findByUserIdAndCompletionId(userId: String, completionId: String) =
            find("userId = ?1 and completionId = ?2", userId, completionId).firstResult()

        fun findByUserId(userId: String) =
            find("userId", userId).list()
    }
}
