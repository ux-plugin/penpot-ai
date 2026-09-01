//! Renders a backend-neutral [`render_core::model::Scene`] with Vello.
//!
//! This is the second half of the approach-B pipeline. render-wasm's converter
//! (`model_export::node_from_shape`, verified by its own tests) projects Skia `Shape`s into
//! exactly these `render_core::model` types; here we consume the same types and draw them with
//! Vello — no Skia involved. Together the two halves are the end-to-end path
//! `Penpot shape → neutral model → Vello pixels`.
//!
//! Since D12 the model carries kurbo and peniko types directly, so this file has no conversion
//! helpers left: `Affine`, `Rect` and `BezPath` arrive ready to draw. render-core and
//! vello_common resolve to the same kurbo/peniko, so the types unify with no bridging.
//!
//! # Two things about the traversal that are easy to get wrong
//!
//! **Parent transforms are not accumulated.** Penpot stores absolute `selrect`s, so a child is
//! already positioned in page space. render-wasm applies `scale · viewport · shape_matrix` from
//! scratch for every shape and never carries a parent CTM down, so composing one here would
//! double-transform everything nested. Containers contribute layers — clip, opacity — and
//! nothing else.
//!
//! **Each shape's matrix is centred on its own bounds**, which is what
//! [`render_core::model::Node::effective_transform`] returns. Using the raw transform makes a
//! rotation orbit the page origin instead of spinning in place, which reads as a shape flying
//! off-screen rather than as a wrong matrix.

use render_core::blend::DEFAULT_BLEND;
use render_core::schedule::PaintOp;
use render_core::blur::radius_to_sigma;
use render_core::kurbo::{Affine, BezPath, Rect};
use render_core::model as m;

use render_core::geometry::{cap_shadow_blur, cap_sigma_to_device, outline, spread_outline};
use render_core::model::Brush;
use render_core::peniko::Color;
use vello_common::filter_effects::{EdgeMode, Filter, FilterPrimitive};
use vello_example_scenes::{ExampleScene, RenderingContext};

use parley::fontique::{FontInfoOverride, GenericFamily};
use parley::{FontContext, LayoutContext};

use crate::rich_editor::{EditorCommandRef, RichEditor};
use render_core::text::TextBrush;

/// A Gaussian-blur filter of the given sigma. `EdgeMode::None` fades to transparent at the edges,
/// which is what a blur or a soft shadow wants.
fn gaussian_blur(sigma: f32) -> Filter {
    Filter::from_primitive(FilterPrimitive::GaussianBlur {
        std_deviation: sigma,
        edge_mode: EdgeMode::None,
    })
}


/// Depth cap for the walk. The tree comes off the wire, and a cycle would otherwise recurse
/// until the wasm stack gives out — a hang rather than a diagnosable failure. Real documents
/// nest an order of magnitude below this.
const MAX_DEPTH: u32 = 128;

/// A focus scene that draws a neutral model via the backend-agnostic `RenderingContext`.
///
/// The model comes from the ABI — whatever the host has sent through `use_shape` and friends.
/// The hand-built [`demo_model`] stands in only while the ABI is empty, so the dev harness has
/// something to show with no host attached.
pub struct NeutralModelScene {
    fallback: m::Scene,
    text: TextEngine,
}

impl std::fmt::Debug for NeutralModelScene {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `TextEngine` wraps Parley contexts that are not `Debug`; the scene's identity is the
        // fallback model, so that is all this prints.
        f.debug_struct("NeutralModelScene")
            .field("fallback", &self.fallback)
            .finish_non_exhaustive()
    }
}

impl NeutralModelScene {
    pub fn new() -> Self {
        Self {
            fallback: demo_model(),
            text: TextEngine::new(),
        }
    }
}

/// The Parley state text layout needs, kept across frames on the scene rather than rebuilt each
/// frame: the font collection (fed by `store_font`, which must persist its faces) and the reusable
/// layout/font contexts (a `FontContext` is expensive to construct).
struct TextEngine {
    font_cx: FontContext,
    layout_cx: LayoutContext<TextBrush>,
    /// The live editor for the focused text shape, if any ([`RichEditor`] holds the span model, its
    /// multi-style layout, and the caret/selection over it). Rebuilt when focus moves; `None` when
    /// nothing is being edited. See [`crate::editor`] for why the ABI only queues into this via the
    /// render pass.
    editor: Option<RichEditor>,
    /// The shape id `editor` was built for, so a focus change triggers a rebuild.
    editor_for: Option<u128>,
    /// This engine's position in the shared font registry — see [`crate::abi::fonts_since`].
    font_cursor: usize,
}

/// Caret width in text-local units. Parley draws the caret as a thin rect of this width.
const CARET_WIDTH: f32 = 2.0;

impl TextEngine {
    fn new() -> Self {
        Self {
            font_cx: FontContext::new(),
            layout_cx: LayoutContext::new(),
            editor: None,
            editor_for: None,
            font_cursor: 0,
        }
    }

