//! Headless GPU-vs-oracle proof for the walk kernel (V1-S2b). Runs the three compute passes on a real
//! wgpu device and asserts the read-back [`StepRecord`]s match
//! [`render_core::schedule::flatten::count_and_scatter`] — the CPU reference the WGSL transliterates —
//! byte-for-byte, so the algorithm and the GPU are never in doubt at the same time.
//!
//! An **integration** test (not an in-`src` `#[cfg(test)]` module) on purpose: it links the plain
//! `vello_gpu_renderer` lib, so it is independent of that crate's in-lib test module. Skips cleanly
//! when no adapter is present (headless CI), matching the crate's other GPU proofs.

use std::collections::HashSet;

use render_core::host::Modifiers;
use render_core::kurbo::{Affine, Rect};
use render_core::model::{Node, Scene, ShapeKind, ROOT_ID};
use render_core::schedule::flatten::{count_and_scatter, flatten_leaves};
use render_core::tiling::{visible_tiles, TileKey};
use vello_gpu_renderer::walk_gpu::{walk_on_gpu, WalkPipelines};

/// Headless wgpu device, or `None` when no adapter is available — the caller skips rather than fails.
fn device() -> Option<(wgpu::Device, wgpu::Queue)> {
    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()?;
    pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("walk_gpu test"),
        ..Default::default()
    }))
    .ok()
}

fn rect(id: u128, x0: f64, y0: f64, x1: f64, y1: f64) -> Node {
    let mut n = Node::new(id, ShapeKind::Rect);
    n.bounds = Rect::new(x0, y0, x1, y1);
    n
}

fn group(id: u128, children: Vec<u128>) -> Node {
    let mut n = Node::new(id, ShapeKind::Group);
    n.children = children;
    n
}

/// Flatten `scene`, run the GPU walk and the host oracle for each view, and assert they match exactly.
/// `w` sizes the viewport (hence the visible tile range); `dirty` is fed to *both* sides so the
/// comparison is apples-to-apples whether or not the reject fires.
fn assert_gpu_matches_oracle(scene: &Scene, views: &[Affine], w: u32, dirty: Option<Rect>) {
    let Some((device, queue)) = device() else {
        eprintln!("no wgpu adapter — skipping GPU walk diff");
        return;
    };
    let pipes = WalkPipelines::new(&device);
    let flat = flatten_leaves(scene, &Modifiers::new()).expect("eligible scene");

    for &view in views {
        let visible: HashSet<TileKey> = visible_tiles(view, w, w).into_iter().collect();

        let oracle = count_and_scatter(&flat, view, &visible, dirty);
        let gpu = walk_on_gpu(&device, &queue, &pipes, &flat, view, &visible, dirty);

        assert_eq!(gpu.len(), oracle.len(), "record count mismatch for view {view:?}");
        assert_eq!(gpu, oracle, "GPU walk must match the host oracle byte-for-byte for view {view:?}");
    }
}

/// The core proof: a flat scene of several tile-spanning leaves. Integer coords, so `f32` is exact.
#[test]
fn gpu_walk_matches_oracle_flat() {
    let mut s = Scene::new();
    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    root.children = vec![1, 2, 3, 4];
    s.insert(root);
    for n in [
        rect(1, 20.0, 20.0, 300.0, 300.0),
        rect(2, 480.0, 100.0, 1600.0, 1200.0), // spans many 512px tiles
        rect(3, 700.0, 700.0, 760.0, 760.0),
        rect(4, 0.0, 1500.0, 60.0, 1560.0),
    ] {
        s.insert(n);
    }
    assert_gpu_matches_oracle(&s, &[Affine::IDENTITY, Affine::scale(2.0), Affine::translate((37.0, -13.0))], 2048, None);
}

/// The dirty-reject path: a `dirty` rect covering only the top-left quadrant must cull every leaf whose
/// affected bounds fall entirely outside it — on the GPU exactly as on the oracle.
#[test]
fn gpu_walk_matches_oracle_with_dirty_reject() {
    let mut s = Scene::new();
    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    root.children = vec![1, 2, 3, 4];
    s.insert(root);
    for n in [
        rect(1, 20.0, 20.0, 300.0, 300.0),       // inside dirty
        rect(2, 1800.0, 1800.0, 2000.0, 2000.0), // outside dirty → rejected
        rect(3, 100.0, 900.0, 400.0, 1100.0),    // straddles the dirty edge
        rect(4, 1900.0, 40.0, 2000.0, 140.0),    // outside dirty → rejected
    ] {
        s.insert(n);
    }
    let dirty = Some(Rect::new(0.0, 0.0, 1000.0, 1000.0));
    assert_gpu_matches_oracle(&s, &[Affine::IDENTITY, Affine::scale(1.5)], 2048, dirty);
}

/// The generality proof: a nested tree (leaves inside organizational groups, group-in-group) — flatten
/// collapses it to the same page-space array, so the GPU walk must still match the oracle.
#[test]
fn gpu_walk_matches_oracle_nested() {
    let mut s = Scene::new();
    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    root.children = vec![5, 10, 3];
    s.insert(root);
    for n in [
        rect(5, 40.0, 40.0, 120.0, 120.0),
        group(10, vec![1, 20]),
        rect(1, 20.0, 20.0, 300.0, 300.0),
        group(20, vec![2, 4]),
        rect(2, 480.0, 100.0, 1400.0, 900.0),
        rect(4, 700.0, 700.0, 760.0, 760.0),
        rect(3, 0.0, 1200.0, 60.0, 1300.0),
    ] {
        s.insert(n);
    }
    assert_gpu_matches_oracle(&s, &[Affine::IDENTITY, Affine::scale(2.0), Affine::translate((21.0, -33.0))], 2048, None);
}

/// A denser field (a 40×40 grid = 1600 leaves) so the scan runs many rounds and the scatter packs many
/// disjoint slots — the offset arithmetic is where an off-by-one would show up.
#[test]
fn gpu_walk_matches_oracle_dense_grid() {
    let mut s = Scene::new();
    let mut root = Node::new(ROOT_ID, ShapeKind::Group);
    let mut ids = Vec::new();
    let mut leaves = Vec::new();
    let mut id = 1u128;
    for gy in 0..40 {
        for gx in 0..40 {
            let x = f64::from(gx) * 90.0;
            let y = f64::from(gy) * 90.0;
            leaves.push(rect(id, x, y, x + 80.0, y + 80.0));
            ids.push(id);
            id += 1;
        }
    }
    root.children = ids;
    s.insert(root);
    for n in leaves {
        s.insert(n);
    }
    assert_gpu_matches_oracle(&s, &[Affine::IDENTITY, Affine::scale(1.5)], 4096, None);
}
