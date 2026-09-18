//! Native replayer for the editor's ABI recordings (`abi-recorder.ts`): the capture is the
//! host's intent — entry-point names, scalar args, and the shared-buffer bytes staged before
//! each buffer-consuming call — so replaying it against the same `extern "C"` surface installs
//! the EXACT live document as a native fixture. This is the bridge the artifact hunts were
//! missing: every native harness previously rendered `parity::*` scenes, which merely resemble
//! the editor's seeded documents.
//!
//! Names the wasm shell stubs (layout, rotation, constraints — recorded through the stub) are
//! skipped; `store_font` is skipped because the recorder does not capture font bytes yet, so a
//! replayed document renders every effect and shape but no glyphs. An unrecognised name panics:
//! a new capture surfacing a new entry point must be added here, not silently dropped.

use base64::Engine as _;
use render_core::vello::abi;

const SKIP: &[&str] = &[
    "set_shape_rotation",
    "clear_shape_constraints",
    "set_layout_data",
    "clear_shape_layout",
    "clear_shape_material",
    "store_font",
];

/// What a replay observed on the way through: the applied call count plus the recording's own
/// canvas geometry (`init` CSS size, `set_render_options` dpr) so a harness can size its target
/// exactly like the captured session's backing store.
pub struct Replayed {
    pub applied: usize,
    pub canvas: (i32, i32),
    pub dpr: f32,
}

