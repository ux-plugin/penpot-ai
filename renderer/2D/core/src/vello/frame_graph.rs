//! Contract 1: the frame graph — what the frame is made of, and nothing about where or when.
//!
//! The scene walk produces it; the scheduler consumes it. A node is an operation over positional
//! inputs. Geometry enters exactly once, as a draw item's device bounds; every other footprint is
//! a pure function of the graph ([`FrameGraph::extents`], [`pad`]). Scene references live only in
//! draw items; a node never says which texture, rect, round or binding it will use.

use crate::kurbo::Rect;
use crate::peniko::Color;
pub use crate::vello::units::{BlurAxis, ComposeMode};

/// Index into [`FrameGraph::nodes`].
pub type NodeId = usize;
/// The document's shape id.
pub type ShapeId = u128;

/// The whole frame as structure: topological (a node cites only smaller indices), the LAST node
/// being the frame itself.
#[derive(Clone, Debug)]
pub struct FrameGraph {
    /// The viewport, device px.
    pub frame: Rect,
    /// The page colour the scheduler clears to.
    pub background: Color,
    pub nodes: Vec<GNode>,
}

/// One operation. `inputs` are positional; the op fixes their roles.
#[derive(Clone, Debug)]
pub struct GNode {
    pub op: Op,
    pub inputs: Vec<NodeId>,
    /// Dumps only; never branched on.
    pub label: String,
}

/// The operation alphabet. Spine ops (`Compose`, and a `Draw` over the state below) take that
/// state as `inputs[0]`; chain ops take a value (and, for the binary pointwise ops, a reference);
/// a `Draw` with no input inside a chain is a coverage or distance leaf.
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    /// Paint scene content over the state below. inputs = `[below]` (empty for the first draw,
    /// which paints over the cleared background).
    Draw(Vec<DrawItem>),
    /// One separable Gaussian axis. inputs = `[value]`.
    Blur { sigma: f32, axis: BlurAxis, linear: bool, edge_clamp_style: EdgeClampStyle },
    /// Lens units; the payload is the unit's uniform, field program included. inputs = `[value]`,
    /// or `[value, distance]` when the warp samples a drawn distance field.
    Warp(Vec<f32>),
    Scatter(Vec<f32>),
    Shade(Vec<f32>),
    /// Binary pointwise units. inputs = `[value, reference]`. `EraseBy`'s payload is
    /// `[dx, dy]`: the reference is read displaced by that device vector (the inner shadow's
    /// punch), so the reference is never drawn displaced.
    MaskMix(Vec<f32>),
    EraseBy(Vec<f32>),
    ClipToSource(Vec<f32>),
    /// The chain's straight colour. inputs = `[value]`.
    Colour(Vec<f32>),
    /// Land a value on the state below. inputs = `[below, value]` or `[below, value, coverage]`.
    /// `offset` translates the value as it is read — a shadow's displacement — so the value is
    /// never drawn displaced.
    Compose { mode: ComposeMode, colour: Option<[f32; 4]>, offset: [f32; 2] },
}

/// One thing a [`Op::Draw`] paints, z-ordered within its draw.
#[derive(Clone, Debug, PartialEq)]
pub struct DrawItem {
    pub shape: ShapeId,
    pub style: DrawStyle,
    /// Device px — the ONLY geometry in the graph.
    pub bounds: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DrawStyle {
    /// Fills, strokes, text, images; opacity, blend and clips stay inside.
    Body,
    /// The solid outline, dilated by `spread` page px. `analytic` says the marker's own rasterised
    /// area reproduces this coverage per pixel (false for glyph coverage).
    Coverage { analytic: bool, spread: f32 },
    /// The signed distance of the outline, encoded over `decode` device px.
    Distance { decode: f32 },
}

/// What a blur's out-of-bounds taps read: the clamped edge, or transparency.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum EdgeClampStyle {
    #[default]
    Extend,
    Transparent,
}

