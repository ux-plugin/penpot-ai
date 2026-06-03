package com.plugin.core.pipeline

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.apache.kafka.common.serialization.Deserializer
import org.apache.kafka.common.serialization.Serde
import org.apache.kafka.common.serialization.Serdes
import org.apache.kafka.common.serialization.Serializer

/**
 * Kafka Streams JSON serdes for the pipeline records. JSON-over-Kafka is the v1
 * serialization choice — swap to Avro + schema registry if/when contracts need
 * stronger enforcement (see FOLLOWUP.md).
 *
 * One shared Jackson [ObjectMapper] with the Kotlin + JavaTime modules. Java time
 * types (Instant) serialize as ISO-8601 strings — readable in kafka-ui and stable
 * across JVM versions.
 */
object JsonSerdes {
    val mapper: ObjectMapper = jacksonObjectMapper().apply {
        registerModule(JavaTimeModule())
        configure(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false)
    }

    inline fun <reified T : Any> of(): Serde<T> = jsonSerde(T::class.java, mapper)

    val stringSerde: Serde<String> = Serdes.String()
}

fun <T : Any> jsonSerde(clazz: Class<T>, mapper: ObjectMapper): Serde<T> {
    val ser = Serializer<T> { _, value ->
        if (value == null) null else mapper.writeValueAsBytes(value)
    }
    val deser = Deserializer<T> { _, bytes ->
        if (bytes == null || bytes.isEmpty()) null else mapper.readValue(bytes, clazz)
    }
    return Serdes.serdeFrom(ser, deser)
}
