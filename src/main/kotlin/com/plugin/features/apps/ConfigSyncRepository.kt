package com.plugin.features.apps

import io.quarkus.hibernate.reactive.panache.Panache.withTransaction
import io.quarkus.hibernate.reactive.panache.common.WithSession
import io.quarkus.hibernate.reactive.panache.kotlin.PanacheRepository
import io.smallrye.mutiny.Uni
import jakarta.enterprise.context.ApplicationScoped
import jakarta.ws.rs.NotFoundException
import java.time.Instant
import org.eclipse.microprofile.config.inject.ConfigProperty

@ApplicationScoped
class ConfigSyncRepository(
    @param:ConfigProperty(name = "apps.encryption-key-ttl-s") private val encryptionKeyTtl: Long
) : PanacheRepository<ConfigUser> {
    @WithSession
    fun getEncryptionKey(userId: String): Uni<EncryptionKeyResponse?> {
        return find("id", userId).firstResult().map { user ->
            if (user?.encryptionKey != null && user.encryptionKeyExpiresAt.isAfter(Instant.now())) {
                EncryptionKeyResponse(key = user.encryptionKey, expiresAt = user.encryptionKeyExpiresAt)
            } else {
                null
            }
        }
    }

    @WithSession
    fun saveEncryptionKey(userId: String, encryptionKey: String): Uni<EncryptionKeyResponse> {
        return withTransaction {
            find("id", userId).firstResult().flatMap { user ->
                if (user == null) {
                    Uni.createFrom().failure(NotFoundException("user does not exist"))
                } else {
                    user.encryptionKey = encryptionKey
                    user.encryptionKeyExpiresAt = Instant.now().plusSeconds(encryptionKeyTtl)
                    persistAndFlush(user).map { EncryptionKeyResponse(it.encryptionKey, it.encryptionKeyExpiresAt) }
                }
            }
        }
    }
}
