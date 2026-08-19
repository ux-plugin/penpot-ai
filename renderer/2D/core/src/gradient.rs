//! Penpot's three gradient kinds as a peniko gradient plus a paint transform.
//!
//! Computed once for both backends. render-wasm builds the equivalent Skia shaders in
//! `shapes/fills.rs`; that code stays as the Skia renderer's own path, but the *projection* into
//! the neutral model comes through here, so the two cannot drift on a rotation or a seam.
//!
//! # The two spaces
//!
//! Penpot's exporter emits every gradient coordinate normalised to `0..1` of the shape's own box.
//! Mapping that unit box onto the shape is the caller's job — it needs the bounds, which a fill
//! does not carry. What is returned here is everything *inside* the unit box: for a linear
//! gradient nothing at all, and for the other two a rotation, an ellipse scale, or a shear that
//! peniko's gradient types cannot express on their own.
//!
//! So the full chain is `unit_box_to(bounds) · transform`, and a caller that forgets the first
//! factor draws the whole gradient inside one pixel at the page origin.

use crate::kurbo::{Affine, Point};
use crate::peniko::color::{AlphaColor, DynamicColor, Srgb};
use crate::peniko::{ColorStop, Gradient};

/// Which of Penpot's gradients this is. Diamond is absent on purpose: it has no peniko
/// equivalent and rides with the Phase-4 custom shaders (D10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GradientShape {
    Linear,
    Radial,
    Angular,
}

/// A gradient's normalised geometry, straight off the wire.
///
/// `width` is overloaded by kind, which is the wire format's doing rather than ours: for radial
/// it is `(ellipse_ratio, unused)`, and for angular it is a *point* — the end of the second axis,
/// which need not be perpendicular to the first, so angular gradients can shear.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GradientGeometry {
    pub start: (f32, f32),
    pub end: (f32, f32),
    pub width: (f32, f32),
}

/// Build the paint for a gradient, or `None` when it is degenerate.
///
/// `None` means "do not paint this fill" rather than "paint it wrong": a zero-length radial has
/// no direction to rotate to, and inventing one puts recognisable but incorrect paint on screen.
pub fn gradient_paint(
    shape: GradientShape,
    geometry: GradientGeometry,
    stops: &[ColorStop],
) -> Option<(Gradient, Affine)> {
    match shape {
        GradientShape::Linear => Some((
            Gradient::new_linear(point(geometry.start), point(geometry.end))
                .with_stops(stops),
            Affine::IDENTITY,
        )),
        GradientShape::Radial => radial(geometry, stops),
        GradientShape::Angular => angular(geometry, stops),
    }
}

/// Mirrors `Gradient::to_radial_shader`.
///
/// The radius is the *distance* from start to end, not a stored scalar, and the gradient is then
/// rotated to that direction and squashed by `width.0` into an ellipse. Reading the radius from
/// `width` instead — which the field name invites — gives a circle of the wrong size pointing the
/// wrong way.
fn radial(g: GradientGeometry, stops: &[ColorStop]) -> Option<(Gradient, Affine)> {
    let dx = f64::from(g.end.0 - g.start.0);
    let dy = f64::from(g.end.1 - g.start.1);
    let radius_sq = dx * dx + dy * dy;
    if radius_sq < 1e-18 {
        return None;
    }
    let radius = radius_sq.sqrt().max(1e-6);
    let angle = dy.atan2(dx) + core::f64::consts::FRAC_PI_2;
    let centre = point(g.start);

    let transform = Affine::translate((centre.x, centre.y))
        * Affine::rotate(angle)
        * Affine::scale_non_uniform(f64::from(g.width.0), 1.0)
        * Affine::translate((-centre.x, -centre.y));

    let gradient = Gradient::new_radial(centre, radius as f32)
        .with_stops(stops);
    Some((gradient, transform))
}

/// Mirrors `Gradient::to_angular_shader`.
///
/// The sweep itself is fixed — centred at `(0.5, 0.5)`, a full turn from zero — and *all* of the
/// placement lives in the transform, built from two axes that need not be perpendicular. That is
/// what lets an angular gradient shear, which a peniko sweep cannot express by itself.
fn angular(g: GradientGeometry, stops: &[ColorStop]) -> Option<(Gradient, Affine)> {
    let cx = f64::from(g.start.0);
    let cy = f64::from(g.start.1);
    let v1x = f64::from(g.end.0) - cx;
    let v1y = f64::from(g.end.1) - cy;
    let v2x = f64::from(g.width.0) - cx;
    let v2y = f64::from(g.width.1) - cy;

    let axes = Affine::new([2.0 * v1x, 2.0 * v1y, 2.0 * v2x, 2.0 * v2y, 0.0, 0.0]);
    if axes.determinant().abs() < 1e-12 {
        return None;
    }

    let transform =
        Affine::translate((cx, cy)) * axes * Affine::translate((-0.5, -0.5));

    let gradient = Gradient::new_sweep(
        Point::new(0.5, 0.5),
        0.0,
        core::f32::consts::TAU,
    )
    .with_stops(&wrap_angular_stops(stops)[..]);

    Some((gradient, transform))
}

