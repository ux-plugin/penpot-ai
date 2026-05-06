package com.plugin.api.features.apikey

import com.plugin.api.config.properties.ApiKeyProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test

class ApiKeyGeneratorTest {

    @Test
    fun `generated keys carry the configured prefix and the expected secret length`() {
        val props = ApiKeyProperties(prefix = "pk_test_", secretLength = 32)
        val gen = ApiKeyGenerator(props)
        val key = gen.generate()
        assertThat(key.plaintext).startsWith("pk_test_")
        assertThat(key.plaintext.removePrefix("pk_test_")).hasSize(32)
        assertThat(key.displayPrefix).isEqualTo(key.plaintext.take("pk_test_".length + 4))
    }

    @Test
    fun `generated keys are unique across many invocations`() {
        val gen = ApiKeyGenerator(ApiKeyProperties())
        val produced = (1..1_000).map { gen.generate().plaintext }.toSet()
        assertThat(produced).hasSize(1_000)
    }

    @Test
    fun `hash is deterministic for the same plaintext and varies between distinct plaintexts`() {
        val gen = ApiKeyGenerator(ApiKeyProperties())
        val h1 = gen.hash("pk_test_alpha")
        val h2 = gen.hash("pk_test_alpha")
        val h3 = gen.hash("pk_test_beta")
        assertThat(h1).isEqualTo(h2)
        assertThat(h1).isNotEqualTo(h3)
        assertThat(h1).hasSize(64)
        assertThat(h1).matches("^[0-9a-f]{64}$")
    }

    @Test
    fun `generate hash matches direct hash of plaintext`() {
        val gen = ApiKeyGenerator(ApiKeyProperties())
        val key = gen.generate()
        assertThat(gen.hash(key.plaintext)).isEqualTo(key.hash)
    }
}
