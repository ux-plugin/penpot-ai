package com.plugin.api.features.apikey

import com.plugin.api.config.properties.ApiKeyProperties
import org.springframework.stereotype.Component
import java.security.MessageDigest
import java.security.SecureRandom

@Component
class ApiKeyGenerator(private val props: ApiKeyProperties) {

    private val random = SecureRandom()

    fun generate(): GeneratedKey {
        val secret = randomBase62(props.secretLength)
        val plaintext = props.prefix + secret
        val hash = sha256Hex(plaintext)
        val displayPrefix = plaintext.take(props.prefix.length + 4)
        return GeneratedKey(plaintext = plaintext, hash = hash, displayPrefix = displayPrefix)
    }

    fun hash(plaintext: String): String = sha256Hex(plaintext)

    private fun randomBase62(len: Int): String {
        val out = StringBuilder(len)
        repeat(len) { out.append(BASE62[random.nextInt(BASE62.length)]) }
        return out.toString()
    }

    private fun sha256Hex(input: String): String {
        val md = MessageDigest.getInstance("SHA-256")
        val bytes = md.digest(input.toByteArray(Charsets.UTF_8))
        val hex = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            hex.append(HEX[(b.toInt() ushr 4) and 0x0f])
            hex.append(HEX[b.toInt() and 0x0f])
        }
        return hex.toString()
    }

    data class GeneratedKey(val plaintext: String, val hash: String, val displayPrefix: String)

    companion object {
        private const val BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
        private const val HEX = "0123456789abcdef"
    }
}
