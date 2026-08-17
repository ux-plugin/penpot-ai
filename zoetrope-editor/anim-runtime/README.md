# anim-runtime

The portable animation runtime core — a Rust port of the TypeScript `anim/` IR
(`src/lib/renderer/anim/`). This is the piece that ships to every platform
(wasm32 for web + the editor preview; native via C FFI for iOS/Android/Flutter/
desktop). Skia renders everywhere; this crate only computes property values.

It mirrors, module-for-module:

| Rust (`src/lib.rs`) | TypeScript |
|---|---|
| IR structs + serde | `anim/types.ts` |
| `sample_curve` / `cubic_bezier` / `sample_binding` | `anim/sample.ts` |
| `normalize_time` / `evaluate_timeline` | `anim/evaluate.ts` |
| `serialize_anim_doc` / `deserialize_anim_doc` + `ANIM_FORMAT_VERSION` | `anim/serialize.ts` |

The serde mapping matches the JSON **format contract** exactly (untagged `Interp`,
`tag = "kind"` for `Domain`/`ObjectRef`, `loop` field). serde's typed deserialize
IS the structural validation; a version gate rejects incompatible docs.

## Test

```sh
cargo test --offline
```

The tests mirror the TS conformance vectors. `deserializes_the_ts_contract`
parses the exact bytes `serialize.ts` emits and evaluates them to the same values
— the cross-language parity guarantee. Keep the two suites in lockstep: when a TS
vector changes, change the Rust one.

## Status & next steps

- **R1 — core (done, verified here):** IR + sampler + evaluator + format, `cargo test` green.
- **R2 — wasm boundary (needs toolchain):** a `#[cfg(feature = "wasm")]` `wasm-bindgen`
  surface — `load_doc(bytes) -> id maps` (parse once, assign integer node/param
  indices) and `eval(time, params_ptr) -> out_buffer` (write `[nodeIndex, matrix…,
  opacity]` into a pre-allocated buffer read zero-copy via a `Float32Array` view).
  No strings/JSON per frame. Build via `wasm32-unknown-unknown` + `wasm-bindgen`, or
  fold into render-wasm's emscripten/Docker pipeline so writes feed the renderer in-wasm.
- **R3 — wire the controller:** a TS `RustRuntime` binding behind a feature flag,
  `PlaybackController.renderFrame` calling `eval` and applying via the existing
  `WasmModifierSink`; the TS engine stays as reference/fallback.

The current environment has only `wasm32-unknown-emscripten` and no `wasm-pack`, so
R2/R3 are scaffolded here but built where the wasm toolchain (or the devenv Docker
image) is available.
