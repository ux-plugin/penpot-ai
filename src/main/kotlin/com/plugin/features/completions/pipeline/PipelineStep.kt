package com.plugin.features.completions.pipeline

/**
 * Base interface for pipeline steps
 *
 * Pipeline steps are modular components that process data in a sequential manner. Each step receives a PipelineContext
 * and can modify it or add results.
 *
 * @param I Input type for the pipeline step
 * @param O Output type for the pipeline step
 */
interface PipelineStep<I, O> {
    /**
     * Execute this pipeline step
     *
     * @param input The input data for this step
     * @param context The pipeline context that carries data between steps
     * @return The output result of this step
     */
    suspend fun execute(input: I, context: PipelineContext): O

    /** Get the name of this pipeline step (for logging/debugging) */
    fun getName(): String
}

/**
 * Pipeline context that carries data between pipeline steps
 *
 * This allows steps to share data and results without tight coupling
 */
class PipelineContext {
    private val data = mutableMapOf<String, Any?>()

    fun <T> put(key: String, value: T) {
        data[key] = value
    }

    @Suppress("UNCHECKED_CAST")
    fun <T> get(key: String): T? {
        return data[key] as? T
    }

    fun contains(key: String): Boolean {
        return data.containsKey(key)
    }

    fun remove(key: String) {
        data.remove(key)
    }
}

/**
 * A pipeline that executes multiple steps in sequence
 *
 * @param I Input type for the pipeline
 * @param O Output type for the pipeline
 */
class Pipeline<I, O>(private val steps: List<PipelineStep<*, *>>, private val name: String = "Pipeline") {
    /**
     * Execute the pipeline with the given input
     *
     * @param input The initial input to the pipeline
     * @return The final output from the pipeline
     */
    @Suppress("UNCHECKED_CAST")
    suspend fun execute(input: I): O {
        val context = PipelineContext()
        var currentInput: Any? = input

        for (step in steps) {
            val typedStep = step as PipelineStep<Any?, Any?>
            currentInput = typedStep.execute(currentInput, context)
        }

        return currentInput as O
    }

    fun getName(): String = name
}

/** Builder for creating pipelines */
class PipelineBuilder<I, O> {
    private val steps = mutableListOf<PipelineStep<*, *>>()
    private var name: String = "Pipeline"

    fun withName(name: String): PipelineBuilder<I, O> {
        this.name = name
        return this
    }

    fun <T> addStep(step: PipelineStep<*, T>): PipelineBuilder<I, T> {
        steps.add(step)
        @Suppress("UNCHECKED_CAST") return this as PipelineBuilder<I, T>
    }

    fun build(): Pipeline<I, O> {
        return Pipeline(steps, name)
    }
}

/** Extension function to create a pipeline builder */
fun <I> pipeline(): PipelineBuilder<I, I> {
    return PipelineBuilder()
}