impl Op {
    /// How many inputs the op takes: `(min, max)`.
    #[must_use]
    pub fn arity(&self) -> (usize, usize) {
        match self {
            Op::Draw(_) => (0, 1),
            Op::Blur { .. } | Op::Scatter(_) | Op::Shade(_) | Op::Colour(_) => (1, 1),
            Op::Warp(_) => (1, 2),
            Op::MaskMix(_) | Op::EraseBy(_) | Op::ClipToSource(_) => (2, 2),
            Op::Compose { .. } => (2, 3),
        }
    }
}

/// How far an op's taps stray from the output pixel, device px: the neighbourhood a consumer
/// must be served beyond its own extent.
#[must_use]
pub fn pad(op: &Op) -> f32 {
    match op {
        Op::Blur { sigma, .. } => (3.0 * sigma).ceil() + 8.0,
        Op::Warp(_) | Op::Scatter(_) => 32.0,
        _ => 0.0,
    }
}

impl FrameGraph {
    /// Node `i` writes the state below: a compose, or a draw over a `below` input — or node 0,
    /// the root the spine grows from. A later draw with no input is a chain leaf (a coverage).
    #[must_use]
    pub fn is_spine(&self, i: NodeId) -> bool {
        match &self.nodes[i].op {
            Op::Compose { .. } => true,
            Op::Draw(_) => i == 0 || !self.nodes[i].inputs.is_empty(),
            _ => false,
        }
    }

    /// The structural invariants: topological order, arity per op, spine ops sitting on the spine
    /// (their `inputs[0]` is a spine node), chain ops reading only chain or spine values, and the
    /// last node being a spine node. `Err` names the first violation.
    pub fn validate(&self) -> Result<(), String> {
        if self.nodes.is_empty() {
            return Err("empty graph".into());
        }
        for (i, n) in self.nodes.iter().enumerate() {
            let (lo, hi) = n.op.arity();
            if n.inputs.len() < lo || n.inputs.len() > hi {
                return Err(format!("node {i} ({}): {} inputs, expected {lo}..={hi}", n.label, n.inputs.len()));
            }
            for &j in &n.inputs {
                if j >= i {
                    return Err(format!("node {i} ({}) cites node {j}: not topological", n.label));
                }
            }
            if self.is_spine(i) {
                if let Some(&below) = n.inputs.first().filter(|&&b| !self.is_spine(b)) {
                    return Err(format!("node {i} ({}): inputs[0] = {below} is not a spine node", n.label));
                }
            } else if n.inputs.is_empty() && !matches!(n.op, Op::Draw(_)) {
                return Err(format!("node {i} ({}): a chain op with no value", n.label));
            }
        }
        if !self.is_spine(self.nodes.len() - 1) {
            return Err("the last node is not a spine node".into());
        }
        Ok(())
    }

    /// Every node's device extent, computed forward: a draw is its items' union over the state
    /// below; a neighbourhood op inflates its value by [`pad`]; a pointwise op keeps its value's
    /// extent; a compose is the state below joined with the value, translated by its offset.
    #[must_use]
    pub fn extents(&self) -> Vec<Rect> {
        let mut ext: Vec<Rect> = Vec::with_capacity(self.nodes.len());
        for n in &self.nodes {
            let of = |i: usize| ext[i];
            let r = match &n.op {
                Op::Draw(items) => items
                    .iter()
                    .map(|it| it.bounds)
                    .chain(n.inputs.first().map(|&b| of(b)))
                    .reduce(|a, b| a.union(b))
                    .unwrap_or(Rect::ZERO),
                Op::Blur { .. } | Op::Warp(_) | Op::Scatter(_) => {
                    let p = f64::from(pad(&n.op));
                    of(n.inputs[0]).inflate(p, p)
                }
                Op::Shade(_) | Op::Colour(_) | Op::MaskMix(_) | Op::EraseBy(_) | Op::ClipToSource(_) => {
                    of(n.inputs[0])
                }
                Op::Compose { offset, .. } => {
                    let v = of(n.inputs[1]) + crate::kurbo::Vec2::new(f64::from(offset[0]), f64::from(offset[1]));
                    of(n.inputs[0]).union(v)
                }
            };
            ext.push(r);
        }
        ext
    }

