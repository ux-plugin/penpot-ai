//! The C-style ABI, mirroring render-wasm's so the host drives both backends identically.
//!
//! D17: the Skia and Vello modules share one wire format and one calling convention. The host
//! reaches this through the `Module`-shaped facade in `skia-rs-wasm`
//! (`vello-module-facade.ts`), which maps `Module._use_shape(…)` onto `exports.use_shape(…)`
//! and republishes `HEAPU8` over `exports.memory`. So `api/*.ts` drives this module unmodified.
//!
//! Two differences from render-wasm, both spelling rather than semantics:
//! - This crate is edition 2024, so exports are `#[unsafe(no_mangle)]` rather than
//!   `#[no_mangle]`. Copying a signature across without the wrap fails to compile.
//! - Decoding builds `render_core::model` values instead of Skia-typed ones. Same bytes,
//!   different construction — that divergence is the point.
//!
//! The implicit current-shape cursor is inherited deliberately (D17, "accepted debt"): the
//! host's existing call sequence is proven, and matching it is what lets the two modules be
//! driven interchangeably. Explicit `upsert(id, payload)` is the Phase-3 target.

use std::collections::HashMap;
use std::sync::Mutex;

use render_core::abi::decode_fill;
use render_core::kurbo::{Affine, Rect};
use render_core::model::{Node, Scene, ShapeKind};

/// The shared byte buffer. The host allocates, writes through `HEAPU8`, then calls a no-arg
/// export that drains it — exactly render-wasm's protocol.
static BUFFER: Mutex<Option<Vec<u8>>> = Mutex::new(None);

static STATE: Mutex<Option<SceneState>> = Mutex::new(None);

/// Nodes keyed by id, plus insertion order, plus the cursor the property setters apply to.
#[derive(Default)]
struct SceneState {
    nodes: HashMap<u128, Node>,
    order: Vec<u128>,
    current: Option<u128>,
}

impl SceneState {
    fn upsert(&mut self, id: u128) {
        if !self.nodes.contains_key(&id) {
            self.order.push(id);
            self.nodes.insert(id, blank_node(id));
        }
        self.current = Some(id);
    }

    fn current_mut(&mut self) -> Option<&mut Node> {
        let id = self.current?;
        self.nodes.get_mut(&id)
    }

    /// Project into the flat draw list the renderer consumes, in insertion order.
    #[allow(dead_code)]
    fn to_scene(&self) -> Scene {
        let mut scene = Scene::new();
        for id in &self.order {
            if let Some(node) = self.nodes.get(id) {
                scene.push(node.clone());
            }
        }
        scene
    }
}

fn blank_node(id: u128) -> Node {
    Node {
        id,
        kind: ShapeKind::Rect,
        bounds: Rect::ZERO,
        path: None,
        corners: None,
        transform: Affine::IDENTITY,
        fills: Vec::new(),
        strokes: Vec::new(),
        opacity: 1.0,
        hidden: false,
    }
}

fn with_state<R>(f: impl FnOnce(&mut SceneState) -> R) -> R {
    let mut guard = STATE.lock().expect("scene state poisoned");
    f(guard.get_or_insert_with(SceneState::default))
}

fn with_current<R>(f: impl FnOnce(&mut Node) -> R) -> Option<R> {
    with_state(|state| state.current_mut().map(f))
}

/// Take the pending buffer, leaving it empty. Mirrors render-wasm's `mem::bytes()`.
fn take_bytes() -> Vec<u8> {
    BUFFER
        .lock()
        .expect("byte buffer poisoned")
        .take()
        .unwrap_or_default()
}

/// The scene as the renderer wants it. Not part of the ABI.
///
/// Dead code until slice D hands it to `renderer.rs` in place of the demo scene.
#[allow(dead_code)]
pub(crate) fn current_scene() -> Scene {
    with_state(|state| state.to_scene())
}

// --- transport -------------------------------------------------------------------------

