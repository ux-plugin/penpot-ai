package com.plugin.api.features.auth.auth0

import com.plugin.api.features.user.UserEntity
import com.plugin.api.features.user.UserRepository
import com.plugin.api.features.user.UserRole
import org.slf4j.LoggerFactory
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.security.oauth2.jwt.Jwt
import org.springframework.stereotype.Component
import java.time.Instant

/**
 * Resolves an Auth0-issued JWT to a local users row, creating one on first login.
 *
 * The local `users` table stores the Auth0 `sub` (e.g. `auth0|abc123`) in `auth0_sub` and the
 * email claim in `email`. New OAuth-provisioned rows are keyed by `id = sub`.
 */
@Component
@ConditionalOnProperty(prefix = "auth0", name = ["issuer"])
class Auth0UserProvisioner(private val userRepository: UserRepository) {
    private val logger = LoggerFactory.getLogger(javaClass)

    suspend fun ensureUser(jwt: Jwt): UserEntity {
        val sub = jwt.subject ?: error("Auth0 JWT is missing the sub claim")

        userRepository.findByAuth0Sub(sub)?.let { return it }

        val email = jwt.getClaimAsString("email")
        val name = jwt.getClaimAsString("name") ?: email ?: sub
        val newUser = UserEntity(
            id = sub,
            email = email,
            name = name,
            role = UserRole.USER,
            createdAt = Instant.now(),
            auth0Sub = sub,
        )
        logger.info("Provisioning new local user {} from Auth0 sub", newUser.id)
        return try {
            userRepository.save(newUser)
        } catch (e: Exception) {
            // Two concurrent first-time logins for the same sub can both pass the lookup above
            // and race on INSERT; the loser hits the PK or auth0_sub UNIQUE. If the row now
            // exists, reuse it instead of failing the request.
            userRepository.findByAuth0Sub(sub)?.also {
                logger.info("Reusing user {} after concurrent Auth0 provisioning race", it.id)
            } ?: throw e
        }
    }
}
