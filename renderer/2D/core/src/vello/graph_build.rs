//! The scene walk that produces the frame graph: the document in z-order becomes a spine of
//! draws and composes, and every effect a shape carries becomes a chain hanging off that spine.
//!
//! The walk knows the scene and the view and nothing else. Every number it writes is in device
//! units — a blur's sigma, a lens's field, a shadow's offset — so the scheduler never sees a page
//! quantity. Every rect it writes is a draw item's device bounds; nothing else in the graph is
//! geometry.
//!
//! What lowers, and how:
//! - a run of plain shapes is ONE spine `Draw`; a container whose subtree carries no effect is one
//!   item of it, drawn as the subtree it is (its clip, mask and isolation stay inside vello);
//! - a container whose subtree does carry an effect is descended when nothing of its own would be
//!   lost — no clip, no mask, no opacity or blend isolation — and is otherwise one item, its inner
//!   effects rendering natively where vello can (box shadows) and not at all where it cannot;
//! - a box shape's shadows stay native (vello's blurred rounded rect) unless a `Replace` effect
//!   removes the body they ride on; a path's or a text's shadows lower to coverage chains;
//! - a drop shadow is `coverage → blur → Compose{Over, colour, offset}`; an inner shadow is
//!   `coverage → (blur) → EraseBy(coverage) → Compose{Over, colour}` with the punch's displacement
//!   an `EraseBy` payload fact; a gather is `below → units → Compose{MaskedMix}` masked by a
//!   coverage leaf; a body replacement is `body leaf → units → Compose{Over, offset}`.

use crate::kurbo::{Affine, Rect, Vec2};
use crate::model::{Node, Scene, ShapeKind};
use crate::effect::{Compose, Effect, Op as EffectOp, Source};
use crate::vello::bake::{PAYLOAD_PROGRAM_SLOT, PROGRAM_NOISE, PROGRAM_RADIAL};
use crate::vello::frame_graph::{
    BlurAxis, ComposeMode, DrawItem, DrawStyle, EdgeClampStyle, FrameGraph, GNode, NodeId, Op, ShapeId,
};

/// A blur below this device sigma is invisible and is not emitted.
const NEGLIGIBLE_SIGMA: f32 = 0.5;

/// The frame graph of the installed document for a `width × height` viewport under `root`.
#[must_use]
pub fn build_frame_graph(root: Affine, width: u32, height: u32) -> FrameGraph {
    let view = crate::vello::abi::effective_view(root);
    let frame = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
    let background = crate::vello::abi::background();
    crate::vello::abi::with_scene(|live, _, modifiers| {
        let modifier = |id: ShapeId| modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
        build(live, &modifier, view, frame, background)
    })
}

/// The frame graph of `scene` under the page→device `view`, for a caller that holds the scene.
#[must_use]
pub fn build(
    scene: &Scene,
    modifier: &dyn Fn(ShapeId) -> Affine,
    view: Affine,
    frame: Rect,
    background: crate::peniko::Color,
) -> FrameGraph {
    let c = view.as_coeffs();
    let mut b = Builder {
        scene,
        modifier,
        view,
        scale: ((c[0] * c[0] + c[1] * c[1]).sqrt()) as f32,
        frame,
        nodes: Vec::new(),
        spine: 0,
        pending: Vec::new(),
        fx_no: 0,
    };
    for &root in scene.roots() {
        b.walk(root);
    }
    b.flush();
    FrameGraph { frame, background, nodes: b.nodes }
}

struct Builder<'a> {
    scene: &'a Scene,
    modifier: &'a dyn Fn(ShapeId) -> Affine,
    view: Affine,
    /// The view's uniform scale: page px → device px.
    scale: f32,
    frame: Rect,
    nodes: Vec<GNode>,
    /// The node the spine currently ends at.
    spine: NodeId,
    /// Plain items awaiting their spine `Draw`.
    pending: Vec<DrawItem>,
    fx_no: u32,
}