/// Close the seam of an angular gradient.
///
/// A sweep meets itself at 3 o'clock. If the stops do not already reach both ends, the colour
/// jumps there — a hard radial line across the shape. Skia's `angular_wrapped_stops` adds the
/// interpolated seam colour at 0 and 1; this is the same rule, and it has to live beside the
/// transform or one backend draws the line and the other does not.
fn wrap_angular_stops(stops: &[ColorStop]) -> Vec<ColorStop> {
    const EPSILON: f32 = 1e-6;

    if stops.len() < 2 {
        return stops.to_vec();
    }
    let first = stops[0];
    let last = *stops.last().expect("checked non-empty");

    let needs_start = first.offset > EPSILON;
    let needs_end = last.offset < 1.0 - EPSILON;
    if !needs_start && !needs_end {
        return stops.to_vec();
    }

    let gap = match (needs_start, needs_end) {
        (true, true) => (1.0 - last.offset) + first.offset,
        (true, false) => first.offset,
        (false, true) => 1.0 - last.offset,
        (false, false) => unreachable!("handled above"),
    };
    let seam = |a: ColorStop, b: ColorStop| {
        if gap <= EPSILON {
            return a.color;
        }
        let t = (1.0 - last.offset) / gap;
        let (from, to) = (a.color.to_alpha_color::<Srgb>(), b.color.to_alpha_color::<Srgb>());
        let mut out = from.components;
        for (slot, end) in out.iter_mut().zip(to.components) {
            *slot += (end - *slot) * t;
        }
        DynamicColor::from_alpha_color(AlphaColor::<Srgb>::new(out))
    };

    let mut out = Vec::with_capacity(stops.len() + 2);
    if needs_start {
        out.push(ColorStop {
            offset: 0.0,
            color: if needs_end { seam(last, first) } else { last.color },
        });
    }
    out.extend_from_slice(stops);
    if needs_end {
        out.push(ColorStop {
            offset: 1.0,
            color: if needs_start { seam(last, first) } else { first.color },
        });
    }
    out
}

/// The map from unit-box space into diamond-local space, where `|p.x| + |p.y| = 1` is the
/// gradient's outer edge. `None` when the span is degenerate — no direction to build the field
/// along, so painting it would be a guess.
///
/// Mirrors render-wasm's `to_diamond_shader` inverse matrix: rotate by the span's angle, squash
/// by `width.0`, and divide by the span length so distance 1 lands at the far stop. The element
/// order is the angular-gradient trap again — `a`/`b` is the x-basis, `c`/`d` the y-basis.
pub fn diamond_transform(g: GradientGeometry) -> Option<Affine> {
    let dx = f64::from(g.end.0 - g.start.0);
    let dy = f64::from(g.end.1 - g.start.1);
    let r = (dx * dx + dy * dy).sqrt();
    if r < 1e-6 {
        return None;
    }
    let angle = dy.atan2(dx);
    let (cos_a, sin_a) = (angle.cos(), angle.sin());
    let aspect = if g.width.0 > 0.0 { f64::from(g.width.0) } else { 1.0 };

    let linear = Affine::new([
        cos_a / r,
        -sin_a / (r * aspect),
        sin_a / r,
        cos_a / (r * aspect),
        0.0,
        0.0,
    ]);
    let centre = point(g.start);
    Some(linear * Affine::translate((-centre.x, -centre.y)))
}

