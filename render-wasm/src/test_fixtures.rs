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
    Blur, BlurType, Color, Fill, Frame, GlassEffect, Gradient, Rect as ShapeRect, Shadow,
    ShadowStyle, Shape, SolidColor, Stroke, StrokeCap, StrokeKind, StrokeStyle, TextureEffect,
    Type,
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

    if spec.container_depth == 0 {
        build_flat(state, spec);
    } else {
        build_nested(state, spec);
    }

    // Tile index needs the populated pool to map shape→tile correctly.
    state.rebuild_tiles();
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

fn configure_container(
    shape: &mut Shape,
    spec: &SceneSpec,
    depth: u32,
    child_idx: u32,
    parent: Uuid,
) {
    shape.parent_id = Some(parent);
    shape.shape_type = Type::Frame(Frame::default());
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
