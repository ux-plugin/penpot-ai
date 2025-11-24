package com.plugin.features.user

import com.plugin.features.auth.core.NotFoundException
import org.springframework.beans.factory.annotation.Value
import org.springframework.data.redis.core.ReactiveRedisTemplate
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.security.core.annotation.AuthenticationPrincipal
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.stereotype.Service
import org.springframework.web.bind.annotation.*
import java.util.*
import javax.crypto.KeyGenerator

@Service
class UserService(
    private val userRepository: UserRepository,
    private val reactiveRedisTemplate: ReactiveRedisTemplate<String, PortState>,
    @Value("\${user.companion-app-key-prefix}") private val companionAppKeyPrefix: String
) {

    suspend fun getUser(userId: String): GetUserResponse {
        return userRepository.getUser(userId)
    }

    suspend fun updateUser(userId: String, userUpdate: UpdateUserRequest) {
        userRepository.updateUser(userId, userUpdate)
    }

    suspend fun deleteUser(userId: String) {
        userRepository.deleteUser(userId)
    }

    suspend fun getSocialProfiles(userId: String): GetSocialLoginsResponse {
        return userRepository.getSocialLogins(userId)
    }

    suspend fun getCurrentPort(userId: String): PortState? {
        return userRepository.getPort(userId)
    }

    suspend fun updatePort(userId: String, portState: PortState) {
        userRepository.savePort(userId, portState)
        // Publish to Redis
        reactiveRedisTemplate.convertAndSend(companionAppKeyPrefix + userId, portState)
    }

    suspend fun getEncryptionKey(userId: String): EncryptionKeyResponse? {
        return userRepository.getEncryptionKey(userId)
    }

    suspend fun createEncryptionKey(userId: String): EncryptionKeyResponse {
        val keyGenerator = KeyGenerator.getInstance("AES")
        keyGenerator.init(256)
        val secretKey = keyGenerator.generateKey()
        val encryptionKey = Base64.getEncoder().encodeToString(secretKey.encoded)
        return userRepository.saveEncryptionKey(userId, encryptionKey)
    }
}

@RestController
@RequestMapping("/user")
class UserResource(
    private val userService: UserService
) {

    @GetMapping("/info")
    suspend fun getUser(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val user = userService.getUser(userId)
            ResponseEntity.ok(user)
        } catch (e: NotFoundException) {
            ResponseEntity.status(HttpStatus.NOT_FOUND).build<Unit>()
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        }
    }

    @PostMapping("/update")
    suspend fun updateUser(
        @AuthenticationPrincipal jwt: Jwt,
        @RequestBody userUpdate: UpdateUserRequest
    ): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            userService.updateUser(userId, userUpdate)
            ResponseEntity.ok().build<Unit>()
        } catch (e: NotFoundException) {
            ResponseEntity.status(HttpStatus.NOT_FOUND).build<Unit>()
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        }
    }

    @DeleteMapping("/delete")
    suspend fun deleteUser(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            userService.deleteUser(userId)
            ResponseEntity.ok().build<Unit>()
        } catch (e: NotFoundException) {
            ResponseEntity.status(HttpStatus.NOT_FOUND).build<Unit>()
        } catch (e: SecurityException) {
            ResponseEntity.status(HttpStatus.UNAUTHORIZED).build<Unit>()
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        }
    }

    @GetMapping("/socials")
    suspend fun getSocialUser(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val profiles = userService.getSocialProfiles(userId)
            ResponseEntity.ok(profiles)
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        }
    }

    @PostMapping("/key")
    suspend fun generateKey(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val key = userService.createEncryptionKey(userId)
            ResponseEntity.ok(key)
        } catch (e: NotFoundException) {
            ResponseEntity.status(HttpStatus.NOT_FOUND).body("User not found")
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Internal server error")
        }
    }

    @GetMapping("/key")
    suspend fun getKey(@AuthenticationPrincipal jwt: Jwt): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            val key = userService.getEncryptionKey(userId)
            ResponseEntity.ok(key)
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body("Internal server error")
        }
    }

    @PostMapping("/port")
    suspend fun updatePort(
        @AuthenticationPrincipal jwt: Jwt,
        @RequestBody portState: PortState
    ): ResponseEntity<*> {
        val userId = jwt.subject
        return try {
            userService.updatePort(userId, portState)
            ResponseEntity.ok().build<Unit>()
        } catch (e: Exception) {
            ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).build<Unit>()
        }
    }
}
