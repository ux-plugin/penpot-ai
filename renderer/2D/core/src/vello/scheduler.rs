//! The scheduler: frame graph in, frame plan out — R2's module. Today it plans the spine only:
//! clear the frame, one front-end over every spine draw, one fine window over the frame, present.
//! Chains are not planned yet, so a graph with effects renders without them.

use crate::kurbo::{Affine, Rect};

use crate::vello::frame_graph::{DrawItem, FrameGraph, Op};
use crate::vello::frame_plan::{DrawCmd, FramePlan, Pass, Tiles, Window};

/// The plan for `graph` on a `width × height` store whose rows are the frame.
#[must_use]
pub fn plan(graph: &FrameGraph, width: u32, height: u32) -> FramePlan {
    let frame = Rect::new(0.0, 0.0, f64::from(width), f64::from(height));
    let items: Vec<DrawItem> = graph
        .nodes
        .iter()
        .enumerate()
        .filter(|&(i, _)| graph.is_spine(i))
        .filter_map(|(_, n)| match &n.op {
            Op::Draw(items) => Some(items.iter().cloned()),
            _ => None,
        })
        .flatten()
        .collect();
    FramePlan {
        store: (width, height),
        params: Vec::new(),
        passes: vec![
            Pass::Clear { rect: frame, colour: graph.background.components },
            Pass::Frontend { draws: vec![DrawCmd::Shapes { items, transform: Affine::IDENTITY, clip: None }] },
            Pass::Fine { window: Window { rounds: (0, u32::MAX), tiles: Tiles::All }, output: frame, base: None, input: None },
            Pass::Present { from: frame },
        ],
    }
}