    /// Register every face published since this engine's last frame. Reads the shared registry
    /// through this engine's own cursor ([`crate::abi::fonts_since`]) — reading never removes, so
    /// other consumers (another renderer, text measurement) see the same faces. Idempotent. The face
    /// is registered under our own alias — see [`font_alias`] — which the draw path looks it up by.
    fn sync_fonts(&mut self) {
        for font in crate::abi::fonts_since(&mut self.font_cursor) {
            let registered = self.font_cx.collection.register_fonts(
                font.bytes,
                Some(FontInfoOverride {
                    family_name: Some(&font.alias),
                    width: None,
                    style: None,
                    weight: None,
                    axes: None,
                }),
            );
            // An emoji face also joins Parley's `Emoji` generic family. Parley appends that generic
            // to the font query for any cluster it detects as emoji, so an emoji the primary font
            // lacks falls through to this face — and glifo's glyph cascade (COLR > bitmap > outline)
            // draws its colour layers. `append` (not `set`) so multiple emoji faces accumulate.
            if font.is_emoji {
                let ids = registered.iter().map(|(family_id, _)| *family_id);
                self.font_cx
                    .collection
                    .append_generic_families(GenericFamily::Emoji, ids);
            }
        }
    }

    /// Bring the editor in step with the ABI: rebuild it when focus moves, apply the queued edit
    /// commands, and report the selection state back. Runs inside the render pass — the only place
    /// the `FontContext` the edited text lays out against is reachable (see [`crate::editor`]).
    fn sync_editor(&mut self, scene: &m::Scene) {
        let (focused, commands) = crate::editor::take_focus_and_commands();
        let Self {
            font_cx,
            layout_cx,
            editor,
            editor_for,
            font_cursor: _,
        } = self;

        let Some(id) = focused else {
            *editor = None;
            *editor_for = None;
            crate::editor::clear_snapshot();
            return;
        };

        // (Re)build when focus moves to a different shape. `RichEditor::build` lays it out once, so
        // geometry is valid even before the first pointer event.
        if *editor_for != Some(id) {
            *editor = scene.get(id).and_then(|node| node.text.as_ref()).map(|block| {
                let width = scene.get(id).map_or(0.0, |n| n.bounds.width() as f32);
                RichEditor::build(block, width, font_cx, layout_cx)
            });
            *editor_for = Some(id);
        }

        let Some(ed) = editor.as_mut() else {
            crate::editor::clear_snapshot();
            return;
        };

        let overtype = crate::editor::overtype();
        for command in &commands {
            use crate::editor::EditorCommand as C;
            let borrowed = match command {
                C::PointerDown(x, y) => EditorCommandRef::PointerDown(*x, *y),
                C::ExtendToPoint(x, y) => EditorCommandRef::ExtendToPoint(*x, *y),
                C::SelectWord(x, y) => EditorCommandRef::SelectWord(*x, *y),
                C::SelectAll => EditorCommandRef::SelectAll,
                C::Insert(s) => EditorCommandRef::Insert(s),
                C::InsertParagraph => EditorCommandRef::InsertParagraph,
                C::DeleteBackward(word) => EditorCommandRef::DeleteBackward(*word),
                C::DeleteForward(word) => EditorCommandRef::DeleteForward(*word),
                C::Move { direction, word, extend } => {
                    EditorCommandRef::Move { direction: *direction, word: *word, extend: *extend }
                }
                C::SetCompose(s) => EditorCommandRef::SetCompose(s),
                C::CommitCompose(s) => EditorCommandRef::CommitCompose(s),
            };
            ed.apply(borrowed, overtype, font_cx, layout_cx);
        }

        let (start, end) = ed.selection_range();
        // The caret in shape-local space, for `get_cursor_rect` (IME candidate placement).
        let caret = Some(ed.caret_rect(CARET_WIDTH));
        crate::editor::set_snapshot(
            ed.text().to_string(),
            (start, end),
            caret,
            Some(ed.layout_size()),
        );
    }
}

impl Default for NeutralModelScene {
    fn default() -> Self {
        Self::new()
    }
}

