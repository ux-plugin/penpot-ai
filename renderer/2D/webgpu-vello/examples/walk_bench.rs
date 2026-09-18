//! Before/after for the GPU walk kernel (V1-S3), headless on the native GPU, swept across scene size.
//!
//! For each N it builds an N-leaf scene nested to depth 8 (organizational groups, all
//! flatten-eligible), sets a 4K viewport, and does a full-rebuild schedule build — the O(shapes) zoom
//! frame the walk dominates. It times the walk three ways, all feeding the *same* `finish_schedule`,
//! and cross-checks that the CPU-walk and GPU-walk schedules are identical:
//!
//!   * **CPU flat walk** — `walk_flat_into` (today's production path on classic + hybrid).
//!   * **GPU resident dispatch** — count→scan→scatter over buffers uploaded *once* (the "persistent
//!     GPU scene" endgame): no upload, no readback. The true steady-state per-frame GPU cost.
//!   * **GPU walk (full)** — `walk_on_gpu`: a fresh upload + dispatch + blocking readback each call
//!     (naive V1: what it costs today with the CPU round-trip still in place).
//!
//! The sweep answers the only question that matters before building the async readback pipeline: at
//! what scene size, if any, does the GPU walk beat the CPU? Run: `cargo run --release --example walk_bench`.

use std::collections::HashSet;
use std::time::Instant;

use render_core::host::Modifiers;
use render_core::kurbo::{Affine, Rect};
use render_core::model::{Node, Scene, ShapeKind, ROOT_ID};
use render_core::schedule::builder::{build_visible, dirty_page_bbox, finalize_composites, finish_schedule};
use render_core::schedule::flatten::{flatten_leaves, records_to_steps, walk_flat_into, FlatShape};
use render_core::schedule::step::Step;
use render_core::tiling::{visible_tiles, TileKey};
use vello_gpu_renderer::walk_gpu::{walk_on_gpu, WalkPipelines, WalkResources};

const VIEWPORT_W: u32 = 3840;
const VIEWPORT_H: u32 = 2160;
const RUNS: usize = 9;
const SIZES: &[usize] = &[2_000, 20_000, 100_000, 500_000];

/// A grid of small leaf rects filling the 4K viewport, nested into a depth-8 tree of trivial groups.
fn stress_scene(n_leaves: usize) -> Scene {
    let mut s = Scene::new();
    let cols = (n_leaves as f64 * f64::from(VIEWPORT_W) / f64::from(VIEWPORT_H)).sqrt().ceil() as usize;
    let rows = n_leaves.div_ceil(cols);
    let cw = f64::from(VIEWPORT_W) / cols as f64;
    let ch = f64::from(VIEWPORT_H) / rows as f64;

    let mut leaf_ids = Vec::with_capacity(n_leaves);
    for i in 0..n_leaves {
        let id = (i + 1) as u128;
        let (col, row) = (i % cols, i / cols);
        let (x, y) = (col as f64 * cw, row as f64 * ch);
        let mut node = Node::new(id, ShapeKind::Rect);
        node.bounds = Rect::new(x, y, x + cw * 0.8, y + ch * 0.8);
        s.insert(node);
        leaf_ids.push(id);
    }

    let mut next_gid: u128 = 10_000_000;
    let top = build_tree(&mut s, &mut next_gid, 1, &leaf_ids);
    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    root.children = vec![top];
    s.insert(root);
    s
}

/// Recursively wrap `leaves` in a balanced tree of trivial groups, stopping at depth 8 (or a tiny chunk).
fn build_tree(s: &mut Scene, next_gid: &mut u128, depth: u32, leaves: &[u128]) -> u128 {
    let gid = *next_gid;
    *next_gid += 1;
    let mut g = Node::new(gid, ShapeKind::Group);
    if depth >= 8 || leaves.len() <= 4 {
        g.children = leaves.to_vec();
    } else {
        let chunk = leaves.len().div_ceil(3);
        g.children = leaves.chunks(chunk).map(|c| build_tree(s, next_gid, depth + 1, c)).collect();
    }
    s.insert(g);
    gid
}

