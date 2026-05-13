# Kafka migration — follow-up work

Things deliberately cut from the Spring Cloud Stream + Kafka Streams rewrite so the
first push could land cleanly. Each item below is independent and can be picked up
in any order. Items grouped by area; rough effort tagged per item (S = ½ day, M =
1–2 days, L = 3+ days).

---

## 1. Pipeline functionality regressed vs the old Redis design

### 1.1 Immediate session close on client `CLOSE_HINT` `[M]`
The HTTP endpoint `/ingest/sessions/{id}/close` still works and publishes a
`RawRecord(type=CLOSE_HINT, ...)` to `chunks.raw`. The sanitizer topology
**ignores it for window closure** — the only closer is the
`SessionWindows.ofInactivityGapWithNoGrace(10 min)` inactivity gap.

Effect: a session that the client explicitly closes still waits 10 minutes for the
window to expire before `sessions.closed` fires. That's a meaningful latency
regression vs the old design.

Fix sketch: instead of (or in addition to) the windowed aggregate, run a
`Transformer` over `chunks.raw` with a session-state store. On `CHUNK`, update the
running aggregate. On `CLOSE_HINT`, emit `SessionClosedRecord` immediately and
clear the store. The window-based path can stay as the safety net for sessions
where the client never sends the hint. Search for `CLOSE_HINT` in
`sanitizer/topology/SanitizerTopology.kt` for the insertion point.

### 1.2 Per-chunk classification (DROP / QUARANTINE / SANITIZED) `[M]`
v1 forwards every CHUNK as `Classification.SANITIZED`. The legacy
`ChunkClassifier` ran against full session state at close time, so it doesn't
port directly.

To restore: decide whether classification is **per chunk** (truly streaming —
needs new heuristics that work on a single chunk) or **per session at close**
(simpler — classifier runs in the processor right before metadata write,
quarantine path emits to a new `sessions.quarantined` topic that triggers S3
copy by a separate worker / lifecycle job).