impl ExampleScene for NeutralModelScene {
    fn render<T: RenderingContext>(
        &mut self,
        ctx: &mut T,
        resources: &mut T::Resources,
        root: Affine,
    ) {
        // Register any faces uploaded since the last frame before laying text out against them.
        self.text.sync_fonts();

        // Scheduler production sink: when set, this render draws exactly one node's *body* into the
        // target (no background, no tree), at the matrix the caller baked into `root`. This is how
        // the sink executes a `Paint` step — reusing the whole draw path (model, text, modifiers)
        // without a per-node bridge on the scene trait.
        let batch = paint_batch();
        if !batch.is_empty() {
            let fallback = &self.fallback;
            let text = &mut self.text;
            crate::abi::with_scene(|live, viewport, modifiers| {
                let (model, view) = if live.is_empty() {
                    (fallback, root)
                } else {
                    (live, root * viewport)
                };
                // The batch is already in z-order (builder emission order); execute each op in turn
                // into this one scene so a run of plain shapes becomes a single `renderer.render`. A
                // `PushLayer`/`PopLayer` pair isolates a plain opacity/blend group as an in-scene
                // layer — no separate surface, still one submission.
                for op in &batch {
                    match *op {
                        PaintOp::Body(only) => {
                            if let Some(node) = model.get(only) {
                                let modifier = modifiers.get(&only).copied().unwrap_or(Affine::IDENTITY);
                                let matrix = view * modifier * node.effective_transform();
                                paint_node_body(ctx, resources, text, node, matrix);
                            }
                        }
                        PaintOp::PushLayer(id) => {
                            if let Some(node) = model.get(id) {
                                // Group opacity/blend, applied to the whole subtree drawn until the
                                // matching pop. Clip is left to the node's own draw path (frame
                                // clipping is not yet isolating here), matching the `ScopeOf` path.
                                let alpha = (node.opacity < 1.0).then_some(node.opacity);
                                let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
                                ctx.push_layer(None, blend, alpha, None, None);
                            }
                        }
                        // A masked group's `DstIn` sub-layer: the next `Body` (the mask child)
                        // composites onto the content already in the isolation layer with `DstIn`, so
                        // the content survives only where the mask has alpha — a soft alpha mask.
                        PaintOp::PushMaskLayer => {
                            use render_core::peniko::{BlendMode, Compose, Mix};
                            ctx.push_layer(None, Some(BlendMode::new(Mix::Normal, Compose::DestIn)), None, None, None);
                        }
                        PaintOp::PopLayer => ctx.pop_layer(),
                    }
                }
            });
            return;
        }

        // Mask render: fill exactly one node's silhouette in solid white — the coverage the sink
        // multiplies into a gather's blurred backdrop so it shows through the shape's outline, not
        // its bounding box. No paints, no children, no effects; the anti-aliased edge is the mask.
        if let Some(only) = mask_only() {
            let fallback = &self.fallback;
            crate::abi::with_scene(|live, viewport, modifiers| {
                let (model, view) = if live.is_empty() {
                    (fallback, root)
                } else {
                    (live, root * viewport)
                };
                if let Some(node) = model.get(only) {
                    let modifier = modifiers.get(&only).copied().unwrap_or(Affine::IDENTITY);
                    let matrix = view * modifier * node.effective_transform();
                    ctx.set_transform(matrix);
                    ctx.set_paint(render_core::peniko::Color::from_rgba8(255, 255, 255, 255));
                    ctx.fill_path(&outline(node));
                }
            });
            return;
        }

        // The page background, if the host set one. Drawn in canvas space, under everything.
        let background = crate::abi::background();
        if background.components[3] > 0.0 {
            ctx.set_transform(Affine::IDENTITY);
            ctx.set_paint(background);
            ctx.fill_rect(&Rect::new(
                0.0,
                0.0,
                f64::from(ctx.width()),
                f64::from(ctx.height()),
            ));
        }

        // Pre-borrow the disjoint fields so the closure can hold the fallback model and the text
        // engine at once (a whole-`self` capture would alias them).
        let fallback = &self.fallback;
        let text = &mut self.text;
        crate::abi::with_scene(|live, viewport, modifiers| {
            // Fold the queued editor commands into the live editor before drawing, so the caret and
            // selection this frame paints are up to date. Only the live scene is editable.
            text.sync_editor(live);
            // `root` is the harness's own pan/zoom; `viewport` is what the host set through
            // `set_view`. They compose — the harness stays at identity when a host is driving.
            let (model, view) = if live.is_empty() {
                (fallback, root)
            } else {
                (live, root * viewport)
            };
            for id in model.roots() {
                draw_node(ctx, resources, text, model, *id, view, modifiers, 0);
            }
        });
    }

    fn status(&self) -> Option<String> {
        let live = crate::abi::with_scene(|scene, _, _| scene.len());
        let (source, count) = if live == 0 {
            ("demo", self.fallback.len())
        } else {
            ("host", live)
        };
        Some(format!("neutral model → vello · {source} · {count} nodes"))
    }
}

