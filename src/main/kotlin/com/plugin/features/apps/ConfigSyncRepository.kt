package com.plugin.features.apps

import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException

@ApplicationScoped
class ConfigSyncRepository: PanacheRepository<ConfigUser> {
    @WithSession
    fun getEncryptionKey(userId: String): Uni<String?> {
        return find("id", userId).firstResult().map { it?.encryptionKey }
    }

    @WithSession
    fun saveEncryptionKey(userId: String, encryptionKey: String): Uni<String> {
        return withTransaction {
            find("id", userId).firstResult().flatMap { user ->
                if (user == null) {
                    Uni.createFrom().failure(NotFoundException("user does not exist"))
                } else {
                    user.encryptionKey = encryptionKey
                    persistAndFlush(user).map { it.encryptionKey }
                }
            }
        }
    }
}