I'd lean towards the second path. Per-chunk classification is interesting but
the legacy logic was inherently per-session ("does the session have a
FullSnapshot anywhere?"), and porting it intact is straightforward.

### 1.3 Quarantine flow `[M]`
With 1.2 above. Today nothing copies `raw/ → quarantine/` and nothing emits
`SESSION_QUARANTINED`. The MinIO lifecycle rule on `quarantine/` still exists in
`docker-compose.yaml minio-init` but no producer reaches it.

### 1.4 Raw eviction (the old `RAW_PROCESSED` flow) `[S]`
Anonymizer used to publish `RAW_PROCESSED` so the sanitizer would delete raw
chunks after their anon copies were written. Gone in v1. We rely entirely on
MinIO ILM (`raw/ expire-days 1` in `minio-init`) to age out raw chunks.

That's acceptable for now but it means raw chunks are retained for up to ~24h
even after they've been anonymized. To restore the prompt eviction: have the
anonymizer topology output a second stream (`chunks.processed`) keyed by the
anon `seq`, and run a sweeper worker (or another small KStream consumer) that
deletes the matching raw object.

### 1.5 Cross-chunk PII context in the anonymizer `[M]`
`RrwebTransformer` is stateless — every chunk is scrubbed in isolation. That
misses two real cases:

- A PII string that straddles a chunk boundary (rare but possible: an `Input`
  event mid-typed when the chunk boundary lands).
- Consistent replacement of the same value across chunks (the same email
  becomes the same token `[EMAIL]` everywhere — currently true because the
  rule emits a fixed token, but if rules are upgraded to per-session
  pseudonyms this becomes load-bearing).

Fix: add a state store keyed by `sessionId` in the anonymizer topology:

```kotlin
Materialized.as<String, AnonContext, _>("anonymizer-ctx-store")
```

…and switch from `.mapValues { ... }` to `.transformValues({ AnonTransformer(ctx) }, "anonymizer-ctx-store")`.
The transformer reads/writes the per-session context on each chunk.

### 1.6 Incremental session_metadata aggregation `[M]`
v1 processor reads all anonymized chunks for the session in one pass on
`SessionClosedRecord`. That re-introduces a "wait until close, then bulk
process" stage — the exact thing per-chunk pipelining was supposed to avoid.

True streaming design: KTable over `chunks.anonymized` keyed by `sessionId`
maintains the running `eventCount`, `firstTs`, `lastTs`, `pageTransitions`
incrementally per chunk. Join (`KStream-KTable` join on `sessionId`) with
`sessions.closed` to flush the final row.

The S3 read per chunk still has to happen somewhere — moving it from
"all-at-once at close" to "per-chunk in `chunks.anonymized`" trades latency
for distribution.

---

## 2. Infrastructure / production-readiness gaps

### 2.1 Pre-create topics with explicit partition count + retention `[S]`
Right now Redpanda auto-creates topics on first publish with **1 partition**.
For dev that's fine; for any real workload it caps parallelism to one
consumer thread per worker.

Add a `KafkaAdmin` bean to `:core` (or a `rpk topic create` step in
`docker-compose minio-init`-style bootstrap container) that declares:

```
chunks.raw           partitions=8  retention.ms=86400000     # 1d
chunks.sanitized     partitions=8  retention.ms=86400000
chunks.anonymized    partitions=8  retention.ms=604800000    # 7d (mirrors anon/ S3 90d cap roughly)
sessions.closed      partitions=8  retention.ms=2592000000   # 30d
*.dlq                partitions=8  retention.ms=2592000000
```

Per topology, also set `num.stream.threads` to match partitions for parallelism.

### 2.2 Topic retention `[S]`
Same as 2.1 — without explicit retention, Redpanda defaults to 7 days. Probably
fine but should be set deliberately.

### 2.3 Schema registry + Avro `[L]`
v1 uses JSON serdes with type-info headers (`spring.json.add.type.headers`).
Works, but contracts are enforced only by the Jackson `trustedPackages` list and
classpath presence. Switching to Avro + Confluent Schema Registry would:
- Catch breaking schema changes at producer build time
- Reduce on-wire size (binary vs JSON)
- Open up `KStream.join` / `groupBy` with Confluent's `SpecificAvroSerde`

The dev compose already exposes the Redpanda schema registry on port 18081 —
unused right now. Hook it up when contracts start changing across teams.

### 2.4 Replace inline R2DBC sink with Kafka Connect JDBC Sink `[M]`
The processor topology currently does its own R2DBC write to
`session_metadata`. Works, but means the processor needs DB creds + R2DBC on
the classpath, and a slow DB blocks the stream thread.

Kafka Connect with the [JDBC Sink connector](https://docs.confluent.io/kafka-connectors/jdbc/current/sink-connector/index.html)
moves the DB write out of the processor entirely. The processor just emits
to a `session.metadata` topic; Connect drains it into Postgres asynchronously
with built-in retry, DLQ, and exactly-once-on-the-sink-side.

Trade: one more piece of infra (Kafka Connect worker). Worth it only if the
DB becomes a bottleneck.

### 2.5 Deserialization-error DLQ `[S]`
Default Kafka Streams behavior on a JSON deserialization failure is to halt
the stream thread. With auto-created topics + JSON serdes, a stray non-JSON
message (e.g. someone using `rpk topic produce` to debug) is enough to take
down a worker.

Add a `DeserializationExceptionHandler` that routes bad messages to
`<topic>.dlq` and continues. Configure via:

```yaml
spring.cloud.stream.kafka.streams.binder.configuration:
  default.deserialization.exception.handler: org.springframework.kafka.streams.RecoveringDeserializationExceptionHandler
```

…paired with a `KafkaSendingMessageRecoverer` bean wired to a `KafkaTemplate`
that targets `<topic>.dlq`.

### 2.6 Kafka Streams health + readiness `[S]`
The actuator block was simplified to just `health,info,metrics` and no group
membership for `liveness`/`readiness`. SCS Kafka Streams binder publishes a
`KafkaStreamsBinderHealthIndicator` that reports REBALANCING / NOT_RUNNING /
ERROR — expose it in the liveness group:

```yaml
management.endpoint.health.group:
  liveness:
    include: livenessState, binders
  readiness:
    include: readinessState, binders
```

Then point k8s probes at `/actuator/health/liveness` / `/readiness`.

### 2.7 Metrics export `[S]`
Kafka Streams emits a rich set of JMX metrics (process latency, commit rate,
state-store cache hit ratio, rebalance count). They're collected by Micrometer
when `spring-boot-starter-actuator` is on the path (it is) but only exposed
via `/actuator/metrics`. Add a Prometheus registry binding to scrape from a
Grafana dashboard.

---

## 3. Tests deleted in this pass — restore equivalents

These tests targeted code paths that were rewritten or removed. The pure-logic
tests (`RrwebTransformerTest`, `AnonymizerRulesTest`) survived; the integration
and consumer-level tests didn't.

| Deleted | What it covered | Restore as |
|---|---|---|
| `core/.../BackpressureGuardTest.kt` | XLEN-based backpressure | n/a — feature dropped |
| `core/.../IngestEventTest.kt` | Redis-fields round-trip | replace with `RawRecord` JSON round-trip test |
| `sanitizer/.../IngestRawConsumerIT.kt` | XREADGROUP consume + handler dispatch | `TopologyTestDriver` test against `SanitizerTopology` |
| `sanitizer/.../SessionLifecycleServiceIT.kt` | classify / publish / evict on close | `TopologyTestDriver` test asserting `sessions.closed` after inactivity |
| `sanitizer/.../IdleScanSchedulerIT.kt` | @Scheduled idle scan | covered implicitly by window-close test |
| `sanitizer/.../SessionStateRepositoryIT.kt` | Redis hash state | covered by state-store test (use `KeyValueStore` API) |
| `sanitizer/.../RawProcessedConsumerIT.kt` | eviction trigger | n/a — feature dropped (see 1.4) |
| `anonymizer/.../SanitizedConsumerIT.kt` | consume + transform + publish | `TopologyTestDriver` against `AnonymizerTopology` |
| `anonymizer/.../SessionAnonymizationServiceIT.kt` | full per-session anon + S3 ops | per-chunk variant via `TopologyTestDriver` + mock `ObjectStore` |
| `processor/.../AnonConsumerIT.kt` | end-to-end consume → metadata write | `TopologyTestDriver` + Testcontainers Postgres |
| `processor/.../NoopChunkProcessorTest.kt` | no-op pass-through | n/a — `NoopChunkProcessor` removed |
| `api/.../IngestionServiceIT.kt` | service + Redis stream publish | rewrite against `StreamBridge` with embedded Kafka |

The Kafka Streams primitives have a dedicated test framework — `TopologyTestDriver`
+ `TestInputTopic` / `TestOutputTopic`. No broker needed; ~milliseconds per test.
Spring Cloud Stream Kafka Streams binder exposes the underlying `Topology` via
`StreamsBuilderFactoryBean` if you need to grab it from a `@SpringBootTest`.

For full end-to-end smoke, `spring-kafka-test`'s `@EmbeddedKafka` works with the
binder.

---

## 4. Property + config cleanup

### 4.1 `AnonymizerProperties` has dead fields `[S]`
`inputStream`, `anonStream`, `rawProcessedStream` are still in
`core/.../AnonymizerProperties.kt` and bound from
`anonymizer/application.yaml`. None of them are read by the topology — output
topics are declared via `spring.cloud.stream.bindings.anonymize-out-0.destination`.
Drop the fields and the corresponding YAML keys.

### 4.2 `IngestProperties.s3KeyPrefix` `[S]`
Set to `""` in every environment. Either remove the field or document where
it would be used (multi-tenant S3 bucket prefix?).

### 4.3 Redis still autoconfigured in sanitizer / anonymizer `[S]`
`spring.data.redis.{host,port}` is still in their `application.yaml` even
though neither worker uses Redis anymore. Spring Boot's
`RedisReactiveAutoConfiguration` will still attempt a connection on startup
(harmless if Redis is up but pointless). Either:

- Drop `data.redis.*` from both YAMLs and add
  `exclude = [RedisReactiveAutoConfiguration::class, RedisAutoConfiguration::class]`
  to `@SpringBootApplication` on each worker, OR
- Drop `spring-boot-starter-data-redis-reactive` from `:core`'s deps once no
  consumer needs it. The `:api` still does (api-key cache, auth tokens) —
  consider moving that dep to `:api` instead of `:core` to avoid the leak.

### 4.4 Dev-profile `KAFKA_BOOTSTRAP_SERVERS` `[S]`
The new bindings reference `${KAFKA_BOOTSTRAP_SERVERS:localhost:9092}`. For
local non-Docker runs (the `application-dev.yaml` flow), the default is fine
as long as `kafka` from the compose file is reachable on `localhost:19092` —
the **external** advertised address. The current default uses `9092` which is
the **internal** address.

If you run any worker locally outside the compose network, change the dev
fallback to `localhost:19092`:

```yaml
spring.cloud.stream.kafka.streams.binder.brokers: ${KAFKA_BOOTSTRAP_SERVERS:localhost:19092}
```

### 4.5 Drop legacy worker config from `api/application.yaml` `[S]`
Already done in this pass. Confirm `worker.*` is gone end-to-end (search the
yaml + envvars in `docker-compose.yaml`).

---

## 5. Operational items before any production rollout

1. **Pre-create topics** (2.1) — without this, partitions=1 → no parallelism.
2. **Set `processing.guarantee=exactly_once_v2`** on the workers once you've
   validated the topology works at-least-once. Will require Kafka transactions
   enabled (Redpanda supports them).
3. **Tune `num.stream.threads`** per worker to match partition count.
4. **Set `state.dir`** to a persistent volume in production. Currently uses
   the container's `/tmp` (per Kafka Streams default), which means state
   stores rebuild from changelog on every pod restart — fine for correctness,
   slow for recovery.
5. **DLQ wiring** (2.5) — without it, one bad message halts the worker.
6. **Health + readiness probes** (2.6) — current probes will report "UP" even
   if Kafka Streams is in `ERROR` state.

---

## 6. Known-deferred fragile bits

### 6.1 `runBlocking` inside `mapValues`
The anonymizer and processor topologies bridge Kafka Streams' synchronous
operator contract to suspend `ObjectStore` calls via `runBlocking`. Acceptable
because each stream thread processes records serially, but it ties up the
stream thread for the duration of the S3 round-trip. If S3 latency goes up,
throughput drops linearly.

Options when this becomes a problem:
- Move S3 reads out of the topology entirely (e.g. into Kafka Connect or a
  separate side-effect worker that consumes `chunks.sanitized` and produces
  `chunks.anonymized`). Pure CPU stays in the topology.
- Use the async-by-default `ProcessorAPI` instead of the DSL — more code,
  more control.

### 6.2 `Suppressed.untilWindowCloses(BufferConfig.unbounded())` in the sanitizer
Unbounded buffer means an unlucky pile-up of half-open sessions could
balloon. Acceptable in dev; cap with `BufferConfig.maxBytes(...)` or
`maxRecords(...)` and a `shutDownWhenFull()` / `emitEarlyWhenFull()` policy
before prod.

### 6.3 SCS Kafka binder vs Kafka Streams binder coexistence
The API uses the plain Kafka binder (producer-only). The three workers use
the Kafka Streams binder. Both binders are on the classpath via `:core`.
Spring Cloud Stream picks the right one per app based on which beans
(`Function<KStream...>` vs `StreamBridge`) are present. Verified working in
the boot logs of all four services — but if you ever hit ambiguous-binder
errors, the workaround is explicit `spring.cloud.stream.defaultBinder`.

### 6.4 Auto-topic-creation
Redpanda dev-mode auto-creates topics. Real Kafka clusters disable that by
default. Make sure 2.1 lands before you point this at a prod cluster.

---

## 7. Quick reference — what changed in this push

**New files**
- `core/src/main/kotlin/com/plugin/core/pipeline/Topics.kt`
- `core/src/main/kotlin/com/plugin/core/pipeline/RawRecord.kt`
- `core/src/main/kotlin/com/plugin/core/pipeline/SanitizedRecord.kt`
- `core/src/main/kotlin/com/plugin/core/pipeline/AnonymizedRecord.kt`
- `core/src/main/kotlin/com/plugin/core/pipeline/SessionClosedRecord.kt`
- `core/src/main/kotlin/com/plugin/core/pipeline/JsonSerdes.kt`
- `sanitizer/.../topology/SanitizerTopology.kt`
- `anonymizer/.../topology/AnonymizerTopology.kt`
- `processor/.../topology/ProcessorTopology.kt`

**Deleted (replaced by topologies)**
- `core/.../ingest/{IngestEvent,IngestStreamPublisher,BackpressureGuard,IngestConfig}.kt`
- `core/.../worker/{stream/StreamConsumerSupport,WorkerHeartbeat,WorkerHeartbeatHealthIndicator,WorkerConfig}.kt`
- `core/.../config/properties/{WorkerProperties,ProcessorProperties}.kt`
- `sanitizer/.../{consumers/*,lifecycle/*,classify/*,scheduler/*,state/*,config/*}.kt`
- `anonymizer/.../{consumers/*,lifecycle/*,config/*}.kt`
- `processor/.../{consumers/*,processing/*,config/ProcessorConfig}.kt`
- All corresponding `*IT.kt` and `*Test.kt` files

**Rewritten**
- `api/.../IngestionService.kt` — XADD → `StreamBridge.send`
- `api/.../IngestionController.kt` — drop `IngestBackpressureException` catch
- All four `application.yaml` — add `spring.cloud.stream.*`, drop `worker.*`
- `core/build.gradle.kts` — SCS deps + transitive BOM
- `docker-compose.yaml` — add Redpanda + Redpanda Console services
