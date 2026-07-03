//! Procedural "Dynamic" stroke — perturbs a path into a hand-drawn / wavy line
//! *before* it is stroked, so the existing stroker draws the result. Controls
//! (all 0..1; frequency/wiggle may exceed 1.0):
//!   - `frequency`: wiggle wavelength (higher → shorter waves / more wiggles),
//!   - `wiggle`:    perpendicular displacement amplitude,
//!   - `smoothen`:  corner rounding of the result (Chaikin iterations).
//!
//! The perturbation is **anchored to the contour's start point** and sampled by
//! *absolute* arc-length against a **fixed** wavelength — like a pen drawing
//! from that point. Consequences:
//!   - moving / rotating the shape carries the exact same wiggle along rigidly
//!     (arc-length and the id-derived seed are both unchanged);
//!   - resizing reveals more of the same fixed noise field from the anchored
//!     start rather than re-randomising the whole line (the near-start stays
//!     put, the far end extends);
//!   - the offset tapers to 0 within one wavelength of each end, so the line
//!     passes through the start/end point — the hand-drawn "starts and returns
//!     to a point" look.
//!
//! The seed comes from the shape id (`seed_from_bytes`), so it is identical
//! every frame, unique per shape, and unaffected by any gesture.

use crate::shapes::DynamicStroke;
use skia_safe::{self as skia, Path, Point};

const MAX_WAVELENGTH: f32 = 160.0; // px between wiggles at frequency = 0
const MIN_WAVELENGTH: f32 = 28.0; // px between wiggles at frequency = 1
const SAMPLES_PER_WAVE: f32 = 8.0; // resampling resolution
const MAX_AMPLITUDE: f32 = 26.0; // px perpendicular offset at wiggle = 1

/// FNV-1a hash of arbitrary bytes → u32. Used to turn a shape id into a stable
/// per-shape wiggle seed: identical every frame, unique per shape, and unchanged
/// by moving / rotating / resizing (only the *revealed* arc-length changes).
pub fn seed_from_bytes(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811C_9DC5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

pub fn apply_dynamic(path: &Path, params: &DynamicStroke, seed: u32) -> Path {
    // Frequency and wiggle may exceed 1.0 (the UI allows >100% for stronger
    // effects); only smoothen is capped. The wavelength is floored so a high
    // frequency can't collapse it to zero.
    let frequency = params.frequency.max(0.0);
    let wiggle = params.wiggle.max(0.0);
    let smoothen = params.smoothen.clamp(0.0, 1.0);

    if wiggle <= 0.0 {
        return path.clone();
    }

    let wavelength = (MAX_WAVELENGTH + (MIN_WAVELENGTH - MAX_WAVELENGTH) * frequency).max(4.0);
    let amplitude = MAX_AMPLITUDE * wiggle;
    let iterations = (smoothen * 4.0).round() as u32;

    let mut builder = skia::PathBuilder::new();
    let mut measure = skia::PathMeasure::new(path, false, None);
    let mut contour: u32 = 0;

    loop {
        let length = measure.length();
        let closed = measure.is_closed();
        if length > 1.0 {
            let contour_seed = seed ^ contour.wrapping_mul(0x9E37_79B9);
            let pts = displace(&mut measure, length, wavelength, amplitude, contour_seed);
            let pts = if iterations > 0 {
                chaikin(&pts, iterations, closed)
            } else {
                pts
            };
            append(&mut builder, &pts, closed);
        }
        contour = contour.wrapping_add(1);
        if !measure.next_contour() {
            break;
        }
    }

    builder.detach()
}

/// Resample the current contour at a **fixed** arc-length step and offset each
/// sample along its normal by non-periodic value-noise evaluated at the sample's
/// *absolute* arc-length. The offset tapers to 0 within one wavelength of both
/// ends, so the deformed line passes through the contour's start/end point —
/// this anchors the pattern under resize (start stays put, far end extends) and
/// gives the "starts and returns to a point" look.
fn displace(
    measure: &mut skia::PathMeasure,
    length: f32,
    wavelength: f32,
    amplitude: f32,
    seed: u32,
) -> Vec<Point> {
    let ds = (wavelength / SAMPLES_PER_WAVE).max(1.0);
    let steps = (length / ds).ceil().max(1.0) as usize;
    // Ramp the offset up over ~one wavelength at each end (clamped so it never
    // exceeds half the contour) → the endpoints stay pinned to the base path.
    let ramp = wavelength.min(length * 0.5).max(1.0);

    let mut pts = Vec::with_capacity(steps + 1);
    for i in 0..=steps {
        let s = (i as f32 * ds).min(length); // absolute arc-length from the start
        if let Some((pos, tan)) = measure.pos_tan(s) {
            // `tan` is unit length from PathMeasure; rotate 90° for the normal.
            let normal = Point::new(-tan.y, tan.x);
            let taper = smoothstep(ramp, s) * smoothstep(ramp, length - s);
            let offset = value_noise(s / wavelength, seed) * amplitude * taper;
            pts.push(Point::new(
                pos.x + normal.x * offset,
                pos.y + normal.y * offset,
            ));
        }
    }
    pts
}

/// Chaikin corner-cutting: each pass replaces every segment with its 1/4 and
/// 3/4 points, rounding the polyline.
fn chaikin(pts: &[Point], iterations: u32, closed: bool) -> Vec<Point> {
    let mut current = pts.to_vec();
    for _ in 0..iterations {
        let n = current.len();
        if n < 3 {
            break;
        }
        let mut next = Vec::with_capacity(n * 2);
        let segments = if closed { n } else { n - 1 };
        if !closed {
            next.push(current[0]);
        }
        for i in 0..segments {
            let a = current[i];
            let b = current[(i + 1) % n];
            next.push(Point::new(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
            next.push(Point::new(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
        }
        if !closed {
            next.push(current[n - 1]);
        }
        current = next;
    }
    current
}

fn append(builder: &mut skia::PathBuilder, pts: &[Point], closed: bool) {
    if pts.len() < 2 {
        return;
    }
    builder.move_to(pts[0]);
    for p in &pts[1..] {
        builder.line_to(*p);
    }
    if closed {
        builder.close();
    }
}

/// Smoothstep ramp: 0 at x = 0, 1 at x >= edge (clamped in between).
fn smoothstep(edge: f32, x: f32) -> f32 {
    if edge <= 0.0 {
        return 1.0;
    }
    let t = (x / edge).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn hash01(n: u32) -> f32 {
    let mut x = n.wrapping_mul(0x9E37_79B9).wrapping_add(0x7F4A_7C15);
    x ^= x >> 15;
    x = x.wrapping_mul(0x85EB_CA77);
    x ^= x >> 13;
    (x & 0x00FF_FFFF) as f32 / 16_777_216.0
}

fn lattice(i: i64, seed: u32) -> f32 {
    hash01((i as u32).wrapping_add(seed))
}

/// Smooth value noise in [-1, 1] at continuous coordinate `t`, sampled from a
/// non-periodic lattice anchored at t = 0.
fn value_noise(t: f32, seed: u32) -> f32 {
    let i0 = t.floor() as i64;
    let f = t - i0 as f32;
    let u = f * f * (3.0 - 2.0 * f); // smoothstep
    let a = lattice(i0, seed);
    let b = lattice(i0 + 1, seed);
    (a + (b - a) * u) * 2.0 - 1.0
}
