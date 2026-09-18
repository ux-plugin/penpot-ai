//! A halo the lens reads is sized by the pair that reads it, never past the store.
//!
//! `fixtures/glass-zoom-edge.abi.json` is an editor capture: the showcase with a glass at 245%
//! lens zoom. Magnification reads toward the lens's centre, so once the glass crosses the frame
//! edge its halo spans the glass's whole off-frame part; at these views that is wider than the
//! store, and before the halo counted in the pair's size rules the packer panicked ("a value is
//! wider than the store") and the renderer never drew again. No GPU: this plans, it does not render.

use std::collections::HashMap;

use render_core::kurbo::Affine;
use render_core::vello::abi;
use render_core::vello::graph_build::build_frame_graph;
use render_core::vello::scheduler::plan;

#[path = "../examples/util/replay.rs"]
mod replay_util;

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/glass-zoom-edge.abi.json");

#[test]
fn a_halo_wider_than_the_store_lowers_its_pair() {
    let rep = replay_util::replay(FIXTURE);
    let (w, h) = ((rep.canvas.0 as f32 * rep.dpr) as u32, (rep.canvas.1 as f32 * rep.dpr) as u32);
    let (_, pages) = abi::effect_preset();
    // Views that panicked: the glass leaving the frame at 3× and past it further out.
    for (zoom, pan) in [(3.0, (-426.0, -255.0)), (4.0, (-800.0, -500.0)), (6.0, (-800.0, -500.0)), (12.0, (-800.0, -500.0))] {
        abi::set_view(zoom, pan.0, pan.1);
        let g = build_frame_graph(Affine::IDENTITY, w, h);
        // WebGPU's default texture limit, what a browser adapter hands out.
        let _ = plan(&g, w, h, 8192, pages, &mut HashMap::new());
    }
}