thread_local! {
    /// Whether spatially-spreading effects (blur/shadow/filter graph) are drawn. Off during tiled
    /// rendering — the fork's decimated blur seams when run per-tile — until effects move to their
    /// own composited surfaces. Plain paint, opacity, blend and clip are unaffected.
    static EFFECTS_ENABLED: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

/// Enable or disable spatial-effect drawing for subsequent `draw_node` calls on this thread.
pub(crate) fn set_effects_enabled(on: bool) {
    EFFECTS_ENABLED.with(|c| c.set(on));
}

fn effects_enabled() -> bool {
    EFFECTS_ENABLED.with(std::cell::Cell::get)
}

thread_local! {
    /// When non-empty, [`NeutralModelScene::render`] draws exactly these nodes' bodies, in order,
    /// into the target (a scheduler `Paint` step's shape run) instead of the whole tree — see the
    /// check at the top of `render`. A run rather than a single id so a coalesced batch of plain
    /// shapes renders in one pass.
    static PAINT_BATCH: std::cell::RefCell<Vec<PaintOp>> = const { std::cell::RefCell::new(Vec::new()) };
    /// When set, `render` fills only this node's silhouette in solid white — a coverage mask the
    /// sink uses to clip a gather's blurred backdrop to the shape's outline (not its bbox).
    static MASK_ONLY: std::cell::Cell<Option<u128>> = const { std::cell::Cell::new(None) };
}

/// Scope the next `render` to this run of paint ops (the sink sets it per `Paint` step, then clears).
pub(crate) fn set_paint_batch(ops: &[PaintOp]) {
    PAINT_BATCH.with(|c| {
        let mut v = c.borrow_mut();
        v.clear();
        v.extend_from_slice(ops);
    });
}

/// Clear the paint-batch scope so the next `render` draws the whole tree again.
pub(crate) fn clear_paint_batch() {
    PAINT_BATCH.with(|c| c.borrow_mut().clear());
}

fn paint_batch() -> Vec<PaintOp> {
    PAINT_BATCH.with(|c| c.borrow().clone())
}

/// Scope the next `render` to one node's silhouette-as-coverage (a `PaintGather` clip mask).
pub(crate) fn set_mask_only(id: Option<u128>) {
    MASK_ONLY.with(|c| c.set(id));
}

fn mask_only() -> Option<u128> {
    MASK_ONLY.with(std::cell::Cell::get)
}

/// Draw one node and its subtree.
///
/// `root` is the viewport matrix and is passed down unchanged — see the module docs on why it is
/// not composed with each node's transform.
fn draw_node<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    text: &mut TextEngine,
    scene: &m::Scene,
    id: u128,
    root: Affine,
    modifiers: &crate::abi::Modifiers,
    depth: u32,
) {
    if depth >= MAX_DEPTH {
        return;
    }
    let Some(node) = scene.get(id) else {
        // A container can list a child the host has not sent yet; that is normal mid-sync.
        return;
    };
    if node.hidden {
        return;
    }
    if node.kind == m::ShapeKind::Unsupported {
        // A kind this backend does not draw yet (Text, Bool, SVGRaw). Skip it and its subtree,
        // matching the digest's reachability so the picture and the hash count the same nodes.
        return;
    }

    // The gesture transform sits between the viewport and the shape's own matrix: it is
    // expressed in page space, so it must be applied to the shape's page-space geometry and
    // then viewed, not folded into the shape's centred transform.
    //
    // It is *not* inherited down the tree. The host propagates a container's gesture to each
    // descendant explicitly (`propagate_modifiers`), exactly as it does for the committed
    // transforms, which are absolute per shape — inheriting here would apply a group's drag
    // twice to everything inside it.
    let modifier = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
    let matrix = root * modifier * node.effective_transform();

    // Clip and the composite layer cannot share one layer, because they cover different things.
    //
    // Opacity and blend both wrap this node's own paint *and* its children — a half-transparent
    // or multiplied group must composite as one image against the backdrop, not per child, so
    // they ride the *same* outer layer. Clipping covers only the children: render-wasm builds the
    // clip in `get_children_clip_bounds`, and a frame is not clipped by itself (which matters once
    // strokes land, since a stroke straddles the boundary).
    // Drop shadows sit behind the shape, and *outside* the layer-blur/opacity/blend layer — a
    // layer blur blurs the shape, not its shadow. Each is its own soft, offset, coloured
    // silhouette; multiple shadows are just multiple passes (no multi-primitive filter needed).
    // Spatially-spreading effects (drop/inner shadow, layer blur, filter graph) are gated off while
    // tiling: the fork's decimated Gaussian is grid-sensitive, so running it independently inside
    // each tile buffer seams and flickers under pan/zoom. They will be re-introduced through their
    // own `extrect`-anchored surfaces, composited once (the render-wasm model), not per-tile. Plain
    // paint, opacity, blend and clip are translation-invariant and tile cleanly, so they stay.
    let effects = effects_enabled();

    if effects {
        draw_drop_shadows(ctx, node, matrix);
    }

    // A filter graph wraps this node's composited paint *and* its children as one image — the
    // outermost of this node's layers, so it filters the finished shape rather than each child, and
    // it sits outside the drop shadow (which is drawn behind). A linear chain lowers to nested filter
    // layers; the shape draws inside all of them and we pop the same count afterward.
    let filter_layers = if effects {
        push_filter_graph(ctx, node, matrix)
    } else {
        0
    };

    let alpha = (node.opacity < 1.0).then_some(node.opacity);
    let blend = (node.blend != DEFAULT_BLEND).then_some(node.blend);
    // Layer blur rides the same outer layer as opacity/blend, via `push_layer`'s filter slot, so
    // it covers this node's paint and its children as one image. (This is the whole-scene walk, which
    // does not go through the sink — the sink-batch path `paint_node_body` defers blur to the sink.)
    let blur = effects
        .then(|| {
            node.blur
                .map(|radius| gaussian_blur(cap_sigma_to_device(radius_to_sigma(radius), matrix)))
        })
        .flatten();
    let composite = alpha.is_some() || blend.is_some() || blur.is_some();
    if composite {
        ctx.set_transform(matrix);
        ctx.push_layer(None, blend, alpha, None, blur);
    }

    // Text carries no `fills`/geometry — its paint is the glyph colour inside its spans — so it
    // takes its own draw path rather than `paint_self`.
    if node.kind == m::ShapeKind::Text {
        draw_text(ctx, resources, text, node, matrix);
    } else {
        // Inner shadows enclose the shape's own paint (they darken inside its edges), so they wrap
        // `paint_self` — inside the composite/filter layers, but tighter than the drop shadow, which
        // sits behind. Gated with the other effects while tiling.
        let inner_shadows = if effects {
            push_inner_shadows(ctx, node, matrix)
        } else {
            0
        };
        // Whole-scene walk: no composite step, so this node's own opacity/blend (pushed at
        // `composite` above) already isolates it — the leaf paint stays raw here to avoid doubling.
        paint_self(ctx, node, matrix, false);
        for _ in 0..inner_shadows {
            ctx.pop_layer();
        }
    }

    let clip = (node.clip && !node.children.is_empty()).then(|| outline(node));
    if clip.is_some() {
        // The clip path is captured in the transform current at push time, which is this
        // node's — matching render-wasm, where each clip entry carries its own matrix.
        ctx.set_transform(matrix);
        ctx.push_layer(clip.as_ref(), None, None, None, None);
    }

    draw_children(ctx, resources, text, scene, node, root, modifiers, depth);

    if clip.is_some() {
        ctx.pop_layer();
    }
    if composite {
        ctx.pop_layer();
    }
    for _ in 0..filter_layers {
        ctx.pop_layer();
    }
}

