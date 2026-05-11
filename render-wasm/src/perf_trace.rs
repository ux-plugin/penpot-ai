//! Per-frame perf accumulator for tile-scheduler hot path.
//!
//! Permanent instrumentation gated on the `perf-trace` cargo feature.
//! Pairs with `tile-scheduler`. Aggregates per-tag (count, total_ms,
//! max_ms) in a thread-local map, plus a small set of named counters
//! (tile cache hit/miss/write). One frame's worth of data is dumped
//! to UTF-8 JSON on demand via `snapshot_json`, surfaced through the
//! `dump_perf_snapshot` wasm export.
//!
//! Call-site contract — use the `perf_guard!` and `perf_count_*!`
//! macros defined in `main.rs`. They expand to nothing when the
//! feature is off, so instrumentation has zero cost in production
//! builds.

#![cfg(feature = "perf-trace")]
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt::Write;

#[derive(Default, Clone, Copy)]
struct Entry {
    count: u64,
    total_ms: f64,
    max_ms: f64,
}

#[derive(Default, Clone, Copy)]
struct Counters {
    tile_hits: u64,
    tile_misses: u64,
    tile_writes: u64,
    /// Effect-output cache (cross-frame, per `EffectKey`). Phase 1
    /// scaffold reports zeros; phase 2+ wires reads/writes in
    /// `scheduler_render_effects`.
    effect_cache_hits: u64,
    effect_cache_misses: u64,
    effect_cache_evictions: u64,
}

/// Gesture marker pushed via `mark_event` (wasm export). Lets JS tag
/// frames as "pan_start" / "pan_end" / "move_start" / "zoom_start" /
/// etc. The snapshot serializes the list so per-gesture timing can be
/// reconstructed offline.
#[derive(Clone)]
struct Marker {
    label: String,
    /// `FRAMES` counter at the time of the mark.
    frame: u64,
    /// `WALL_MS` accumulator at the time of the mark — gives a wall-clock
    /// delta between consecutive marks.
    wall_ms: f64,
}

thread_local! {
    static STATS: RefCell<HashMap<&'static str, Entry>> = RefCell::new(HashMap::new());
    static COUNTERS: RefCell<Counters> = RefCell::new(Counters::default());
    static FRAMES: RefCell<u64> = RefCell::new(0);
    static FRAME_LAST: RefCell<f64> = RefCell::new(0.0);
    static WALL_MS: RefCell<f64> = RefCell::new(0.0);
    /// Capped at 1024 markers to avoid unbounded growth during long
    /// sessions; older entries are dropped when the cap is reached.
    static MARKERS: RefCell<Vec<Marker>> = RefCell::new(Vec::new());
}

#[cfg(target_arch = "wasm32")]
#[inline]
fn now_ms() -> f64 {
    crate::get_now!()
}

#[cfg(not(target_arch = "wasm32"))]
#[inline]
fn now_ms() -> f64 {
    0.0
}

/// RAII timing guard. Construct at the top of a scope; the elapsed
/// time is folded into `STATS[tag]` on drop. Drops also fire on `?`,
/// `continue`, and `break`, so guards inside loop bodies record on
/// every iteration regardless of exit path.
pub struct Guard {
    tag: &'static str,
    start: f64,
}

