//! Deterministic scene generators for the perf bench harness.
//!
//! Mirrored on the JS side via preset id; one source of truth lives
//! here. Each `SceneSpec` controls a parameterised configuration —
//! shape count, container hierarchy, and which effects fire on each
//! shape. `build_into_state` clears the existing pool and rebuilds
//! it from a spec; the wasm-exported `build_perf_scene(scene_id)`
//! looks up a preset and calls in.
//!
//! Gated on `perf-trace` so production builds don't ship the
//! generator code or its presets.

#![cfg(feature = "perf-trace")]
#![allow(dead_code)]

use crate::math;
use crate::shapes::{
    Blur, BlurType, Color, Fill, FontFamily, FontStyle, Frame, GlassEffect, Gradient, GrowType,
    Group, Paragraph, Rect as ShapeRect, SVGRaw, Shadow, ShadowStyle, Shape, SolidColor, Stroke,
    StrokeCap, StrokeKind, StrokeStyle, TextAlign, TextContent, TextDirection, TextSpan,
    TextureEffect, Type,
};
use crate::state::State;
use crate::uuid::Uuid;

/// Fill style applied to every shape in the generated scene.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillSpec {
    None,
    Solid,
}

/// Shape kind for leaves and containers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeKindSpec {
    /// Leaves are `Rect`, containers are `Frame`.
    RectLeaves,
}

/// Single-effect isolation mode for per-effect attribution scenes.
/// When set, `configure_leaf` clears any default fills/strokes/shadows
/// for the leaf and applies only the requested effect path. Lets the
/// bench attribute time per individual effect (drop shadow vs inner
/// shadow vs layer blur vs background blur vs glass vs texture/scatter
/// vs gradient fill vs stroke-only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IsolatedFx {
    None,
    DropShadow,
    InnerShadow,
    LayerBlur,
    BackgroundBlur,
    Glass,
    Texture,
    GradientFill,
    StrokeOnly,
    /// V2c.2 — every leaf gets `opacity = 0.6`. Forces a `save_layer`
    /// per leaf in the renderer; the externalized `BeginLayer`/
    /// `EndLayer` scheduler steps target this scene.
    Opacity,
    /// V2c.3 prereq — every leaf becomes a `Text` shape with a
    /// short string in the embedded default font. Covers the text
    /// render path that no existing iso scene exercises.
    Text,
    /// V2c.3 prereq — every leaf becomes a `SVGRaw` shape with a
    /// small inline SVG. Covers the SVG render path.
    SvgIcon,
    /// V2c.3 prereq, container-level — every container becomes a
    /// `Group { masked: true }`. The first child of each group acts
    /// as the mask (per `Shape::mask_id`). Leaves get a basic solid
    /// fill, no leaf effect.
    Masked,
    /// V2c.3 target, container-level — every container becomes a
    /// `Group` with `opacity = 0.6`. Leaves get a basic solid fill,
    /// no leaf effect. Designed to expose the per-tile children
    /// re-render cost that V2c.3's subtree cache will eliminate.
    OpacityGroups,
}

impl IsolatedFx {
    /// Container-level variants apply to the parent `Group/Frame`,
    /// not to leaves. Leaves in container-level scenes get only a
    /// basic fill so the effect under test is the container's.
    pub fn applies_to_container(self) -> bool {
        matches!(self, Self::Masked | Self::OpacityGroups)
    }
}

/// Parameterised scene description. Same shape on both sides of the
/// wasm boundary; encode at most one preset id and look the spec up
/// here.
#[derive(Debug, Clone)]
pub struct SceneSpec {
    pub name: &'static str,
    pub n_shapes: usize,
    pub container_depth: u32,
    pub branching_factor: u32,
    pub drop_shadows_per_shape: u32,
    pub drop_shadow_blur: f32,
    pub bg_blur: bool,
    pub glass: bool,
    pub inner_shadows: u32,
    pub fill: FillSpec,
    pub kinds: ShapeKindSpec,
    /// When true, ignore the uniform effect knobs above and apply a
    /// mixed distribution across shapes (some with 1 shadow, some
    /// with 6, a sprinkle of bg_blur / glass / inner). Used by the
    /// "fast_mixed" preset to exercise every code path in one cell.
    pub heterogeneous: bool,
    /// Layer-on flag for `heterogeneous`: also varies shape type
    /// (Rect / Circle), drops a `TextureEffect` (scatter) on some
    /// shapes, drops a `GlassEffect` (gather) on others, and creates
    /// shapes with both scatter+gather to exercise the combined
    /// `BuildCache` path. Plus pins explicit fx combinations on the
    /// first 5 root-level children. Used by the "fx_combos" preset.
    pub fx_combos: bool,
    /// Per-effect isolation. When non-`None`, every leaf gets a single
    /// solid fill plus the requested effect — nothing else. Designed
    /// for attribution: each iso scene's frame timings reflect that
    /// one effect's cost only. Containers get no effects.
    pub iso_fx: IsolatedFx,
}

impl SceneSpec {
    const fn flat(name: &'static str, n: usize, shadows: u32) -> Self {
        Self {
            name,
            n_shapes: n,
            container_depth: 0,
            branching_factor: 1,
            drop_shadows_per_shape: shadows,
            drop_shadow_blur: 16.0,
            bg_blur: false,
            glass: false,
            inner_shadows: 0,
            fill: FillSpec::Solid,
            kinds: ShapeKindSpec::RectLeaves,
            heterogeneous: false,
            fx_combos: false,
            iso_fx: IsolatedFx::None,
        }
    }

