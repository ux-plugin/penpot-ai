package com.plugin.features.completions

interface IAiServerService {
    suspend fun createCompletion(prompt: String): FrameNode
}
