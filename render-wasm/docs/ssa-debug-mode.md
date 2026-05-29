# SSA debug mode

Diagnostic overlay + logging for the SSA scheduler's per-tile paint path.
Built to surface the class of "shapes render at the wrong location" bug
visible when the per-tile transform, the `Step::Paint::clip_rect`
emission, or the tile-to-target compositing is off by some amount that
isn't obvious from pixels alone.

## What it shows

For each Paint step, the overlay paints — on top of the body draw —
four things in world coordinates:

| Element                  | Color  | Tells you                                                                                              |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------------ |
| Tile border              | Red    | The tile's world bounds. If borders form a clean adjacent grid, tile-to-target compositing is correct. |
| Tile coord label         | Red    | `(tx, ty)` plus the selrect + clip rect numbers as text inside the tile.                               |
| World-origin crosshair   | Green  | A `+` at world (0, 0). Wherever this lands is where the tile transform thinks (0, 0) is.               |
| Selrect outline          | Cyan   | The shape's claimed world bounds. If cyan is in the right place but pixels aren't, the shape transform is wrong (not the tile transform). |

In addition, every Paint step posts a structured log line to a local
HTTP receiver. The line contains the full geometry tuple — tile,
selrect, world_origin, world_clip, scale, margins, effect count —
which is what you cross-reference against the frontend's reported
selrect coordinates.

## Turning it on

Set the existing `debug` flag via the WASM C ABI:

```c
set_render_options(/* debug */ 1, /* dpr */ 1.0);
```

The flag is `RenderOptions::is_debug_visible()`, defined in
`render-wasm/src/render/options.rs` (`DEBUG_VISIBLE = 0x01`). It's
runtime-toggleable — no rebuild needed once the binary is shipped with
`SSA_IR=1`.

## Building with debug support

The overlay code lives behind `#[cfg(feature = "ssa-ir")]`. Build:

```bash
cd skia-rs-wasm
pnpm build:wasm:ssa
```

This forwards `SSA_IR=1` through the Docker devenv, which causes
`_build_env` to add `--features ssa-ir` to the cargo flags. Output
lands in `skia-rs-wasm/public/wasm/` as usual.

## Capturing logs

The wasm posts each log line to `http://localhost:9876/log`. A small
Node receiver appends to a file:

```bash
cd skia-rs-wasm
pnpm ssa:log-server
```

That truncates `skia-rs-wasm/.ssa-debug.log` at start and writes a
line per request. Add `--append` to keep prior contents.

Custom port / path:

```bash
node scripts/ssa-log-server.js --port=9876 --out=/tmp/ssa.log
```

Once the server is up, load the page that uses the wasm, toggle the
debug flag, and pan/zoom. The log fills with one line per Paint step:

```
2026-05-26T18:14:22.847Z [ssa-debug] paint tile=(2,1) shape=44d3d7a8-... selrect=(572.7,274.4 402.4x315.6) world_origin=(512.0,256.0) world_clip=(512.0,256.0 256.0x256.0) scale=1.000 margins=(0,0) effects=1
```

## What to look for in the logs

**The "4 gray boxes in 2x2 pattern around the selrect" symptom — what
each line in the log will show:**

- If `world_clip.left` / `world_clip.top` are **the same** on every
  log line for a single shape across multiple tiles → the schedule
  builder is emitting the wrong `clip_rect`. Expected: vary by
  `tile_size` per tile.
- If `world_clip` varies but `margins=(M,M)` with `M ≠ 0` and the
  paint surface is `tile_size × tile_size` (no padding) → the
  translation has an unwanted `margins/scale` offset. Fix: pass
  `margins = ISize::new(0, 0)` to PaintCtx for SSA pool surfaces.
- If `world_clip` and `margins` look right but the shape still
  renders wrong → take a snapshot with the overlay on. If the cyan
  selrect outline lands in the right world location but the painted
  pixels don't, the issue is the `apply_tile_and_shape_transform` →
  shape.transform handling, not the tile transform.

## Files

- `render-wasm/src/render/ssa/debug.rs` — overlay + log helpers
- `render-wasm/src/render/ssa/shape_body.rs` — calls `paint_overlay`
- `render-wasm/src/tile_grid/ssa/production_sink.rs` — calls
  `log_paint_step` once per Paint
- `skia-rs-wasm/scripts/ssa-log-server.js` — log receiver
- `skia-rs-wasm/package.json` — `build:wasm:ssa` + `ssa:log-server`