    const fn nested(
        name: &'static str,
        n: usize,
        depth: u32,
        branching: u32,
        shadows: u32,
    ) -> Self {
        Self {
            name,
            n_shapes: n,
            container_depth: depth,
            branching_factor: branching,
            drop_shadows_per_shape: shadows,
            drop_shadow_blur: 16.0,
            bg_blur: false,
            glass: false,
            inner_shadows: 0,
            fill: FillSpec::Solid,
            kinds: ShapeKindSpec::RectLeaves,
            heterogeneous: false,
            fx_combos: false,
            iso_fx: IsolatedFx::None,
        }
    }

    /// Per-effect isolation scene: 200 flat leaves, solid fill, one
    /// effect per shape. Used to attribute time per individual effect
    /// without container hierarchy noise.
    const fn iso(name: &'static str, n: usize, fx: IsolatedFx) -> Self {
        Self {
            name,
            n_shapes: n,
            container_depth: 0,
            branching_factor: 1,
            drop_shadows_per_shape: 0,
            drop_shadow_blur: 16.0,
            bg_blur: false,
            glass: false,
            inner_shadows: 0,
            fill: FillSpec::Solid,
            kinds: ShapeKindSpec::RectLeaves,
            heterogeneous: false,
            fx_combos: false,
            iso_fx: fx,
        }
    }

    /// Container-level isolation scene: `n_groups` containers, each
    /// holding `leaves_per_group` leaves. Used by container-level
    /// `IsolatedFx` variants (Masked, OpacityGroups) so the metric
    /// reflects per-container cost rather than per-leaf.
    const fn iso_groups(
        name: &'static str,
        n_groups: u32,
        leaves_per_group: usize,
        fx: IsolatedFx,
    ) -> Self {
        Self {
            name,
            n_shapes: n_groups as usize * leaves_per_group,
            container_depth: 1,
            branching_factor: n_groups,
            drop_shadows_per_shape: 0,
            drop_shadow_blur: 16.0,
            bg_blur: false,
            glass: false,
            inner_shadows: 0,
            fill: FillSpec::Solid,
            kinds: ShapeKindSpec::RectLeaves,
            heterogeneous: false,
            fx_combos: false,
            iso_fx: fx,
        }
    }
}

/// Preset id ↔ spec table. The id is the contract between Rust and
/// the JS perf page. **Append-only** — never reorder; new presets
/// take a new tail id.
pub fn preset(id: u32) -> Option<SceneSpec> {
    Some(match id {
        0 => SceneSpec::flat("flat_baseline", 1_000, 0),
        1 => SceneSpec::flat("flat_1shadow", 1_000, 1),
        2 => SceneSpec::flat("flat_6shadows", 1_000, 6),
        3 => SceneSpec::nested("nested_d3_b5_no_fx", 1_000, 3, 5, 0),
        4 => SceneSpec::nested("nested_d3_b5_1shadow", 1_000, 3, 5, 1),
        5 => SceneSpec::nested("nested_d3_b5_6shadows", 1_000, 3, 5, 6),
        6 => {
            let mut s = SceneSpec::nested("mixed_kitchen_sink", 500, 3, 5, 2);
            s.bg_blur = true;
            s.glass = true;
            s.inner_shadows = 1;
            s
        }
        7 => SceneSpec::nested("nested_d5_b5_3shadows_10k", 10_000, 5, 5, 3),
        8 => {
            // Single bench scene that exercises every effect path in
            // one cell. Containers and leaves get a varied shadow
            // distribution (0/1/6) so timings reflect a realistic
            // dashboard rather than a uniform stress test.
            let mut s = SceneSpec::nested("fast_mixed_500", 500, 2, 4, 0);
            s.bg_blur = true;
            s.glass = true;
            s.inner_shadows = 0; // applied per-shape in heterogeneous mode
            s.heterogeneous = true;
            s
        }
        9 => {
            // Heaviest mix: heterogeneous shadows + Rect/Circle types
            // + per-shape texture (scatter) and glass (gather)
            // sprinkles + shapes with both fx in combination + 5
            // explicit fx combos pinned at root level. Catches
            // BuildCache(Scatter) + BuildCache(Gather) interactions
            // and the scatter+glass combined cache code path.
            let mut s = SceneSpec::nested("fx_combos_500", 500, 2, 4, 0);
            s.heterogeneous = true;
            s.fx_combos = true;
            s
        }
        // Per-effect isolation scenes (200 flat leaves, one effect per
        // shape). Frame timings on these scenes attribute cost to a
        // single effect path, so the diff CLI can answer "drop shadow
        // is N ms/frame" without container or fill noise.
        10 => SceneSpec::iso("iso_drop_shadow_200", 200, IsolatedFx::DropShadow),
        11 => SceneSpec::iso("iso_inner_shadow_200", 200, IsolatedFx::InnerShadow),
        12 => SceneSpec::iso("iso_layer_blur_200", 200, IsolatedFx::LayerBlur),
        // bg_blur + glass are per-leaf gather effects — heaviest paths
        // in the renderer. 100 shapes keeps each frame timing in the
        // tens of ms range and the run inside the playwright timeout.
        13 => SceneSpec::iso("iso_bg_blur_100", 100, IsolatedFx::BackgroundBlur),
        14 => SceneSpec::iso("iso_glass_100", 100, IsolatedFx::Glass),
        15 => SceneSpec::iso("iso_texture_200", 200, IsolatedFx::Texture),
        16 => SceneSpec::iso("iso_gradient_500", 500, IsolatedFx::GradientFill),
        17 => SceneSpec::iso("iso_stroke_500", 500, IsolatedFx::StrokeOnly),
        // V2c.2 — every leaf has `opacity = 0.6`. Forces `save_layer`
        // per leaf, which V2c.2 lifts from `render_shape_enter` into a
        // top-level `BeginLayer`/`EndLayer` step.
        18 => SceneSpec::iso("iso_opacity_500", 500, IsolatedFx::Opacity),
        // V2c.3 prereq — text path coverage. 200 text leaves, default
        // embedded Source Sans Pro font, single short string per leaf.
        19 => SceneSpec::iso("iso_text_200", 200, IsolatedFx::Text),
        // V2c.3 prereq — SVG path coverage. 50 leaves (SVG render is
        // heavier than rect/text per shape). Each leaf has a small
        // inline SVG with a stroked path.
        20 => SceneSpec::iso("iso_svg_50", 50, IsolatedFx::SvgIcon),
        // V2c.3 prereq — masked group two-pass coverage. 10 groups ×
        // 5 leaves each. First child of each group acts as mask
        // (per `Shape::mask_id`). 50 leaves total.
        21 => SceneSpec::iso_groups("iso_masked_50", 10, 5, IsolatedFx::Masked),
        // V2c.3 target — container opacity. 20 groups × 5 leaves,
        // `opacity = 0.6` on each group. The subtree cache should
        // hit for every group on idle/pan; zoom invalidates by
        // scale bucket.
        22 => SceneSpec::iso_groups("iso_groups_100", 20, 5, IsolatedFx::OpacityGroups),
        _ => return None,
    })
}

