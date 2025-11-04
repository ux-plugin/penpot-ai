package com.plugin.features.completions

import java.time.Instant

data class PromptRequest(val prompt: String)

data class ComponentCompletionResponse(
    var id: String,
    var prompt: String,
    var aiCompletion: FrameNode,
    var createdAt: Instant,
)

data class CompletionsLoadFailedResponse(val message: String = "Failed to load completions")

data class CompletionNotFoundResponse(val message: String = "Completion not found")
