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

thread_local! {
    static STATS: RefCell<HashMap<&'static str, Entry>> = RefCell::new(HashMap::new());
    static COUNTERS: RefCell<Counters> = RefCell::new(Counters::default());
    static FRAMES: RefCell<u64> = RefCell::new(0);
    static FRAME_LAST: RefCell<f64> = RefCell::new(0.0);
    static WALL_MS: RefCell<f64> = RefCell::new(0.0);
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

/// Bump frame counter and accumulate wall-clock time between
/// successive calls. Call once at the end of every top-level render
/// entry point (`start_render_loop`, continuation `process_animation_frame`).
pub fn record_frame() {
    FRAMES.with(|f| *f.borrow_mut() += 1);
    let now = now_ms();
    FRAME_LAST.with(|fl| {
        let mut last = fl.borrow_mut();
        if *last > 0.0 {
            WALL_MS.with(|w| *w.borrow_mut() += now - *last);
        }
        *last = now;
    });
}

/// Reset all stats. Called from JS via `clear_perf_snapshot` between
/// scenarios so each scenario sees a clean slate.
pub fn clear() {
    STATS.with(|s| s.borrow_mut().clear());
    COUNTERS.with(|c| *c.borrow_mut() = Counters::default());
    FRAMES.with(|f| *f.borrow_mut() = 0);
    FRAME_LAST.with(|fl| *fl.borrow_mut() = 0.0);
    WALL_MS.with(|w| *w.borrow_mut() = 0.0);
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
    out.push_str("]}");
    out
}
