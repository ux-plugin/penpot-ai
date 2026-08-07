//! Host tests for the neutral scheduler — no GPU, no backend. They assert the *structure* of the
//! emitted schedule (which surfaces, which steps, what order) and that the dependency graph is
//! well-formed, which is the whole point of having the scheduler in core.

use kurbo::{Affine, Rect, Vec2};

use crate::model::{Node, Scene, ShapeKind, Shadow, ROOT_ID};

use super::builder::build;
use super::dep_graph::DepGraph;
use super::step::{PaintOp, Step};
use super::surface_ref::SurfaceRole;

const VIEW: Affine = Affine::IDENTITY;
const W: u32 = 1024;
const H: u32 = 1024;

fn scene_with(nodes: Vec<Node>) -> Scene {
    let mut s = Scene::new();
    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    root.children = nodes.iter().map(|n| n.id).collect();
    s.insert(root);
    for n in nodes {
        s.insert(n);
    }
    s
}

fn rect(id: u128, x0: f64, y0: f64, x1: f64, y1: f64) -> Node {
    let mut n = Node::new(id, ShapeKind::Rect);
    n.bounds = Rect::new(x0, y0, x1, y1);
    n
}

fn group(id: u128, opacity: f32, children: Vec<u128>) -> Node {
    let mut n = Node::new(id, ShapeKind::Group);
    n.opacity = opacity;
    n.children = children;
    n
}

/// A scene whose root lists exactly `root_children` (so nested containers aren't double-visited).
fn scene_tree(root_children: Vec<u128>, nodes: Vec<Node>) -> Scene {
    let mut s = Scene::new();
    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    root.children = root_children;
    s.insert(root);
    for n in nodes {
        s.insert(n);
    }
    s
}

fn drop_shadow(blur: f32, spread: f32, offset: Vec2) -> Shadow {
    Shadow { color: peniko::Color::BLACK, blur, spread, offset, inset: false }
}

/// The index of the first step matching `f`.
fn find(steps: &[Step], f: impl Fn(&Step) -> bool) -> Option<usize> {
    steps.iter().position(f)
}

/// The body ids a `Paint` step draws, in order (ignoring layer push/pop ops).
fn bodies(step: &Step) -> Vec<u128> {
    if let Step::Paint { ops, .. } = step {
        ops.iter().filter_map(|o| if let PaintOp::Body(id) = o { Some(*id) } else { None }).collect()
    } else {
        Vec::new()
    }
}

/// Whether a `Paint` step draws `id`'s body.
fn draws(step: &Step, id: u128) -> bool {
    bodies(step).contains(&id)
}

#[test]
fn a_plain_shape_paints_direct_into_its_tile_then_folds_to_target() {
    let scene = scene_with(vec![rect(1, 100.0, 100.0, 300.0, 300.0)]);
    let sched = build(&scene, VIEW, W, H);

    // Exactly one Paint, writing directly into a TileOutput (no effect surface).
    let paints: Vec<_> = sched
        .steps
        .iter()
        .filter(|s| matches!(s, Step::Paint { .. }))
        .collect();
    assert_eq!(paints.len(), 1);
    assert!(matches!(
        paints[0],
        Step::Paint { write_to, .. } if write_to.role == SurfaceRole::TileOutput
    ));
    // And it folds to Target in the finalize pass.
    assert!(sched.steps.iter().any(|s| matches!(
        s,
        Step::Composite { to, .. } if to.is_target()
    )));
}

#[test]
fn a_drop_shadow_paints_its_whole_body_into_an_effect_surface_then_composites_it() {
    let mut r = rect(1, 150.0, 150.0, 350.0, 350.0);
    r.shadows = vec![drop_shadow(40.0, 0.0, Vec2::new(26.0, 26.0))];
    let scene = scene_with(vec![r]);
    let sched = build(&scene, VIEW, W, H);

    // The body paints into a RasterEffectOutput surface (one Paint, to the effect surface).
    let paint = find(&sched.steps, |s| {
        matches!(s, Step::Paint { write_to, .. } if matches!(write_to.role, SurfaceRole::RasterEffectOutput(1)))
    });
    assert!(paint.is_some(), "spread body must paint into its own effect surface");
    // That surface is then composited into a tile — and the produce precedes the composite.
    let composite = find(&sched.steps, |s| {
        matches!(s, Step::Composite { from, to, .. }
            if matches!(from.role, SurfaceRole::RasterEffectOutput(1)) && to.role == SurfaceRole::TileOutput)
    });
    assert!(composite.is_some(), "effect surface must be composited into a tile");
    assert!(paint.unwrap() < composite.unwrap(), "produce must precede consume");
}