impl Guard {
    pub fn new(tag: &'static str) -> Self {
        Self {
            tag,
            start: now_ms(),
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        let elapsed = now_ms() - self.start;
        STATS.with(|s| {
            let mut m = s.borrow_mut();
            let e = m.entry(self.tag).or_insert_with(Entry::default);
            e.count += 1;
            e.total_ms += elapsed;
            if elapsed > e.max_ms {
                e.max_ms = elapsed;
            }
        });
    }
}

pub fn tile_hit() {
    COUNTERS.with(|c| c.borrow_mut().tile_hits += 1);
}

pub fn tile_miss() {
    COUNTERS.with(|c| c.borrow_mut().tile_misses += 1);
}

pub fn tile_write() {
    COUNTERS.with(|c| c.borrow_mut().tile_writes += 1);
}

pub fn effect_cache_hit() {
    COUNTERS.with(|c| c.borrow_mut().effect_cache_hits += 1);
}

pub fn effect_cache_miss() {
    COUNTERS.with(|c| c.borrow_mut().effect_cache_misses += 1);
}

pub fn effect_cache_evict() {
    COUNTERS.with(|c| c.borrow_mut().effect_cache_evictions += 1);
}

thread_local! {
    /// Snapshot of stats at the previous `record_frame` POST so the
    /// per-frame delta can be computed without recomputing the whole
    /// table on every call. Used by the debug-mode telemetry POST in
    /// `record_frame`; survives the V2c.3 cache revert because it's
    /// generic frame-step delta tracking, not cache-specific.
    static LAST_FRAME_STATS: RefCell<HashMap<&'static str, (u64, f64)>> = RefCell::new(HashMap::new());
    static LAST_FRAME_TS: RefCell<f64> = RefCell::new(0.0);
}

/// Bump frame counter and accumulate wall-clock time between
/// successive calls. Call once at the end of every top-level render
/// entry point (`start_render_loop`, continuation `process_animation_frame`).
///
/// Also POSTs a per-frame summary to the debug-mode log sink: this
/// frame's wall time + the top per-step ms deltas since the last
/// frame. Lets the agent stream live frame timings while the user
/// drives gestures.
pub fn record_frame() {
    FRAMES.with(|f| *f.borrow_mut() += 1);
    let now = now_ms();
    let frame_ms = FRAME_LAST.with(|fl| {
        let mut last = fl.borrow_mut();
        let delta = if *last > 0.0 { now - *last } else { 0.0 };
        if delta > 0.0 {
            WALL_MS.with(|w| *w.borrow_mut() += delta);
        }
        *last = now;
        delta
    });

    // Per-frame summary POST. Compute step ms-delta against the
    // previous frame's snapshot, emit the top 8 by delta. Keeps the
    // body tight (< 1 KB) at 60 Hz on localhost.
    let frame = FRAMES.with(|f| *f.borrow());
    let counters = COUNTERS.with(|c| *c.borrow());
    let current: Vec<(&'static str, u64, f64)> = STATS.with(|s| {
        s.borrow()
            .iter()
            .map(|(k, v)| (*k, v.count, v.total_ms))
            .collect()
    });
    let mut deltas: Vec<(&'static str, f64, u64)> = Vec::with_capacity(current.len());
    LAST_FRAME_STATS.with(|prev| {
        let prev_map = prev.borrow();
        for (tag, count, ms) in &current {
            let (pc, pm) = prev_map.get(*tag).copied().unwrap_or((0, 0.0));
            let d_ms = ms - pm;
            let d_count = count.saturating_sub(pc);
            if d_ms > 0.0 || d_count > 0 {
                deltas.push((tag, d_ms, d_count));
            }
        }
    });
    deltas.sort_by(|a, b| {
        b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)
    });
    let top: Vec<_> = deltas.iter().take(8).collect();

    let mut body = String::with_capacity(512);
    let _ = write!(body, "{{\"tag\":\"frame\",\"site\":\"perf_trace.rs:record_frame\",\"value\":{{\"f\":{},\"ms\":{:.3}", frame, frame_ms);
    let _ = write!(
        body,
        ",\"tile_h\":{},\"tile_m\":{},\"eff_h\":{},\"eff_m\":{}",
        counters.tile_hits,
        counters.tile_misses,
        counters.effect_cache_hits,
        counters.effect_cache_misses,
    );
    body.push_str(",\"top\":[");
    for (i, (tag, d_ms, d_count)) in top.iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        let _ = write!(
            body,
            "{{\"t\":\"{}\",\"ms\":{:.3},\"n\":{}}}",
            tag, d_ms, d_count
        );
    }
    body.push_str("]}}");
    crate::wapi_post_log!(body);

    // Persist the snapshot for next frame's delta.
    LAST_FRAME_STATS.with(|prev| {
        let mut m = prev.borrow_mut();
        m.clear();
        for (tag, count, ms) in current {
            m.insert(tag, (count, ms));
        }
    });
    LAST_FRAME_TS.with(|t| *t.borrow_mut() = now);
}

