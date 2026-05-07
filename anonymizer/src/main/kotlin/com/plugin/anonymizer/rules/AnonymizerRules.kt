package com.plugin.anonymizer.rules

import com.plugin.core.config.properties.AnonymizerProperties
import org.springframework.stereotype.Component

/**
 * Compiled view of [AnonymizerProperties.RulesProperties]. Patterns are pre-compiled
 * once at boot so the hot-path transform doesn't recompile per chunk.
 */
@Component
class AnonymizerRules(props: AnonymizerProperties) {
    val dropInputEvents: Boolean = props.rules.dropInputEvents
    val stripUrlQueryStrings: Boolean = props.rules.stripUrlQueryStrings
    val textPatterns: List<CompiledPattern> = props.rules.textPatterns.map {
        CompiledPattern(it.name, Regex(it.pattern), it.replacement)
    }

    /** Apply every text pattern in declared order. */
    fun scrubText(input: String): String {
        if (input.isEmpty() || textPatterns.isEmpty()) return input
        var out = input
        for (p in textPatterns) {
            out = p.regex.replace(out, p.replacement)
        }
        return out
    }

    data class CompiledPattern(val name: String, val regex: Regex, val replacement: String)
}
