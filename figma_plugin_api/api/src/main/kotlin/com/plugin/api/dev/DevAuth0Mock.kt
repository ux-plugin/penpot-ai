package com.plugin.api.dev

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jose.jwk.JWKSet
import com.nimbusds.jose.jwk.KeyUse
import com.nimbusds.jose.jwk.RSAKey
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import com.plugin.api.config.properties.Auth0Properties
import org.springframework.context.annotation.Profile
import org.springframework.http.MediaType
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.RSAPrivateKey
import java.security.interfaces.RSAPublicKey
import java.util.Date

/**
 * DEV ONLY (`@Profile("dev")`): a tiny local stand-in for Auth0.
 *
 * It serves a JWKS and mints long-lived RS256 JWTs signed with a dev keypair, so the editor can
 * obtain a valid *user* token WITHOUT real Auth0 or a login flow. Crucially this adds NO
 * auth-bypass code: the real [Auth0Properties]-driven `auth0JwtDecoder` validates these tokens
 * exactly like prod (signature via JWKS + issuer + audience + expiry) and `Auth0UserProvisioner`
 * provisions the local user from the `sub` claim. In prod `auth0.issuer` points at real Auth0, so
 * a dev-signed token fails signature verification and is rejected — there is nothing to leave on.
 *
 * Requires `application-dev.yaml` to point auth0.* at this instance:
 *   auth0.issuer: http://localhost:8080/dev
 *   auth0.jwk-set-uri: http://localhost:8080/dev/.well-known/jwks.json
 *   auth0.audience: penpot-ai-dev
 * The `/dev` routes are already permitAll in SecurityConfig, so both endpoints are reachable.
 *
 * Usage: `GET /dev/token` → paste `access_token` into `VITE_AI_BACKEND_KEY`. It's valid for ~10y.
 */
@RestController
@Profile("dev")
@RequestMapping("/dev")
class DevAuth0Mock(private val auth0: Auth0Properties) {

    private val keyId = "penpot-dev-key"

    // Deterministic keypair (fixed seed) so minted tokens survive backend restarts — a token you
    // paste into the editor env keeps working across `gradle bootRun` cycles.
    private val keyPair = KeyPairGenerator.getInstance("RSA").apply {
        initialize(2048, SecureRandom.getInstance("SHA1PRNG").apply { setSeed(DEV_SEED) })
    }.generateKeyPair()

    private val rsaJwk: RSAKey = RSAKey.Builder(keyPair.public as RSAPublicKey)
        .privateKey(keyPair.private as RSAPrivateKey)
        .keyID(keyId)
        .keyUse(KeyUse.SIGNATURE)
        .algorithm(JWSAlgorithm.RS256)
        .build()

    /** Public JWKS the `auth0JwtDecoder` fetches to verify dev-minted tokens. */
    @GetMapping("/.well-known/jwks.json", produces = [MediaType.APPLICATION_JSON_VALUE])
    fun jwks(): String = JWKSet(rsaJwk.toPublicJWK()).toString()

    /** Mint a long-lived dev user token. Copy `access_token` into `VITE_AI_BACKEND_KEY`. */
    @GetMapping("/token", produces = [MediaType.APPLICATION_JSON_VALUE])
    fun token(
        @RequestParam(defaultValue = "auth0|dev") sub: String = "auth0|dev",
        @RequestParam(defaultValue = "dev@localhost") email: String = "dev@localhost",
        @RequestParam(defaultValue = "Dev User") name: String = "Dev User",
    ): Map<String, String> {
        val issuer = requireNotNull(auth0.issuer) { "auth0.issuer must be set for the dev token minter" }
        val now = Date()
        val exp = Date(now.time + TEN_YEARS_MS)
        val claims = JWTClaimsSet.Builder()
            .issuer(issuer)
            .subject(sub)
            .apply { auth0.audience?.let { audience(it) } }
            .issueTime(now)
            .expirationTime(exp)
            .claim("email", email)
            .claim("name", name)
            .build()
        val signed = SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID(keyId).build(), claims)
        signed.sign(RSASSASigner(keyPair.private as RSAPrivateKey))
        return mapOf("access_token" to signed.serialize(), "token_type" to "Bearer")
    }

    companion object {
        private val DEV_SEED = "penpot-ai-dev-jwt-seed-v1".toByteArray()
        private const val TEN_YEARS_MS = 10L * 365 * 24 * 60 * 60 * 1000
    }
}