/// Number of presets in the table. Test loops use this to iterate.
pub fn preset_count() -> u32 {
    let mut n = 0u32;
    while preset(n).is_some() {
        n += 1;
    }
    n
}

const LEAF_W: f32 = 80.0;
const LEAF_H: f32 = 60.0;
const LEAF_STRIDE: f32 = 100.0;
const LEAVES_PER_ROW: usize = 100;

/// Reset the shapes pool and populate it from `spec`. Containers come
/// first so leaves can reference them as parents. Returns nothing —
/// caller is expected to call `rebuild_tiles` afterwards if rendering
/// is to follow.
pub fn build_into_state(state: &mut State, spec: &SceneSpec) {
    // Replace the entire pool: drop existing shapes + start a fresh
    // root. `initialize` reserves capacity to avoid re-allocs in the
    // 10k-shape preset.
    let estimated = spec.n_shapes
        + container_count(spec.container_depth, spec.branching_factor) as usize
        + 1;
    let pool = &mut state.shapes;
    *pool = crate::state::ShapesPool::new();
    pool.initialize(estimated);
    pool.add_shape(Uuid::nil());

    // Container-level iso scenes need predictable visual layout
    // (leaves inside parent's bounds so the container's clip+effect
    // visibly applies). The generic `build_nested` positions leaves
    // in a global grid which lands most of them outside their
    // parent — fine for timing-only bench but invisible on the
    // canvas. Use a dedicated layout for iso_groups / iso_masked.
    if spec.iso_fx.applies_to_container() {
        build_iso_groups(state, spec);
    } else if spec.container_depth == 0 {
        build_flat(state, spec);
    } else {
        build_nested(state, spec);
    }

    // Tile index needs the populated pool to map shape→tile correctly.
    state.rebuild_tiles();
}

/// Layout for container-level iso scenes (`Masked`, `OpacityGroups`).
///
/// Containers laid out in a regular grid that fits the perf-page
/// canvas (1920×1080 logical, viewport ≈ 960×540 visible). Each
/// container holds `leaves_per_group = n_shapes / n_groups` leaves
/// arranged in a sub-grid within the container's selrect. Leaves get
/// `parent_id = container.id` so the container's effect (mask /
/// opacity) actually applies to the visible pixels.
fn build_iso_groups(state: &mut State, spec: &SceneSpec) {
    let n_groups = spec.branching_factor as usize;
    let leaves_per_group = spec.n_shapes / n_groups.max(1);

    // Lay containers out in a 5-col grid within the visible area.
    const GROUP_COLS: usize = 5;
    const GROUP_W: f32 = 170.0;
    const GROUP_H: f32 = 170.0;
    const GROUP_GAP: f32 = 20.0;

    // Sub-grid for leaves inside each container.
    const LEAF_COLS: usize = 3;
    const LEAF_W_INNER: f32 = 40.0;
    const LEAF_H_INNER: f32 = 40.0;
    const LEAF_GAP_INNER: f32 = 10.0;

    let nil = Uuid::nil();
    let mut counter: u64 = 0;
    let mut container_ids: Vec<Uuid> = Vec::with_capacity(n_groups);

    for g in 0..n_groups {
        counter += 1;
        let id = Uuid::from_u64_pair(0xDEAD, counter);
        let shape = state.shapes.add_shape(id);
        let col = (g % GROUP_COLS) as f32;
        let row = (g / GROUP_COLS) as f32;
        shape.parent_id = Some(nil);
        shape.shape_type = match spec.iso_fx {
            IsolatedFx::Masked => Type::Group(Group { masked: true }),
            IsolatedFx::OpacityGroups => Type::Group(Group { masked: false }),
            _ => Type::Frame(Frame::default()),
        };
        if matches!(spec.iso_fx, IsolatedFx::OpacityGroups) {
            shape.opacity = 0.6;
        }
        // Groups don't clip by default in Penpot; only Frames do. Both
        // variants here are Group, so children render even if outside
        // selrect — but we keep selrect sized to the children so the
        // tile spatial index covers them correctly.
        let x = col * (GROUP_W + GROUP_GAP) + 20.0;
        let y = row * (GROUP_H + GROUP_GAP) + 20.0;
        shape.selrect = math::Rect::from_xywh(x, y, GROUP_W, GROUP_H);
        // Light tinted background fill so the group is visible behind
        // its leaves at lower opacity.
        let tint = deterministic_color(g, 80);
        shape.fills.push(Fill::Solid(SolidColor(tint)));
        container_ids.push(id);
        state.shapes.get_mut(&nil).unwrap().children.push(id);
    }

    let is_masked = matches!(spec.iso_fx, IsolatedFx::Masked);
    for (g, &parent) in container_ids.iter().enumerate() {
        let parent_origin = state
            .shapes
            .get(&parent)
            .map(|s| (s.selrect.x(), s.selrect.y()))
            .unwrap_or((0.0, 0.0));
        for li in 0..leaves_per_group {
            counter += 1;
            let id = Uuid::from_u64_pair(0xCAFE, counter);
            let shape = state.shapes.add_shape(id);
            shape.parent_id = Some(parent);
            shape.shape_type = Type::Rect(ShapeRect::default());
            // For Masked groups, the first child acts as the mask
            // (per `Shape::mask_id`). Size it to cover the whole
            // container area so the other 4 leaves' pixels actually
            // pass the mask. Without this, the small mask + non-
            // overlapping leaves render as fully-clipped (blank).
            if is_masked && li == 0 {
                shape.selrect = math::Rect::from_xywh(
                    parent_origin.0 + 10.0,
                    parent_origin.1 + 10.0,
                    GROUP_W - 20.0,
                    GROUP_H - 20.0,
                );
                shape
                    .fills
                    .push(Fill::Solid(SolidColor(Color::from_argb(255, 0, 0, 0))));
                state.shapes.get_mut(&parent).unwrap().children.push(id);
                continue;
            }
            let li_content = if is_masked { li - 1 } else { li };
            let lcol = (li_content % LEAF_COLS) as f32;
            let lrow = (li_content / LEAF_COLS) as f32;
            let x = parent_origin.0 + 25.0 + lcol * (LEAF_W_INNER + LEAF_GAP_INNER);
            let y = parent_origin.1 + 25.0 + lrow * (LEAF_H_INNER + LEAF_GAP_INNER);
            shape.selrect = math::Rect::from_xywh(x, y, LEAF_W_INNER, LEAF_H_INNER);
            shape
                .fills
                .push(Fill::Solid(SolidColor(deterministic_color(
                    g.wrapping_mul(7).wrapping_add(li),
                    255,
                ))));
            state.shapes.get_mut(&parent).unwrap().children.push(id);
        }
    }
}

