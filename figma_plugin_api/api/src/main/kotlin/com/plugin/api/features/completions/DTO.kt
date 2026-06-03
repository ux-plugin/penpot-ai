package com.plugin.api.features.completions

/**
 * Completions: Action details
 */
data class CompletionAction(val action: String, val target: String, val params: String)

/**
 * Completions: Response (Server → Client)
 * AI-generated component action streamed via RSocket request-channel
 */
data class CompletionStreamEvent(val action: CompletionAction? = null, val reasoning: String? = null, val text: String? = null)