impl Builder<'_> {
    fn push(&mut self, op: Op, inputs: Vec<NodeId>, label: String) -> NodeId {
        self.nodes.push(GNode { op, inputs, label });
        self.nodes.len() - 1
    }

    /// Land the pending items as one spine draw. The first flush always emits, so node 0 exists
    /// and is the root the spine grows from.
    fn flush(&mut self) {
        if self.pending.is_empty() && !self.nodes.is_empty() {
            return;
        }
        let items = std::mem::take(&mut self.pending);
        let inputs = if self.nodes.is_empty() { vec![] } else { vec![self.spine] };
        let label = format!("draw · {} item(s)", items.len());
        self.spine = self.push(Op::Draw(items), inputs, label);
    }

    fn matrix(&self, id: ShapeId, node: &Node) -> Affine {
        self.view * (self.modifier)(id) * node.effective_transform()
    }

    /// The shape's device bounds, its page box grown by `spread` page px first.
    fn device_bounds(&self, id: ShapeId, node: &Node, spread: f32) -> Rect {
        let page = crate::schedule::page_bounds(node, (self.modifier)(id));
        let s = f64::from(spread);
        self.view.transform_rect_bbox(page.inflate(s, s))
    }

    /// A page-space vector under the view's linear part.
    fn device_vec(&self, v: Vec2) -> [f32; 2] {
        let c = self.view.as_coeffs();
        [(c[0] * v.x + c[2] * v.y) as f32, (c[1] * v.x + c[3] * v.y) as f32]
    }

    fn sigma(&self, radius: f32) -> f32 {
        crate::blur::radius_to_sigma(radius) * self.scale
    }

    /// The effects the whole-viewport path lowers for `node`: its stack minus the coverage
    /// effects vello draws natively on a box shape that keeps its body.
    fn lowerable(node: &Node) -> Vec<Effect> {
        let stack = crate::effect::effect_stack(node);
        let has_replace = stack.iter().any(|e| e.compose == Compose::Replace);
        let native_coverage = !matches!(node.kind, ShapeKind::Path | ShapeKind::Text) && !has_replace;
        stack
            .into_iter()
            .filter(|e| !(native_coverage && matches!(e.source, Source::Coverage { .. })))
            .collect()
    }

    fn subtree_lowers(&self, id: ShapeId) -> bool {
        let Some(node) = self.scene.get(id) else { return false };
        if node.hidden {
            return false;
        }
        !Self::lowerable(node).is_empty() || node.children.iter().any(|&c| self.subtree_lowers(c))
    }

    fn walk(&mut self, id: ShapeId) {
        let Some(node) = self.scene.get(id) else { return };
        if node.hidden || node.kind == ShapeKind::Unsupported {
            return;
        }
        let effects = Self::lowerable(node);
        if effects.is_empty() {
            let has_paint = !node.fills.is_empty() || node.text.is_some() || !node.strokes.is_empty();
            let transparent_container = node.kind.is_container()
                && !node.clip
                && !node.masked
                && node.opacity >= 1.0
                && node.blend == crate::peniko::BlendMode::default();
            if transparent_container && node.children.iter().any(|&c| self.subtree_lowers(c)) {
                for &child in &node.children {
                    self.walk(child);
                }
                return;
            }
            if has_paint || !node.children.is_empty() {
                let bounds = self.device_bounds(id, node, 0.0);
                self.pending.push(DrawItem { shape: id, style: DrawStyle::Body, bounds });
            }
            return;
        }
        self.flush();
        self.lower_effect_node(id, node, &effects);
    }

    /// A coverage leaf: the outline dilated by `spread`, at the shape's own position.
    fn coverage(&mut self, id: ShapeId, node: &Node, spread: f32, label: String) -> NodeId {
        let item = DrawItem {
            shape: id,
            style: DrawStyle::Coverage { analytic: node.text.is_none(), spread },
            bounds: self.device_bounds(id, node, spread),
        };
        self.push(Op::Draw(vec![item]), vec![], label)
    }

    /// A separable Gaussian as its two axis nodes; a negligible sigma emits nothing.
    fn blur(&mut self, sigma: f32, linear: bool, edge: EdgeClampStyle, cur: NodeId, name: &str, tag: &str) -> NodeId {
        if sigma <= NEGLIGIBLE_SIGMA {
            return cur;
        }
        let x = self.push(
            Op::Blur { sigma, axis: BlurAxis::X, linear, edge_clamp_style: edge },
            vec![cur],
            format!("{name} {tag} blur-X σ{sigma:.1}"),
        );
        self.push(
            Op::Blur { sigma, axis: BlurAxis::Y, linear, edge_clamp_style: edge },
            vec![x],
            format!("{name} {tag} blur-Y σ{sigma:.1}"),
        )
    }

    fn compose(&mut self, mode: ComposeMode, colour: Option<[f32; 4]>, offset: [f32; 2], value: NodeId, coverage: Option<NodeId>, label: String) {
        let mut inputs = vec![self.spine, value];
        inputs.extend(coverage);
        self.spine = self.push(Op::Compose { mode, colour, offset }, inputs, label);
    }

    /// Lower one effect-bearing shape in paint order: drops under the body, the body, the gather
    /// through the coverage, the body replacement, inners over.
    fn lower_effect_node(&mut self, id: ShapeId, node: &Node, effects: &[Effect]) {
        self.fx_no += 1;
        let name = format!("s{}", self.fx_no);
        let has_replace = effects.iter().any(|e| e.compose == Compose::Replace);
        let has_paint = !node.fills.is_empty() || node.text.is_some() || !node.strokes.is_empty();
        let mut body_done = false;
        let emit_body = |b: &mut Self, body_done: &mut bool| {
            if *body_done {
                return;
            }
            *body_done = true;
            if has_replace || !has_paint {
                return;
            }
            let bounds = b.device_bounds(id, node, 0.0);
            b.pending.push(DrawItem { shape: id, style: DrawStyle::Body, bounds });
            b.flush();
        };
        for e in effects {
            if e.compose != Compose::Under {
                emit_body(self, &mut body_done);
            }
            match e.compose {
                Compose::Under => self.drop_shadow(id, node, e, &name),
                Compose::Over => self.inner_shadow(id, node, e, &name),
                Compose::ThroughCoverage => self.gather(id, node, e, &name),
                Compose::Replace => self.replacement(id, node, e, &name),
            }
        }
        emit_body(self, &mut body_done);
    }

    fn tint_of(e: &Effect) -> Option<[f32; 4]> {
        e.ops.iter().find_map(|o| match o {
            EffectOp::Tint(c) => Some(c.components),
            _ => None,
        })
    }

    fn drop_shadow(&mut self, id: ShapeId, node: &Node, e: &Effect, name: &str) {
        let Source::Coverage { spread } = e.source else { return };
        let sil = self.coverage(id, node, spread, format!("{name} drop silhouette"));
        let sigma = self.sigma(e.governing_blur().unwrap_or(0.0));
        let tail = self.blur(sigma, false, EdgeClampStyle::Transparent, sil, name, "drop");
        let offset = e
            .ops
            .iter()
            .fold(Vec2::ZERO, |a, o| if let EffectOp::Offset(v) = o { a + *v } else { a });
        self.compose(ComposeMode::Over, Self::tint_of(e), self.device_vec(offset), tail, None, format!("{name} drop → spine"));
    }

    fn inner_shadow(&mut self, id: ShapeId, node: &Node, e: &Effect, name: &str) {
        let Source::Coverage { spread } = e.source else { return };
        let flood = self.coverage(id, node, spread, format!("{name} inner flood"));
        let (offset, blur) = e
            .ops
            .iter()
            .find_map(|o| match o {
                EffectOp::EraseBy { offset, blur } => Some((*offset, *blur)),
                _ => None,
            })
            .unwrap_or((Vec2::ZERO, 0.0));
        let punch = self.blur(self.sigma(blur), false, EdgeClampStyle::Transparent, flood, name, "punch");
        let d = self.device_vec(offset);
        let band = self.push(Op::EraseBy(vec![d[0], d[1]]), vec![flood, punch], format!("{name} inner band"));
        self.compose(ComposeMode::Over, Self::tint_of(e), [0.0; 2], band, None, format!("{name} inner → spine"));
    }

    fn gather(&mut self, id: ShapeId, node: &Node, e: &Effect, name: &str) {
        let mut cur = self.spine;
        for op in &e.ops {
            cur = match op {
                EffectOp::Blur { radius } => self.blur(self.sigma(*radius), true, EdgeClampStyle::Extend, cur, name, "gather"),
                EffectOp::Lens(_) => self.lens(id, node, cur, name),
                EffectOp::Tint(c) => self.push(Op::Colour(c.components.to_vec()), vec![cur], format!("{name} gather tint")),
                EffectOp::FieldTint(c) => {
                    let tinted = self.push(Op::Colour(c.components.to_vec()), vec![cur], format!("{name} field tint"));
                    let m = self.matrix(id, node);
                    let c0 = m * node.bounds.center();
                    let k = m.as_coeffs();
                    let radius = 0.5 * node.bounds.width().min(node.bounds.height()) * (k[0] * k[0] + k[1] * k[1]).sqrt();
                    let mut u = vec![0.0f32; 24];
                    u[2] = c0.x as f32;
                    u[3] = c0.y as f32;
                    u[4] = radius as f32;
                    u[PAYLOAD_PROGRAM_SLOT] = PROGRAM_RADIAL;
                    let below = self.spine;
                    self.push(Op::MaskMix(u), vec![tinted, below], format!("{name} field mask"))
                }
                EffectOp::Offset(_) | EffectOp::EraseBy { .. } | EffectOp::NoiseWarp { .. } => cur,
            };
        }
        if cur == self.spine {
            return;
        }
        let cov = self.coverage(id, node, 0.0, format!("{name} gather mask"));
        self.compose(ComposeMode::MaskedMix, None, [0.0; 2], cur, Some(cov), format!("{name} gather → spine"));
    }

    /// The lens units over `cur`: warp (through a sampled distance for a path), the frost blur
    /// and scatter, shade, and the mask-mix against the state below — each carrying the lens's
    /// device field.
    fn lens(&mut self, id: ShapeId, node: &Node, cur: NodeId, name: &str) -> NodeId {
        let Some((g, geom)) = crate::effect_graph::lens_geometry(node, (self.modifier)(id)) else { return cur };
        let (w, h) = (self.frame.width() as u32, self.frame.height() as u32);
        let base = crate::effect_graph::lens_device_field(&g, geom, (w, h), (0.0, 0.0), self.view, 1.0);
        let with = |slot: usize, v: f32| {
            let mut u = base.to_vec();
            u[slot] = v;
            u
        };
        let mut warp_inputs = vec![cur];
        if node.path.is_some() {
            let bounds = self.device_bounds(id, node, 0.0);
            let decode = bounds.width().max(bounds.height()) as f32;
            let item = DrawItem { shape: id, style: DrawStyle::Distance { decode }, bounds };
            warp_inputs.push(self.push(Op::Draw(vec![item]), vec![], format!("{name} lens sdf")));
        }
        let warp = self.push(Op::Warp(with(17, g.chromatic_aberration)), warp_inputs, format!("{name} lens warp"));
        let sigma = g.total_blur_sigma() * self.scale;
        let head = if sigma > NEGLIGIBLE_SIGMA {
            let blurred = self.blur(sigma, false, EdgeClampStyle::Extend, warp, name, "frost");
            self.push(Op::Scatter(with(18, g.frost)), vec![blurred], format!("{name} lens scatter"))
        } else {
            warp
        };
        let mut shade = with(19, g.specular_opacity);
        shade[20] = g.specular_saturation;
        let shaded = self.push(Op::Shade(shade), vec![head], format!("{name} lens shade"));
        let below = self.spine;
        self.push(Op::MaskMix(base.to_vec()), vec![shaded, below], format!("{name} lens mask-mix"))
    }

    fn replacement(&mut self, id: ShapeId, node: &Node, e: &Effect, name: &str) {
        let bounds = self.device_bounds(id, node, 0.0);
        let item = DrawItem { shape: id, style: DrawStyle::Body, bounds };
        let leaf = self.push(Op::Draw(vec![item]), vec![], format!("{name} body leaf"));
        let mut cur = leaf;
        let mut offset = Vec2::ZERO;
        for op in &e.ops {
            cur = match op {
                EffectOp::Blur { radius } => self.blur(self.sigma(*radius), true, EdgeClampStyle::Transparent, cur, name, "body"),
                EffectOp::NoiseWarp { magnitude, grain, clip } => {
                    let mut u = vec![0.0f32; 24];
                    u[2] = *magnitude;
                    u[3] = *grain;
                    u[21] = f32::from(u8::from(*clip));
                    u[PAYLOAD_PROGRAM_SLOT] = PROGRAM_NOISE;
                    let warp = self.push(Op::Warp(u), vec![cur], format!("{name} noise warp"));
                    if *clip {
                        self.push(Op::ClipToSource(Vec::new()), vec![warp, leaf], format!("{name} noise clip"))
                    } else {
                        warp
                    }
                }
                EffectOp::Offset(v) => {
                    offset += *v;
                    cur
                }
                EffectOp::Tint(_) | EffectOp::FieldTint(_) | EffectOp::Lens(_) | EffectOp::EraseBy { .. } => cur,
            };
        }
        self.compose(ComposeMode::Over, None, self.device_vec(offset), cur, None, format!("{name} body → spine"));
    }
}

