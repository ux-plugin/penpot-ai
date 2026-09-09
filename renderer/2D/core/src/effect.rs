//! One ordered effect list, derived from the node's five authoring fields.
//!
//! A [`Node`] stores its effects in five parallel shapes — `shadows`, `blur`, `background_blur` /
//! `glass`, `effects`, `filter_graph` — because that is how they are *authored*. A design tool really
//! does treat a shadow as a different concept from a custom shader. A renderer does not: it only ever
//! needs to know what an effect reads, how far it reads, and how the result lands back in the scene.
//!
//! Keeping the authoring shape as the rendering shape has a concrete cost. Every optimisation has to
//! be written once per representation: the atlas prepass needs a planner per kind, dedup can't see
//! that a drop shadow and an inner shadow fill the same outline, and `whole_viewport_can_render` has
//! to enumerate special cases. Five representations means five implementations of everything.
//!
//! So this module *derives* a single ordered [`Effect`] list. Storage does not move — the authoring
//! fields stay exactly as they are, and nothing about the format, the ABI or the frontend changes.
//! What changes is that renderer code can stop asking "which field was this?" and start asking the
//! three questions that actually decide scheduling:
//!
//! - [`Source`] — does it read the shape's coverage, its isolated body, or the backdrop beneath it?
//! - [`Reach`](crate::footprint::Reach) — does it read at its own pixel, or a neighbourhood?
//! - [`Compose`] — does the result go under the body, over it, replace it, or show through it?
//!
//! Everything else is parameters. A drop shadow *is* "read coverage, offset, blur, tint, compose
//! under"; nothing about it needs a dedicated field once you say that.
//!
//! The derived order is the order the renderer already composites in, and each field's own authored
//! list order is preserved within its group.

use crate::kurbo::{Rect, Vec2};
use crate::model::{Glass, Node};
use crate::peniko::Color;

/// What an effect reads as its input.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// The shape's own coverage — its filled outline as an alpha mask, dilated by `spread`. Shadows
    /// read this. Two effects with equal `spread` read *identical* pixels, which is what makes them
    /// dedupable without knowing anything about shadows.
    Coverage { spread: f32 },
    /// The node's own paint and its children, rendered in isolation.
    Body,
    /// Whatever is already painted beneath the shape. Forces z-order interleaving, because the
    /// backdrop has to be finished before the effect can run.
    Backdrop,
}

/// How an effect's result lands back in the scene, relative to the node's body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Compose {
    /// Behind the body — a drop shadow.
    Under,
    /// On top of the body — an inner shadow.
    Over,
    /// Becomes the body — a layer blur or a body-only shader chain.
    Replace,
    /// On top, clipped to the shape's coverage — the gathers (background blur, glass).
    ThroughCoverage,
}

/// One step in an effect's own pipeline, applied in order.
#[derive(Clone, Debug)]
pub enum Op {
    /// Gaussian blur of `radius` **page-space** units (converted to a device sigma by the consumer).
    Blur { radius: f32 },
    /// Multiply by a flat colour.
    Tint(Color),
    /// Translate by a **shape-local** vector.
    Offset(Vec2),
    /// Erase by this effect's own source, offset and blurred — the inner shadow's punch.
    EraseBy { offset: Vec2, blur: f32 },
    /// Warp by a fractal-noise displacement (the texture effect): a `Warp` unit over the noise
    /// field, optionally clipped back to the source coverage. `magnitude` is the maximum per-axis
    /// shift in page-space units; `grain` divides the sample position (larger = coarser).
    NoiseWarp { magnitude: f32, grain: f32, clip: bool },
    /// The glass refraction/frost pipeline.
    Lens(Box<Glass>),
    /// Tint faded by a radial ramp from the shape's centre (the background-field tint): a `Tint`
    /// plus a `MaskMix` measuring the radial field. Pointwise — no reach of its own.
    FieldTint(Color),
}