/// Reset all stats. Called from JS via `clear_perf_snapshot` between
/// scenarios so each scenario sees a clean slate.
pub fn clear() {
    STATS.with(|s| s.borrow_mut().clear());
    COUNTERS.with(|c| *c.borrow_mut() = Counters::default());
    FRAMES.with(|f| *f.borrow_mut() = 0);
    FRAME_LAST.with(|fl| *fl.borrow_mut() = 0.0);
    WALL_MS.with(|w| *w.borrow_mut() = 0.0);
    MARKERS.with(|m| m.borrow_mut().clear());
    LAST_FRAME_STATS.with(|m| m.borrow_mut().clear());
    LAST_FRAME_TS.with(|t| *t.borrow_mut() = 0.0);
    LAYER_BLUR_DECISION_LAST.with(|m| m.borrow_mut().clear());
    EMIT_CACHE_DECISION_LAST.with(|m| m.borrow_mut().clear());
    BUILD_LOCAL_BLUR_LAST.with(|m| m.borrow_mut().clear());
    SHAPE_WALK_SEEN.with(|m| m.borrow_mut().clear());
    MODIFIED_SHAPE_SEEN.with(|m| m.borrow_mut().clear());
    crate::wapi_post_log!(String::from(
        "{\"tag\":\"perf_clear\",\"site\":\"perf_trace.rs:clear\",\"value\":{}}"
    ));
}

thread_local! {
    /// Dedupe map for layer-blur decision POSTs: `shape_id` → last
    /// reject reason posted. Re-POST only on change. Bounded by scene
    /// shape count.
    static LAYER_BLUR_DECISION_LAST: RefCell<HashMap<crate::uuid::Uuid, Option<&'static str>>> = RefCell::new(HashMap::new());
    /// Dedupe map for `emit_cache_build_for_shape` predicate POSTs:
    /// `shape_id` → packed predicate tuple `(has_scatter, has_gather,
    /// has_local_blur)`. Re-POST only on tuple change.
    static EMIT_CACHE_DECISION_LAST: RefCell<HashMap<crate::uuid::Uuid, u8>> = RefCell::new(HashMap::new());
    /// Dedupe map for `BuildCache(LocalBlur)` dispatch POSTs:
    /// `shape_id` → `(hit, scale_bucket)`. Re-POST only on change so
    /// steady-state hit streaks don't flood. First miss-then-hit
    /// transition is the diagnostic signal we care about.
    static BUILD_LOCAL_BLUR_LAST: RefCell<HashMap<crate::uuid::Uuid, (bool, i8)>> = RefCell::new(HashMap::new());
    /// Dedupe map for `log_shape_walk` POSTs: `shape_id` → already-
    /// posted flag. Each shape gets exactly one POST per session
    /// (until `clear()`). Captures shape-type + blur predicate.
    static SHAPE_WALK_SEEN: RefCell<HashMap<crate::uuid::Uuid, ()>> = RefCell::new(HashMap::new());
    /// Dedupe map for `log_modified_shape` POSTs. Kept separate from
    /// `SHAPE_WALK_SEEN` because a single shape may legitimately
    /// appear in both: a Frame that the scheduler walks AND that JS
    /// drags via set_modifiers will get exactly one event under each
    /// tag.
    static MODIFIED_SHAPE_SEEN: RefCell<HashMap<crate::uuid::Uuid, ()>> = RefCell::new(HashMap::new());
}

