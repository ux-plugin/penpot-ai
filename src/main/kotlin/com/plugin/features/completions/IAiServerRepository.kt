package com.plugin.features.completions

import io.smallrye.mutiny.Uni

interface IAiServerRepository {
    fun createCompletion(prompt: String): Uni<FrameNode>
}