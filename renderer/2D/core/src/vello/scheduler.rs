//! The scheduler: frame graph in, frame plan out. Every decision about where and when is made
//! here, and the executor makes none. A pipeline of stages, each a value the next reads and none
//! writes back:
//!
//! 1. **Demand** (`resolve::Demand`). Backward from the frame: a compose owes its demand to the
//!    state below and, less its offset, to its value; a neighbourhood op owes its input its own
//!    demand grown by its pad (a `Transparent` blur grows nothing — the clamp supplies zeros); a
//!    pointwise op passes its demand through; a resample owes its input its demand in the input's
//!    texels. A node's output rect is its demand clipped to its extent — the frame for the spine,
//!    and for a chain node whatever it reaches, past the frame included; a draw item that misses
//!    its draw's demand is dropped.
//! 2. **Expansion** (DAG++, [`expanded`], `halo::expand`). With demand known at the pairs'
//!    targets on the builder's graph, every read of the frame's spine that escapes the frame is
//!    rerouted through a [`crate::vello::frame_graph::Op::Halo`]: an instance per spine node read and
//!    resolution read at, whose spine draws the scene there at that resolution with the chains
//!    composed below cloned over fill points of their level, so effects below a chain are present
//!    past the frame. Expanded once; everything after runs on DAG++.
//! 3. **Capacity** (`resolve::Res::decide`). The store below the frame is the preset's pages,
//!    capped by the device. Each pair's resolution is decided once, in closed form, then demand
//!    runs again: the run between a pair may be no wider nor taller than the store's rows, and no
//!    two adjacent links of it (the leaf or halo it starts from included) may together exceed
//!    them: a chain is lowered only when it could not fit the store alone; chains that cannot
//!    share a round run one after the other. Resolutions step down a ladder of halves, so a
//!    resample is a whole box; there is no floor. Across frames a pair keeps its resolution until
//!    the rule that set it has moved by a margin, so a zoom does not flicker.
//! 4. **Arms** (`arms::Work`). A chain is cut at its barriers: a head (a blur axis, a warp, a
//!    scatter, a resample) or a pointwise op over a leaf or the spine starts an arm, and the pointwise
//!    ops after it ride along while the value has no other reader. The compose folds into the arm
//!    that makes its value, which then writes its spine's rows in place: the frame (value 0), or
//!    a halo's value. A halo spine has one value, the rows its nodes demand joined; every halo on
//!    it is filled from the frame where it overlaps it, by a copy at the frame's resolution or a
//!    keep-resample arm below it, once the node it continues is ready there.
//! 5. **Rounds** (`schedule::Schedule`). An arm runs one round after everything it reads: the
//!    spine at a node is the round of the last compose below it, a halo the later of its fill and
//!    its spine, an arm is its own round, and a leaf or halo root is drawn the round before its
//!    first reader — then each chain, in spine order, is shifted later by the least amount at
//!    which the packer fits its values beside those placed before them (first fit: chains overlap
//!    in time only when they fit beside each other; the packer is the one judge of what fits, so
//!    there is no fill factor and no second pass). Nothing but the frame is drawn at round 0 by
//!    right: a value's draw is sequenced into its round by a boundary marker in its tiles, the
//!    way spine draws take the segment of the last compose below them. A tile runs every mark of
//!    a window in list order, so nothing else separates rounds.
//! 6. **Packing** (`schedule::Schedule`; ruling 19, amended at R4). Every leaf, halo and arm
//!    output that is not a compose is a rect placed in the rows below the frame by
//!    [`crate::vello::store_pack::StorePacker`], which hands out whole tiles and lets values whose lifetimes do
//!    not meet share them. Its origin splits back into the page fine folds rows by and the
//!    placement that rides the records.
//! 7. **Parameters** (`params::Params`). Every arm's operands — the tile's registers, a value's
//!    rows, a silhouette — and its descriptor, serialised once.
//! 8. **Emission** (`emit::emit`). Clear (the frame to the background, the pages to
//!    transparent), one front-end over the spine in z-order (clipped to the frame once pages sit
//!    under it, so a shape reaching past the frame's bottom never paints a page) with a marker at
//!    every compose, then the page work in round order: each leaf and halo root draw behind its
//!    boundary marker (each clipped to its store rect), a halo spine's draws and compose markers
//!    under the halo's transform, and a marker per page arm; before each round's fine, the clears
//!    of the rects drawn in it (a leaf's to transparent, a halo's to the background — the tiles
//!    may have held an earlier value) and the copies filling the halos whose node became ready
//!    the round before; one fine per round over that round's tiles; present. `params` holds one
//!    descriptor per arm and one tile list per round.

use std::collections::HashMap;

use crate::vello::arms::Work;
use crate::vello::emit::emit;
use crate::vello::frame_graph::FrameGraph;
use crate::vello::frame_plan::FramePlan;
use crate::vello::halo;
use crate::vello::params::Params;
use crate::vello::resolve::{Laps, Resolved};
use crate::vello::schedule::{Dump, Schedule};