fn container_count(depth: u32, branching: u32) -> u32 {
    if branching <= 1 {
        return depth;
    }
    // (branching^depth - 1) / (branching - 1) — closed form for total
    // nodes in a perfect b-ary tree, depth = number of levels of
    // containers above leaves (exclusive of root and leaves).
    let mut total = 0u32;
    let mut level_size = 1u32;
    for _ in 0..depth {
        level_size = level_size.saturating_mul(branching);
        total = total.saturating_add(level_size);
    }
    total
}

fn build_flat(state: &mut State, spec: &SceneSpec) {
    let nil = Uuid::nil();
    for i in 0..spec.n_shapes {
        let id = Uuid::from_u64_pair(0xCAFE, i as u64);
        let shape = state.shapes.add_shape(id);
        configure_leaf(shape, spec, i, nil);
        state.shapes.get_mut(&nil).unwrap().children.push(id);
    }
    if spec.bg_blur {
        attach_root_bg_blur(state, spec);
    }
    if spec.glass {
        attach_root_glass(state, spec);
    }
}

fn build_nested(state: &mut State, spec: &SceneSpec) {
    // Build container tree breadth-first. Each level holds
    // `parent_count * branching` containers. The deepest level's
    // containers fan out into leaves to reach `n_shapes`.
    let mut current_level: Vec<Uuid> = vec![Uuid::nil()];
    let mut counter: u64 = 0;

    for depth in 0..spec.container_depth {
        let mut next_level: Vec<Uuid> = Vec::with_capacity(
            current_level.len() * spec.branching_factor as usize,
        );
        for &parent in &current_level {
            for child_idx in 0..spec.branching_factor {
                counter += 1;
                let id = Uuid::from_u64_pair(0xDEAD, counter);
                let shape = state.shapes.add_shape(id);
                configure_container(shape, spec, depth, child_idx, parent);
                state.shapes.get_mut(&parent).unwrap().children.push(id);
                next_level.push(id);
            }
        }
        current_level = next_level;
    }

    // Leaves distributed across deepest containers (round-robin).
    let bucket_count = current_level.len().max(1);
    for i in 0..spec.n_shapes {
        let parent = current_level[i % bucket_count];
        let id = Uuid::from_u64_pair(0xCAFE, i as u64);
        let shape = state.shapes.add_shape(id);
        configure_leaf(shape, spec, i, parent);
        state.shapes.get_mut(&parent).unwrap().children.push(id);
    }

    if spec.bg_blur {
        attach_root_bg_blur(state, spec);
    }
    if spec.glass {
        attach_root_glass(state, spec);
    }
    if spec.fx_combos {
        pin_root_fx_combos(state);
    }
}

/// Pin explicit fx combinations on the first 5 root-level children.
/// Each gets exactly one pre-defined fx setup so the per-frame
/// schedule always emits a known mix of `BuildCache(Scatter)`,
/// `BuildCache(Gather)`, and the combined Scatter+Gather path.
///
/// Slots:
///   0: glass-only (gather)
///   1: texture-only (scatter)
///   2: glass + texture (combined cache)
///   3: bg_blur + heavy drop shadow
///   4: glass + texture + drop shadow stack
fn pin_root_fx_combos(state: &mut State) {
    let nil = Uuid::nil();
    let root_children: Vec<Uuid> = state
        .shapes
        .get(&nil)
        .map(|r| r.children.iter().copied().take(5).collect())
        .unwrap_or_default();
    for (slot, id) in root_children.iter().enumerate() {
        let Some(shape) = state.shapes.get_mut(id) else {
            continue;
        };
        // Reset any heterogeneous fx the regular builder left so the
        // slot gets a clean, known combination.
        shape.background_blur = None;
        shape.glass = None;
        shape.texture = None;
        shape.shadows.clear();
        match slot {
            0 => {
                shape.glass = Some(make_glass());
            }
            1 => {
                shape.texture = Some(TextureEffect::new(10.0, 6.0, true, false));
            }
            2 => {
                shape.glass = Some(make_glass());
                shape.texture = Some(TextureEffect::new(10.0, 6.0, true, false));
            }
            3 => {
                shape.background_blur =
                    Some(Blur::new(BlurType::BackgroundBlur, false, 14.0));
                for i in 0..6u8 {
                    shape.shadows.push(Shadow::new(
                        Color::from_argb(180 - i * 20, 0, 0, 0),
                        14.0 + i as f32 * 4.0,
                        0.0,
                        (2.0 + i as f32 * 2.0, 4.0 + i as f32 * 2.0),
                        ShadowStyle::Drop,
                        false,
                    ));
                }
            }
            4 => {
                shape.glass = Some(make_glass());
                shape.texture = Some(TextureEffect::new(10.0, 6.0, true, false));
                for i in 0..3u8 {
                    shape.shadows.push(Shadow::new(
                        Color::from_argb(160, 0, 0, 0),
                        12.0 + i as f32 * 4.0,
                        0.0,
                        (2.0, 4.0 + i as f32 * 4.0),
                        ShadowStyle::Drop,
                        false,
                    ));
                }
            }
            _ => {}
        }
    }
}