#[test]
fn a_spread_effect_that_spills_past_a_tile_edge_composites_into_the_neighbour() {
    // Body hugs the x=512 boundary; a big shadow pushes the extrect across it, so the one effect
    // surface must composite into both tile columns — the spill the seam bug dropped.
    let mut r = rect(1, 360.0, 100.0, 500.0, 300.0);
    r.shadows = vec![drop_shadow(60.0, 20.0, Vec2::new(40.0, 0.0))];
    let scene = scene_with(vec![r]);
    let sched = build(&scene, VIEW, W, H);

    let tiles_composited: std::collections::HashSet<i32> = sched
        .steps
        .iter()
        .filter_map(|s| match s {
            Step::Composite { from, to, .. }
                if matches!(from.role, SurfaceRole::RasterEffectOutput(1))
                    && to.role == SurfaceRole::TileOutput =>
            {
                to.tile.map(|t| t.tile_x)
            }
            _ => None,
        })
        .collect();
    assert!(tiles_composited.contains(&0), "composites into the home column");
    assert!(tiles_composited.contains(&1), "spills into the neighbour column");
}

#[test]
fn a_lower_plain_shape_paints_before_a_higher_shadowed_shape_composites() {
    // Z-order: shape 1 (plain, below) then shape 2 (shadowed, above), both in tile (0,0).
    let mut hi = rect(2, 120.0, 120.0, 320.0, 320.0);
    hi.shadows = vec![drop_shadow(30.0, 0.0, Vec2::new(10.0, 10.0))];
    let scene = scene_with(vec![rect(1, 100.0, 100.0, 300.0, 300.0), hi]);
    let sched = build(&scene, VIEW, W, H);

    let lower_paint = find(&sched.steps, |s| {
        draws(s, 1) && matches!(s, Step::Paint { write_to, .. } if write_to.role == SurfaceRole::TileOutput)
    })
    .expect("lower shape paints");
    let higher_composite = find(&sched.steps, |s| {
        matches!(s, Step::Composite { from, .. } if matches!(from.role, SurfaceRole::RasterEffectOutput(2)))
    })
    .expect("higher shape composites its effect surface");
    assert!(
        lower_paint < higher_composite,
        "single-pass z-order: the lower body must land before the higher shape's effect composites over it"
    );
}

#[test]
fn a_plain_opacity_group_isolates_as_an_in_scene_layer() {
    // Group 10 at 50% opacity holds two overlapping plain rects. Isolation is still required (the
    // overlap must not double-composite), but nothing in the subtree needs a raster surface — so the
    // group folds in as an in-scene `PushLayer`/`PopLayer` bracket, no `ScopeOf`, no separate submit.
    let scene = scene_tree(
        vec![10],
        vec![
            group(10, 0.5, vec![1, 2]),
            rect(1, 100.0, 100.0, 300.0, 300.0),
            rect(2, 150.0, 150.0, 350.0, 350.0),
        ],
    );
    let sched = build(&scene, VIEW, W, H);

    // No scope surface, and no fold composite off one.
    assert!(
        !sched.steps.iter().any(|s| matches!(s, Step::Paint { write_to, .. } if matches!(write_to.role, SurfaceRole::ScopeOf(_)))),
        "a plain opacity group must not open a scope surface"
    );
    assert!(
        !sched.steps.iter().any(|s| matches!(s, Step::Composite { from, .. } if matches!(from.role, SurfaceRole::ScopeOf(_)))),
        "a layer group has no scope to fold"
    );

    // The whole group is one coalesced tile paint: push the layer, both children in z-order, pop.
    let tile_paints: Vec<_> = sched
        .steps
        .iter()
        .filter(|s| matches!(s, Step::Paint { write_to, .. } if write_to.role == SurfaceRole::TileOutput))
        .collect();
    assert_eq!(tile_paints.len(), 1, "the plain group coalesces into a single tile paint");
    let ops = match tile_paints[0] {
        Step::Paint { ops, .. } => ops.clone(),
        _ => unreachable!(),
    };
    assert_eq!(
        ops,
        vec![PaintOp::PushLayer(10), PaintOp::Body(1), PaintOp::Body(2), PaintOp::PopLayer],
        "the group brackets its children in z-order as one in-scene layer"
    );

    assert!(DepGraph::build(&sched.steps).is_acyclic(), "a layered schedule must stay acyclic");
}