/// Log every shape passed through `State::set_modifiers`, once per
/// session per shape. Bypasses the scheduler-walk view — directly
/// captures what JS is mutating each gesture so we can see the shape's
/// type / parent / blur state regardless of whether the scheduler
/// reaches it.
pub fn log_modified_shape(shape_id: crate::uuid::Uuid, shape: &crate::shapes::Shape) {
    let already = MODIFIED_SHAPE_SEEN.with(|m| {
        let mut map = m.borrow_mut();
        if map.contains_key(&shape_id) {
            true
        } else {
            map.insert(shape_id, ());
            false
        }
    });
    if already {
        return;
    }
    let type_name = match &shape.shape_type {
        crate::shapes::Type::Rect(_) => "Rect",
        crate::shapes::Type::Circle => "Circle",
        crate::shapes::Type::Path(_) => "Path",
        crate::shapes::Type::Bool(_) => "Bool",
        crate::shapes::Type::Frame(_) => "Frame",
        crate::shapes::Type::Group(_) => "Group",
        crate::shapes::Type::Text(_) => "Text",
        crate::shapes::Type::SVGRaw(_) => "SVGRaw",
    };
    let blur_state = match shape.blur {
        Some(b) => format!(
            "{{\"present\":true,\"type\":\"{:?}\",\"value\":{:.3},\"hidden\":{}}}",
            b.blur_type, b.value, b.hidden
        ),
        None => String::from("{\"present\":false}"),
    };
    let drop_shadows = shape.drop_shadows_visible().count();
    let parent = match shape.parent_id {
        Some(p) => format!("\"{:?}\"", p),
        None => String::from("null"),
    };
    let body = format!(
        "{{\"tag\":\"modified_shape\",\"site\":\"state.rs:set_modifiers\",\"value\":{{\"shape_id\":\"{:?}\",\"type\":\"{}\",\"recursive\":{},\"children\":{},\"parent\":{},\"blur\":{},\"drop_shadows\":{}}}}}",
        shape_id,
        type_name,
        shape.is_recursive(),
        shape.children.len(),
        parent,
        blur_state,
        drop_shadows
    );
    crate::wapi_post_log!(body);
}

/// Log every shape the scheduler walks, once per session per shape.
/// Captures shape type + blur fields so we can spot when the blurred
/// shape is a container (recursive Group/Frame) that doesn't qualify
/// for the leaf-only layer-blur cache.
pub fn log_shape_walk(shape_id: crate::uuid::Uuid, shape: &crate::shapes::Shape) {
    let already = SHAPE_WALK_SEEN.with(|m| {
        let mut map = m.borrow_mut();
        if map.contains_key(&shape_id) {
            true
        } else {
            map.insert(shape_id, ());
            false
        }
    });
    if already {
        return;
    }
    let is_recursive = shape.is_recursive();
    let type_name = match &shape.shape_type {
        crate::shapes::Type::Rect(_) => "Rect",
        crate::shapes::Type::Circle => "Circle",
        crate::shapes::Type::Path(_) => "Path",
        crate::shapes::Type::Bool(_) => "Bool",
        crate::shapes::Type::Frame(_) => "Frame",
        crate::shapes::Type::Group(_) => "Group",
        crate::shapes::Type::Text(_) => "Text",
        crate::shapes::Type::SVGRaw(_) => "SVGRaw",
    };
    let blur_state = match shape.blur {
        Some(b) => format!(
            "{{\"present\":true,\"type\":\"{:?}\",\"value\":{:.3},\"hidden\":{}}}",
            b.blur_type, b.value, b.hidden
        ),
        None => String::from("{\"present\":false}"),
    };
    let drop_shadows = shape.drop_shadows_visible().count();
    let n_children = shape.children.len();
    let body = format!(
        "{{\"tag\":\"shape_walk\",\"site\":\"tile_grid.rs:emit_shape_steps_checked\",\"value\":{{\"shape_id\":\"{:?}\",\"type\":\"{}\",\"recursive\":{},\"children\":{},\"hidden\":{},\"blur\":{},\"drop_shadows\":{}}}}}",
        shape_id, type_name, is_recursive, n_children, shape.hidden, blur_state, drop_shadows
    );
    crate::wapi_post_log!(body);
}

/// Dispatcher-side log for `BuildCache(LocalBlur)`. Dedupes on
/// `(shape_id, hit, scale_bucket)`. First miss-then-hit transition is
/// the diagnostic signal; steady-state hits emit once then go silent.
pub fn log_build_local_blur(shape_id: crate::uuid::Uuid, hit: bool, scale_bucket: i8) {
    let key = (hit, scale_bucket);
    let changed = BUILD_LOCAL_BLUR_LAST.with(|m| {
        let mut map = m.borrow_mut();
        if map.get(&shape_id).copied() == Some(key) {
            false
        } else {
            map.insert(shape_id, key);
            true
        }
    });
    if !changed {
        return;
    }
    let body = format!(
        "{{\"tag\":\"build_local_blur\",\"site\":\"tile_grid.rs:BuildCache_LocalBlur\",\"value\":{{\"shape_id\":\"{:?}\",\"hit\":{},\"scale_bucket\":{}}}}}",
        shape_id, hit, scale_bucket
    );
    crate::wapi_post_log!(body);
}