/// Paint one node's **own body** into `ctx` at `matrix` — fills, strokes, drop/inner shadows, layer
/// blur and filter graph — for the scheduler's `Paint` step. Deliberately excludes two things
/// `draw_node` does: the opacity/blend composite (the scheduler applies that when it *composites*
/// this node's surface, via the `Composite` step's `LayerPaint`) and the children (each child is its
/// own `Paint`). Effects are always drawn — the surface the sink renders into is sized to hold them,
/// which is the entire reason effects live on their own surface.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn paint_node_body<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    text: &mut TextEngine,
    node: &m::Node,
    matrix: Affine,
) {
    if node.hidden || node.kind == m::ShapeKind::Unsupported {
        return;
    }
    // Drop shadows sit behind the body.
    draw_drop_shadows(ctx, node, matrix);
    let filter_layers = push_filter_graph(ctx, node, matrix);
    // Layer blur is NOT applied here. The sink blurs this shape's `RasterEffectOutput` surface with
    // its full-resolution `run_graph` Gaussian (`hybrid_backend::blurs_layer_inline() == false`),
    // exactly as the classic backend does — so both backends blur identically. vello_hybrid's inline
    // filter is *decimated* (downsample → blur → upsample) and spreads ~2x wider at the same sigma,
    // which made hybrid's layer blur visibly stronger. The body therefore renders sharp here.
    if node.kind == m::ShapeKind::Text {
        draw_text(ctx, resources, text, node, matrix);
    } else if node.kind == m::ShapeKind::Svg {
        if let Some(content) = &node.svg {
            render_core::vello::svg::render_svg(ctx, content, node.bounds, matrix);
        }
    } else {
        let inner = push_inner_shadows(ctx, node, matrix);
        // Sink path: opacity/blend is applied by the scheduler's `Composite` step, so paint raw.
        paint_self(ctx, node, matrix, false);
        for _ in 0..inner {
            ctx.pop_layer();
        }
    }
    for _ in 0..filter_layers {
        ctx.pop_layer();
    }
}

/// Push one nested filter layer per node in the shape's filter graph, and return how many were
/// pushed so the caller pops the same number. The chain is in application order (`nodes[0]` first),
/// but the *last* filter layer pushed is the innermost — closest to the shape, applied first (see
/// the fork's `filter_offset_nested`) — so the nodes are pushed in reverse. Nothing pushed when the
/// node has no graph.
fn push_filter_graph<T: RenderingContext>(ctx: &mut T, node: &m::Node, matrix: Affine) -> u32 {
    let Some(graph) = &node.filter_graph else {
        return 0;
    };
    for filter_node in graph.nodes.iter().rev() {
        ctx.set_transform(matrix);
        ctx.push_filter_layer(lower_node(filter_node));
    }
    graph.nodes.len() as u32
}

/// Lower one neutral filter node to a vello-fork filter primitive. `Custom` selects a WGSL branch in
/// the fork's `custom_effect` hook (effect 0 = tint, `[r, g, b, amount]`) — no bounds expansion,
/// since a colour effect stays within the source, unlike the offset/blur the fork sizes itself.
fn lower_node(filter_node: &m::FilterNode) -> Filter {
    match filter_node {
        m::FilterNode::Blur { sigma } => gaussian_blur(*sigma),
        m::FilterNode::Offset { dx, dy } => Filter::from_primitive(FilterPrimitive::Offset {
            dx: *dx,
            dy: *dy,
        }),
        m::FilterNode::InnerShadow { dx, dy, sigma, color } => {
            Filter::from_primitive(FilterPrimitive::InnerShadow {
                dx: *dx,
                dy: *dy,
                std_deviation: *sigma,
                color: *color,
                edge_mode: EdgeMode::None,
            })
        }
    }
}

/// Draw a container's children, honouring a masked group.
///
/// For a masked group the first (bottom-most) child is Penpot's mask: it clips the rest to its
/// silhouette instead of being drawn itself. An **opaque** mask makes that exactly a clip to the
/// silhouette, which is what happens here — the mask child's outline becomes a clip layer around
/// the content. A **soft** mask (a gradient, an image, or a partly transparent fill) needs a true
/// DstIn *alpha* mask, which `push_layer`'s mask slot wants as a screen-space raster built from an
/// offscreen render the neutral `RenderingContext` cannot yet produce — so it is deferred and, for
/// now, approximated by this hard clip, the same "carry it in the model, approximate the pixels"
/// contract as shadow spread and inner shadows. The digest already agrees regardless, because the
/// mask flag and the children are in the model either way.
fn draw_children<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    text: &mut TextEngine,
    scene: &m::Scene,
    node: &m::Node,
    root: Affine,
    modifiers: &crate::abi::Modifiers,
    depth: u32,
) {
    // The mask is the first child, the content the rest. A masked group with no children has
    // nothing to mask; one with only the mask draws nothing at all (the content is empty).
    let mask_id = (node.masked && node.kind == m::ShapeKind::Group)
        .then(|| node.children.first().copied())
        .flatten();

    let Some(mask_id) = mask_id else {
        for child in &node.children {
            draw_node(ctx, resources, text, scene, *child, root, modifiers, depth + 1);
        }
        return;
    };

    // Clip to the mask child's silhouette, captured in that child's own page-space matrix — the
    // same way a frame's clip carries the matrix current at push time. If the mask child has not
    // arrived yet, draw the content unclipped rather than hiding it, matching how a not-yet-sent
    // child is tolerated elsewhere.
    let clipped = scene.get(mask_id).map(|mask| {
        let modifier = modifiers.get(&mask_id).copied().unwrap_or(Affine::IDENTITY);
        ctx.set_transform(root * modifier * mask.effective_transform());
        ctx.push_layer(Some(&outline(mask)), None, None, None, None);
    });

    for child in node.children.iter().skip(1) {
        draw_node(ctx, resources, text, scene, *child, root, modifiers, depth + 1);
    }

    if clipped.is_some() {
        ctx.pop_layer();
    }
}