#[test]
fn a_group_with_an_effect_in_its_subtree_uses_a_scope_surface() {
    // A shadowed child forces a raster surface (its `Composite` breaks the batch), and a layer can't
    // span two scene renders — so the enclosing opacity group must isolate into its own `ScopeOf`,
    // folded at group opacity, rather than an in-scene layer.
    let mut child = rect(1, 100.0, 100.0, 300.0, 300.0);
    child.shadows = vec![drop_shadow(30.0, 0.0, Vec2::new(10.0, 10.0))];
    let scene = scene_tree(vec![10], vec![group(10, 0.5, vec![1]), child]);
    let sched = build(&scene, VIEW, W, H);

    // The shadowed child spreads into its own effect surface, which composites into the group's
    // ScopeOf — so the scope is a `Composite` target (a rewrite), not a `Paint` target.
    assert!(
        sched.steps.iter().any(|s| s.rewrites().iter().any(|r| matches!(r.role, SurfaceRole::ScopeOf(10)))),
        "a group with an effect in its subtree isolates into a scope surface"
    );
    assert!(
        !sched.steps.iter().any(|s| matches!(s, Step::Paint { ops, .. } if ops.contains(&PaintOp::PushLayer(10)))),
        "the effect-bearing group takes the surface path, not the in-scene layer"
    );
    let fold = find(&sched.steps, |s| {
        matches!(s, Step::Composite { from, to, paint, .. }
            if matches!(from.role, SurfaceRole::ScopeOf(10))
                && to.role == SurfaceRole::TileOutput
                && (paint.opacity - 0.5).abs() < 1e-6)
    });
    assert!(fold.is_some(), "the scope folds into the tile at group opacity");
    assert!(DepGraph::build(&sched.steps).is_acyclic(), "a scoped schedule must stay acyclic");
}

#[test]
fn a_fully_opaque_group_needs_no_scope() {
    let scene = scene_tree(vec![10], vec![group(10, 1.0, vec![1]), rect(1, 100.0, 100.0, 300.0, 300.0)]);
    let sched = build(&scene, VIEW, W, H);

    assert!(
        !sched
            .steps
            .iter()
            .any(|s| matches!(s, Step::Paint { write_to, .. } if matches!(write_to.role, SurfaceRole::ScopeOf(_)))),
        "a trivial group must not open a scope"
    );
    assert!(
        sched.steps.iter().any(|s| draws(s, 1)
            && matches!(s, Step::Paint { write_to, .. } if write_to.role == SurfaceRole::TileOutput)),
        "its child paints straight into the tile"
    );
}