/// Per-shape `emit_cache_build_for_shape` decision log. Dedupes via
/// `EMIT_CACHE_DECISION_LAST` so the POST volume scales with scene
/// edit frequency, not frame count.
pub fn log_emit_cache_decision(
    shape_id: crate::uuid::Uuid,
    shape: &crate::shapes::Shape,
    has_scatter: bool,
    has_gather: bool,
    has_local_blur: bool,
) {
    let pred: u8 = (has_scatter as u8) | ((has_gather as u8) << 1) | ((has_local_blur as u8) << 2);
    let changed = EMIT_CACHE_DECISION_LAST.with(|m| {
        let mut map = m.borrow_mut();
        let prev = map.get(&shape_id).copied();
        if prev == Some(pred) {
            false
        } else {
            map.insert(shape_id, pred);
            true
        }
    });
    if !changed {
        return;
    }
    let blur_present = shape.blur.is_some();
    let bg_blur_present = shape.background_blur.is_some();
    let drop_shadows = shape.drop_shadows_visible().count();
    let inner_shadows = shape.inner_shadows_visible().count();
    let body = format!(
        "{{\"tag\":\"emit_cache_decision\",\"site\":\"tile_grid.rs:emit_cache_build_for_shape\",\"value\":{{\"shape_id\":\"{:?}\",\"has_scatter\":{},\"has_gather\":{},\"has_local_blur\":{},\"blur_present\":{},\"bg_blur_present\":{},\"drop_shadows\":{},\"inner_shadows\":{}}}}}",
        shape_id, has_scatter, has_gather, has_local_blur, blur_present, bg_blur_present, drop_shadows, inner_shadows
    );
    crate::wapi_post_log!(body);
}

/// Per-shape decision log for `LocalKind::from_shape_layer_blur`.
/// POSTs once per shape per *change* in decision (qualified vs which
/// reject reason). Avoids 60-Hz flood when a shape repeatedly fails the
/// same gate across frames.
pub fn log_layer_blur_decision(
    shape: &crate::shapes::Shape,
    reject: Option<&'static str>,
) {
    let changed = LAYER_BLUR_DECISION_LAST.with(|m| {
        let mut map = m.borrow_mut();
        let prev = map.get(&shape.id).copied().flatten();
        if prev == reject {
            false
        } else {
            map.insert(shape.id, reject);
            true
        }
    });
    if !changed {
        return;
    }
    let blur_state = match shape.blur {
        Some(b) => format!(
            "{{\"present\":true,\"type\":\"{:?}\",\"value\":{:.3},\"hidden\":{}}}",
            b.blur_type, b.value, b.hidden
        ),
        None => String::from("{\"present\":false}"),
    };
    let bg_blur_state = match shape.background_blur {
        Some(b) => format!(
            "{{\"present\":true,\"value\":{:.3},\"hidden\":{}}}",
            b.value, b.hidden
        ),
        None => String::from("{\"present\":false}"),
    };
    let drop_shadows = shape.drop_shadows_visible().count();
    let inner_shadows = shape.inner_shadows_visible().count();
    let has_glass = shape.glass.as_ref().is_some_and(|g| !g.hidden);
    let has_texture = shape
        .texture
        .as_ref()
        .is_some_and(|t| !t.hidden && t.radius > 0.0);
    let reject_str = reject.unwrap_or("qualified");
    let body = format!(
        "{{\"tag\":\"layer_blur_decision\",\"site\":\"local.rs:from_shape_layer_blur\",\"value\":{{\"shape_id\":\"{:?}\",\"reject\":\"{}\",\"blur\":{},\"bg_blur\":{},\"drop_shadows\":{},\"inner_shadows\":{},\"glass\":{},\"texture\":{}}}}}",
        shape.id, reject_str, blur_state, bg_blur_state, drop_shadows, inner_shadows, has_glass, has_texture
    );
    crate::wapi_post_log!(body);
}

/// Logged once per successful qualification — same shape stays
/// emitting "qualified" via `log_layer_blur_decision`. Kept as a
/// thin wrapper for symmetry with the qualified path call site.
pub fn log_layer_blur_qualified(_id: crate::uuid::Uuid, _value: f32, _sigma: f32) {
    // No-op — `log_layer_blur_decision(.., None)` handles the
    // qualified-state POST via the dedupe map. Kept to give the call
    // site a clear name and a place to add follow-up signal later
    // (e.g. emit sigma changes even when the rejection state didn't
    // change).
}