/// Draw a node's drop shadows, back to front, behind its own paint.
///
/// A drop shadow is the shape's silhouette, offset, filled with the shadow colour and softened by
/// a Gaussian blur — built from the single upstream `GaussianBlur` primitive rather than the
/// fork's compound `DropShadow` (which bundles the source and so cannot stack). One
/// `push_filter_layer` per shadow keeps every filter graph single-primitive.
///
/// **Spread** grows the silhouette before the blur ([`spread_outline`]) — no fork edit, because our
/// shadow is a CPU-filled path rather than the fork's alpha-morphology primitive. Still dropped
/// rather than faked: **inner** shadows (never reach the model). The offset is applied in the
/// shape's own space (`matrix · translate(offset)`), so it rotates with the shape; that composition
/// is not yet pixel-checked against render-wasm.
fn draw_drop_shadows<T: RenderingContext>(ctx: &mut T, node: &m::Node, matrix: Affine) {
    // A text shadow is glyph-shaped, not a box around the bounds; drawing `outline(node)` (the
    // bounds rect) would be wrong, so text shadows are deferred with the rest of the text effects.
    if node.shadows.is_empty()
        || node.kind == m::ShapeKind::Group
        || node.kind == m::ShapeKind::Text
    {
        return;
    }
    // The un-spread silhouette, reused for every zero-spread shadow so the common case allocates
    // no extra path.
    let base = outline(node);
    // Only *drop* shadows are drawn behind the shape here; inner shadows are drawn *inside* it by
    // `push_inner_shadows`, wrapping the shape's own paint.
    for shadow in node.shadows.iter().filter(|s| !s.inset) {
        // Cap the device-space blur so it never enters the fork's lossy many-decimation regime —
        // parity with render-wasm, which caps the shadow blur the same way. The offset shrinks by
        // the same factor when the blur is clamped, so the shadow keeps its shape past the cap.
        let (sigma, offset_ratio) = cap_shadow_blur(radius_to_sigma(shadow.blur), matrix);
        let softened = sigma > 0.0;
        // Set the (zoom-scaled) transform *before* pushing the blur layer. `push_filter_layer`
        // captures the transform current at push time and scales the blur's sigma and expansion by
        // it, so a stale transform here would fix the shadow's softness at a device-pixel size — it
        // would stop growing as you zoom in, reading as the blur collapsing to a hard edge that
        // "narrows to fit the viewport". The offset rides in the same matrix, so it too scales and
        // rotates with the shape.
        ctx.set_transform(
            matrix * Affine::translate((shadow.offset.x * offset_ratio, shadow.offset.y * offset_ratio)),
        );
        ctx.set_paint_transform(Affine::IDENTITY);
        ctx.set_paint(shadow.color);
        if softened {
            ctx.push_filter_layer(gaussian_blur(sigma));
        }
        if shadow.spread > 0.0 {
            let grown = spread_outline(node, f64::from(shadow.spread));
            ctx.fill_path(&grown);
        } else {
            ctx.fill_path(&base);
        }
        if softened {
            ctx.pop_layer();
        }
    }
}

/// Wrap the shape's own paint in one filter layer per inner (inset) shadow, returning the count so
/// the caller pops the same number after painting. Unlike a drop shadow — a separate silhouette
/// drawn behind — an inner shadow is a property *of the shape's pixels*: the fork's `InnerShadow`
/// primitive reads the layer's alpha and darkens inside its edges (`inner = colour · a · (1 −
/// blurred.a)`), so it must enclose the fill rather than sit behind it.
///
/// The transform is set before each push so the fork scales the offset and blur by the zoom, and the
/// blur is capped exactly like the drop shadow. Not applied to groups (no paint of their own) or
/// text (glyph-shaped inner shadows are deferred with the other text effects).
fn push_inner_shadows<T: RenderingContext>(ctx: &mut T, node: &m::Node, matrix: Affine) -> u32 {
    if node.kind == m::ShapeKind::Group || node.kind == m::ShapeKind::Text {
        return 0;
    }
    let mut pushed = 0;
    for shadow in node.shadows.iter().filter(|s| s.inset) {
        ctx.set_transform(matrix);
        ctx.push_filter_layer(inner_shadow_filter(shadow, matrix));
        pushed += 1;
    }
    pushed
}

