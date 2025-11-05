package com.plugin.features.completions.pipeline

import io.quarkus.test.junit.QuarkusTest
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

/**
 * Unit tests for the Pipeline architecture
 *
 * Tests the modular pipeline framework that allows composing processing steps
 */
@QuarkusTest
class PipelineStepTest {

    @Test
    fun `test pipeline context stores and retrieves data`() {
        val context = PipelineContext()

        context.put("key1", "value1")
        context.put("key2", 42)
        context.put("key3", listOf(1, 2, 3))

        assertEquals("value1", context.get<String>("key1"))
        assertEquals(42, context.get<Int>("key2"))
        assertEquals(listOf(1, 2, 3), context.get<List<Int>>("key3"))
        assertNull(context.get<String>("nonexistent"))
    }

    @Test
    fun `test pipeline context contains and remove`() {
        val context = PipelineContext()
        context.put("testKey", "testValue")

        assertTrue(context.contains("testKey"))
        assertFalse(context.contains("nonexistent"))

        context.remove("testKey")
        assertFalse(context.contains("testKey"))
    }

    @Test
    fun `test simple pipeline with single step`() = runBlocking {
        val step =
            object : PipelineStep<String, String> {
                override suspend fun execute(input: String, context: PipelineContext): String {
                    return input.uppercase()
                }

                override fun getName(): String = "UppercaseStep"
            }

        val pipeline = pipeline<String>().withName("TestPipeline").addStep(step).build()

        val result = pipeline.execute("hello")
        assertEquals("HELLO", result)
    }

    @Test
    fun `test pipeline with multiple steps`() = runBlocking {
        val step1 =
            object : PipelineStep<String, String> {
                override suspend fun execute(input: String, context: PipelineContext): String {
                    context.put("step1", "executed")
                    return input.uppercase()
                }

                override fun getName(): String = "UppercaseStep"
            }

        val step2 =
            object : PipelineStep<String, Int> {
                override suspend fun execute(input: String, context: PipelineContext): Int {
                    context.put("step2", "executed")
                    return input.length
                }

                override fun getName(): String = "LengthStep"
            }

        val pipeline = pipeline<String>().withName("MultiStepPipeline").addStep(step1).addStep(step2).build()

        val result = pipeline.execute("hello")
        assertEquals(5, result)
    }

    @Test
    fun `test pipeline context shared between steps`() = runBlocking {
        val step1 =
            object : PipelineStep<String, String> {
                override suspend fun execute(input: String, context: PipelineContext): String {
                    context.put("originalInput", input)
                    return input.uppercase()
                }

                override fun getName(): String = "Step1"
            }

        val step2 =
            object : PipelineStep<String, String> {
                override suspend fun execute(input: String, context: PipelineContext): String {
                    val original = context.get<String>("originalInput")
                    return "$input-$original"
                }

                override fun getName(): String = "Step2"
            }

        val pipeline = pipeline<String>().addStep(step1).addStep(step2).build()

        val result = pipeline.execute("test")
        assertEquals("TEST-test", result)
    }

    @Test
    fun `test pipeline builder creates correct pipeline name`() = runBlocking {
        val step =
            object : PipelineStep<String, String> {
                override suspend fun execute(input: String, context: PipelineContext): String = input

                override fun getName(): String = "NoOpStep"
            }

        val pipeline = pipeline<String>().withName("CustomName").addStep(step).build()

        assertEquals("CustomName", pipeline.getName())
    }

    @Test
    fun `test pipeline with default name`() = runBlocking {
        val step =
            object : PipelineStep<String, String> {
                override suspend fun execute(input: String, context: PipelineContext): String = input

                override fun getName(): String = "NoOpStep"
            }

        val pipeline = pipeline<String>().addStep(step).build()

        assertEquals("Pipeline", pipeline.getName())
    }
}
