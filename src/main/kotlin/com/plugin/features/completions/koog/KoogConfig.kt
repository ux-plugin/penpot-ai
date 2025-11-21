package com.plugin.features.completions.koog

import io.quarkus.runtime.annotations.StaticInitSafe
import io.smallrye.config.ConfigMapping
import io.smallrye.config.WithDefault
import io.smallrye.config.WithName

/** Configuration for Koog AI agent framework */
@StaticInitSafe
@ConfigMapping(prefix = "koog")
interface KoogConfig {
    /** Fireworks AI API key for Whisper transcription */
    @WithName("fireworks.api-key") fun fireworksApiKey(): String?

    /** OpenAI API key for LLM responses (fallback if not using Fireworks for LLM) */
    @WithName("openai.api-key") fun openaiApiKey(): String?

    /** LLM model to use for agent responses */
    @WithName("llm.model") @WithDefault("gpt-4o-mini") fun llmModel(): String

    /** Temperature for LLM responses */
    @WithName("llm.temperature") @WithDefault("0.7") fun llmTemperature(): Double

    /** Max iterations for agent */
    @WithName("agent.max-iterations") @WithDefault("10") fun maxIterations(): Int
}