/// The fork's inner-shadow filter for one inset [`m::Shadow`]. Offset and blur are user-space; the
/// fork's `transform_shadow_params` scales them to device by the layer transform, so the blur is
/// pre-capped (as a user-space value) the same way the drop shadow is. Inner shadows ignore
/// `spread`, matching render-wasm.
fn inner_shadow_filter(shadow: &m::Shadow, matrix: Affine) -> Filter {
    // The offset shrinks with the blur past the cap so the inner shadow's dark band — whose
    // thickness is the offset — keeps its proportion under zoom instead of drifting.
    let (std_deviation, offset_ratio) = cap_shadow_blur(radius_to_sigma(shadow.blur), matrix);
    let offset_ratio = offset_ratio as f32;
    Filter::from_primitive(FilterPrimitive::InnerShadow {
        dx: shadow.offset.x as f32 * offset_ratio,
        dy: shadow.offset.y as f32 * offset_ratio,
        std_deviation,
        color: shadow.color,
        edge_mode: EdgeMode::None,
    })
}

/// Shape and paint a text node with Parley.
///
/// render-wasm lays the same content out with Skia; the two shapers disagree glyph-for-glyph, so
/// the neutral model carries the *input* and each backend shapes it — the digest hashes that input,
/// not this result (see [`render_core::text`]). One Parley `Layout` per paragraph, stacked top to
/// bottom (matching render-wasm's per-paragraph layout), then the whole stack is offset for
/// vertical alignment.
///
/// Deferred, and dropped rather than faked (a later slice): text transforms, RTL, emoji/COLR,
/// text effects, the editor.
fn draw_text<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    engine: &mut TextEngine,
    node: &m::Node,
    matrix: Affine,
) {
    if node.text.is_none() {
        return;
    }

    // While this shape is the focused editor, its text comes from the editor's own layout — so the
    // caret and selection (computed from that same layout) always align with the drawn glyphs.
    if engine.editor_for == Some(node.id) && engine.editor.is_some() {
        draw_focused_editor(ctx, resources, engine, node, matrix);
        return;
    }

    // The layout + glyph drawing is the backend-neutral path shared with the classic backend; font
    // aliases resolve through the ABI collection via [`AbiEnv`].
    render_core::vello::text::draw_text_block(
        ctx,
        resources,
        &mut engine.font_cx,
        &mut engine.layout_cx,
        &AbiEnv,
        node,
        matrix,
        None,
    );
}

/// Draw a text shape that is being edited: its selection highlights, then its glyphs (from the
/// editor's own layout), then the caret — all in the node's space so they align with each other.
fn draw_focused_editor<T: RenderingContext>(
    ctx: &mut T,
    resources: &mut T::Resources,
    engine: &TextEngine,
    node: &m::Node,
    matrix: Affine,
) {
    let Some(editor) = engine.editor.as_ref() else {
        return;
    };
    // Top-aligned for now; a vertical-align offset (as `draw_text` computes) is a later refinement.
    let (ox, oy) = (node.bounds.x0, node.bounds.y0);

    // Selection highlights, behind the glyphs.
    ctx.set_transform(matrix);
    ctx.set_paint_transform(Affine::IDENTITY);
    ctx.set_paint(crate::abi::argb_to_color(crate::editor::selection_color()));
    for bbox in editor.selection_geometry() {
        ctx.fill_rect(&Rect::new(ox + bbox.x0, oy + bbox.y0, ox + bbox.x1, oy + bbox.y1));
    }

    // The text itself, from the editor's multi-style layout (already rebuilt by `sync_editor`),
    // through the shared neutral glyph-run drawer.
    render_core::vello::text::draw_layout(
        ctx,
        resources,
        &AbiEnv,
        editor.layout(),
        ox as f32,
        oy as f32,
        node.bounds,
        &node.strokes,
        None,
    );

    // The caret on top, in its visible blink phase.
    if crate::editor::blink_on() {
        let [cx, cy, cw, ch] = editor.caret_rect(CARET_WIDTH);
        ctx.set_transform(matrix);
        ctx.set_paint_transform(Affine::IDENTITY);
        ctx.set_paint(crate::abi::argb_to_color(crate::editor::cursor_color()));
        ctx.fill_rect(&Rect::new(
            ox + f64::from(cx),
            oy + f64::from(cy),
            ox + f64::from(cx + cw),
            oy + f64::from(cy + ch),
        ));
    }
}

// The paragraph layout + glyph-run drawing (`layout_paragraph`, `alignment_of`, `draw_layout`,
// `draw_glyph_run`) now live in the backend-neutral `render_core::vello::text`, shared with the
// classic backend. `draw_text` and `draw_focused_editor` above delegate to it.

/// Paint a node's own geometry, ignoring its children.
///
/// The fill/stroke translation — every paint kind, the rect/path/outline dispatch, the paint-space
/// reset — is the backend-neutral [`render_core::vello::draw::paint_body`], shared verbatim with the
/// classic backend; image/diamond references resolve through the ABI atlas via [`AbiEnv`].
fn paint_self<T: RenderingContext>(ctx: &mut T, node: &m::Node, matrix: Affine, group_inline: bool) {
    render_core::vello::draw::paint_body(ctx, &AbiEnv, node, matrix, group_inline);
}

/// The host-backed [`DrawEnv`](render_core::vello::draw::DrawEnv) for the hybrid backend: image and
/// baked-diamond references resolve through the ABI atlas the renderer fills each frame from
/// `store_image_rgba` / `stage_diamond_bakes`.
pub(crate) struct AbiEnv;

