package com.plugin.processor.processing

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Test

/**
 * Smoke check on the v0 no-op. Pure unit, no Spring, no containers.
 */
class NoopChunkProcessorTest {

    @Test
    fun `noop process returns without throwing`(): Unit = runBlocking {
        NoopChunkProcessor().process("org-A", "sess-1", 0L, 5L)
    }
}
