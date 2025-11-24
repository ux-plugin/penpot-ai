package com.plugin.dev

import com.plugin.config.JwtService
import com.plugin.features.user.UserEntity
import com.plugin.features.user.UserR2dbcRepository
import com.plugin.features.user.UserRole
import kotlinx.coroutines.reactor.awaitSingleOrNull
import org.springframework.context.annotation.Profile
import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.*
import java.time.Instant

data class AddUserRequest(
    val id: String,
    val username: String,
    val name: String,
    val role: UserRole
)

data class AddUserResponse(val accessToken: String)

data class GetJwtResponse(val accessToken: String)

@RestController
@RequestMapping("/dev/user", produces = [MediaType.APPLICATION_JSON_VALUE])
@Profile("dev")
class UserManagementResource(
    private val userRepository: UserR2dbcRepository,
    private val jwtService: JwtService
) {
    
    @PostMapping("/add", consumes = [MediaType.APPLICATION_JSON_VALUE])
    suspend fun addUser(@RequestBody request: AddUserRequest): AddUserResponse {
        val newUser = UserEntity(
            id = request.id,
            username = request.username,
            name = request.name,
            role = request.role,
            createdAt = Instant.now()
        )
        
        userRepository.save(newUser).awaitSingleOrNull()
        
        val token = jwtService.createToken(
            subject = request.id,
            role = request.role.name,
            expirationSeconds = 3600
        )
        
        return AddUserResponse(accessToken = token)
    }
    
    @GetMapping("/jwt")
    suspend fun getJWT(@RequestParam userId: String): GetJwtResponse {
        val token = jwtService.createToken(
            subject = userId,
            role = UserRole.USER.name,
            expirationSeconds = 3600
        )
        
        return GetJwtResponse(accessToken = token)
    }
}
