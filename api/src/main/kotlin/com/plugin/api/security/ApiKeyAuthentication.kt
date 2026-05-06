package com.plugin.api.security

import org.springframework.security.authentication.AbstractAuthenticationToken
import org.springframework.security.core.GrantedAuthority
import org.springframework.security.core.authority.SimpleGrantedAuthority

/**
 * Authentication produced by the API key filter chain. Carries the resolved
 * organization and creating-user IDs so downstream handlers don't need a DB hit.
 */
class ApiKeyAuthentication(
    val apiKeyId: String,
    val orgId: String,
    val userId: String,
    val keyPrefix: String,
    authorities: Collection<GrantedAuthority> = listOf(SimpleGrantedAuthority("ROLE_API_KEY")),
) : AbstractAuthenticationToken(authorities) {

    init {
        isAuthenticated = true
    }

    override fun getCredentials(): Any = ""

    override fun getPrincipal(): Any = userId

    override fun getName(): String = userId
}