/// Reserve `len` bytes in the wasm heap and hand back a pointer for the host to write into.
///
/// Returns null if a buffer is already outstanding, matching render-wasm's "Bytes already
/// allocated" guard — a leaked allocation is a host bug and should be loud, but this module
/// has no panic-to-JS channel yet, so it signals instead.
#[unsafe(no_mangle)]
pub extern "C" fn alloc_bytes(len: usize) -> *mut u8 {
    let mut guard = BUFFER.lock().expect("byte buffer poisoned");
    if guard.is_some() {
        return std::ptr::null_mut();
    }
    let mut bytes = vec![0u8; len];
    let ptr = bytes.as_mut_ptr();
    *guard = Some(bytes);
    ptr
}

#[unsafe(no_mangle)]
pub extern "C" fn free_bytes() {
    *BUFFER.lock().expect("byte buffer poisoned") = None;
}

// --- shape lifecycle -------------------------------------------------------------------

/// Select (creating if absent) the shape subsequent setters apply to. The id arrives as a
/// UUID split into four little-endian u32s, same as render-wasm.
#[unsafe(no_mangle)]
pub extern "C" fn use_shape(a: u32, b: u32, c: u32, d: u32) {
    let id = uuid_u128(a, b, c, d);
    with_state(|state| state.upsert(id));
}

#[unsafe(no_mangle)]
pub extern "C" fn set_shape_selrect(left: f32, top: f32, right: f32, bottom: f32) {
    with_current(|node| {
        node.bounds = Rect::new(left as f64, top as f64, right as f64, bottom as f64);
    });
}

/// Skia's row-major affine. kurbo's `Affine::new` is column-major `[a, b, c, d, e, f]` where
/// `b` is skew_y and `c` is skew_x — swapping them is a silent shear. `core_convert` on the
/// Skia side pins the same mapping with a test.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_transform(a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) {
    with_current(|node| {
        node.transform = Affine::new([a as f64, b as f64, c as f64, d as f64, e as f64, f as f64]);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn set_shape_opacity(opacity: f32) {
    with_current(|node| node.opacity = opacity);
}

#[unsafe(no_mangle)]
pub extern "C" fn set_shape_hidden(hidden: bool) {
    with_current(|node| node.hidden = hidden);
}

/// Shape kind, as render-wasm's `RawShapeType`: 0 Frame, 1 Group, 2 Bool, 3 Rect, 4 Path,
/// 5 Text, 6 Circle, 7 SVGRaw. Anything this module cannot draw yet stays a rect.
///
/// Named `set_shape_type` rather than anything more descriptive because the export name *is*
/// the contract — the host calls `module._set_shape_type(…)` and the facade strips the
/// underscore, so a divergent name here is simply a function the host never reaches.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_type(shape_type: u8) {
    with_current(|node| {
        node.kind = match shape_type {
            4 => ShapeKind::Path,
            6 => ShapeKind::Circle,
            _ => ShapeKind::Rect,
        };
    });
}

/// Corner radii for a rect: top-left, top-right, bottom-right, bottom-left. All-zero collapses
/// to `None`, mirroring render-wasm's `make_corners`.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_corners(r1: f32, r2: f32, r3: f32, r4: f32) {
    let corners = render_core::model::corners_from_raw(r1, r2, r3, r4);
    with_current(|node| node.corners = corners);
}

// --- path geometry ---------------------------------------------------------------------

/// Accumulator for chunked path uploads, mirroring render-wasm's `PATH_UPLOAD_BUFFER`. Paths
/// can exceed one `alloc_bytes` window, so the host streams them: start, N chunks, then commit.
static PATH_BUFFER: Mutex<Vec<u8>> = Mutex::new(Vec::new());

#[unsafe(no_mangle)]
pub extern "C" fn start_shape_path_buffer() {
    PATH_BUFFER.lock().expect("path buffer poisoned").clear();
}