fn configure_leaf(shape: &mut Shape, spec: &SceneSpec, idx: usize, parent: Uuid) {
    shape.parent_id = Some(parent);
    shape.shape_type = if spec.fx_combos && idx % 3 == 0 {
        // 33% of leaves rendered as Circle to exercise the non-Rect
        // path (different selrect→tile mapping, different fill paint
        // shape, different stroke geometry).
        Type::Circle
    } else {
        Type::Rect(ShapeRect::default())
    };
    let col = (idx % LEAVES_PER_ROW) as f32;
    let row = (idx / LEAVES_PER_ROW) as f32;
    shape.selrect = math::Rect::from_xywh(
        col * LEAF_STRIDE + 10.0,
        row * LEAF_STRIDE + 10.0,
        LEAF_W,
        LEAF_H,
    );
    // V2c.3: container-level iso variants apply to the parent
    // container, not the leaf. Leaf gets a basic solid fill so the
    // measured cost is the container's effect, not noise.
    if spec.iso_fx.applies_to_container() {
        shape.fills.push(Fill::Solid(SolidColor(deterministic_color(idx, 255))));
        return;
    }
    if spec.iso_fx != IsolatedFx::None {
        apply_isolated_fx(shape, spec.iso_fx, idx);
        return;
    }
    apply_fill(shape, spec, idx);
    if spec.heterogeneous {
        apply_heterogeneous_shadows(shape, idx, /*is_container=*/ false);
        apply_heterogeneous_stroke(shape, idx, /*is_container=*/ false);
    } else {
        apply_shadows(shape, spec);
    }
    if spec.fx_combos {
        apply_fx_combo(shape, idx);
    }
}