#[test]
fn a_background_blur_composes_a_backdrop_then_gathers_before_its_own_body() {
    let mut r = rect(1, 150.0, 150.0, 350.0, 350.0);
    r.background_blur = Some(20.0);
    let scene = scene_with(vec![r]);
    let sched = build(&scene, VIEW, W, H);

    let compose = find(&sched.steps, |s| {
        matches!(s, Step::ComposeBackdrop { shape: 1, write_to, .. } if matches!(write_to.role, SurfaceRole::Backdrop(1)))
    })
    .expect("a gather composes a backdrop surface");
    let paint_gather = find(&sched.steps, |s| {
        matches!(s, Step::PaintGather { shape: 1, backdrop, .. } if matches!(backdrop.role, SurfaceRole::Backdrop(1)))
    })
    .expect("a gather paints from its backdrop");
    let body = find(&sched.steps, |s| {
        draws(s, 1) && matches!(s, Step::Paint { write_to, .. } if write_to.role == SurfaceRole::TileOutput)
    })
    .expect("the gather shape still paints its own body");

    assert!(compose < paint_gather, "the backdrop is composed before the gather reads it");
    assert!(paint_gather < body, "the blurred backdrop paints under the shape's own body");
}

#[test]
fn a_glass_shape_schedules_as_a_gather() {
    let mut r = rect(1, 150.0, 150.0, 350.0, 350.0);
    r.glass = Some(crate::model::Glass {
        surface_type: 0,
        bezel_width: 20.0,
        thickness: 1.0,
        refractive_index: 1.5,
        specular_angle: 0.0,
        specular_opacity: 0.3,
        specular_saturation: 4.0,
        chromatic_aberration: 2.0,
        splay: 0.0,
        tilt_angle: 0.0,
        edge_boost: 0.0,
        zoom: 1.0,
        blur: 4.0,
        frost: 0.2,
    });
    let scene = scene_with(vec![r]);
    let sched = build(&scene, VIEW, W, H);

    assert!(
        sched.steps.iter().any(|s| matches!(s, Step::ComposeBackdrop { shape: 1, .. })),
        "glass composes a backdrop (it is a gather effect)"
    );
    assert!(
        sched.steps.iter().any(|s| matches!(s, Step::PaintGather { shape: 1, .. })),
        "glass paints from the backdrop"
    );
    assert!(DepGraph::build(&sched.steps).is_acyclic());
}

#[test]
fn a_gather_backdrop_is_composed_after_the_shapes_below_it_paint() {
    // Z-order: a lower plain shape, then a higher background-blur shape over it. The backdrop must
    // freeze AFTER the lower shape paints (so the blur samples it) and reads the tile it painted.
    let lower = rect(1, 100.0, 100.0, 400.0, 400.0);
    let mut glass = rect(2, 150.0, 150.0, 350.0, 350.0);
    glass.background_blur = Some(16.0);
    let scene = scene_with(vec![lower, glass]);
    let sched = build(&scene, VIEW, W, H);

    let lower_paint = find(&sched.steps, |s| draws(s, 1)).expect("lower paints");
    let compose = find(&sched.steps, |s| matches!(s, Step::ComposeBackdrop { shape: 2, .. })).expect("gather composes");
    assert!(
        lower_paint < compose,
        "single-pass z-order: the backdrop is composed after the below-z shape paints"
    );
    let reads_a_tile = matches!(&sched.steps[compose],
        Step::ComposeBackdrop { read_from, .. } if read_from.iter().any(|r| r.role == SurfaceRole::TileOutput));
    assert!(reads_a_tile, "the backdrop is fused from the tile outputs beneath the gather");

    assert!(DepGraph::build(&sched.steps).is_acyclic(), "a gather schedule must stay acyclic");
}

#[test]
fn the_schedule_dependency_graph_is_acyclic_and_in_natural_order() {
    let mut a = rect(1, 100.0, 100.0, 300.0, 300.0);
    a.shadows = vec![drop_shadow(40.0, 10.0, Vec2::new(20.0, 20.0))];
    let b = rect(2, 600.0, 600.0, 900.0, 900.0);
    let scene = scene_with(vec![a, b]);
    let sched = build(&scene, VIEW, W, H);

    let graph = DepGraph::build(&sched.steps);
    assert!(graph.is_acyclic(), "a cyclic schedule is a builder bug");
    assert!(
        graph.is_topologically_valid(),
        "the builder emits in dependency order, so every edge must point forward"
    );
}