#[unsafe(no_mangle)]
pub extern "C" fn set_shape_path_chunk_buffer() {
    let bytes = take_bytes();
    PATH_BUFFER
        .lock()
        .expect("path buffer poisoned")
        .extend_from_slice(&bytes);
}

#[unsafe(no_mangle)]
pub extern "C" fn set_shape_path_buffer() {
    let bytes = {
        let mut buffer = PATH_BUFFER.lock().expect("path buffer poisoned");
        std::mem::take(&mut *buffer)
    };
    apply_path_bytes(&bytes);
}

/// The single-shot form, for paths small enough to fit one `alloc_bytes` window.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_path_content() {
    let bytes = take_bytes();
    apply_path_bytes(&bytes);
}

/// Decode a packed segment buffer onto the current shape.
///
/// Applies only when the shape is a path, which is what render-wasm's `set_path_segments` does
/// — it matches on `Type::Path`/`Type::Bool` and silently ignores anything else. Mirroring that
/// keeps the two backends in step on call ordering; the host sets the type first.
///
/// A malformed buffer drops the geometry rather than panicking. This module has no
/// panic-to-JS channel yet, and a missing shape is a better failure than a dead renderer.
fn apply_path_bytes(bytes: &[u8]) {
    let Ok(segments) = render_core::abi::decode_path(bytes) else {
        return;
    };
    let path = render_core::model::bez_path_from_raw(&segments);
    with_current(|node| {
        if node.kind == ShapeKind::Path {
            node.path = Some(path);
        }
    });
}

// --- fills -----------------------------------------------------------------------------