/// The colour at ramp position `t`, as straight (unpremultiplied) `RGBA8`.
///
/// Component-wise linear interpolation in sRGB, matching Skia's shader sampling and the seam
/// wrapping above — a perceptually smarter blend would be a worse match, and the point is to
/// agree with how this very engine draws the gradient.
pub fn sample_stops(stops: &[ColorStop], t: f32) -> [u8; 4] {
    if stops.is_empty() {
        return [0, 0, 0, 0];
    }
    let t = t.clamp(0.0, 1.0);
    if t <= stops[0].offset {
        return srgb_u8(stops[0]);
    }
    if t >= stops[stops.len() - 1].offset {
        return srgb_u8(stops[stops.len() - 1]);
    }
    let hi = stops.iter().position(|s| s.offset >= t).unwrap_or(stops.len() - 1);
    let (a, b) = (stops[hi - 1], stops[hi]);
    let span = b.offset - a.offset;
    let f = if span > f32::EPSILON { (t - a.offset) / span } else { 0.0 };

    let ca = a.color.to_alpha_color::<Srgb>().components;
    let cb = b.color.to_alpha_color::<Srgb>().components;
    let mut out = [0u8; 4];
    for i in 0..4 {
        out[i] = ((ca[i] + (cb[i] - ca[i]) * f) * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    out
}

fn srgb_u8(stop: ColorStop) -> [u8; 4] {
    let c = stop.color.to_alpha_color::<Srgb>().components;
    [
        (c[0] * 255.0).round() as u8,
        (c[1] * 255.0).round() as u8,
        (c[2] * 255.0).round() as u8,
        (c[3] * 255.0).round() as u8,
    ]
}

/// The edge length of the square tile a diamond gradient is baked into. It has no peniko paint
/// kind, so it is rasterised to this `DIAMOND_TILE × DIAMOND_TILE` field and drawn as an image;
/// both the bake ([`bake_diamond_rgba`]) and the draw path key off this one size.
pub const DIAMOND_TILE: u32 = 512;

/// Bake the diamond field into a `size × size` tile of straight RGBA, row-major, top-left origin.
///
/// The tile is unit-box space, so a caller draws it with `unit_box_to(bounds)` exactly like a
/// gradient — the aspect distortion of a non-square shape comes from that mapping, matching
/// render-wasm, which evaluates its shader in the shape's normalised space too. `None` when the
/// gradient is degenerate.
pub fn bake_diamond_rgba(g: GradientGeometry, stops: &[ColorStop], size: u32) -> Option<Vec<u8>> {
    let inv = diamond_transform(g)?;
    let mut out = vec![0u8; (size as usize) * (size as usize) * 4];
    let s = f64::from(size);
    for y in 0..size {
        for x in 0..size {
            let u = (f64::from(x) + 0.5) / s;
            let v = (f64::from(y) + 0.5) / s;
            let p = inv * Point::new(u, v);
            let t = (p.x.abs() + p.y.abs()) as f32;
            let rgba = sample_stops(stops, t);
            let i = ((y as usize) * (size as usize) + (x as usize)) * 4;
            out[i..i + 4].copy_from_slice(&rgba);
        }
    }
    Some(out)
}

fn point(p: (f32, f32)) -> Point {
    Point::new(f64::from(p.0), f64::from(p.1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::peniko::Color;

    fn stops(offsets: &[f32]) -> Vec<ColorStop> {
        offsets
            .iter()
            .map(|o| ColorStop {
                offset: *o,
                color: Color::from_rgba8(255, 0, 0, 255).into(),
            })
            .collect()
    }

    /// Linear needs no transform of its own — the caller's unit-box mapping is the whole job.
    #[test]
    fn linear_is_the_identity() {
        let (g, t) = gradient_paint(
            GradientShape::Linear,
            GradientGeometry {
                start: (0.0, 0.0),
                end: (1.0, 0.0),
                width: (0.0, 0.0),
            },
            &stops(&[0.0, 1.0]),
        )
        .expect("a linear gradient is never degenerate");

        assert_eq!(t, Affine::IDENTITY);
        assert!(matches!(g.kind, crate::peniko::GradientKind::Linear(_)));
    }

    /// The radius comes from the distance between the two points. Reading it off `width` — which
    /// the field name invites — is the mistake this pins.
    #[test]
    fn radial_takes_its_radius_from_the_span() {
        let (g, _) = gradient_paint(
            GradientShape::Radial,
            GradientGeometry {
                start: (0.5, 0.5),
                end: (0.9, 0.5),
                width: (1.0, 0.0),
            },
            &stops(&[0.0, 1.0]),
        )
        .unwrap();

        match g.kind {
            crate::peniko::GradientKind::Radial(p) => {
                assert!((p.end_radius - 0.4).abs() < 1e-5, "{}", p.end_radius);
            }
            other => panic!("expected radial, got {other:?}"),
        }
    }

    /// A radial with no span has no direction to rotate to; painting it would be a guess.
    #[test]
    fn a_degenerate_radial_is_dropped() {
        assert!(
            gradient_paint(
                GradientShape::Radial,
                GradientGeometry {
                    start: (0.5, 0.5),
                    end: (0.5, 0.5),
                    width: (1.0, 0.0),
                },
                &stops(&[0.0, 1.0]),
            )
            .is_none()
        );
    }

    /// `width` squashes the circle into an ellipse, so it must reach the transform rather than
    /// the radius — a ratio of 1 and of 0.5 cannot produce the same matrix.
    #[test]
    fn the_ellipse_ratio_lands_in_the_transform() {
        let geometry = |w: f32| GradientGeometry {
            start: (0.5, 0.5),
            end: (0.9, 0.5),
            width: (w, 0.0),
        };
        let round = gradient_paint(GradientShape::Radial, geometry(1.0), &stops(&[0.0, 1.0]))
            .unwrap()
            .1;
        let squashed = gradient_paint(GradientShape::Radial, geometry(0.5), &stops(&[0.0, 1.0]))
            .unwrap()
            .1;
        assert_ne!(round, squashed);
    }

    /// Angular's two axes need not be perpendicular; a sheared pair must survive into the matrix,
    /// because that is the one thing a peniko sweep cannot say on its own.
    #[test]
    fn angular_keeps_its_shear() {
        let (_, sheared) = gradient_paint(
            GradientShape::Angular,
            GradientGeometry {
                start: (0.5, 0.5),
                end: (1.0, 0.5),
                width: (0.8, 1.0),
            },
            &stops(&[0.0, 1.0]),
        )
        .unwrap();
        let (_, square) = gradient_paint(
            GradientShape::Angular,
            GradientGeometry {
                start: (0.5, 0.5),
                end: (1.0, 0.5),
                width: (0.5, 1.0),
            },
            &stops(&[0.0, 1.0]),
        )
        .unwrap();
        assert_ne!(sheared, square);

        let [a, b, c, d, ..] = sheared.as_coeffs();
        assert!((a * c + b * d).abs() > 1e-9);
    }

    /// Stops that do not reach both ends leave a hard line at the seam unless it is closed.
    #[test]
    fn angular_closes_its_seam() {
        let (g, _) = gradient_paint(
            GradientShape::Angular,
            GradientGeometry {
                start: (0.5, 0.5),
                end: (1.0, 0.5),
                width: (0.5, 1.0),
            },
            &stops(&[0.25, 0.75]),
        )
        .unwrap();

        assert_eq!(g.stops.len(), 4, "a stop added at each end");
        assert_eq!(g.stops[0].offset, 0.0);
        assert_eq!(g.stops[3].offset, 1.0);
        assert_eq!(
            g.stops[0].color, g.stops[3].color,
            "both ends must be the same colour, or the seam is still visible"
        );
    }

    /// …and stops that already span the full turn are left exactly as they are.
    #[test]
    fn angular_leaves_a_closed_ring_alone() {
        let (g, _) = gradient_paint(
            GradientShape::Angular,
            GradientGeometry {
                start: (0.5, 0.5),
                end: (1.0, 0.5),
                width: (0.5, 1.0),
            },
            &stops(&[0.0, 1.0]),
        )
        .unwrap();
        assert_eq!(g.stops.len(), 2);
    }

    /// The bake must put the ramp's start colour at the centre and the end colour at the L1 edge,
    /// with a diamond (not circular) contour between — that is the whole point of the metric.
    #[test]
    fn diamond_bake_puts_the_ramp_along_the_l1_distance() {
        let stops = &[
            ColorStop {
                offset: 0.0,
                color: Color::from_rgba8(255, 0, 0, 255).into(),
            },
            ColorStop {
                offset: 1.0,
                color: Color::from_rgba8(0, 0, 255, 255).into(),
            },
        ];
        let g = GradientGeometry {
            start: (0.5, 0.5),
            end: (1.0, 0.5),
            width: (1.0, 0.0),
        };
        let size = 64u32;
        let rgba = bake_diamond_rgba(g, stops, size).expect("not degenerate");
        let at = |x: u32, y: u32| {
            let i = ((y * size + x) * 4) as usize;
            [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
        };
        let c = size / 2;

        let [r, _, b, _] = at(c, c);
        assert!(r > 200 && b < 60, "centre should be the start colour, got {:?}", at(c, c));

        let axis = at((0.98 * f64::from(size)) as u32, c);
        assert!(axis[2] > axis[0], "far along the axis should trend to the end colour: {axis:?}");
    }

    /// A degenerate diamond has no span to build the field along, so there is nothing to bake.
    #[test]
    fn a_degenerate_diamond_does_not_bake() {
        let g = GradientGeometry {
            start: (0.5, 0.5),
            end: (0.5, 0.5),
            width: (1.0, 0.0),
        };
        assert!(bake_diamond_rgba(g, &[], 16).is_none());
    }
}