#[test]
fn coalesce_merges_adjacent_plain_shapes_into_one_paint() {
    // Two plain rects in the same tile (0,0), nothing between them → one batched Paint of both, in
    // z-order. This is the optimization: N plain shapes become one `renderer.render`, not N.
    let scene = scene_with(vec![rect(1, 50.0, 50.0, 200.0, 200.0), rect(2, 60.0, 60.0, 210.0, 210.0)]);
    let sched = build(&scene, VIEW, W, H);

    let tile_paints: Vec<_> = sched
        .steps
        .iter()
        .filter(|s| matches!(s, Step::Paint { write_to, .. } if write_to.role == SurfaceRole::TileOutput))
        .collect();
    assert_eq!(tile_paints.len(), 1, "adjacent plain shapes coalesce into a single tile paint");
    assert_eq!(bodies(tile_paints[0]), vec![1u128, 2], "the batch holds both shapes in z-order");
}

#[test]
fn coalesce_breaks_a_plain_run_at_an_interleaved_effect() {
    // Z-order in tile (0,0): plain(1), shadowed(2), plain(3). The shadow must layer between 1 and 3,
    // so they must NOT share a batch — two separate tile paints, with the effect composite between.
    let mut mid = rect(2, 70.0, 70.0, 220.0, 220.0);
    mid.shadows = vec![drop_shadow(20.0, 0.0, Vec2::new(8.0, 8.0))];
    let scene = scene_with(vec![
        rect(1, 50.0, 50.0, 200.0, 200.0),
        mid,
        rect(3, 60.0, 60.0, 210.0, 210.0),
    ]);
    let sched = build(&scene, VIEW, W, H);

    let tile_paints: Vec<_> = sched
        .steps
        .iter()
        .filter(|s| matches!(s, Step::Paint { write_to, .. } if write_to.role == SurfaceRole::TileOutput))
        .collect();
    assert_eq!(tile_paints.len(), 2, "an interleaved effect splits the plain run");
    assert_eq!(bodies(tile_paints[0]), vec![1u128]);
    assert_eq!(bodies(tile_paints[1]), vec![3u128]);
    assert!(DepGraph::build(&sched.steps).is_acyclic(), "the split schedule stays acyclic");
}

fn custom(reads_backdrop: bool, reach: f32) -> crate::model::CustomShader {
    crate::model::CustomShader { wgsl: String::new(), reach, params: vec![], reads_backdrop }
}

#[test]
fn a_backdrop_reading_custom_shader_schedules_as_a_gather() {
    // Declared to sample the backdrop → the expensive, z-serial gather path (and the resolution cap).
    let mut r = rect(1, 150.0, 150.0, 350.0, 350.0);
    r.custom_shader = Some(custom(true, 8.0));
    let scene = scene_with(vec![r]);
    let sched = build(&scene, VIEW, W, H);

    assert!(
        sched.steps.iter().any(|s| matches!(s, Step::ComposeBackdrop { shape: 1, always_cap: true, .. })),
        "a backdrop-reading custom shader is a gather, capped because it is opaque"
    );
    assert!(
        !sched.steps.iter().any(|s| matches!(s,
            Step::Paint { write_to, .. } if matches!(write_to.role, SurfaceRole::RasterEffectOutput(1)))),
        "a gather does not take the spread path"
    );
}

#[test]
fn a_body_only_custom_shader_schedules_as_a_spread_not_a_gather() {
    // Declared to read only its own body → the cheap spread path: its own effect surface, no backdrop.
    let mut r = rect(1, 150.0, 150.0, 350.0, 350.0);
    r.custom_shader = Some(custom(false, 8.0));
    let scene = scene_with(vec![r]);
    let sched = build(&scene, VIEW, W, H);

    assert!(
        sched.steps.iter().any(|s| matches!(s,
            Step::Paint { write_to, .. } if matches!(write_to.role, SurfaceRole::RasterEffectOutput(1)))),
        "a body-only custom shader paints into its own effect surface (spread)"
    );
    assert!(
        !sched.steps.iter().any(|s| matches!(s, Step::ComposeBackdrop { .. })),
        "a body-only custom shader never composes a backdrop"
    );
    assert!(DepGraph::build(&sched.steps).is_acyclic());
}
