package com.plugin.anonymizer.lifecycle

import com.plugin.core.ingest.IngestEvent
import com.plugin.core.ingest.IngestStreamPublisher

/**
 * Marker types so DI can inject the right publisher per output stream.
 *
 *  - [AnonStreamPublisher] → `ingest.anon` (consumed by the processor)
 *  - [RawProcessedStreamPublisher] → `ingest.raw.processed` (consumed by the sanitizer
 *    to evict raw chunks once anon copy is durable)
 */
class AnonStreamPublisher(delegate: IngestStreamPublisher) : DelegatingPublisher(delegate)

class RawProcessedStreamPublisher(delegate: IngestStreamPublisher) : DelegatingPublisher(delegate)

abstract class DelegatingPublisher(private val delegate: IngestStreamPublisher) {
    suspend fun publish(event: IngestEvent) {
        delegate.publish(event)
    }
}
