package com.plugin.config

import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.RSASSASigner
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import org.springframework.stereotype.Service
import java.security.interfaces.RSAPrivateKey
import java.time.Instant
import java.util.*

@Service
class JwtService(private val privateKey: RSAPrivateKey) {
    fun createToken(subject: String, role: String, expirationSeconds: Long): String {
        val now = Instant.now()
        val expiration = now.plusSeconds(expirationSeconds)

        val claimsSet =
            JWTClaimsSet
                .Builder()
                .issuer("ux-plugin")
                .subject(subject)
                .claim("role", role)
                .issueTime(Date.from(now))
                .expirationTime(Date.from(expiration))
                .build()

        val signer = RSASSASigner(privateKey)
        val signedJWT = SignedJWT(JWSHeader.Builder(JWSAlgorithm.RS256).keyID("ux-plugin").build(), claimsSet)

        signedJWT.sign(signer)
        return signedJWT.serialize()
    }
}