/// Lower one authored filter node to the op it runs as.
///
/// A filter graph is the one authoring route where the chain is written directly rather than implied
/// by a named effect, so it lowers into the *same* body ops a layer blur already uses — no path of
/// its own. `None` for the one that is not a body transform: an inner shadow composites over the
/// shape rather than replacing it, so it is dropped here rather than mis-rendered.
fn filter_op(n: &crate::model::FilterNode) -> Option<Op> {
    use crate::model::FilterNode;
    match n {
        FilterNode::Blur { sigma } => Some(Op::Blur { radius: crate::blur::sigma_to_radius(*sigma) }),
        FilterNode::Offset { dx, dy } => Some(Op::Offset(Vec2::new(f64::from(*dx), f64::from(*dy)))),
        FilterNode::InnerShadow { .. } => None,
    }
}

/// One effect, in the only three terms a renderer needs.
#[derive(Clone, Debug)]
pub struct Effect {
    pub source: Source,
    pub ops: Vec<Op>,
    pub compose: Compose,
}

impl Effect {
    /// How far this effect reads past the pixel it writes, in page-space units. `0.0` means it reads
    /// only its own pixel, so it can fuse into a neighbour instead of materialising a texture.
    #[must_use]
    pub fn reach(&self) -> f32 {
        self.ops
            .iter()
            .map(|op| match op {
                Op::Blur { radius } => 3.0 * crate::blur::radius_to_sigma(*radius),
                Op::EraseBy { offset, blur } => {
                    3.0 * crate::blur::radius_to_sigma(*blur) + offset.x.abs().max(offset.y.abs()) as f32
                }
                Op::Offset(o) => o.x.abs().max(o.y.abs()) as f32,
                Op::NoiseWarp { magnitude, .. } => *magnitude,
                Op::Lens(g) => 3.0 * g.total_blur_sigma(),
                Op::Tint(_) | Op::FieldTint(_) => 0.0,
            })
            .fold(0.0_f32, f32::max)
    }

    /// The page-space rect this effect covers, given the shape's page bounds.
    ///
    /// The pipeline is walked in order and each op is applied to the running rect, because footprint
    /// **composes**: a silhouette dilated by spread, then translated by an offset, then blurred, ends
    /// up displaced by all three. Taking a maximum instead would undersize the surface and clip the
    /// result. `EraseBy` unions its own offset copy, since the band spans both positions.
    #[must_use]
    pub fn footprint(&self, base: Rect) -> Rect {
        let mut r = match self.source {
            Source::Coverage { spread } => base.inflate(f64::from(spread), f64::from(spread)),
            Source::Body | Source::Backdrop => base,
        };
        for op in &self.ops {
            r = match op {
                Op::Offset(o) => Rect::new(r.x0 + o.x, r.y0 + o.y, r.x1 + o.x, r.y1 + o.y),
                Op::Blur { radius } => {
                    let reach = f64::from(3.0 * crate::blur::radius_to_sigma(*radius));
                    r.inflate(reach, reach)
                }
                Op::EraseBy { offset, blur } => {
                    let reach = f64::from(3.0 * crate::blur::radius_to_sigma(*blur));
                    r.union(Rect::new(r.x0 + offset.x, r.y0 + offset.y, r.x1 + offset.x, r.y1 + offset.y))
                        .inflate(reach, reach)
                }
                Op::NoiseWarp { magnitude, .. } => r.inflate(f64::from(*magnitude), f64::from(*magnitude)),
                Op::Tint(_) | Op::FieldTint(_) => r,
                Op::Lens(g) => {
                    let reach = f64::from(3.0 * g.total_blur_sigma());
                    r.inflate(reach, reach)
                }
            };
        }
        r
    }

    /// The blur **radius** that governs this effect's render scale, if any — the last blur in the
    /// chain. A blur applied last softens everything before it, so the whole chain tolerates that
    /// blur's band limit; an earlier op's sharper requirement no longer applies.
    #[must_use]
    pub fn governing_blur(&self) -> Option<f32> {
        self.ops.iter().rev().find_map(|op| match op {
            Op::Blur { radius } => Some(*radius),
            Op::EraseBy { blur, .. } => Some(*blur),
            _ => None,
        })
    }

    /// Whether this effect has to wait for the backdrop beneath the shape to be finished.
    #[must_use]
    pub fn reads_backdrop(&self) -> bool {
        self.source == Source::Backdrop
    }
}