/// Replace the current shape's fills from the pending buffer.
///
/// Layout matches render-wasm exactly: a 4-byte header whose first byte is the fill count,
/// then that many fixed-size records. Decoding is render-core's shared codec, so both
/// backends read identical bytes through identical code.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_fills() {
    let bytes = take_bytes();
    let count = bytes.first().copied().unwrap_or(0) as usize;

    let fills = bytes
        .get(4..)
        .map(|body| {
            body.chunks_exact(render_core::abi::RAW_FILL_DATA_SIZE)
                .take(count)
                .filter_map(|chunk| decode_fill(chunk).ok())
                .filter_map(brush_from_raw)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    with_current(|node| node.fills = fills);
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_fills() {
    with_current(|node| node.fills.clear());
}

/// Raw fill payload to a peniko brush. The Vello counterpart of render-wasm's
/// `From<RawFillData> for shapes::Fill` — same input, different construction.
fn brush_from_raw(raw: render_core::abi::RawFillData) -> Option<render_core::peniko::Brush> {
    use render_core::abi::RawFillData as R;
    use render_core::peniko::{Brush, ColorStop, Gradient};

    let stops = |g: &render_core::abi::RawGradientData| {
        g.active_stops()
            .iter()
            .map(|s| ColorStop {
                offset: s.offset,
                color: argb_to_color(s.color).into(),
            })
            .collect::<Vec<_>>()
    };

    Some(match raw {
        R::Solid(s) => Brush::Solid(argb_to_color(s.color)),
        R::Linear(g) => Brush::Gradient(
            Gradient::new_linear(kpoint(g.start()), kpoint(g.end())).with_stops(&stops(&g)[..]),
        ),
        R::Radial(g) => Brush::Gradient(
            Gradient::new_radial(kpoint(g.start()), g.width_x).with_stops(&stops(&g)[..]),
        ),
        R::Angular(g) => Brush::Gradient(
            Gradient::new_sweep(kpoint(g.start()), 0.0, std::f32::consts::TAU)
                .with_stops(&stops(&g)[..]),
        ),
        // Diamond has no peniko equivalent; it rides with the Phase-4 custom shaders (D10).
        R::Diamond(_) => return None,
        // Image fills need the texture path, which this module does not have yet.
        R::Image(_) => return None,
    })
}

#[inline]
fn kpoint(p: (f32, f32)) -> render_core::kurbo::Point {
    render_core::kurbo::Point::new(p.0 as f64, p.1 as f64)
}

/// The wire carries packed ARGB, matching Skia's word order.
#[inline]
fn argb_to_color(argb: u32) -> render_core::peniko::Color {
    render_core::peniko::Color::from_rgba8(
        ((argb >> 16) & 0xff) as u8,
        ((argb >> 8) & 0xff) as u8,
        (argb & 0xff) as u8,
        ((argb >> 24) & 0xff) as u8,
    )
}

#[inline]
fn uuid_u128(a: u32, b: u32, c: u32, d: u32) -> u128 {
    ((a as u128) << 96) | ((b as u128) << 64) | ((c as u128) << 32) | (d as u128)
}

// --- introspection ---------------------------------------------------------------------

/// Node count, so the host and tests can assert the scene took without reading pixels.
#[unsafe(no_mangle)]
pub extern "C" fn scene_node_count() -> u32 {
    with_state(|state| state.order.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_scene() {
    with_state(|state| {
        state.nodes.clear();
        state.order.clear();
        state.current = None;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_core::peniko::Brush;

    /// The ABI is built on module-global state — the implicit current-shape cursor D17 accepts
    /// as debt. The test harness runs tests in parallel threads, so without serialising them
    /// one test's `clear_scene()` lands between another's `use_shape` and its assertions and
    /// the failure looks flaky. Every test holds this for its duration.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn reset() -> std::sync::MutexGuard<'static, ()> {
        // A panicking test poisons the lock; the state is reset here anyway, so recover.
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clear_scene();
        free_bytes();
        guard
    }

    #[test]
    fn use_shape_creates_then_reselects() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        use_shape(0, 0, 0, 2);
        use_shape(0, 0, 0, 1);
        assert_eq!(scene_node_count(), 2);
    }

    #[test]
    fn setters_apply_to_the_current_shape() {
        let _guard = reset();
        use_shape(0, 0, 0, 7);
        set_shape_selrect(1.0, 2.0, 11.0, 22.0);
        set_shape_opacity(0.5);
        set_shape_type(6);

        let scene = current_scene();
        let node = &scene.nodes[0];
        assert_eq!(node.bounds, Rect::new(1.0, 2.0, 11.0, 22.0));
        assert_eq!(node.opacity, 0.5);
        assert_eq!(node.kind, ShapeKind::Circle);
    }

    /// The element-order trap, from the Vello side. An asymmetric matrix is required —
    /// a symmetric one passes even with skew_x and skew_y swapped.
    #[test]
    fn transform_keeps_skia_element_order() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_transform(2.0, 3.0, 5.0, 7.0, 11.0, 13.0);
        let scene = current_scene();
        assert_eq!(
            scene.nodes[0].transform.as_coeffs(),
            [2.0, 3.0, 5.0, 7.0, 11.0, 13.0]
        );
    }

    /// Drives the real transport: allocate, write bytes as the host would, then decode.
    #[test]
    fn fills_decode_from_the_shared_buffer() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        let size = render_core::abi::RAW_FILL_DATA_SIZE;
        let mut payload = vec![0u8; 4 + size];
        payload[0] = 1; // one fill
        payload[4] = 0x00; // tag: solid
        payload[8..12].copy_from_slice(&0xff112233u32.to_le_bytes());

        let ptr = alloc_bytes(payload.len());
        assert!(!ptr.is_null());
        // Stand in for the host's `HEAPU8.set(bytes, ptr)`.
        {
            let mut guard = BUFFER.lock().unwrap();
            guard.as_mut().unwrap().copy_from_slice(&payload);
        }
        set_shape_fills();

        let scene = current_scene();
        assert_eq!(
            scene.nodes[0].fills,
            vec![Brush::Solid(render_core::peniko::Color::from_rgba8(
                0x11, 0x22, 0x33, 0xff
            ))]
        );
    }

    /// Write `payload` through the real transport, as the host's `HEAPU8.set(bytes, ptr)` does.
    fn upload(payload: &[u8]) {
        let ptr = alloc_bytes(payload.len());
        assert!(!ptr.is_null());
        let mut guard = BUFFER.lock().unwrap();
        guard.as_mut().unwrap().copy_from_slice(payload);
    }

    fn triangle_bytes() -> Vec<u8> {
        use render_core::abi::{
            RAW_SEGMENT_DATA_SIZE, RawLineCommand, RawMoveCommand, RawSegmentData, encode_segment,
        };
        let segments = [
            RawSegmentData::MoveTo(RawMoveCommand::new((0.0, 0.0))),
            RawSegmentData::LineTo(RawLineCommand::new((10.0, 0.0))),
            RawSegmentData::LineTo(RawLineCommand::new((5.0, 8.0))),
            RawSegmentData::Close,
        ];
        let mut buf = vec![0u8; RAW_SEGMENT_DATA_SIZE * segments.len()];
        for (i, s) in segments.iter().enumerate() {
            encode_segment(s, &mut buf[i * RAW_SEGMENT_DATA_SIZE..]).unwrap();
        }
        buf
    }

    #[test]
    fn path_content_decodes_from_the_shared_buffer() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_type(4); // Path

        upload(&triangle_bytes());
        set_shape_path_content();

        let scene = current_scene();
        let path = scene.nodes[0].path.as_ref().expect("path must be set");
        assert_eq!(path.elements().len(), 4);
    }

    /// The chunked form: the host streams a path that does not fit one allocation window.
    #[test]
    fn path_buffer_accumulates_chunks() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_type(4);

        let bytes = triangle_bytes();
        let (head, tail) = bytes.split_at(render_core::abi::RAW_SEGMENT_DATA_SIZE * 2);

        start_shape_path_buffer();
        upload(head);
        set_shape_path_chunk_buffer();
        upload(tail);
        set_shape_path_chunk_buffer();
        set_shape_path_buffer();

        let scene = current_scene();
        assert_eq!(scene.nodes[0].path.as_ref().unwrap().elements().len(), 4);

        // Committing drains the accumulator, so a second commit does not replay the path.
        use_shape(0, 0, 0, 2);
        set_shape_type(4);
        set_shape_path_buffer();
        let scene = current_scene();
        assert!(scene.nodes[1].path.as_ref().unwrap().is_empty());
    }

    /// Mirrors render-wasm's `set_path_segments`, which ignores anything that is not a path.
    #[test]
    fn path_content_is_ignored_on_a_non_path_shape() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_type(3); // Rect

        upload(&triangle_bytes());
        set_shape_path_content();

        assert!(current_scene().nodes[0].path.is_none());
    }

    /// A ragged buffer must drop the geometry, not panic — there is no panic-to-JS channel.
    #[test]
    fn a_malformed_path_buffer_is_dropped() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_type(4);

        upload(&[0u8; render_core::abi::RAW_SEGMENT_DATA_SIZE + 5]);
        set_shape_path_content();

        assert!(current_scene().nodes[0].path.is_none());
    }

    #[test]
    fn corners_collapse_when_square() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        set_shape_corners(0.0, 0.0, 0.0, 0.0);
        assert!(current_scene().nodes[0].corners.is_none());

        set_shape_corners(1.0, 2.0, 3.0, 4.0);
        let corners = current_scene().nodes[0].corners.expect("radii must be set");
        assert_eq!(corners.top_left, 1.0);
        assert_eq!(corners.bottom_left, 4.0);
    }

    #[test]
    fn a_second_alloc_without_free_is_refused() {
        let _guard = reset();
        assert!(!alloc_bytes(8).is_null());
        assert!(alloc_bytes(8).is_null());
        free_bytes();
        assert!(!alloc_bytes(8).is_null());
    }
}
