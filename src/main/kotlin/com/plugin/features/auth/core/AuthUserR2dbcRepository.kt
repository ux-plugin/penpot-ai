package com.plugin.features.auth.core

import org.springframework.data.r2dbc.repository.Query
import org.springframework.data.r2dbc.repository.R2dbcRepository
import org.springframework.stereotype.Repository
import reactor.core.publisher.Mono

@Repository
interface AuthUserR2dbcRepository : R2dbcRepository<AuthUserEntity, String> {
    @Query("SELECT * FROM users WHERE id = :id AND refresh_token = :refreshToken")
    fun findByIdAndRefreshToken(id: String, refreshToken: String): Mono<AuthUserEntity>
}

@Repository
interface SocialLoginR2dbcRepository : R2dbcRepository<SocialLoginEntity, String> {
    @Query("SELECT * FROM social_logins WHERE provider_user_id = :providerUserId AND provider = :provider")
    fun findByProviderUserIdAndProvider(providerUserId: String, provider: String): Mono<SocialLoginEntity>
    
    @Query("SELECT * FROM social_logins WHERE user_id = :userId AND id = :id")
    fun findByUserIdAndId(userId: String, id: String): Mono<SocialLoginEntity>
    
    @Query("DELETE FROM social_logins WHERE id = :id")
    fun deleteByIdCustom(id: String): Mono<Void>
}
