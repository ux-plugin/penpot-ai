//! The scene walk that produces the frame graph — R1's module. Today it builds the spine only:
//! every root as a body item in one `Draw`, so a plain document renders exactly and effects are
//! absent by construction until R1 lowers each effect-stack entry into a chain.

use crate::kurbo::{Affine, Rect};

use crate::vello::frame_graph::{DrawItem, DrawStyle, FrameGraph, GNode, Op};

/// The frame graph of the installed document for a `width × height` viewport under `root`.
#[must_use]
pub fn build_frame_graph(root: Affine, width: u32, height: u32) -> FrameGraph {
    let full_view = crate::vello::abi::effective_view(root);
    let frame = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
    let items: Vec<DrawItem> = crate::vello::abi::with_scene(|live, _, modifiers| {
        live.roots()
            .iter()
            .map(|&id| {
                let bounds = live
                    .get(id)
                    .map(|n| {
                        let m = modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
                        full_view.transform_rect_bbox(crate::schedule::page_bounds(n, m))
                    })
                    .unwrap_or(frame);
                DrawItem { shape: id, style: DrawStyle::Body, bounds }
            })
            .collect()
    });
    FrameGraph {
        frame,
        background: crate::vello::abi::background(),
        nodes: vec![GNode { op: Op::Draw(items), inputs: vec![], label: "spine".into() }],
    }
}