/// Push a gesture marker. JS calls this on pointerdown/pointerup,
/// wheel, viewport-translate, etc. so the snapshot timeline can be
/// segmented by user-action boundaries. `label` is the marker's name
/// (e.g. "pan_start", "move_end"). Capped at 1024 entries; oldest
/// dropped on overflow.
pub fn mark_event(label: &str) {
    let frame = FRAMES.with(|f| *f.borrow());
    let wall_ms = WALL_MS.with(|w| *w.borrow());
    MARKERS.with(|m| {
        let mut v = m.borrow_mut();
        if v.len() >= 1024 {
            v.remove(0);
        }
        v.push(Marker {
            label: label.to_string(),
            frame,
            wall_ms,
        });
    });

    // Mirror to the debug POST sink so the agent gets per-gesture
    // boundary signals interleaved with the per-frame stream.
    let label_escaped = label.replace('\\', "\\\\").replace('"', "\\\"");
    let mut body = String::with_capacity(160 + label_escaped.len());
    let _ = write!(
        body,
        "{{\"tag\":\"marker\",\"site\":\"perf_trace.rs:mark_event\",\"value\":{{\"label\":\"{}\",\"frame\":{},\"wall_ms\":{:.3}}}}}",
        label_escaped, frame, wall_ms
    );
    crate::wapi_post_log!(body);
}

/// Build a length-prefixed JSON byte vector. First 4 bytes are the
/// payload length (little-endian u32), remaining bytes are UTF-8
/// JSON. Mirrors the layout produced by `mem::write_vec` so the JS
/// side can reuse the existing read pattern.
pub fn snapshot_bytes() -> Vec<u8> {
    let json = snapshot_json();
    let bytes = json.into_bytes();
    let len = bytes.len() as u32;
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&bytes);
    out
}

fn snapshot_json() -> String {
    let frames = FRAMES.with(|f| *f.borrow());
    let wall_ms = WALL_MS.with(|w| *w.borrow());
    let counters = COUNTERS.with(|c| *c.borrow());
    let stats: Vec<(&'static str, Entry)> = STATS.with(|s| {
        let m = s.borrow();
        let mut v: Vec<_> = m.iter().map(|(k, v)| (*k, *v)).collect();
        v.sort_by(|a, b| {
            b.1.total_ms
                .partial_cmp(&a.1.total_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        v
    });

    let mut out = String::with_capacity(256 + 96 * stats.len());
    out.push('{');
    let _ = write!(out, "\"frames\":{}", frames);
    let _ = write!(out, ",\"wall_ms\":{:.4}", wall_ms);
    out.push_str(",\"cache\":{");
    let _ = write!(
        out,
        "\"tile_hits\":{},\"tile_misses\":{},\"tile_writes\":{}",
        counters.tile_hits, counters.tile_misses, counters.tile_writes
    );
    let _ = write!(
        out,
        ",\"effect_cache_hits\":{},\"effect_cache_misses\":{},\"effect_cache_evictions\":{}",
        counters.effect_cache_hits,
        counters.effect_cache_misses,
        counters.effect_cache_evictions
    );
    out.push('}');
    out.push_str(",\"stats\":[");
    for (i, (tag, e)) in stats.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        let _ = write!(
            out,
            "{{\"tag\":\"{}\",\"count\":{},\"total_ms\":{:.4},\"max_ms\":{:.4}}}",
            tag, e.count, e.total_ms, e.max_ms
        );
    }
    out.push_str("],\"markers\":[");
    let markers: Vec<Marker> = MARKERS.with(|m| m.borrow().clone());
    for (i, mk) in markers.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // Escape only `"` and `\`; labels come from JS-side trusted
        // string literals (pan_start etc.), so this is sufficient.
        let label_escaped = mk
            .label
            .replace('\\', "\\\\")
            .replace('"', "\\\"");
        let _ = write!(
            out,
            "{{\"label\":\"{}\",\"frame\":{},\"wall_ms\":{:.4}}}",
            label_escaped, mk.frame, mk.wall_ms
        );
    }
    out.push_str("]}");
    out
}
