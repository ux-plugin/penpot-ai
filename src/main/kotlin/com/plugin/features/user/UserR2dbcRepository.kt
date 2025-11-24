package com.plugin.features.user

import org.springframework.data.r2dbc.repository.Query
import org.springframework.data.r2dbc.repository.R2dbcRepository
import org.springframework.stereotype.Repository
import reactor.core.publisher.Mono

@Repository
interface UserR2dbcRepository : R2dbcRepository<UserEntity, String> {
    fun findByUsername(username: String): Mono<UserEntity>
}

@Repository
interface SocialLoginsR2dbcRepository : R2dbcRepository<SocialLogins, String> {
    @Query("SELECT * FROM social_logins WHERE user_id = :userId")
    fun findByUserId(userId: String): Mono<List<SocialLogins>>
}
