package com.plugin.processor.config

import com.plugin.core.config.properties.ProcessorProperties
import com.plugin.processor.processing.ChunkProcessor
import com.plugin.processor.processing.NoopChunkProcessor
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

/**
 * Wires the active [ChunkProcessor] based on `processor.mode`. v0 only knows NOOP;
 * AI mode is reserved for the next ticket and currently falls through to NOOP with
 * a log warning.
 */
@Configuration
@EnableConfigurationProperties(ProcessorProperties::class)
class ProcessorConfig {

    @Bean
    fun chunkProcessor(props: ProcessorProperties): ChunkProcessor = when (props.mode) {
        ProcessorProperties.Mode.NOOP -> NoopChunkProcessor()
        ProcessorProperties.Mode.AI -> NoopChunkProcessor()  // placeholder until AI ticket lands
    }
}
