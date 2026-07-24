//! PowerStroke (variable-width) brush geometry. Skia's stroker is uniform-width,
//! so we generate the outline ourselves: walk the spine with `PathMeasure`,
//! offset each sample along its normal by a per-point half-width, and build a
//! filled ribbon that the caller fills. Half-width at arc-fraction `t` is
//!   `base_half * profile(t) * nib_factor(tangent)`.
//!
//! Open contours become a single filled ribbon (left edge forward, right edge
//! back). Closed contours become an annular band (outer + inner loops, even-odd
//! fill) so a rect/ellipse/closed path gets a calligraphic frame.

use crate::shapes::WidthProfile;
use skia_safe::{self as skia, Path, Point};
use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    /// Cache of built ribbon outlines keyed by a hash of the inputs. The ribbon is
    /// built on the shape's LOCAL geometry (not device space), so pan/zoom leaves
    /// the key unchanged and hits the cache — only a real geometry/width edit
    /// misses and rebuilds. Bounded; cleared wholesale when it grows large.
    static RIBBON_CACHE: RefCell<HashMap<u64, Path>> = RefCell::new(HashMap::new());
}

/// Content hash of everything `power_ribbon` depends on, so pan/zoom reuses the
/// cached outline and only a real edit invalidates it.
fn ribbon_cache_key(
    spine: &Path,
    base_width: f32,
    profile: WidthProfile,
    nib_deg: f32,
    width_points: &[f32],
) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    let pts = spine.points();
    pts.len().hash(&mut h);
    for p in pts {
        p.x.to_bits().hash(&mut h);
        p.y.to_bits().hash(&mut h);
    }
    base_width.to_bits().hash(&mut h);
    (profile as u8).hash(&mut h);
    nib_deg.to_bits().hash(&mut h);
    width_points.len().hash(&mut h);
    for v in width_points {
        v.to_bits().hash(&mut h);
    }
    h.finish()
}

/// Minimum ribbon width — a thin stroke still shows a visible profile instead of
/// sub-pixel geometry that reads as "nothing".
const MIN_WIDTH: f32 = 4.0;

/// Catmull-Rom interpolation of `p1..p2` at `u` (0..1), using `p0`/`p3` as the
/// surrounding tangent points — a smooth curve that passes through every point.
fn catmull(p0: f32, p1: f32, p2: f32, p3: f32, u: f32) -> f32 {
    0.5 * (2.0 * p1
        + (-p0 + p2) * u
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * u * u
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * u * u * u)
}

/// Interpolate `(left, right)` half-width multipliers at arc-fraction `t` from
/// flattened `[t, l, r, mode, …]` points (assumed sorted by `t`). The segment
/// *leaving* point `i` follows point `i`'s `mode`: `0` smooth (Catmull-Rom),
/// `1` corner (linear), `2` stepped (hold `i`'s value, hard jump at `i+1`).
/// Clamps to the first / last point outside their range.
fn custom_factors(points: &[f32], t: f32) -> (f32, f32) {
    let n = points.len() / 4;
    if n == 0 {
        return (1.0, 1.0);
    }
    let at = |i: usize| {
        let b = i * 4;
        (points[b], points[b + 1], points[b + 2], points[b + 3])
    };
    let (t_first, l_first, r_first, _) = at(0);
    if t <= t_first {
        return (l_first, r_first);
    }
    let (t_last, l_last, r_last, _) = at(n - 1);
    if t >= t_last {
        return (l_last, r_last);
    }
    for i in 0..n - 1 {
        let (ta, la, ra, ma) = at(i);
        let (tb, lb, rb, _) = at(i + 1);
        if t >= ta && t <= tb {
            let mode = ma.round() as i32;
            if mode == 2 {
                // Stepped: hold the left value across the whole segment.
                return (la, ra);
            }
            let u = ((t - ta) / (tb - ta).max(1e-6)).clamp(0.0, 1.0);
            if mode == 1 {
                // Corner: straight linear ramp.
                return (la + (lb - la) * u, ra + (rb - ra) * u);
            }
            // Smooth: Catmull-Rom, clamping the ends to their own value.
            let (_, l0, r0, _) = if i > 0 { at(i - 1) } else { at(i) };
            let (_, l3, r3, _) = if i + 2 < n { at(i + 2) } else { at(i + 1) };
            return (
                catmull(l0, la, lb, l3, u).max(0.0),
                catmull(r0, ra, rb, r3, u).max(0.0),
            );
        }
    }
    (l_last, r_last)
}

