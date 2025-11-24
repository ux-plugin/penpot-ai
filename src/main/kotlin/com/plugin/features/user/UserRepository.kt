package com.plugin.features.user

import com.plugin.features.auth.core.NotFoundException
import kotlinx.coroutines.reactor.awaitSingle
import kotlinx.coroutines.reactor.awaitSingleOrNull
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional
import java.time.Instant
import java.util.*

@Repository
class UserRepository(
    private val userR2dbcRepository: UserR2dbcRepository,
    private val socialLoginsR2dbcRepository: SocialLoginsR2dbcRepository,
    @Value("\${user.encryption-key-ttl-s}") private val encryptionKeyTtl: Long
) {
    
    suspend fun getUser(userId: String): GetUserResponse {
        val user = userR2dbcRepository.findById(userId).awaitSingleOrNull()
            ?: throw NotFoundException("User $userId not found")
        return GetUserResponse(
            id = user.id,
            username = user.username,
            name = user.name,
            role = user.role,
            allowSavingCompletions = user.allowSavingCompletions,
            port = user.port
        )
    }

    @Transactional
    suspend fun updateUser(userId: String, userUpdate: UpdateUserRequest) {
        val user = userR2dbcRepository.findById(userId).awaitSingleOrNull()
            ?: throw NotFoundException("User $userId not found")
        
        userUpdate.username?.let { user.username = it }
        userUpdate.name?.let { user.name = it }
        userUpdate.allowSavingCompletions?.let { user.allowSavingCompletions = it }
        
        userR2dbcRepository.save(user).awaitSingle()
    }

    suspend fun deleteUser(userId: String) {
        userR2dbcRepository.deleteById(userId).awaitSingleOrNull()
    }

    suspend fun getSocialLogins(userId: String): GetSocialLoginsResponse {
        val logins = socialLoginsR2dbcRepository.findByUserId(userId).awaitSingleOrNull() ?: emptyList()
        return GetSocialLoginsResponse(logins.map { SocialLogin(it.id, it.provider) })
    }

    suspend fun getEncryptionKey(userId: String): EncryptionKeyResponse? {
        val user = userR2dbcRepository.findById(userId).awaitSingleOrNull()
            ?: throw NotFoundException("User $userId not found")
        
        return if (user.encryptionKey != null && user.encryptionKeyExpiresAt?.isAfter(Instant.now()) == true) {
            EncryptionKeyResponse(key = user.encryptionKey!!, expiresAt = user.encryptionKeyExpiresAt!!)
        } else {
            null
        }
    }

    @Transactional
    suspend fun saveEncryptionKey(userId: String, encryptionKey: String): EncryptionKeyResponse {
        val user = userR2dbcRepository.findById(userId).awaitSingleOrNull()
            ?: throw NotFoundException("User $userId not found")
        
        val expiresAt = Instant.now().plusSeconds(encryptionKeyTtl)
        user.encryptionKey = encryptionKey
        user.encryptionKeyExpiresAt = expiresAt
        
        userR2dbcRepository.save(user).awaitSingle()
        return EncryptionKeyResponse(key = encryptionKey, expiresAt = expiresAt)
    }

    suspend fun getPort(userId: String): PortState? {
        val user = userR2dbcRepository.findById(userId).awaitSingleOrNull()
        return user?.port?.let { PortState(it) }
    }

    @Transactional
    suspend fun savePort(userId: String, portState: PortState) {
        val user = userR2dbcRepository.findById(userId).awaitSingleOrNull()
            ?: throw NotFoundException("User $userId not found")
        
        user.port = portState.port
        userR2dbcRepository.save(user).awaitSingle()
    }
}