    /// The chain a compose's value belongs to: every non-spine node reachable from `value`.
    #[must_use]
    pub fn chain_of(&self, value: NodeId) -> Vec<NodeId> {
        let mut seen = vec![false; self.nodes.len()];
        let mut stack = vec![value];
        let mut out = Vec::new();
        while let Some(i) = stack.pop() {
            if seen[i] || self.is_spine(i) {
                continue;
            }
            seen[i] = true;
            out.push(i);
            stack.extend(self.nodes[i].inputs.iter().copied());
        }
        out.sort_unstable();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(shape: u128, x0: f64, y0: f64, x1: f64, y1: f64) -> DrawItem {
        DrawItem { shape, style: DrawStyle::Body, bounds: Rect::new(x0, y0, x1, y1) }
    }

    fn shadow_graph() -> FrameGraph {
        FrameGraph {
            frame: Rect::new(0.0, 0.0, 400.0, 300.0),
            background: Color::WHITE,
            nodes: vec![
                GNode { op: Op::Draw(vec![item(1, 10.0, 10.0, 100.0, 100.0)]), inputs: vec![], label: "ground".into() },
                GNode {
                    op: Op::Draw(vec![DrawItem { shape: 2, style: DrawStyle::Coverage { analytic: true, spread: 0.0 }, bounds: Rect::new(120.0, 20.0, 200.0, 80.0) }]),
                    inputs: vec![],
                    label: "cov".into(),
                },
                GNode { op: Op::Blur { sigma: 4.0, axis: BlurAxis::X, linear: true, edge_clamp_style: EdgeClampStyle::Transparent }, inputs: vec![1], label: "bx".into() },
                GNode { op: Op::Blur { sigma: 4.0, axis: BlurAxis::Y, linear: true, edge_clamp_style: EdgeClampStyle::Transparent }, inputs: vec![2], label: "by".into() },
                GNode { op: Op::Compose { mode: ComposeMode::Over, colour: Some([0.0, 0.0, 0.0, 0.5]), offset: [6.0, 8.0] }, inputs: vec![0, 3], label: "shadow".into() },
                GNode { op: Op::Draw(vec![item(2, 120.0, 20.0, 200.0, 80.0)]), inputs: vec![4], label: "body".into() },
            ],
        }
    }

    #[test]
    fn a_shadow_graph_validates_and_its_chain_is_connectivity() {
        let g = shadow_graph();
        g.validate().expect("valid");
        assert_eq!(g.chain_of(3), vec![1, 2, 3]);
    }

    #[test]
    fn extents_inflate_by_pad_and_translate_by_compose_offset() {
        let g = shadow_graph();
        let e = g.extents();
        let p = f64::from(pad(&g.nodes[2].op));
        assert_eq!(e[2], Rect::new(120.0 - p, 20.0 - p, 200.0 + p, 80.0 + p));
        assert_eq!(e[3], e[2].inflate(p, p));
        let shifted = e[3] + crate::kurbo::Vec2::new(6.0, 8.0);
        assert_eq!(e[4], e[0].union(shifted));
        assert_eq!(e[5], e[4].union(Rect::new(120.0, 20.0, 200.0, 80.0)));
    }

    #[test]
    fn the_invariants_reject_a_chain_op_on_the_spine_and_a_forward_edge() {
        let mut g = shadow_graph();
        g.nodes[4].inputs[0] = 2;
        assert!(g.validate().is_err(), "a compose over a chain value is not on the spine");
        let mut g = shadow_graph();
        g.nodes[2].inputs[0] = 3;
        assert!(g.validate().is_err(), "a forward edge is not topological");
        let mut g = shadow_graph();
        g.nodes.push(GNode { op: Op::Colour(vec![]), inputs: vec![3], label: "dangling".into() });
        assert!(g.validate().is_err(), "the last node must be the frame");
    }
}