/// The graph as text, one node per line: index, spine mark, label, op, inputs, and every draw
/// item's shape, style and bounds. Numbers print to one decimal so a fixture is stable.
#[must_use]
pub fn dump(g: &FrameGraph) -> String {
    let mut s = String::new();
    s.push_str(&format!("frame {} nodes {} background {:?}\n", rect(g.frame), g.nodes.len(), g.background.components));
    for (i, n) in g.nodes.iter().enumerate() {
        let mark = if g.is_spine(i) { '|' } else { ' ' };
        s.push_str(&format!("{i:>3} {mark} {:<26} in={:?} {}\n", n.label, n.inputs, op(&n.op)));
    }
    s
}

fn rect(r: Rect) -> String {
    format!("[{:.1} {:.1} {:.1} {:.1}]", r.x0, r.y0, r.x1, r.y1)
}

fn op(o: &Op) -> String {
    match o {
        Op::Draw(items) => {
            let union = items.iter().map(|it| it.bounds).reduce(|a, b| a.union(b)).unwrap_or(Rect::ZERO);
            let shown: Vec<String> = items
                .iter()
                .take(6)
                .map(|it| {
                    let style = match it.style {
                        DrawStyle::Body => "body".to_string(),
                        DrawStyle::Coverage { analytic, spread } => format!("coverage{}{}", if analytic { "" } else { "/glyph" }, if spread > 0.0 { format!("+{spread:.1}") } else { String::new() }),
                        DrawStyle::Distance { decode } => format!("distance/{decode:.1}"),
                    };
                    format!("{:x}:{style}{}", it.shape & 0xffff, rect(it.bounds))
                })
                .collect();
            let more = if items.len() > shown.len() { format!(" +{}", items.len() - shown.len()) } else { String::new() };
            format!("Draw n={} {} {}{more}", items.len(), rect(union), shown.join(" "))
        }
        Op::Blur { sigma, axis, linear, edge_clamp_style } => {
            format!("Blur σ{sigma:.1} {axis:?} {}{}", if *linear { "linear" } else { "srgb" }, match edge_clamp_style { EdgeClampStyle::Extend => "", EdgeClampStyle::Transparent => " transparent" })
        }
        Op::Warp(u) => format!("Warp program {:.0}", u.get(PAYLOAD_PROGRAM_SLOT).copied().unwrap_or(0.0)),
        Op::Scatter(_) => "Scatter".into(),
        Op::Shade(_) => "Shade".into(),
        Op::MaskMix(u) => format!("MaskMix program {:.0}", u.get(PAYLOAD_PROGRAM_SLOT).copied().unwrap_or(0.0)),
        Op::EraseBy(u) => format!("EraseBy at {:.1},{:.1}", u.first().copied().unwrap_or(0.0), u.get(1).copied().unwrap_or(0.0)),
        Op::ClipToSource(_) => "ClipToSource".into(),
        Op::Colour(c) => format!("Colour {c:.2?}"),
        Op::Compose { mode, colour, offset } => {
            format!("Compose {mode:?}{}{}", colour.map_or(String::new(), |c| format!(" colour {c:.2?}")), if *offset == [0.0; 2] { String::new() } else { format!(" offset {:.1},{:.1}", offset[0], offset[1]) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph_of(load: impl FnOnce(), zoom: f32) -> FrameGraph {
        load();
        crate::vello::abi::set_render_options(0, 1.0);
        crate::vello::abi::set_canvas_background(0xffff_ffff);
        crate::vello::abi::set_view(zoom, 0.0, 0.0);
        let g = build_frame_graph(Affine::IDENTITY, 800, 600);
        g.validate().unwrap_or_else(|e| panic!("{e}\n{}", dump(&g)));
        g
    }

    fn spine(g: &FrameGraph) -> Vec<NodeId> {
        (0..g.nodes.len()).filter(|&i| g.is_spine(i)).collect()
    }

    fn composes(g: &FrameGraph) -> Vec<&GNode> {
        g.nodes.iter().filter(|n| matches!(n.op, Op::Compose { .. })).collect()
    }

    #[test]
    fn plain_shapes_coalesce_into_one_spine_draw() {
        let g = graph_of(|| { crate::vello::abi::load_stack_glass_scene(2, 0); }, 1.0);
        let draws: Vec<_> = spine(&g).into_iter().filter(|&i| matches!(g.nodes[i].op, Op::Draw(_))).collect();
        assert_eq!(draws[0], 0, "node 0 is the ground draw");
        let Op::Draw(items) = &g.nodes[0].op else { unreachable!() };
        assert!(items.len() > 1, "the checker ground is one draw of many items:\n{}", dump(&g));
        assert!(items.iter().all(|it| it.style == DrawStyle::Body));
    }

    #[test]
    fn a_glass_is_a_chain_from_the_spine_masked_by_its_coverage() {
        let g = graph_of(|| { crate::vello::abi::load_stack_glass_scene(2, 0); }, 1.0);
        let c: Vec<_> = composes(&g).into_iter().filter(|n| n.label.contains("gather")).collect();
        assert_eq!(c.len(), 2, "two glass shapes, two gather composes:\n{}", dump(&g));
        for n in &c {
            let Op::Compose { mode, colour, offset } = n.op else { unreachable!() };
            assert_eq!(mode, ComposeMode::MaskedMix);
            assert_eq!(colour, None);
            assert_eq!(offset, [0.0; 2]);
            assert_eq!(n.inputs.len(), 3, "below, value, coverage");
            assert!(g.is_spine(n.inputs[0]));
            let chain = g.chain_of(n.inputs[1]);
            assert!(chain.iter().any(|&j| matches!(g.nodes[j].op, Op::Warp(_))), "a warp heads the lens");
            assert!(chain.iter().any(|&j| matches!(g.nodes[j].op, Op::MaskMix(_))), "a mask-mix ends the lens");
            let warp = chain.iter().find(|&&j| matches!(g.nodes[j].op, Op::Warp(_))).copied().unwrap();
            assert!(g.is_spine(g.nodes[warp].inputs[0]), "the warp reads the state below");
            let Op::Draw(items) = &g.nodes[n.inputs[2]].op else { panic!("coverage leaf") };
            assert!(matches!(items[0].style, DrawStyle::Coverage { analytic: true, spread } if spread == 0.0));
        }
    }

    #[test]
    fn a_path_shadow_lowers_to_coverage_blur_compose_with_a_device_offset() {
        let g = graph_of(|| { crate::vello::abi::load_path_shadow_scene(); }, 2.0);
        let c = composes(&g);
        let drop = c.iter().find(|n| n.label.contains("drop")).expect("a drop shadow compose");
        let Op::Compose { mode, colour, offset } = drop.op else { unreachable!() };
        assert_eq!(mode, ComposeMode::Over);
        assert!(colour.is_some(), "the tint rides the compose");
        let chain = g.chain_of(drop.inputs[1]);
        let leaf = chain[0];
        let Op::Draw(items) = &g.nodes[leaf].op else { panic!("the chain roots at a coverage leaf") };
        assert!(matches!(items[0].style, DrawStyle::Coverage { .. }));
        let blurs: Vec<_> = chain.iter().filter(|&&j| matches!(g.nodes[j].op, Op::Blur { .. })).collect();
        assert!(blurs.len() == 2 || blurs.is_empty(), "a blur is two axes or nothing");
        let g1 = graph_of(|| { crate::vello::abi::load_path_shadow_scene(); }, 1.0);
        let drop1 = composes(&g1).into_iter().find(|n| n.label.contains("drop")).unwrap();
        let Op::Compose { offset: o1, .. } = drop1.op else { unreachable!() };
        assert!((offset[0] - 2.0 * o1[0]).abs() < 1e-3 && (offset[1] - 2.0 * o1[1]).abs() < 1e-3, "the offset is in device px: {offset:?} vs {o1:?}");
        if let Some(&&b2) = blurs.first() {
            let Op::Blur { sigma: s2, .. } = g.nodes[b2].op else { unreachable!() };
            let b1 = g1.chain_of(drop1.inputs[1]).into_iter().find(|&j| matches!(g1.nodes[j].op, Op::Blur { .. })).unwrap();
            let Op::Blur { sigma: s1, .. } = g1.nodes[b1].op else { unreachable!() };
            assert!((s2 - 2.0 * s1).abs() < 1e-3, "sigma is in device px");
        }
    }

    #[test]
    fn an_inner_shadow_erases_the_flood_by_its_displaced_blurred_self() {
        let g = graph_of(|| { crate::vello::abi::load_inner_shadow_scene(); }, 1.0);
        let inner = composes(&g).into_iter().find(|n| n.label.contains("inner")).expect("an inner compose");
        let band = inner.inputs[1];
        let Op::EraseBy(u) = &g.nodes[band].op else { panic!("the value is an erase") };
        assert_eq!(u.len(), 2, "the punch's displacement rides the payload");
        let [flood, punch] = g.nodes[band].inputs[..] else { panic!("two inputs") };
        assert!(matches!(g.nodes[flood].op, Op::Draw(_)));
        let mut r = punch;
        while let Op::Blur { .. } = g.nodes[r].op {
            r = g.nodes[r].inputs[0];
        }
        assert_eq!(r, flood, "the punch is the flood itself, read displaced");
    }

    #[test]
    fn a_layer_blur_replaces_the_body_with_a_blurred_body_leaf() {
        let g = graph_of(|| { crate::vello::abi::load_layer_blur_scene(); }, 1.0);
        let body = composes(&g).into_iter().find(|n| n.label.contains("body")).expect("a body compose");
        let chain = g.chain_of(body.inputs[1]);
        let Op::Draw(items) = &g.nodes[chain[0]].op else { panic!("body leaf") };
        assert_eq!(items[0].style, DrawStyle::Body);
        assert!(g.nodes[chain[0]].inputs.is_empty(), "the leaf draws the body alone");
        assert!(!g.is_spine(chain[0]));
        let blurred = spine(&g)
            .into_iter()
            .filter_map(|i| match &g.nodes[i].op { Op::Draw(items) => Some(items), _ => None })
            .flatten()
            .filter(|it| it.shape == items[0].shape)
            .count();
        assert_eq!(blurred, 0, "a replaced body is not drawn on the spine");
    }

    #[test]
    fn a_backdrop_tint_is_a_colour_over_the_state_below() {
        let g = graph_of(|| { crate::vello::abi::load_backdrop_tint_grid_scene(1); }, 1.0);
        let c = composes(&g);
        assert_eq!(c.len(), 1);
        let Op::Colour(_) = g.nodes[c[0].inputs[1]].op else { panic!("a colour value") };
        assert!(g.is_spine(g.nodes[c[0].inputs[1]].inputs[0]));
    }

    #[test]
    fn the_graph_is_the_same_wherever_the_view_sits() {
        let strip = |g: &FrameGraph| -> Vec<String> {
            g.nodes.iter().enumerate().map(|(i, n)| format!("{} {:?} {}", g.is_spine(i), n.inputs, n.label)).collect()
        };
        let a = graph_of(|| { crate::vello::abi::load_combined_scene(); }, 1.0);
        crate::vello::abi::set_view(1.0, -900.0, -400.0);
        let b = build_frame_graph(Affine::IDENTITY, 800, 600);
        assert_eq!(strip(&a), strip(&b), "the graph does not know about edges");
    }
}