/// Apply a single effect path to a leaf with a solid base fill. All
/// other defaults (no stroke, no shadows, no blur, no glass, no
/// texture) are left at their `Shape::default` zeros — `configure_leaf`
/// returns immediately after this so no later step adds noise.
fn apply_isolated_fx(shape: &mut Shape, fx: IsolatedFx, idx: usize) {
    let primary = deterministic_color(idx, 255);
    let secondary = deterministic_color(idx.wrapping_mul(31).wrapping_add(7), 255);
    // Every iso variant except StrokeOnly + GradientFill uses a base
    // solid fill so the renderer has shape-body pixels to apply the
    // effect to.
    let push_solid = |shape: &mut Shape| {
        shape.fills.push(Fill::Solid(SolidColor(primary)));
    };
    match fx {
        IsolatedFx::None => {}
        IsolatedFx::DropShadow => {
            push_solid(shape);
            shape.shadows.push(Shadow::new(
                Color::from_argb(180, 0, 0, 0),
                16.0,
                0.0,
                (4.0, 6.0),
                ShadowStyle::Drop,
                false,
            ));
        }
        IsolatedFx::InnerShadow => {
            push_solid(shape);
            shape.shadows.push(Shadow::new(
                Color::from_argb(180, 0, 0, 0),
                12.0,
                0.0,
                (0.0, 4.0),
                ShadowStyle::Inner,
                false,
            ));
        }
        IsolatedFx::LayerBlur => {
            push_solid(shape);
            shape.blur = Some(Blur::new(BlurType::LayerBlur, false, 8.0));
        }
        IsolatedFx::BackgroundBlur => {
            push_solid(shape);
            shape.background_blur = Some(Blur::new(BlurType::BackgroundBlur, false, 12.0));
        }
        IsolatedFx::Glass => {
            push_solid(shape);
            shape.glass = Some(GlassEffect {
                surface_type: 0,
                bezel_width: 12.0,
                glass_thickness: 1.0,
                refractive_index: 1.4,
                specular_angle: 0.0,
                specular_opacity: 0.5,
                specular_saturation: 0.0,
                chromatic_aberration: 0.0,
                splay: 0.0,
                tilt_angle: 0.0,
                edge_boost: 0.0,
                zoom: 1.0,
                blur: 16.0,
                frost: 0.0,
                hidden: false,
            });
        }
        IsolatedFx::Texture => {
            push_solid(shape);
            shape.texture = Some(TextureEffect::new(10.0, 6.0, true, false));
        }
        IsolatedFx::GradientFill => {
            shape.fills.push(Fill::LinearGradient(Gradient::new(
                (0.0, 0.0),
                (1.0, 1.0),
                255,
                (0.0, 0.0),
                &[(primary, 0.0), (secondary, 1.0)],
            )));
        }
        IsolatedFx::StrokeOnly => {
            // No fill — stroke is the only paint contributor on this
            // shape so frame timings attribute to stroke geometry.
            shape.strokes.push(Stroke {
                fill: Fill::Solid(SolidColor(primary)),
                width: 4.0,
                style: StrokeStyle::Solid,
                cap_end: None,
                cap_start: None,
                kind: StrokeKind::Center,
            });
        }
        IsolatedFx::Opacity => {
            push_solid(shape);
            // 0.6 forces `needs_layer()` true. 1.0 short-circuits the
            // save_layer; 0.0 makes the shape invisible. 0.6 is in the
            // band where a real designer file ends up after dragging
            // the opacity slider — and the value the renderer most
            // often hits in practice.
            shape.opacity = 0.6;
        }
        IsolatedFx::Text => {
            // Convert leaf to a text shape. Uses the renderer's
            // embedded default font (Source Sans Pro) so no external
            // font registration is needed in the bench harness.
            // `font_variant_id = Uuid::nil()` matches `default_font_uuid()`
            // in `render::fonts`.
            //
            // Override selrect to a more text-friendly aspect ratio
            // and place leaves in a tighter grid so most fit in the
            // viewport (the default LEAVES_PER_ROW=100 puts 80 of
            // them off-screen on a 1920-wide canvas).
            let cols = 12usize;
            let leaf_w = 140.0_f32;
            let leaf_h = 30.0_f32;
            let stride_x = 150.0_f32;
            let stride_y = 40.0_f32;
            let col = (idx % cols) as f32;
            let row = (idx / cols) as f32;
            shape.selrect = math::Rect::from_xywh(
                col * stride_x + 20.0,
                row * stride_y + 20.0,
                leaf_w,
                leaf_h,
            );
            let bounds = shape.selrect;
            let mut content = TextContent::new(bounds, GrowType::AutoHeight);
            let span = TextSpan::new(
                "Hello world".to_string(),
                FontFamily::new(Uuid::nil(), 400, FontStyle::Normal),
                18.0,
                1.2,
                0.0,
                None,
                None,
                TextDirection::LTR,
                400,
                Uuid::nil(),
                vec![Fill::Solid(SolidColor(primary))],
            );
            let para = Paragraph::new(
                TextAlign::Left,
                TextDirection::LTR,
                None,
                None,
                1.2,
                0.0,
                vec![span],
            );
            content.add_paragraph(para);
            // The render path keys on `text_content.layout.paragraphs`
            // (the laid-out skia paragraphs), not the source spans.
            // Without computing layout here, `render_shape` walks an
            // empty paragraph list and emits zero glyphs. Frontend
            // triggers this on shape mutation; for synthetic bench
            // shapes we have to do it explicitly.
            content.update_layout(shape.selrect);
            shape.shape_type = Type::Text(content);
        }
        IsolatedFx::SvgIcon => {
            // Convert leaf to a SVGRaw shape. Inline SVG with a
            // stroked + filled star path so the test exercises the
            // SVG render path on real geometry, not a placeholder.
            //
            // Override layout to an 8-col grid of larger 80x80 icons
            // so the visual capture clearly shows multiple SVGs in
            // the canvas viewport.
            let cols = 8usize;
            let leaf_size = 80.0_f32;
            let stride = 110.0_f32;
            let col = (idx % cols) as f32;
            let row = (idx / cols) as f32;
            shape.selrect = math::Rect::from_xywh(
                col * stride + 20.0,
                row * stride + 20.0,
                leaf_size,
                leaf_size,
            );
            // The SVGRaw render path concats `shape.transform` then
            // calls `dom.render()`, which paints at the SVG's own
            // viewBox coordinate system. The frontend builds the
            // transform separately. For synthetic shapes, embed the
            // selrect origin + scale directly into the SVG viewBox
            // so the icon lands at the leaf's position without an
            // explicit shape.transform.
            let svg = format!(
                "<svg xmlns=\"http://www.w3.org/2000/svg\" \
                 viewBox=\"{} {} {} {}\" preserveAspectRatio=\"none\">\
                 <path d=\"M50 10 L61 39 L93 39 L67 58 L77 88 L50 70 L23 88 L33 58 L7 39 L39 39 Z\" \
                 fill=\"#{:02x}{:02x}{:02x}\" stroke=\"#222\" stroke-width=\"3\" \
                 transform=\"translate({} {}) scale({})\"/></svg>",
                shape.selrect.x() as i32, shape.selrect.y() as i32,
                leaf_size as i32, leaf_size as i32,
                primary.r(), primary.g(), primary.b(),
                shape.selrect.x() as i32, shape.selrect.y() as i32,
                leaf_size / 100.0,
            );
            shape.shape_type = Type::SVGRaw(SVGRaw::from_content(svg));
        }
        // Container-level variants: never reached on leaves (gated
        // earlier in `configure_leaf` via `applies_to_container`).
        IsolatedFx::Masked | IsolatedFx::OpacityGroups => {}
    }
}