/// Median (and min) of `runs` timings of `f`, in ms. One untimed warm-up first.
fn bench(runs: usize, mut f: impl FnMut() -> f64) -> (f64, f64) {
    f();
    let mut xs: Vec<f64> = (0..runs).map(|_| f()).collect();
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    (xs[xs.len() / 2], xs[0])
}

/// Order-insensitive multiset equality (finalize composites iterate a `HashSet`, so their order is
/// nondeterministic-but-benign; within-tile z-order still shows up in the coalesced paint runs).
fn same_steps(a: &[Step], b: &[Step]) -> bool {
    let norm = |s: &[Step]| {
        let mut v: Vec<String> = s.iter().map(|st| format!("{st:?}")).collect();
        v.sort();
        v
    };
    norm(a) == norm(b)
}

fn measure(n_leaves: usize, device: &wgpu::Device, queue: &wgpu::Queue, pipes: &WalkPipelines) {
    let scene = stress_scene(n_leaves);
    let modifiers = Modifiers::new();
    let view = Affine::IDENTITY;
    let visible: HashSet<TileKey> = visible_tiles(view, VIEWPORT_W, VIEWPORT_H).into_iter().collect();
    let dirty = dirty_page_bbox(view, &visible);
    let flat: Vec<FlatShape> = flatten_leaves(&scene, &modifiers).expect("flatten-eligible");

    let records = walk_on_gpu(device, queue, pipes, &flat, view, &visible, dirty);
    let total = records.len() as u32;
    let cpu_schedule = build_visible(&scene, view, &modifiers, &visible, None);
    let gpu_schedule = {
        let mut steps = records_to_steps(&records, &flat, view);
        steps.extend(finalize_composites(view, &visible));
        finish_schedule(steps, &scene, &modifiers)
    };
    assert!(same_steps(&cpu_schedule.steps, &gpu_schedule.steps), "GPU schedule must equal CPU schedule at N={n_leaves}");
    let resident = WalkResources::new(device, &flat, total);

    let (cpu_walk, _) = bench(RUNS, || {
        let mut steps = Vec::new();
        let t = Instant::now();
        walk_flat_into(&flat, view, &visible, dirty, &mut steps);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        std::hint::black_box(&steps);
        ms
    });
    let (gpu_resident, _) = bench(RUNS, || resident.dispatch_ms(device, queue, pipes, view, &visible, dirty));
    let (gpu_full, _) = bench(RUNS, || {
        let t = Instant::now();
        let r = walk_on_gpu(device, queue, pipes, &flat, view, &visible, dirty);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        std::hint::black_box(&r);
        ms
    });
    let (build_cpu, _) = bench(RUNS, || {
        let t = Instant::now();
        let sch = build_visible(&scene, view, &modifiers, &visible, None);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        std::hint::black_box(&sch);
        ms
    });

    let win = if gpu_resident < cpu_walk { "GPU" } else { "CPU" };
    println!(
        "N={n_leaves:>7}  recs={total:>7}  | CPU walk {cpu_walk:>7.3}  GPU resident {gpu_resident:>7.3}  GPU full {gpu_full:>7.3}  | build(CPU) {build_cpu:>7.3}  | walk winner: {win}  (resident vs CPU {:.2}x)",
        cpu_walk / gpu_resident.max(1e-6)
    );
}

fn main() {
    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .ok() else {
        eprintln!("no wgpu adapter — cannot run the GPU bench");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("walk_bench"),
        ..Default::default()
    }))
    .expect("device");
    let pipes = WalkPipelines::new(&device);
    println!("adapter: {}  |  viewport {VIEWPORT_W}x{VIEWPORT_H} (4K)  |  {RUNS} runs, median ms\n", adapter.get_info().name);
    println!("(CPU walk = production flat walk; GPU resident = steady-state dispatch, no upload/readback;");
    println!(" GPU full = naive V1 upload+dispatch+readback; build(CPU) = full schedule incl. finish)\n");

    for &n in SIZES {
        measure(n, &device, &queue, &pipes);
    }
    println!("\n'ratio N.NNx' = how many times faster the resident GPU dispatch is than the CPU walk (>1 = GPU wins).");
}