/// Pixel columns per tile. Must equal vello's `TILE_WIDTH`; the backend checks it at compile time.
pub const TILE_WIDTH: u32 = 16;
/// Pixel rows per tile. Must equal vello's `TILE_HEIGHT`; the backend checks it at compile time.
pub const TILE_HEIGHT: u32 = 16;
pub(crate) const TILE_W: f64 = TILE_WIDTH as f64;
pub(crate) const TILE_H: f64 = TILE_HEIGHT as f64;
/// The plan for `graph` on a `width × height` frame, on a device whose textures reach `max_dim`
/// texels a side, with `pages` frame heights of store below the frame (the preset's; the device
/// caps it). `memory` is what each pair ran at last frame, keyed by its `key`; the plan reads it
/// and writes what it chose.
#[must_use]
pub fn plan(graph: &FrameGraph, width: u32, height: u32, max_dim: u32, pages: f64, memory: &mut HashMap<u128, f32>) -> FramePlan {
    let mut laps = Laps::new("plan");
    let expanded = expanded(graph, width, height, max_dim, pages);
    laps.lap("expanded");
    plan_of(expanded.as_ref().unwrap_or(graph), width, height, max_dim, pages, memory)
}

/// The plan of `graph` as it is, unexpanded: resolve, then the arms, the schedule, the
/// parameters, the passes.
fn plan_of(graph: &FrameGraph, width: u32, height: u32, max_dim: u32, pages: f64, memory: &mut HashMap<u128, f32>) -> FramePlan {
    let mut laps = Laps::new("plan");
    let mut cx = Resolved::of(graph, width, height, max_dim, pages);
    laps.lap("resolved");
    cx.resolve(memory);
    laps.lap("decided");
    let work = Work::of(&cx);
    laps.lap("work");
    let sched = Schedule::fit(&cx, &work);
    laps.lap("schedule");
    if std::env::var_os("WV_PLAN_DUMP").is_some() {
        eprint!("{}", Dump(&cx, &work, &sched));
    }
    let params = Params::bake(&cx, &work, &sched);
    laps.lap("params");
    let plan = emit(&cx, &work, &sched, params);
    laps.lap("emit");
    plan
}