/// The node's effects as ONE ordered list.
///
/// The order is the order they composite in, which is what the whole-viewport stack and the tiled
/// scheduler already do — drop shadows behind, then a backdrop gather, then the body with its own
/// shader chain and layer blur, then inner shadows on top. Within each group the authored list order
/// is preserved, because the author's ordering is meaningful (a `[texture, noise]` chain warps then
/// colours; reversing it is a different picture).
///
/// `filter_graph` is deliberately absent: it is a typed chain wrapping the node *and its children*,
/// which is a layer concern rather than a per-node effect, and it is the one case still routed to the
/// tiled path.
/// Authored texture radius → device displacement magnitude: the slider's 0–100 maps to up to 300px
/// of shift, the scale the effect always shipped with.
pub const TEXTURE_RADIUS_SCALE: f32 = 3.0;

#[must_use]
pub fn effect_stack(node: &Node) -> Vec<Effect> {
    let mut out = Vec::new();

    for s in node.shadows.iter().filter(|s| !s.inset) {
        out.push(Effect {
            source: Source::Coverage { spread: s.spread },
            ops: vec![Op::Offset(s.offset), Op::Blur { radius: s.blur }, Op::Tint(s.color)],
            compose: Compose::Under,
        });
    }

    if let Some(g) = &node.glass {
        out.push(Effect {
            source: Source::Backdrop,
            ops: vec![Op::Lens(Box::new(g.clone()))],
            compose: Compose::ThroughCoverage,
        });
    } else if let Some(radius) = node.background_blur {
        out.push(Effect {
            source: Source::Backdrop,
            ops: vec![Op::Blur { radius }],
            compose: Compose::ThroughCoverage,
        });
    } else if let Some(color) = node.background_tint {
        out.push(Effect {
            source: Source::Backdrop,
            ops: vec![Op::Tint(color)],
            compose: Compose::ThroughCoverage,
        });
    } else if let Some(color) = node.background_field {
        out.push(Effect {
            source: Source::Backdrop,
            ops: vec![Op::FieldTint(color)],
            compose: Compose::ThroughCoverage,
        });
    }

    let body_ops: Vec<Op> = node
        .texture
        .iter()
        .filter(|t| !t.hidden && t.radius > 0.0)
        .map(|t| Op::NoiseWarp {
            magnitude: t.radius * TEXTURE_RADIUS_SCALE,
            grain: t.noise_size.max(1.0),
            clip: t.clip_to_shape,
        })
        .chain(node.blur.map(|radius| Op::Blur { radius }))
        .chain(node.filter_graph.iter().flat_map(|g| g.nodes.iter()).filter_map(filter_op))
        .collect();
    if !body_ops.is_empty() {
        out.push(Effect { source: Source::Body, ops: body_ops, compose: Compose::Replace });
    }

    for s in node.shadows.iter().filter(|s| s.inset) {
        out.push(Effect {
            source: Source::Coverage { spread: s.spread },
            ops: vec![Op::Tint(s.color), Op::EraseBy { offset: s.offset, blur: s.blur }],
            compose: Compose::Over,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Shadow, ShapeKind};

    fn node() -> Node {
        Node::new(1, ShapeKind::Path)
    }

    fn shadow(inset: bool, blur: f32) -> Shadow {
        Shadow {
            color: Color::BLACK,
            blur,
            spread: 0.0,
            offset: Vec2::new(4.0, 5.0),
            inset,
        }
    }

    /// Every authoring field has to reach the derived list — a field silently dropped here would be an
    /// effect that stops rendering.
    #[test]
    fn every_authoring_field_is_represented() {
        let mut n = node();
        n.shadows = vec![shadow(false, 8.0), shadow(true, 6.0)];
        n.blur = Some(3.0);
        n.background_blur = Some(9.0);

        let stack = effect_stack(&n);
        assert_eq!(stack.len(), 4, "drop, gather, body, inner");
        assert_eq!(stack[0].compose, Compose::Under);
        assert_eq!(stack[1].compose, Compose::ThroughCoverage);
        assert_eq!(stack[2].compose, Compose::Replace);
        assert_eq!(stack[3].compose, Compose::Over);
    }

    /// The composite order is the order the renderer paints in; getting it wrong reorders the picture.
    #[test]
    fn drops_go_under_and_inners_go_over_the_body() {
        let mut n = node();
        n.shadows = vec![shadow(true, 6.0), shadow(false, 8.0)];
        n.blur = Some(3.0);
        let order: Vec<Compose> = effect_stack(&n).iter().map(|e| e.compose).collect();
        assert_eq!(order, vec![Compose::Under, Compose::Replace, Compose::Over]);
    }

    /// Two shadows with equal spread read the same pixels — the property that lets a scheduler dedup
    /// them without knowing what a shadow is.
    #[test]
    fn equal_spread_coverage_sources_compare_equal() {
        let mut n = node();
        n.shadows = vec![shadow(false, 8.0), shadow(false, 2.0), shadow(true, 6.0)];
        let sources: Vec<Source> = effect_stack(&n).iter().map(|e| e.source.clone()).collect();
        assert!(sources.iter().all(|s| *s == Source::Coverage { spread: 0.0 }));
    }

    /// Only backdrop readers force z-order interleaving; everything else can be scheduled freely.
    #[test]
    fn only_backdrop_sources_report_reading_the_backdrop() {
        let mut n = node();
        n.shadows = vec![shadow(false, 8.0)];
        n.background_blur = Some(9.0);
        n.blur = Some(3.0);
        let reads: Vec<bool> = effect_stack(&n).iter().map(Effect::reads_backdrop).collect();
        assert_eq!(reads, vec![false, true, false]);
    }

    /// Reach is what decides whether an effect can fuse or has to materialise a texture.
    #[test]
    fn tint_only_effects_have_no_reach_but_blurs_do() {
        let flat = Effect { source: Source::Body, ops: vec![Op::Tint(Color::BLACK)], compose: Compose::Replace };
        assert_eq!(flat.reach(), 0.0);
        let blurred = Effect { source: Source::Body, ops: vec![Op::Blur { radius: 10.0 }], compose: Compose::Replace };
        assert!(blurred.reach() > 0.0);
    }

    /// Footprint composes along the chain — a spread silhouette, shifted, then blurred is displaced
    /// by all three. This is the property that sizes every effect surface.
    #[test]
    fn footprint_composes_spread_offset_and_blur() {
        let mut n = node();
        n.shadows = vec![Shadow { spread: 2.0, ..shadow(false, 8.0) }];
        let e = &effect_stack(&n)[0];
        let base = Rect::new(0.0, 0.0, 10.0, 10.0);
        let f = e.footprint(base);
        let blur_reach = f64::from(3.0 * crate::blur::radius_to_sigma(8.0));
        assert!((f.x0 - (0.0 - 2.0 + 4.0 - blur_reach)).abs() < 1e-9);
        assert!((f.y1 - (10.0 + 2.0 + 5.0 + blur_reach)).abs() < 1e-9);
    }

    /// An inner shadow's band spans both the shape and its offset punch, so the footprint unions them.
    #[test]
    fn inner_shadow_footprint_unions_the_offset_punch() {
        let mut n = node();
        n.shadows = vec![shadow(true, 6.0)];
        let base = Rect::new(0.0, 0.0, 10.0, 10.0);
        let f = effect_stack(&n)[0].footprint(base);
        let blur_reach = f64::from(3.0 * crate::blur::radius_to_sigma(6.0));
        assert!((f.x0 - (0.0 - blur_reach)).abs() < 1e-9, "unshifted side kept");
        assert!((f.x1 - (10.0 + 4.0 + blur_reach)).abs() < 1e-9, "shifted side included");
    }

    /// A trailing blur governs the render scale.
    #[test]
    fn a_trailing_blur_governs_the_render_scale() {
        let mut n = node();
        n.blur = Some(4.0);
        let e = &effect_stack(&n)[0];
        assert_eq!(e.governing_blur(), Some(4.0));
    }

    #[test]
    fn a_node_with_no_effects_derives_an_empty_stack() {
        assert!(effect_stack(&node()).is_empty());
    }
}
