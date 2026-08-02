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
#[derive(Debug, Clone, Copy)]
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
    // `+ 90°` because the stored direction is the gradient's *vertical* axis, which is what
    // makes an un-squashed radial look identical however it is rotated — until `width` is not 1.
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

    // Column-major `[a, b, c, d, e, f]`: `(a, b)` is the x-basis and `(c, d)` the y-basis. Skia
    // spells the same matrix row-major in `new_all`, which is the element-order trap this
    // codebase keeps meeting — writing the axes in Skia's order here transposes the shear.
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
    // Component-wise in sRGB, matching Skia's `lerp_color` — which interpolates the raw channels
    // with no colour-space conversion. A perceptually smarter blend here would be a *better*
    // seam colour and a worse match, and the two backends must agree on the pixel.
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
        // x-basis and y-basis are not perpendicular — that is the shear, surviving.
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
}