fn configure_container(
    shape: &mut Shape,
    spec: &SceneSpec,
    depth: u32,
    child_idx: u32,
    parent: Uuid,
) {
    shape.parent_id = Some(parent);
    // V2c.3 prereq: container-level iso variants override the default
    // `Type::Frame` to `Type::Group` and stamp container-level effect
    // properties. Leaves in these scenes carry no fx (gated earlier
    // in `configure_leaf`).
    shape.shape_type = match spec.iso_fx {
        IsolatedFx::Masked => Type::Group(Group { masked: true }),
        IsolatedFx::OpacityGroups => Type::Group(Group { masked: false }),
        _ => Type::Frame(Frame::default()),
    };
    if matches!(spec.iso_fx, IsolatedFx::OpacityGroups) {
        // 0.6 same convention as `IsolatedFx::Opacity` for direct
        // comparability between leaf-opacity and group-opacity scenes.
        shape.opacity = 0.6;
    }
    // Containers grow with depth so deeper frames enclose their
    // children. Use a coarse grid keyed off the (depth, child_idx)
    // pair — exact geometry is irrelevant for the bench, only that
    // each container's selrect overlaps its children's tiles.
    let stride = LEAF_STRIDE * (spec.branching_factor as f32).powi((depth + 1) as i32);
    let span = stride;
    let col = (child_idx as f32) * stride;
    let row = (depth as f32) * stride * 0.5;
    shape.selrect = math::Rect::from_xywh(col, row, span, span);
    // Containers carry the shadows that dominate the slow Enter path
    // — that's what we want to measure. Leaves also get shadows for
    // configurations targeting the leaf scatter cache.
    apply_fill(shape, spec, depth as usize);
    if spec.heterogeneous {
        // Containers index by (depth, child_idx) — fold both into a
        // single number so neighbouring containers don't all get the
        // same shadow profile.
        let composite_idx = (depth as usize) * 7 + child_idx as usize;
        apply_heterogeneous_shadows(shape, composite_idx, /*is_container=*/ true);
        apply_heterogeneous_stroke(shape, composite_idx, /*is_container=*/ true);
    } else {
        apply_shadows(shape, spec);
    }
}

fn apply_fill(shape: &mut Shape, spec: &SceneSpec, idx: usize) {
    if spec.fill == FillSpec::None {
        return;
    }
    if spec.heterogeneous {
        apply_heterogeneous_fill(shape, idx);
        return;
    }
    shape.fills.push(Fill::Solid(SolidColor(deterministic_color(idx, 255))));
}

/// In heterogeneous mode, vary fill kind by index so the bench
/// exercises gradient render paths alongside solid fills. Roughly:
/// 50% solid, 25% linear gradient, 15% radial, 10% double-fill (solid
/// + linear). Keeps gradient stops simple (2 stops, opaque) so the
/// numbers reflect filter cost, not shader complexity.
fn apply_heterogeneous_fill(shape: &mut Shape, idx: usize) {
    let bucket = idx % 20;
    let primary = deterministic_color(idx, 255);
    let secondary = deterministic_color(idx.wrapping_mul(31).wrapping_add(7), 255);
    match bucket {
        0..=9 => {
            // 50% solid
            shape.fills.push(Fill::Solid(SolidColor(primary)));
        }
        10..=14 => {
            // 25% linear gradient (top-left → bottom-right of selrect)
            shape.fills.push(Fill::LinearGradient(Gradient::new(
                (0.0, 0.0),
                (1.0, 1.0),
                255,
                (0.0, 0.0),
                &[(primary, 0.0), (secondary, 1.0)],
            )));
        }
        15..=17 => {
            // 15% radial gradient (centred, full width)
            shape.fills.push(Fill::RadialGradient(Gradient::new(
                (0.5, 0.5),
                (1.0, 0.5),
                255,
                (1.0, 0.0),
                &[(primary, 0.0), (secondary, 1.0)],
            )));
        }
        _ => {
            // 10% layered solid + translucent linear overlay
            shape.fills.push(Fill::Solid(SolidColor(primary)));
            let overlay_a = deterministic_color(idx, 90);
            let overlay_b = deterministic_color(idx.wrapping_mul(13), 90);
            shape.fills.push(Fill::LinearGradient(Gradient::new(
                (0.0, 0.0),
                (1.0, 1.0),
                90,
                (0.0, 0.0),
                &[(overlay_a, 0.0), (overlay_b, 1.0)],
            )));
        }
    }
}

fn deterministic_color(idx: usize, alpha: u8) -> Color {
    let r = ((idx.wrapping_mul(53)) % 200 + 30) as u8;
    let g = ((idx.wrapping_mul(97)) % 200 + 30) as u8;
    let b = ((idx.wrapping_mul(31)) % 200 + 30) as u8;
    Color::from_argb(alpha, r, g, b)
}

/// Heterogeneous stroke distribution. Most shapes have no stroke;
/// a sizable minority gets a solid 2px center stroke; a smaller
/// minority gets a thicker gradient-filled stroke (exercises the
/// gradient-stroke render path). Containers favour solid borders
/// since gradient strokes on frames are uncommon in real designs.
fn apply_heterogeneous_stroke(shape: &mut Shape, idx: usize, is_container: bool) {
    let bucket = idx % 10;
    let kind = match bucket {
        0 | 1 | 2 if is_container => StrokeProfile::SolidCenter,
        0 | 1 if !is_container => StrokeProfile::SolidCenter,
        3 if !is_container => StrokeProfile::GradientThick,
        4 if is_container => StrokeProfile::GradientThick,
        _ => return,
    };
    let primary = deterministic_color(idx.wrapping_mul(7), 255);
    let stroke = match kind {
        StrokeProfile::SolidCenter => Stroke {
            fill: Fill::Solid(SolidColor(primary)),
            width: 2.0,
            style: StrokeStyle::Solid,
            cap_end: Some(StrokeCap::Round),
            cap_start: Some(StrokeCap::Round),
            kind: StrokeKind::Center,
        },
        StrokeProfile::GradientThick => {
            let secondary = deterministic_color(idx.wrapping_mul(11), 255);
            Stroke {
                fill: Fill::LinearGradient(Gradient::new(
                    (0.0, 0.0),
                    (1.0, 1.0),
                    255,
                    (0.0, 0.0),
                    &[(primary, 0.0), (secondary, 1.0)],
                )),
                width: 4.0,
                style: StrokeStyle::Solid,
                cap_end: Some(StrokeCap::Round),
                cap_start: Some(StrokeCap::Round),
                kind: StrokeKind::Center,
            }
        }
    };
    shape.strokes.push(stroke);
}

#[derive(Copy, Clone)]
enum StrokeProfile {
    SolidCenter,
    GradientThick,
}

