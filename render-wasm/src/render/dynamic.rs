//! Procedural "Dynamic" stroke — perturbs a path into a hand-drawn / wavy line
//! *before* it is stroked, so the existing stroker draws the result. Controls
//! (all 0..1):
//!   - `frequency`: wiggle wavelength (higher → shorter waves / more wiggles),
//!   - `wiggle`:    perpendicular displacement amplitude,
//!   - `smoothen`:  corner rounding of the result (Chaikin iterations).
//!
//! Displacement is deterministic per path (seeded from the geometry) so the
//! line is stable across frames instead of re-randomising every paint.

use std::f32::consts::PI;

use crate::shapes::DynamicStroke;
use skia_safe::{self as skia, Path, Point};

const MAX_WAVELENGTH: f32 = 160.0; // px between wiggles at frequency = 0
const MIN_WAVELENGTH: f32 = 28.0; // px between wiggles at frequency = 1
const SAMPLES_PER_WAVE: f32 = 8.0; // resampling resolution
const MAX_AMPLITUDE: f32 = 26.0; // px perpendicular offset at wiggle = 1

pub fn apply_dynamic(path: &Path, params: &DynamicStroke) -> Path {
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
    let base_seed = seed_from_path(path);

    let mut builder = skia::PathBuilder::new();
    let mut measure = skia::PathMeasure::new(path, false, None);
    let mut contour: u32 = 0;

    loop {
        let length = measure.length();
        let closed = measure.is_closed();
        if length > 1.0 {
            let seed = base_seed ^ contour.wrapping_mul(0x9E37_79B9);
            let pts = displace(&mut measure, length, closed, wavelength, amplitude, seed);
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

/// Resample the current contour and offset each sample along its normal by
/// seamless value-noise. For open contours the offset tapers to 0 at both ends
/// so the endpoints stay anchored.
fn displace(
    measure: &mut skia::PathMeasure,
    length: f32,
    closed: bool,
    wavelength: f32,
    amplitude: f32,
    seed: u32,
) -> Vec<Point> {
    // Snap the lattice so the noise wraps seamlessly across a closed contour.
    let waves = (length / wavelength).round().max(1.0);
    let eff_wavelength = length / waves;
    let period = waves as u32;

    let steps = (waves * SAMPLES_PER_WAVE).round().max(2.0) as usize;
    let n_points = if closed { steps } else { steps + 1 };
    let mut pts = Vec::with_capacity(n_points);

    for i in 0..n_points {
        let t = i as f32 / steps as f32; // 0..1 along the contour
        let distance = (t * length).min(length);
        if let Some((pos, tan)) = measure.pos_tan(distance) {
            // `tan` is unit length from PathMeasure; rotate 90° for the normal.
            let normal = Point::new(-tan.y, tan.x);
            let mut offset = value_noise(distance / eff_wavelength, period, seed) * amplitude;
            if !closed {
                // Sine window → 0 at both ends so the line stays attached.
                offset *= (t * PI).sin();
            }
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

/// Hash a sample of the path points so the wiggle is stable per geometry yet
/// differs between shapes.
fn seed_from_path(path: &Path) -> u32 {
    let mut h: u32 = 0x811C_9DC5;
    let mut count: u32 = 0;
    for p in path.points().iter().take(64) {
        h ^= p.x.to_bits().rotate_left(13);
        h = h.wrapping_mul(0x0100_0193);
        h ^= p.y.to_bits();
        h = h.wrapping_mul(0x0100_0193);
        count = count.wrapping_add(1);
    }
    h ^ count
}

fn hash01(n: u32) -> f32 {
    let mut x = n.wrapping_mul(0x9E37_79B9).wrapping_add(0x7F4A_7C15);
    x ^= x >> 15;
    x = x.wrapping_mul(0x85EB_CA77);
    x ^= x >> 13;
    (x & 0x00FF_FFFF) as f32 / 16_777_216.0
}

fn lattice(i: i64, period: u32, seed: u32) -> f32 {
    let idx = if period > 0 {
        i.rem_euclid(period as i64) as u32
    } else {
        i as u32
    };
    hash01(idx.wrapping_add(seed))
}

/// Smooth value noise in [-1, 1] at continuous coordinate `t`, periodic over
/// `period` lattice cells so a closed contour wraps without a seam.
fn value_noise(t: f32, period: u32, seed: u32) -> f32 {
    let i0 = t.floor() as i64;
    let f = t - i0 as f32;
    let u = f * f * (3.0 - 2.0 * f); // smoothstep
    let a = lattice(i0, period, seed);
    let b = lattice(i0 + 1, period, seed);
    (a + (b - a) * u) * 2.0 - 1.0
}