/// Replay `path` (a `Recording` JSON, tolerant of one extra layer of string quoting from
/// console captures) into the installed ABI.
pub fn replay(path: &str) -> Replayed {
    let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let text: String = if raw.trim_start().starts_with('"') {
        serde_json::from_str(&raw).expect("unwrap quoted recording")
    } else {
        raw
    };
    let doc: serde_json::Value = serde_json::from_str(&text).expect("parse recording");
    assert_eq!(doc["version"].as_i64(), Some(1), "recording version");
    let calls = doc["calls"].as_array().expect("calls array");

    let mut staged: Option<(*mut u8, usize)> = None;
    let mut applied = 0usize;
    let mut canvas = (0i32, 0i32);
    let mut dpr = 1.0f32;
    for call in calls {
        let name = call["fn"].as_str().expect("fn name");
        if SKIP.contains(&name) {
            continue;
        }
        if let Some(b64) = call["buffer"].as_str() {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).expect("base64");
            if let Some((ptr, len)) = staged.take() {
                let n = bytes.len().min(len);
                unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, n) };
            }
        }
        let args: Vec<f64> = call["args"]
            .as_array()
            .map_or_else(Vec::new, |a| a.iter().filter_map(serde_json::Value::as_f64).collect());
        let f = |i: usize| args.get(i).copied().unwrap_or(0.0) as f32;
        let u = |i: usize| args.get(i).copied().unwrap_or(0.0) as i64 as u32;
        let i32a = |i: usize| args.get(i).copied().unwrap_or(0.0) as i64 as i32;
        let b = |i: usize| args.get(i).copied().unwrap_or(0.0) != 0.0;
        match name {
            "init" => {
                canvas = (i32a(0), i32a(1));
                abi::init(i32a(0), i32a(1));
            }
            "set_render_options" => {
                dpr = f(1);
                abi::set_render_options(u(0), f(1));
            }
            "set_scheduler" => abi::set_scheduler(u(0)),
            "set_tile_effects" => abi::set_tile_effects(u(0)),
            "resize_viewbox" => abi::resize_viewbox(i32a(0), i32a(1)),
            "set_canvas_background" => abi::set_canvas_background(u(0)),
            "set_view" => abi::set_view(f(0), f(1), f(2)),
            "set_view_start" => abi::set_view_start(),
            "set_view_end" => abi::set_view_end(),
            "init_shapes_pool" => abi::init_shapes_pool(u(0) as usize),
            "use_shape" => abi::use_shape(u(0), u(1), u(2), u(3)),
            "set_parent" => abi::set_parent(u(0), u(1), u(2), u(3)),
            "set_shape_type" => abi::set_shape_type(u(0) as u8),
            "set_shape_clip_content" => abi::set_shape_clip_content(b(0)),
            "set_shape_opacity" => abi::set_shape_opacity(f(0)),
            "set_shape_hidden" => abi::set_shape_hidden(b(0)),
            "alloc_bytes" => {
                let len = u(0) as usize;
                let ptr = abi::alloc_bytes(len);
                staged = Some((ptr, len));
            }
            "free_bytes" => abi::free_bytes(),
            "set_children" => abi::set_children(),
            "set_children_0" => abi::set_children_0(),
            "set_children_1" => abi::set_children_1(u(0), u(1), u(2), u(3)),
            "set_children_2" => {
                abi::set_children_2(u(0), u(1), u(2), u(3), u(4), u(5), u(6), u(7));
            }
            "set_shape_corners" => abi::set_shape_corners(f(0), f(1), f(2), f(3)),
            "clear_shape_blur" => abi::clear_shape_blur(),
            "clear_shape_texture" => abi::clear_shape_texture(),
            "clear_shape_glass" => abi::clear_shape_glass(),
            "clear_shape_shadows" => abi::clear_shape_shadows(),
            "set_shape_selrect" => abi::set_shape_selrect(f(0), f(1), f(2), f(3)),
            "clear_shape_fills" => abi::clear_shape_fills(),
            "clear_shape_strokes" => abi::clear_shape_strokes(),
            "set_shape_fills" => abi::set_shape_fills(),
            "set_shape_blur" => abi::set_shape_blur(u(0) as u8, b(1), f(2)),
            "set_shape_blend_mode" => abi::set_shape_blend_mode(u(0) as u8),
            "add_shape_shadow" => {
                abi::add_shape_shadow(u(0), f(1), f(2), f(3), f(4), u(5) as u8, b(6));
            }
            "add_shape_center_stroke" => {
                abi::add_shape_center_stroke(f(0), u(1) as u8, u(2) as u8, u(3) as u8);
            }
            "add_shape_outer_stroke" => {
                abi::add_shape_outer_stroke(f(0), u(1) as u8, u(2) as u8, u(3) as u8);
            }
            "add_shape_stroke_fill" => abi::add_shape_stroke_fill(),
            "start_shape_path_buffer" => abi::start_shape_path_buffer(),
            "set_shape_path_chunk_buffer" => abi::set_shape_path_chunk_buffer(),
            "set_shape_path_buffer" => abi::set_shape_path_buffer(),
            "set_shape_masked_group" => abi::set_shape_masked_group(b(0)),
            "set_shape_transform" => {
                abi::set_shape_transform(f(0), f(1), f(2), f(3), f(4), f(5));
            }
            "set_shape_glass" => abi::set_shape_glass(
                i32a(0),
                f(1),
                f(2),
                f(3),
                f(4),
                f(5),
                f(6),
                f(7),
                f(8),
                f(9),
                f(10),
                f(11),
                f(12),
                f(13),
                f(14),
                u(15),
                u(16) as u8,
            ),
            "set_shape_grow_type" => abi::set_shape_grow_type(u(0) as u8),
            "clear_shape_text" => abi::clear_shape_text(),
            "set_shape_vertical_align" => abi::set_shape_vertical_align(u(0) as u8),
            "is_font_uploaded" => {
                let _ = abi::is_font_uploaded(u(0), u(1), u(2), u(3), u(4), u(5) as u8, b(6));
            }
            "set_shape_text_content" => abi::set_shape_text_content(),
            "update_shape_text_layout" => render_core::vello::text::update_shape_text_layout(),
            "calculate_position_data" => {
                let _ = render_core::vello::text::calculate_position_data();
            }
            "get_selection_rect" => {
                let _ = abi::get_selection_rect();
            }
            "set_modifiers" => abi::set_modifiers(),
            "clean_modifiers" => abi::clean_modifiers(),
            "propagate_modifiers" => {
                let _ = abi::propagate_modifiers(b(0));
            }
            "render_sync" => abi::render_sync(),
            "render" => abi::render(i32a(0)),
            "clean_up" => abi::clean_up(),
            other => panic!("replay: unmapped ABI entry point {other:?} — add it to util/replay.rs"),
        }
        applied += 1;
    }
    Replayed { applied, canvas, dpr }
}