/// True if quad `p0→p1→p2→p3` is wound counter-clockwise (positive signed area).
/// The joint discs are emitted with the SAME shoelace sign as the quads so the
/// nonzero fill *unions* them; opposite winding cancels in the overlap and cuts a
/// round white hole at the corner.
fn quad_ccw(p0: Point, p1: Point, p2: Point, p3: Point) -> bool {
    let pts = [p0, p1, p2, p3];
    let mut area = 0.0;
    for i in 0..4 {
        let j = (i + 1) % 4;
        area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    area >= 0.0
}

/// Append a filled disc (radius `r`) at `center`, wound to match the ribbon
/// quads' orientation (`ccw`). Built as an explicit segment fan rather than
/// `add_circle` so its winding SIGN is under our control and can't disagree with
/// the quads under Skia's coordinate convention.
fn add_disc(builder: &mut skia::PathBuilder, center: Point, r: f32, ccw: bool) {
    const SEG: usize = 24;
    let sign = if ccw { 1.0 } else { -1.0 };
    for k in 0..SEG {
        let ang = (k as f32 / SEG as f32) * std::f32::consts::TAU * sign;
        let p = Point::new(center.x + r * ang.cos(), center.y + r * ang.sin());
        if k == 0 {
            builder.move_to(p);
        } else {
            builder.line_to(p);
        }
    }
    builder.close();
}

/// Build a filled variable-width ribbon along `spine`, or `None` if there's no
/// contour long enough to stroke. `width_points` supplies hand-authored
/// (possibly asymmetric) half-widths when `profile` is `Custom`.
pub fn power_ribbon(
    spine: &Path,
    base_width: f32,
    profile: WidthProfile,
    nib_deg: f32,
    width_points: &[f32],
) -> Option<Path> {
    let key = ribbon_cache_key(spine, base_width, profile, nib_deg, width_points);
    if let Some(cached) = RIBBON_CACHE.with(|c| c.borrow().get(&key).cloned()) {
        return Some(cached);
    }
    // Any hand-authored points drive the width (overriding the preset), so the
    // Width tool works on any ribbon brush without switching its engine.
    let custom = width_points.len() >= 4;
    let base_half = base_width.max(MIN_WIDTH) * 0.5;
    let nib = nib_deg.to_radians();
    let use_nib = nib_deg > 0.5;

    let mut builder = skia::PathBuilder::new();
    let mut measure = skia::PathMeasure::new(spine, false, None);
    let mut any = false;

    loop {
        let length = measure.length();
        let closed = measure.is_closed();
        if length > 1.0 {
            // ~96 samples, clamped to a 1–6px step so long paths stay cheap.
            let ds = (length / 96.0).clamp(1.0, 6.0);
            let steps = (length / ds).ceil().max(1.0) as usize;
            let mut left: Vec<Point> = Vec::with_capacity(steps + 1);
            let mut right: Vec<Point> = Vec::with_capacity(steps + 1);
            // Spine centres + local half-width, for the round joint discs below.
            let mut centers: Vec<Point> = Vec::with_capacity(steps + 1);
            let mut radii: Vec<f32> = Vec::with_capacity(steps + 1);

            for i in 0..=steps {
                let s = (i as f32 * ds).min(length);
                let t = s / length;
                if let Some((pos, tan)) = measure.pos_tan(s) {
                    // `tan` is unit-length from PathMeasure; rotate 90° for the normal.
                    let normal = Point::new(-tan.y, tan.x);
                    // Custom points may differ per side; presets are symmetric.
                    let (fl, fr) = if custom {
                        custom_factors(width_points, t)
                    } else {
                        let f = profile_factor(profile, t);
                        (f, f)
                    };
                    let mut hl = base_half * fl;
                    let mut hr = base_half * fr;
                    if use_nib {
                        // Flat-pen nib: width scales with the sine of the angle
                        // between travel direction and the nib, floored so the
                        // line never fully vanishes.
                        let ang = tan.y.atan2(tan.x);
                        let k = (ang - nib).sin().abs().max(0.15);
                        hl *= k;
                        hr *= k;
                    }
                    let hl = hl.max(0.0);
                    let hr = hr.max(0.0);
                    left.push(Point::new(pos.x + normal.x * hl, pos.y + normal.y * hl));
                    right.push(Point::new(pos.x - normal.x * hr, pos.y - normal.y * hr));
                    centers.push(pos);
                    radii.push(hl.max(hr));
                }
            }

            if left.len() >= 2 {
                // One filled quad per spine segment. Consecutive quads share the
                // i-th cross-section edge, so the band is seamless and a closed
                // contour closes itself (its last sample coincides with the first).
                // Nonzero winding (NOT even-odd) means self-crossing offsets at a
                // sharp corner fill solidly instead of punching a hole.
                for i in 0..left.len() - 1 {
                    builder.move_to(left[i]);
                    builder.line_to(left[i + 1]);
                    builder.line_to(right[i + 1]);
                    builder.line_to(right[i]);
                    builder.close();
                }
                // Round-join discs ONLY at real corners (the direction turns >~18°)
                // fill the outer miter wedge there. Adding one at every sample beads
                // thin runs and bloats the path (slow to fill every frame). Endpoints
                // are skipped, so open strokes keep butt caps. Discs are wound to
                // match the quads so the nonzero fill unions them.
                let ccw = quad_ccw(left[0], left[1], right[1], right[0]);
                let n = centers.len();
                // cos(18°) ≈ 0.95 — below this the segment turned enough to be a corner.
                const COS_CORNER: f32 = 0.95;
                let turn_cos = |p: Point, c: Point, q: Point| -> f32 {
                    let (ax, ay) = (c.x - p.x, c.y - p.y);
                    let (bx, by) = (q.x - c.x, q.y - c.y);
                    let la = (ax * ax + ay * ay).sqrt();
                    let lb = (bx * bx + by * by).sqrt();
                    if la < 1e-4 || lb < 1e-4 {
                        1.0
                    } else {
                        (ax * bx + ay * by) / (la * lb)
                    }
                };
                for i in 1..n.saturating_sub(1) {
                    if radii[i] > 0.5 && turn_cos(centers[i - 1], centers[i], centers[i + 1]) < COS_CORNER {
                        add_disc(&mut builder, centers[i], radii[i], ccw);
                    }
                }
                // Closed seam: its endpoints coincide, so the corner there is between
                // the last real segment and the first.
                if closed
                    && n >= 3
                    && radii[0] > 0.5
                    && turn_cos(centers[n - 2], centers[0], centers[1]) < COS_CORNER
                {
                    add_disc(&mut builder, centers[0], radii[0], ccw);
                }
                any = true;
            }
        }
        if !measure.next_contour() {
            break;
        }
    }

    if !any {
        return None;
    }
    // Union the capsules (per-segment quads + corner discs) into ONE simple,
    // non-self-intersecting outline via SkPathOps `simplify()`. All pieces are
    // wound the same way, so the union is well-defined; simplify collapses the
    // many overlapping subpaths into a single outline that can't hole and is
    // cheaper to re-fill each frame. Cache it so pan/zoom never rebuilds.
    let built = builder.detach();
    let result = built.simplify().unwrap_or(built);
    RIBBON_CACHE.with(|c| {
        let mut m = c.borrow_mut();
        if m.len() >= 64 {
            m.clear();
        }
        m.insert(key, result.clone());
    });
    Some(result)
}

/// Fill `ribbon` as a textured ("dry ink") stroke: a base coverage at `density`
/// opacity, overlaid with procedural grain (Perlin `fractal_noise` tinted to the
/// stroke color via a `SrcIn` blend) so the stroke breaks up into a grungy edge.
/// `scale` is the grain feature size in world units.
pub fn draw_grain(
    canvas: &skia::Canvas,
    ribbon: &Path,
    base_paint: &skia::Paint,
    scale: f32,
    density: f32,
) {
    let color = base_paint.color();
    let base_alpha = color.a() as f32;
    let d = density.clamp(0.0, 1.0);

    // Shadow / blur pass: an image filter is set on the paint. A grungy stroke's
    // shadow is its SILHOUETTE, not its texture — draw the solid ribbon once with
    // the filter and stop, so the shadow isn't doubled (two grain layers) or
    // shaped like the noise.
    if base_paint.image_filter().is_some() {
        let mut silhouette = base_paint.clone();
        silhouette.set_style(skia::PaintStyle::Fill);
        silhouette.set_path_effect(None);
        canvas.draw_path(ribbon, &silhouette);
        return;
    }

    // Base coverage — solid fill dimmed by `density` so a low value reads broken.
    let mut base = base_paint.clone();
    base.set_style(skia::PaintStyle::Fill);
    base.set_path_effect(None);
    base.set_alpha((base_alpha * d) as u8);
    canvas.draw_path(ribbon, &base);

    // Grain overlay.
    let freq = 1.0 / scale.max(1.0);
    if let Some(noise) = skia::shaders::fractal_noise((freq, freq), 4, 0.0, None) {
        let mut grain = base_paint.clone();
        grain.set_style(skia::PaintStyle::Fill);
        grain.set_path_effect(None);
        // Tint the grayscale noise to the stroke color, keeping the noise alpha.
        match skia::color_filters::blend(color, skia::BlendMode::SrcIn) {
            Some(cf) => grain.set_shader(noise.with_color_filter(&cf)),
            None => grain.set_shader(noise),
        };
        canvas.draw_path(ribbon, &grain);
    }
}

/// Width multiplier (0..1) at arc-fraction `t` for each preset envelope.
fn profile_factor(profile: WidthProfile, t: f32) -> f32 {
    match profile {
        WidthProfile::Uniform => 1.0,
        // 0 at both ends, 1 in the middle (leaf / calligraphic).
        WidthProfile::TaperBoth => (t * std::f32::consts::PI).sin().max(0.0),
        // Thin start → full end.
        WidthProfile::TaperStart => t.clamp(0.0, 1.0),
        // Full start → thin end.
        WidthProfile::TaperEnd => (1.0 - t).clamp(0.0, 1.0),
        // Thick middle with non-zero ends.
        WidthProfile::Bulge => 0.35 + 0.65 * (t * std::f32::consts::PI).sin().max(0.0),
        // Custom is driven by `width_points`; this is only the empty fallback.
        WidthProfile::Custom => 1.0,
    }
}