impl render_core::vello::draw::DrawEnv for AbiEnv {
    fn resolve_image(&self, id: u128) -> Option<vello_common::paint::ImageId> {
        crate::abi::resolve_image(id)
    }
    fn font_alias(&self, id: u128, weight: u16, italic: bool) -> String {
        crate::abi::font_alias(id, weight, italic)
    }
}

/// A hand-built neutral scene using the SAME types render-wasm's converter emits, now as a tree:
/// a clipping frame whose children overflow it, and a half-transparent group over a path.
///
/// Every element here is a traversal assertion you can check by looking:
/// - the frame's radii are **asymmetric**, so a reordering shows as the wrong corner rounding;
/// - both its children **overflow** it, so a lost clip shows as spill;
/// - the white rect is **rotated**, so a missing centre-conjugation throws it out of the frame
///   entirely rather than tilting it in place;
/// - the group is **half-transparent**, so an alpha applied per-node instead of per-subtree
///   shows as a fully saturated path.
fn demo_model() -> m::Scene {
    let mut s = m::Scene::new();

    let mut root = m::Node::new(m::ROOT_ID, m::ShapeKind::Group);
    root.children = vec![1, 5];
    s.insert(root);

    let mut frame = m::Node::new(1, m::ShapeKind::Frame);
    frame.bounds = Rect::new(120.0, 180.0, 720.0, 600.0);
    frame.corners = Some(render_core::kurbo::RoundedRectRadii::new(
        72.0, 12.0, 72.0, 12.0,
    ));
    frame.fills = vec![m::Paint::plain(Brush::Solid(Color::from_rgba8(56, 152, 236, 255)))];
    // A dashed stroke, straddling the frame's edge. It must *not* be clipped by the frame's own
    // clip — that is why clip and opacity take separate layers — so half of it sits outside.
    let mut frame_stroke = render_core::kurbo::Stroke::new(12.0);
    render_core::model::apply_stroke_style(
        &mut frame_stroke,
        render_core::model::StrokeStyle::Dashed,
        12.0,
        &[],
    );
    frame.strokes = vec![m::Stroke {
        style: frame_stroke,
        paint: m::Paint::plain(Brush::Solid(Color::from_rgba8(255, 255, 255, 255))),
        align: m::StrokeAlign::Center,
    }];
    frame.clip = true;
    frame.children = vec![2, 3];
    s.insert(frame);

    let mut circle = m::Node::new(2, m::ShapeKind::Circle);
    circle.bounds = Rect::new(540.0, 420.0, 870.0, 750.0);
    // A radial gradient, deliberately squashed and rotated: the ellipse ratio and the angle
    // both live in the paint transform, so a circle filled with a plain circular gradient would
    // prove nothing about that path.
    let (radial, radial_transform) = render_core::gradient::gradient_paint(
        render_core::gradient::GradientShape::Radial,
        render_core::gradient::GradientGeometry {
            start: (0.5, 0.5),
            end: (0.95, 0.25),
            width: (0.55, 0.0),
        },
        &[
            render_core::peniko::ColorStop {
                offset: 0.0,
                color: Color::from_rgba8(255, 220, 120, 255).into(),
            },
            render_core::peniko::ColorStop {
                offset: 1.0,
                color: Color::from_rgba8(240, 90, 40, 255).into(),
            },
        ],
    )
    .expect("the demo gradient is not degenerate");
    circle.fills = vec![m::Paint {
        brush: Brush::Gradient(radial),
        transform: radial_transform,
    }];
    s.insert(circle);

    let mut rect = m::Node::new(3, m::ShapeKind::Rect);
    rect.bounds = Rect::new(180.0, 240.0, 420.0, 360.0);
    rect.transform = Affine::rotate(0.3);
    rect.fills = vec![m::Paint::plain(Brush::Solid(Color::from_rgba8(250, 250, 250, 255)))];
    // A dotted stroke: kurbo has no `path_1d` equivalent, so it is a zero-length dash with
    // round caps, which draws dots of diameter equal to the width — the same as Skia's circles.
    let mut dots = render_core::kurbo::Stroke::new(6.0);
    render_core::model::apply_stroke_style(
        &mut dots,
        render_core::model::StrokeStyle::Dotted,
        6.0,
        &[],
    );
    rect.strokes = vec![m::Stroke {
        style: dots,
        paint: m::Paint::plain(Brush::Solid(Color::from_rgba8(20, 20, 20, 255))),
        align: m::StrokeAlign::Center,
    }];
    s.insert(rect);

    let mut group = m::Node::new(5, m::ShapeKind::Group);
    group.opacity = 0.5;
    group.children = vec![6];
    s.insert(group);

    let mut path = BezPath::new();
    path.move_to((0.0, 0.0));
    path.line_to((360.0, 90.0));
    path.curve_to((270.0, 270.0), (180.0, 360.0), (90.0, 450.0));
    path.line_to((0.0, 180.0));
    path.close_path();

    let mut path_node = m::Node::new(6, m::ShapeKind::Path);
    path_node.bounds = Rect::new(0.0, 0.0, 360.0, 450.0);
    path_node.path = Some(path);
    path_node.transform = Affine::translate((860.0, 160.0));
    path_node.fills = vec![m::Paint::plain(Brush::Solid(Color::from_rgba8(70, 190, 120, 255)))];
    s.insert(path_node);

    s
}