/// The graph `plan` schedules for `graph` on a `width × height` frame: DAG++, the graph with every
/// read of the frame's spine past the frame rerouted through a [`crate::vello::frame_graph::Op::Halo`] (see
/// `halo::expand`); `None` when no read escapes and the graph is planned as it is.
#[must_use]
pub fn expanded(graph: &FrameGraph, width: u32, height: u32, max_dim: u32, pages: f64) -> Option<FrameGraph> {
    let cx = Resolved::of(graph, width, height, max_dim, pages);
    halo::expand(graph, cx.store.frame, &cx.res, &cx.dem, &cx.spines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kurbo::{Affine, Rect, Vec2};
    use crate::peniko::Color;
    use crate::vello::arms::Kind;
    use crate::vello::bake;
    use crate::vello::frame_graph::{BlurAxis, ComposeMode, DrawItem, DrawStyle, EdgeClampStyle, GNode, NodeId, Op, BLUR_TAPS};
    use crate::vello::frame_plan::{DrawCmd, Pass, Tiles};
    use crate::vello::params::Operand;
    use crate::vello::resolve::{overlaps, settle};

    fn body(shape: u128, r: Rect) -> DrawItem {
        DrawItem { shape, style: DrawStyle::Body, bounds: r }
    }

    fn cov(shape: u128, r: Rect) -> DrawItem {
        DrawItem { shape, style: DrawStyle::Coverage { analytic: true, spread: 0.0 }, bounds: r }
    }

    /// A ground, one path with a soft drop shadow, one glass over it.
    fn graph() -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let b = Rect::new(100.0, 100.0, 300.0, 260.0);
        let g = Rect::new(200.0, 200.0, 400.0, 380.0);
        FrameGraph::new(frame, Color::WHITE, vec![
                GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() },
                GNode { op: Op::Draw(vec![cov(2, b)]), inputs: vec![], label: "sil".into() },
                GNode { op: Op::Blur { sigma: 4.0, axis: BlurAxis::X, linear: false, edge_clamp_style: EdgeClampStyle::Transparent, taps: BLUR_TAPS }, inputs: vec![1], label: "bx".into() },
                GNode { op: Op::Blur { sigma: 4.0, axis: BlurAxis::Y, linear: false, edge_clamp_style: EdgeClampStyle::Transparent, taps: BLUR_TAPS }, inputs: vec![2], label: "by".into() },
                GNode { op: Op::Compose { mode: ComposeMode::Over, colour: Some([0.0, 0.0, 0.0, 0.5]), offset: [6.0, 8.0] }, inputs: vec![0, 3], label: "drop".into() },
                GNode { op: Op::Draw(vec![body(2, b)]), inputs: vec![4], label: "body".into() },
                GNode { op: Op::Warp(vec![0.0; 24]), inputs: vec![5], label: "warp".into() },
                GNode { op: Op::Shade(vec![0.0; 24]), inputs: vec![6], label: "shade".into() },
                GNode { op: Op::MaskMix(vec![0.0; 24]), inputs: vec![7, 5], label: "mix".into() },
                GNode { op: Op::Draw(vec![cov(3, g)]), inputs: vec![], label: "mask".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![5, 8, 9], label: "glass".into() },
            ])
    }

    #[test]
    fn rounds_are_dependency_depth_and_live_values_share_a_page_apart() {
        let g = graph();
        g.validate().expect("valid");
        let mut s = Resolved::of(&g, 640, 480, 8192, 4.0);
        let w = Work::of(&s);
        let sc = Schedule::fit(&s, &w);
        let arms: Vec<(Vec<NodeId>, Option<NodeId>, u32)> = w.arms.iter().enumerate().map(|(a, arm)| (arm.nodes.clone(), arm.compose, sc.round[a])).collect();
        assert_eq!(arms[0], (vec![2], None, 1), "blur X reads the round-0 silhouette");
        assert_eq!(arms[1], (vec![3], Some(4), 2), "blur Y lands the drop shadow");
        assert_eq!(arms[2], (vec![6, 7, 8], Some(10), 3), "the lens is one arm landing the glass after the body draws");
        assert_eq!(sc.pages(&s, &w), 1, "both values fit beside each other on the first page");
        let sil = w.values.iter().position(|v| v.node == 1).unwrap();
        let bx = w.values.iter().position(|v| v.node == 2).unwrap();
        assert_eq!((sc.slot[sil].birth, sc.slot[sil].last_read), (0, 1));
        assert_eq!((sc.slot[bx].birth, sc.slot[bx].last_read), (1, 2));
        assert!(!overlaps(sc.store_rect(&s, &w, sil), sc.store_rect(&s, &w, bx)), "values alive in the same round never share a texel");
        assert!(sc.store_rect(&s, &w, sil).y0 >= s.store.pitch && sc.store_rect(&s, &w, bx).y0 >= s.store.pitch, "values sit below the frame rows");
    }

    #[test]
    fn the_plan_validates_and_lists_tiles_per_round() {
        let g = graph();
        let p = plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(p.store, (640 + 2 * 96, 480 * 2), "the frame plus the shadow's two blur rings and their rounding on each side, whole tiles; two pages");
        let fines: Vec<&Pass> = p.passes.iter().filter(|p| matches!(p, Pass::Fine { .. })).collect();
        assert_eq!(fines.len(), 4, "rounds 0..3");
        for (r, f) in fines.iter().enumerate() {
            let Pass::Fine { window, .. } = f else { unreachable!() };
            assert_eq!(window.rounds, (r as u32, r as u32 + 1));
            let Tiles::List { n, .. } = window.tiles else { panic!("a tile list per round") };
            assert!(n > 0);
        }
        let shape = p.shape();
        assert_eq!(shape.markers, 3);
        assert_eq!(shape.rounds, 4);
    }

    /// Two nested backdrop gathers: a background glass `A` over the ground, and a downscaled glass
    /// `B` whose own backdrop is `A`'s output (a frost lens over another lens). `B`'s mask (`rb`)
    /// crosses the right frame edge, so `B`'s downscale reads `A` past the frame: the read the
    /// expansion reroutes through a halo.
    fn nested_gathers() -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let ra = Rect::new(100.0, 100.0, 300.0, 260.0);
        let rb = Rect::new(520.0, 150.0, 700.0, 360.0);
        let key = 0x99;
        let warp = |input| GNode { op: Op::Warp(vec![0.0; 24]), inputs: vec![input], label: "warp".into() };
        let shade = |input| GNode { op: Op::Shade(vec![0.0; 24]), inputs: vec![input], label: "shade".into() };
        FrameGraph::new(frame, Color::WHITE, vec![
                GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() },
                warp(0),
                shade(1),
                GNode { op: Op::Draw(vec![cov(2, ra)]), inputs: vec![], label: "maskA".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![0, 2, 3], label: "glassA".into() },
                GNode { op: Op::Resample { target: 0.5, key }, inputs: vec![4], label: "down".into() },
                warp(5),
                shade(6),
                GNode { op: Op::Resample { target: 1.0, key }, inputs: vec![7], label: "up".into() },
                GNode { op: Op::Draw(vec![cov(3, rb)]), inputs: vec![], label: "maskB".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![4, 8, 9], label: "glassB".into() },
            ])
    }

    #[test]
    fn nested_gathers_plan_and_validate() {
        let p = plan(&nested_gathers(), 640, 480, 8192, 4.0, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        assert!(p.shape().markers >= 2, "both glasses land their compose: {}", p.shape().markers);
    }

    /// [`nested_gathers`] expanded by hand into DAG++ with glass `A`'s mask crossing the right
    /// edge too: `B`'s downscale reads `A` past the frame, so it reads a [`Op::Halo`] of `A`
    /// instead, whose spine is a root draw of the ground body, a fill point of the ground's
    /// in-frame state for the clone's sampling ring, and a clone of `A`'s chain (its mask leaf
    /// cloned) composed over it. `target` is `B`'s pair.
    fn halo_graph(target: f32) -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let page = Rect::new(0.0, 0.0, 800.0, 480.0);
        let ra = Rect::new(500.0, 100.0, 700.0, 300.0);
        let rb = Rect::new(520.0, 150.0, 700.0, 360.0);
        let key = 0x99;
        let warp = |input| GNode { op: Op::Warp(vec![0.0; 24]), inputs: vec![input], label: "warp".into() };
        let shade = |input| GNode { op: Op::Shade(vec![0.0; 24]), inputs: vec![input], label: "shade".into() };
        let glass = |below, value, mask, label: &str| GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![below, value, mask], label: label.into() };
        FrameGraph::new(frame, Color::WHITE, vec![
                GNode { op: Op::Draw(vec![body(1, page)]), inputs: vec![], label: "ground".into() },
                warp(0),
                shade(1),
                GNode { op: Op::Draw(vec![cov(2, ra)]), inputs: vec![], label: "maskA".into() },
                glass(0, 2, 3, "glassA"),
                GNode { op: Op::Draw(vec![body(1, page)]), inputs: vec![], label: "root".into() },
                GNode { op: Op::Halo { of: 0 }, inputs: vec![5], label: "fill".into() },
                warp(6),
                shade(7),
                GNode { op: Op::Draw(vec![cov(2, ra)]), inputs: vec![], label: "maskA'".into() },
                glass(6, 8, 9, "glassA'"),
                GNode { op: Op::Halo { of: 4 }, inputs: vec![10], label: "halo".into() },
                GNode { op: Op::Resample { target, key }, inputs: vec![11], label: "down".into() },
                warp(12),
                shade(13),
                GNode { op: Op::Resample { target: 1.0, key }, inputs: vec![14], label: "up".into() },
                GNode { op: Op::Draw(vec![cov(3, rb)]), inputs: vec![], label: "maskB".into() },
                glass(4, 15, 16, "glassB"),
            ])
    }

    #[test]
    fn a_halo_continues_the_spine_past_the_frame_at_its_readers_resolution() {
        let g = halo_graph(0.5);
        g.validate().unwrap_or_else(|e| panic!("{e}"));
        let k = g.resolutions();
        assert_eq!((k[11], k[10], k[6], k[5], k[7], k[9]), (0.5, 0.5, 0.5, 0.5, 0.5, 0.5), "the halo, its spine, its fill point, the clone chain and its leaf run at the reader's k");
        assert_eq!((k[4], k[0], k[3]), (1.0, 1.0, 1.0), "the frame's spine and A's own leaf stay at 1");
        let mut s = Resolved::of(&g, 640, 480, 8192, 4.0);
        let w = Work::of(&s);
        let sc = Schedule::fit(&s, &w);
        let halo = w.value_of[11].unwrap();
        assert_eq!((w.value_of[6], w.value_of[5]), (Some(halo), Some(halo)), "one value per spine: the fill point and the root share the halo's");
        let Kind::Root(root) = &w.values[halo].kind else { panic!("the halo value is drawn from its root") };
        let items: Vec<u128> = root.iter().map(|it| it.shape).collect();
        assert_eq!(items, vec![1], "the root's items, pruned to the halo");
        assert!(s.dem.out[11].x1 > 320.0 && s.dem.out[11].x0 < 320.0, "the halo straddles the frame's right edge in half texels: {:?}", s.dem.out[11]);
        assert!(s.dem.out[10].x0 >= 320.0, "the clone composes only past the frame: {:?}", s.dem.out[10]);
        assert!(s.dem.out[6].x0 < 320.0 && s.dem.out[6].x1 > 320.0, "the fill point holds the clone's sampling ring inside the frame: {:?}", s.dem.out[6]);
        assert!(s.dem.out[5].x0 >= 320.0, "the root draws only past the frame: {:?}", s.dem.out[5]);
        assert_eq!(w.values[halo].rect, s.dem.out[6].union(s.dem.out[11]), "the value is what its spine demands, joined");
        assert!(s.dem.wanted[4].is_some_and(|d| d.x0 < 640.0 && d.x1 <= 640.0), "A is demanded in-frame for the halo's fill: {:?}", s.dem.wanted[4]);
        let (lower, clone, fill, outer) = (w.arm_of[6].unwrap(), w.arm_of[7].unwrap(), w.arm_of[11].unwrap(), w.arm_of[13].unwrap());
        assert_eq!((sc.round[lower], sc.round[clone], sc.round[fill], sc.round[outer]), (1, 2, 3, 4), "the ring's fill, the clone chain, the halo's fill over it, then B's chain");
        assert_eq!((w.arms[lower].out, w.arms[fill].out), (halo, halo), "both fills write the halo value");
        assert_eq!((sc.slot[halo].birth, sc.slot[halo].last_read), (0, 4), "drawn at 0, alive until B's warp has read it");
        let ps = Params::bake(&s, &w, &sc);
        let params = &ps.floats;
        let frame = Operand::Value { v: 0, shift: Vec2::ZERO };
        assert_eq!((ps.arms[lower].value, ps.arms[fill].value), (frame, frame), "the fills resample the frame rows");
        assert_eq!(ps.arms[clone].value, Operand::Value { v: halo, shift: Vec2::ZERO }, "the clone's warp reads the halo value as its spine");
        assert_eq!(ps.arms[outer].value, Operand::Value { v: halo, shift: Vec2::ZERO }, "B's warp reads the halo, not the frame");
        let desc = &params[ps.arms[fill].off as usize..];
        assert_eq!((desc[0] as u32 & bake::bits::RESAMPLE, desc[2], desc[3]), (bake::bits::RESAMPLE, 2.0, bake::RESAMPLE_KEEP), "a keep-resample by two");
    }

    #[test]
    fn a_halo_at_the_spines_resolution_is_one_copy() {
        let g = halo_graph(1.0);
        let s = Resolved::of(&g, 640, 480, 8192, 4.0);
        let w = Work::of(&s);
        assert!(w.arm_of[6].is_none() && w.arm_of[11].is_none(), "no fill arms at k 1");
        let p = plan_as_is(&g);
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        let mut fines = 0;
        let mut copies = Vec::new();
        for pass in &p.passes {
            match pass {
                Pass::Fine { .. } => fines += 1,
                Pass::Copy { src, dst } => copies.push((fines, *src, *dst)),
                _ => {}
            }
        }
        let [(ring_at, ring, ring_dst), (top_at, src, dst)] = copies[..] else { panic!("one copy per fill point: {copies:?}") };
        assert!(src.x1 <= 640.0 && src.y1 <= 480.0 && src.x0 >= 448.0, "copied from the frame rows where the halo overlaps them: {src:?}");
        assert!(ring.x1 <= 640.0 && ring.x0 >= 592.0 && ring.x0 > src.x0, "the ring is copied where the clone samples inside the frame edge, within the top's region: {ring:?}");
        assert!(dst.y0 >= 480.0 && ring_dst.y0 >= 480.0, "into the halo's page rows: {dst:?} {ring_dst:?}");
        assert_eq!((ring_at, top_at), (1, 2), "the ring after round 0 (the ground), the top after round 1 (both glass-A composes) and before B's chain in round 2");
        let frame_draws = p.passes.iter().filter_map(|p| match p { Pass::Frontend { draws } => Some(draws), _ => None }).next().unwrap();
        let identity_shapes = frame_draws.iter().filter(|d| matches!(d, DrawCmd::Shapes { transform, .. } if *transform == Affine::IDENTITY)).count();
        assert_eq!(identity_shapes, 1, "the frame draws the ground once; the root draws only into the halo");
    }

    #[test]
    fn a_halved_halo_plans_and_validates() {
        let p = plan_as_is(&halo_graph(0.5));
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        assert!(p.passes.iter().all(|p| !matches!(p, Pass::Copy { .. })), "the fill is an arm, not a copy");
        let frame_draws = p.passes.iter().filter_map(|p| match p { Pass::Frontend { draws } => Some(draws), _ => None }).next().unwrap();
        let halved = frame_draws.iter().filter(|d| matches!(d, DrawCmd::Shapes { transform, .. } if transform.as_coeffs()[0] == 0.5)).count();
        assert_eq!(halved, 1, "the root is drawn once at half resolution");
    }

    /// The plan of `g` as it is: no expansion.
    fn plan_as_is(g: &FrameGraph) -> FramePlan {
        plan_of(g, 640, 480, 8192, 4.0, &mut HashMap::new())
    }

    fn halos(g: &FrameGraph) -> Vec<(NodeId, NodeId)> {
        g.nodes.iter().enumerate().filter_map(|(i, n)| match n.op { Op::Halo { of } => Some((i, of)), _ => None }).collect()
    }

    #[test]
    fn expansion_reroutes_the_escaping_read_through_a_halo_over_a_root_draw() {
        let g = nested_gathers();
        let x = expanded(&g, 640, 480, 8192, 4.0).expect("B reads A past the right edge");
        x.validate().unwrap_or_else(|e| panic!("{e}\n{}", crate::vello::graph_build::dump(&x)));
        let [(h, of)] = halos(&x)[..] else { panic!("one halo: {:?}", halos(&x)) };
        assert_eq!(x.nodes[of].label, "glassA", "the halo is of glass A");
        let root = x.spine_root(h);
        assert!(root != 0 && matches!(x.nodes[root].op, Op::Draw(ref items) if items.len() == 1 && items[0].shape == 1), "its spine roots at a draw of the ground: {}", x.nodes[root].label);
        assert_eq!(x.nodes[h].inputs, vec![root], "A's mask sits inside the frame, so nothing of A is cloned: the halo stands on the root");
        let down = x.nodes.iter().position(|n| n.label == "down").unwrap();
        assert_eq!(x.nodes[down].inputs, vec![h], "B's downscale reads the halo");
        assert!(x.nodes.iter().all(|n| n.label != "glassA @0"), "no clone of A");
        assert_eq!(x.nodes.len(), g.nodes.len() + 2, "a root and a halo");
        assert_eq!(x.resolutions()[h], 0.5, "the halo runs at B's k");
        plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new()).validate().unwrap_or_else(|e| panic!("{e}"));
    }

    #[test]
    fn expansion_clones_the_chains_whose_footprint_reaches_past_the_frame() {
        let mut g = nested_gathers();
        let Op::Draw(items) = &mut g.nodes[3].op else { unreachable!() };
        items[0].bounds = Rect::new(500.0, 100.0, 700.0, 300.0);
        let x = expanded(&g, 640, 480, 8192, 4.0).expect("both reads escape");
        x.validate().unwrap_or_else(|e| panic!("{e}\n{}", crate::vello::graph_build::dump(&x)));
        let hs = halos(&x);
        let of_a = hs.iter().filter(|&&(_, of)| x.nodes[of].label == "glassA").count();
        let of_ground = hs.iter().filter(|&&(_, of)| x.nodes[of].label == "ground").count();
        assert_eq!((of_a, of_ground), (1, 2), "a halo of A for B, a halo of the ground for A's own read, and the clone's fill point: {hs:?}");
        let clone = x.nodes.iter().position(|n| n.label == "glassA @1").expect("A cloned into B's instance");
        let fill = x.nodes[clone].inputs[0];
        assert!(matches!(x.nodes[fill].op, Op::Halo { of } if x.nodes[of].label == "ground"), "the clone stands on a fill point of the ground");
        let k = x.resolutions();
        assert_eq!((k[clone], k[fill]), (0.5, 0.5), "the clone runs at B's k");
        let mask = x.nodes[clone].inputs[2];
        assert!(x.nodes[mask].label.starts_with("maskA @"), "the clone's mask is its own leaf: {}", x.nodes[mask].label);
        let p = plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
    }

    /// [`graph`] with a resample pair of `target` around the shadow's blurs and another around the
    /// lens's warp.
    fn scaled_graph(target: f32) -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let b = Rect::new(100.0, 100.0, 300.0, 260.0);
        let g = Rect::new(200.0, 200.0, 400.0, 380.0);
        let blur = |axis, input| GNode { op: Op::Blur { sigma: 4.0, axis, linear: false, edge_clamp_style: EdgeClampStyle::Transparent, taps: BLUR_TAPS }, inputs: vec![input], label: String::new() };
        let resample = |target, input| GNode { op: Op::Resample { target, key: 0 }, inputs: vec![input], label: String::new() };
        let g = FrameGraph::new(frame, Color::WHITE, vec![
                GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() },
                GNode { op: Op::Draw(vec![cov(2, b)]), inputs: vec![], label: "sil".into() },
                resample(target, 1),
                blur(BlurAxis::X, 2),
                blur(BlurAxis::Y, 3),
                resample(1.0, 4),
                GNode { op: Op::Compose { mode: ComposeMode::Over, colour: Some([0.0, 0.0, 0.0, 0.5]), offset: [6.0, 8.0] }, inputs: vec![0, 5], label: "drop".into() },
                GNode { op: Op::Draw(vec![body(2, b)]), inputs: vec![6], label: "body".into() },
                resample(target, 7),
                GNode { op: Op::Warp(vec![0.0; 24]), inputs: vec![8], label: "warp".into() },
                resample(1.0, 9),
                GNode { op: Op::Shade(vec![0.0; 24]), inputs: vec![10], label: "shade".into() },
                GNode { op: Op::MaskMix(vec![0.0; 24]), inputs: vec![11, 7], label: "mix".into() },
                GNode { op: Op::Draw(vec![cov(3, g)]), inputs: vec![], label: "mask".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![7, 12, 13], label: "glass".into() },
            ]);
        g.validate().expect("valid");
        g
    }

    #[test]
    fn a_pair_between_equal_resolutions_is_nothing() {
        let plain = plan(&graph(), 640, 480, 8192, 4.0, &mut HashMap::new());
        let paired = plan(&scaled_graph(1.0), 640, 480, 8192, 4.0, &mut HashMap::new());
        assert_eq!(paired.store, plain.store);
        assert_eq!(paired.params, plain.params);
        assert_eq!(paired.passes.len(), plain.passes.len());
        assert_eq!(paired.shape(), plain.shape());
    }

    #[test]
    fn a_half_pair_runs_its_run_at_half_and_resamples_at_its_ends() {
        let g = scaled_graph(0.5);
        let mut s = Resolved::of(&g, 640, 480, 8192, 4.0);
        assert!(s.res.elided[2], "a leaf's downscale is the leaf drawn at half");
        assert!(!s.res.elided[5] && !s.res.elided[8] && !s.res.elided[10]);
        assert_eq!((s.res.k[1], s.res.k[3], s.res.k[4], s.res.k[5], s.res.k[9], s.res.k[10]), (0.5, 0.5, 0.5, 1.0, 0.5, 1.0));
        let w = Work::of(&s);
        let sc = Schedule::fit(&s, &w);
        let ps = Params::bake(&s, &w, &sc);
        let params = &ps.floats;
        let arms: Vec<(Vec<NodeId>, Option<NodeId>)> = w.arms.iter().map(|a| (a.nodes.clone(), a.compose)).collect();
        assert_eq!(arms[0], (vec![3], None), "blur X at half");
        assert_eq!(arms[1], (vec![4], None), "blur Y at half");
        assert_eq!(arms[2], (vec![5], Some(6)), "the upscale lands the shadow");
        assert_eq!(arms[3], (vec![8], None), "the downscale of the body's backdrop is its own arm");
        assert_eq!(arms[4], (vec![9], None), "the warp at half");
        assert_eq!(arms[5], (vec![10, 11, 12], Some(14)), "the upscale heads the lens's tail");
        assert!(matches!(ps.arms[3].value, Operand::Value { v: 0, .. }), "a downscale of the spine reads the frame rows");
        let sil = w.values.iter().position(|v| v.node == 1).unwrap();
        let by = w.values.iter().position(|v| v.node == 4).unwrap();
        assert_eq!(w.values[sil].rect, Rect::new(48.0, 48.0, 160.0, 144.0), "the silhouette at half, with its AA, in tiles");
        assert_eq!(w.values[by].rect, Rect::new(16.0, 16.0, 192.0, 160.0), "the blur at half, padded twice by the half-resolution pad");
        let desc = |a: usize| &params[ps.arms[a].off as usize..][..4];
        let at = |a: usize| (desc(a)[0] as u32 & bake::bits::RESAMPLE != 0, desc(a)[2], desc(a)[3]);
        assert_eq!(at(2), (true, 0.5, bake::RESAMPLE_TRANSPARENT), "up from a transparent chain");
        assert_eq!(at(3), (true, 2.0, bake::RESAMPLE_CLAMP), "down from the spine, inside the frame");
        assert_eq!(at(5), (true, 0.5, bake::RESAMPLE_CLAMP), "up from the backdrop chain");
        assert!(!at(0).0);
        let p = plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new());
        p.validate().unwrap_or_else(|e| panic!("{e}"));
        let Some(Pass::Frontend { draws }) = p.passes.iter().find(|p| matches!(p, Pass::Frontend { .. })) else { panic!() };
        let leaf = draws.iter().find_map(|d| match d {
            DrawCmd::Shapes { items, transform, .. } if items.iter().any(|i| i.shape == 2 && matches!(i.style, DrawStyle::Coverage { .. })) => Some(*transform),
            _ => None,
        }).expect("the silhouette draw");
        let c = leaf.as_coeffs();
        assert_eq!((c[0], c[3]), (0.5, 0.5), "the leaf is drawn at half");
    }

    /// `n` drop shadows of sigma `sigma`, each under its own resample pair, over one ground.
    fn shadows(n: usize, sigma: f32, edge: EdgeClampStyle) -> FrameGraph {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let mut nodes = vec![GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() }];
        for i in 0..n {
            let b = Rect::new(20.0 + 250.0 * i as f64, 100.0, 120.0 + 250.0 * i as f64, 260.0);
            let spine = nodes.len() - 1;
            let sil = nodes.len();
            nodes.push(GNode { op: Op::Draw(vec![cov(2 + i as u128, b)]), inputs: vec![], label: "sil".into() });
            nodes.push(GNode { op: Op::Resample { target: 1.0, key: i as u128 }, inputs: vec![sil], label: "down".into() });
            nodes.push(GNode { op: Op::Blur { sigma, axis: BlurAxis::X, linear: false, edge_clamp_style: edge, taps: BLUR_TAPS }, inputs: vec![sil + 1], label: "bx".into() });
            nodes.push(GNode { op: Op::Blur { sigma, axis: BlurAxis::Y, linear: false, edge_clamp_style: edge, taps: BLUR_TAPS }, inputs: vec![sil + 2], label: "by".into() });
            nodes.push(GNode { op: Op::Resample { target: 1.0, key: i as u128 }, inputs: vec![sil + 3], label: "up".into() });
            nodes.push(GNode { op: Op::Compose { mode: ComposeMode::Over, colour: Some([0.0, 0.0, 0.0, 0.5]), offset: [6.0, 8.0] }, inputs: vec![spine, sil + 4], label: "drop".into() });
        }
        let g = FrameGraph::new(frame, Color::WHITE, nodes);
        g.validate().expect("valid");
        g
    }

    #[test]
    fn a_pair_settles_down_the_ladder_and_climbs_only_with_margin() {
        assert_eq!(settle(1.0, 0.3, None), 0.25);
        assert_eq!(settle(0.5, 0.7, None), 0.5, "never above the target");
        assert_eq!(settle(1.0, 0.6, Some(0.25)), 0.25, "the bound has not cleared the next rung by the margin");
        assert_eq!(settle(1.0, 0.7, Some(0.25)), 0.5, "it has now");
        assert_eq!(settle(1.0, 0.2, Some(0.5)), 0.125, "lowering is immediate");
        assert_eq!(settle(1.0, 3.0, Some(0.5)), 1.0, "a bound with slack climbs all the way");
    }

    #[test]
    fn the_store_is_as_wide_as_the_frame_plus_the_widest_ring_so_only_area_lowers_a_run() {
        let frame = Rect::new(0.0, 0.0, 640.0, 480.0);
        let g = FrameGraph::new(frame, Color::WHITE, vec![
                GNode { op: Op::Draw(vec![body(1, frame)]), inputs: vec![], label: "ground".into() },
                GNode { op: Op::Resample { target: 1.0, key: 7 }, inputs: vec![0], label: "down".into() },
                GNode { op: Op::Blur { sigma: 100.0, axis: BlurAxis::X, linear: true, edge_clamp_style: EdgeClampStyle::Extend, taps: BLUR_TAPS }, inputs: vec![1], label: "bx".into() },
                GNode { op: Op::Blur { sigma: 100.0, axis: BlurAxis::Y, linear: true, edge_clamp_style: EdgeClampStyle::Extend, taps: BLUR_TAPS }, inputs: vec![2], label: "by".into() },
                GNode { op: Op::Resample { target: 1.0, key: 7 }, inputs: vec![3], label: "up".into() },
                GNode { op: Op::Draw(vec![cov(3, Rect::new(100.0, 100.0, 540.0, 380.0))]), inputs: vec![], label: "mask".into() },
                GNode { op: Op::Compose { mode: ComposeMode::MaskedMix, colour: None, offset: [0.0; 2] }, inputs: vec![0, 4, 5], label: "blur".into() },
            ]);
        g.validate().expect("valid");
        let mut memory = HashMap::new();
        let mut s = Resolved::of(&g, 640, 480, 8192, 3.0);
        assert_eq!(s.store.width, 640.0 + 2.0 * 672.0, "two σ100 blurs read 308 px past their output each, plus a tile of rounding per read: the store grows by that ring on both sides");
        assert!(s.dem.out[2].width() > 640.0 && s.dem.out[2].width() <= s.store.width, "at target 1 the backdrop the blur needs is wider than the frame and no wider than the store: {:?}", s.dem.out[2]);
        s.resolve(&mut memory);
        assert_eq!(s.res.k[2], 0.5, "the pair's two links together exceed the store's texels: one rung down fits");
        assert!(s.dem.out[1].area() + s.dem.out[2].area() <= s.store.rows * s.store.width, "{:?} {:?}", s.dem.out[1], s.dem.out[2]);
        assert!(!s.res.elided[1], "the pair is now real");
        assert_eq!(memory.get(&7), Some(&0.5), "the pair remembers what it ran at");
        let mut memory = HashMap::from([(7u128, 0.5f32)]);
        let mut s2 = Resolved::of(&g, 640, 480, 8192, 3.0);
        s2.resolve(&mut memory);
        assert_eq!(memory.get(&7), Some(&0.5), "the same frame keeps last frame's resolution");
        let c = Resolved::of(&g, 640, 480, 640, 4.0);
        assert_eq!(c.store.width, 640.0, "a device that cannot hold the ring caps the store at the frame's width, never below it");
    }

    #[test]
    fn chains_are_placed_first_fit_within_the_store() {
        let g = shadows(3, 4.0, EdgeClampStyle::Transparent);
        let mut roomy = HashMap::new();
        let mut wide = Resolved::of(&g, 640, 480, 8192, 4.0);
        let targets = wide.res.k.clone();
        wide.resolve(&mut roomy);
        assert_eq!(wide.res.k, targets, "three small shadows need no lowering with room to spare");
        let w = Work::of(&wide);
        let sc = Schedule::fit(&wide, &w);
        let natural: Vec<u32> = sc.round.clone();
        assert_eq!(natural, vec![1, 2, 1, 2, 1, 2], "disjoint chains run side by side: {natural:?}");

        let mut tight = HashMap::new();
        let mut s = Resolved::of(&g, 640, 480, 480 + 256, 4.0);
        s.resolve(&mut tight);
        assert_eq!(s.res.k, targets, "every chain fits the store alone, so none is lowered");
        let w = Work::of(&s);
        let sc = Schedule::fit(&s, &w);
        let rounds: Vec<(NodeId, u32)> = w.arms.iter().enumerate().map(|(a, arm)| (arm.chain, sc.round[a])).collect();
        let last = rounds.iter().map(|r| r.1).max().unwrap();
        assert!(last > 2, "a store too small for three chains side by side runs one of them later: {rounds:?}");
        for v in 1..w.values.len() {
            assert!(sc.store_rect(&s, &w, v).y1 <= s.store.pitch + s.store.rows, "value {v} sits within the store's rows: {:?}", sc.store_rect(&s, &w, v));
        }
        assert!(rounds.windows(2).all(|w| w[0].0 != w[1].0 || w[0].1 < w[1].1), "each chain still runs in order: {rounds:?}");
    }

    #[test]
    fn demand_prunes_what_the_frame_never_sees() {
        let mut g = graph();
        let Op::Draw(items) = &mut g.nodes[0].op else { unreachable!() };
        items.push(body(9, Rect::new(2000.0, 2000.0, 2100.0, 2100.0)));
        let p = plan(&g, 640, 480, 8192, 4.0, &mut HashMap::new());
        let Some(Pass::Frontend { draws }) = p.passes.iter().find(|p| matches!(p, Pass::Frontend { .. })) else { panic!() };
        let ground = draws.iter().find_map(|d| match d {
            DrawCmd::Shapes { items, transform, .. } if *transform == Affine::IDENTITY && items.iter().any(|i| i.shape == 1) => Some(items),
            _ => None,
        }).expect("the ground draw");
        assert!(ground.iter().all(|it| it.shape != 9), "an off-frame item is dropped");
    }
}