/// Per-shape scatter (texture) + gather (glass) sprinkle. Bucket
/// distribution targets ~15% scatter-only, ~10% glass-only, ~5% both
/// (the combined-cache path), 70% no extra fx. Combined with the
/// shadow distribution, keeps a wide variety in flight without
/// blowing up GPU cost.
fn apply_fx_combo(shape: &mut Shape, idx: usize) {
    let bucket = (idx + 11) % 20;
    match bucket {
        0..=2 => {
            // 15% texture (scatter)
            shape.texture = Some(TextureEffect::new(8.0, 4.0, true, false));
        }
        3..=4 => {
            // 10% glass (gather)
            shape.glass = Some(make_glass());
        }
        5 => {
            // 5% scatter + gather combination — exercises
            // BuildCache(Gather) feeding into BuildCache(Scatter).
            shape.texture = Some(TextureEffect::new(8.0, 4.0, true, false));
            shape.glass = Some(make_glass());
        }
        _ => {}
    }
}

fn make_glass() -> GlassEffect {
    GlassEffect {
        surface_type: 0,
        bezel_width: 8.0,
        glass_thickness: 1.0,
        refractive_index: 1.4,
        specular_angle: 0.0,
        specular_opacity: 0.4,
        specular_saturation: 0.0,
        chromatic_aberration: 0.0,
        splay: 0.0,
        tilt_angle: 0.0,
        edge_boost: 0.0,
        zoom: 1.0,
        blur: 12.0,
        frost: 0.0,
        hidden: false,
    }
}

/// Mixed-distribution shadow application keyed off shape index.
/// Roughly mirrors a real dashboard: most cards have 1 shadow, a
/// minority have a stack of 6 (the slow case the perf bench is built
/// to surface), a sprinkle of inner shadows, the rest plain.
///
/// Containers skew toward more shadows because in real designs the
/// elevated frame is what carries the shadow, not its leaves.
fn apply_heterogeneous_shadows(shape: &mut Shape, idx: usize, is_container: bool) {
    let bucket = idx % 10;
    let (drop_count, inner_count) = if is_container {
        match bucket {
            0 | 1 | 2 | 3 => (1, 0), // 40% — common card
            4 | 5 => (2, 0),         // 20% — emphasised card
            6 => (6, 0),             // 10% — heavy stacked shadow
            7 => (0, 1),             // 10% — pressed/inset
            _ => (0, 0),             // 30% — flat container
        }
    } else {
        match bucket {
            0 | 1 | 2 => (1, 0), // 30% — chip / tag
            3 | 4 => (6, 0),     // 20% — heavy shadow leaf
            5 => (0, 1),         // 10% — inset element
            _ => (0, 0),         // 40% — flat
        }
    };
    for i in 0..drop_count {
        let off_x = 2.0 + i as f32 * 2.0;
        let off_y = 4.0 + i as f32 * 2.0;
        let blur = 12.0 + i as f32 * 4.0;
        let alpha = (200u8).saturating_sub(20u8.saturating_mul(i as u8));
        shape.shadows.push(Shadow::new(
            Color::from_argb(alpha, 0, 0, 0),
            blur,
            0.0,
            (off_x, off_y),
            ShadowStyle::Drop,
            false,
        ));
    }
    for _ in 0..inner_count {
        shape.shadows.push(Shadow::new(
            Color::from_argb(120, 0, 0, 0),
            8.0,
            0.0,
            (0.0, 2.0),
            ShadowStyle::Inner,
            false,
        ));
    }
}

fn apply_shadows(shape: &mut Shape, spec: &SceneSpec) {
    for i in 0..spec.drop_shadows_per_shape {
        let off_x = 2.0 + i as f32 * 2.0;
        let off_y = 4.0 + i as f32 * 2.0;
        let blur = spec.drop_shadow_blur.max(1.0);
        let alpha = (200u8).saturating_sub(20u8.saturating_mul(i as u8));
        shape.shadows.push(Shadow::new(
            Color::from_argb(alpha, 0, 0, 0),
            blur,
            0.0,
            (off_x, off_y),
            ShadowStyle::Drop,
            false,
        ));
    }
    for _ in 0..spec.inner_shadows {
        shape.shadows.push(Shadow::new(
            Color::from_argb(120, 0, 0, 0),
            8.0,
            0.0,
            (0.0, 2.0),
            ShadowStyle::Inner,
            false,
        ));
    }
}

fn attach_root_bg_blur(state: &mut State, _spec: &SceneSpec) {
    // Pick the first leaf-or-container directly under root and give
    // it a backdrop blur. Single shape only — bg_blur is rarely
    // applied scene-wide and stacking many gives unrealistic numbers.
    let nil = Uuid::nil();
    let first = state
        .shapes
        .get(&nil)
        .and_then(|root| root.children.first().copied());
    if let Some(id) = first {
        if let Some(shape) = state.shapes.get_mut(&id) {
            shape.background_blur = Some(Blur::new(BlurType::BackgroundBlur, false, 12.0));
        }
    }
}

fn attach_root_glass(state: &mut State, _spec: &SceneSpec) {
    let nil = Uuid::nil();
    // Use the second root child if present, otherwise the first.
    let target = state.shapes.get(&nil).and_then(|root| {
        root.children
            .get(1)
            .copied()
            .or_else(|| root.children.first().copied())
    });
    if let Some(id) = target {
        if let Some(shape) = state.shapes.get_mut(&id) {
            shape.glass = Some(GlassEffect {
                surface_type: 0,
                bezel_width: 12.0,
                glass_thickness: 1.0,
                refractive_index: 1.4,
                specular_angle: 0.0,
                specular_opacity: 0.5,
                specular_saturation: 0.0,
                chromatic_aberration: 0.0,
                splay: 0.0,
                tilt_angle: 0.0,
                edge_boost: 0.0,
                zoom: 1.0,
                blur: 16.0,
                frost: 0.0,
                hidden: false,
            });
        }
    }
}
