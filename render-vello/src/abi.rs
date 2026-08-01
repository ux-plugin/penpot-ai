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

use std::sync::Mutex;

use render_core::abi::decode_fill;
use render_core::kurbo::{Affine, Rect};
use render_core::model::{Node, Scene, ShapeKind};
use render_core::peniko::Color;

/// The shared byte buffer. The host allocates, writes through `HEAPU8`, then calls a no-arg
/// export that drains it — exactly render-wasm's protocol.
static BUFFER: Mutex<Option<Vec<u8>>> = Mutex::new(None);

static STATE: Mutex<Option<SceneState>> = Mutex::new(None);

/// Nodes keyed by id, plus the cursor the property setters apply to.
///
/// There is no insertion order here: paint order comes from the tree, walked from
/// [`render_core::model::ROOT_ID`] through each node's `children`. The host sends nodes in no
/// guaranteed order — a child can arrive before the parent that lists it.
#[derive(Default)]
struct SceneState {
    scene: Scene,
    current: Option<u128>,
    viewport: Viewport,
    /// Set by `render`/`render_sync`, cleared when the host's frame loop picks it up.
    needs_frame: bool,
}

/// Pan, zoom and surface metrics — everything needed to place the page on the canvas.
///
/// Mirrors render-wasm's `Viewbox` plus the `dpr` from its render options. `zoom` and `dpr` are
/// separate because they arrive from different entry points and mean different things, even
/// though rendering only ever uses the product.
#[derive(Debug, Clone, Copy)]
struct Viewport {
    zoom: f32,
    pan_x: f32,
    pan_y: f32,
    dpr: f32,
    width: i32,
    height: i32,
    background: Color,
}

impl Default for Viewport {
    fn default() -> Self {
        Self {
            zoom: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            dpr: 1.0,
            width: 0,
            height: 0,
            background: Color::from_rgba8(0, 0, 0, 0),
        }
    }
}

impl Viewport {
    /// The page-to-canvas matrix: `scale(zoom · dpr) · translate(pan)`.
    ///
    /// render-wasm arrives at the same thing by a different route — its `Viewbox::set_all`
    /// stores the visible page rect as `(-pan_x, -pan_y, width/zoom, height/zoom)` and the
    /// canvas is then set up with `scale(zoom · dpr)` and a translation of `-area.left`. Both
    /// put page point `(-pan_x, -pan_y)` at the canvas origin.
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    fn transform(&self) -> Affine {
        let scale = (self.zoom * self.dpr) as f64;
        Affine::scale(scale) * Affine::translate((self.pan_x as f64, self.pan_y as f64))
    }
}

impl SceneState {
    fn upsert(&mut self, id: u128) {
        if self.scene.get(id).is_none() {
            self.scene.insert(Node::new(id, ShapeKind::Rect));
        }
        self.current = Some(id);
    }

    fn current_mut(&mut self) -> Option<&mut Node> {
        let id = self.current?;
        self.scene.get_mut(id)
    }

    /// Replace the current shape's children.
    ///
    /// render-wasm additionally diffs against the previous list to mark dropped children
    /// deleted and invalidate their tiles. Here a dropped child simply stops being reachable
    /// from the root, so it stops painting; it does linger in the map, which is a leak this
    /// module accepts until Phase 3 gives it a real lifecycle.
    fn set_children(&mut self, children: Vec<u128>) {
        if let Some(node) = self.current_mut() {
            node.children = children;
        }
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

/// Borrow the live scene and viewport for the duration of `f`. Not part of the ABI — this is
/// how `scene.rs` reads what the host has sent.
///
/// Borrowed rather than returned by value because this runs once a frame, and cloning the whole
/// node map per frame is exactly the cost this backend exists to avoid.
// `scene.rs` is wasm-only, so a host build sees no caller outside the tests.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn with_scene<R>(f: impl FnOnce(&Scene, Affine) -> R) -> R {
    with_state(|state| {
        let transform = state.viewport.transform();
        f(&state.scene, transform)
    })
}

/// The canvas clear colour the host set, if any.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn background() -> Color {
    with_state(|state| state.viewport.background)
}

/// Whether a frame was requested since the last check, clearing the flag.
///
/// The Vello module does not own a frame loop — Phase 0 put that in the host deliberately
/// (D3), and render-wasm's own `render()` schedules rather than draws. So the C entry point
/// records the request and the host's `requestAnimationFrame` picks it up.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(crate) fn take_needs_frame() -> bool {
    with_state(|state| std::mem::take(&mut state.needs_frame))
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

// --- module lifecycle and viewport ------------------------------------------------------
//
// One asymmetry with render-wasm, and it is not incidental: **`init` does not create the
// drawing surface here.** Emscripten binds a GL context to a canvas in its JS glue, so
// render-wasm's `init(width, height)` can be synchronous and canvas-free. Acquiring a wgpu
// adapter and device is asynchronous and needs the canvas element itself, so surface creation
// stays where Phase 0 put it — `create_focus_renderer(canvas)`, a wasm-bindgen call the host
// makes once, reachable through the facade because it passes non-underscore names straight
// through. Everything after that goes through this ABI.
//
// Phase 3's `Renderer` interface is where that difference gets absorbed, as an async `create`
// both backends implement.

/// Record the surface size. See the note above on why this does not create the surface.
#[unsafe(no_mangle)]
pub extern "C" fn init(width: i32, height: i32) {
    with_state(|state| {
        state.viewport.width = width;
        state.viewport.height = height;
    });
}

/// `debug` is render-wasm's debug-flag bitset, which this module has nothing to draw for yet.
/// `dpr` matters: it multiplies zoom to give the device scale.
#[unsafe(no_mangle)]
pub extern "C" fn set_render_options(_debug: u32, dpr: f32) {
    with_state(|state| state.viewport.dpr = if dpr > 0.0 { dpr } else { 1.0 });
}

#[unsafe(no_mangle)]
pub extern "C" fn resize_viewbox(width: i32, height: i32) {
    with_state(|state| {
        state.viewport.width = width;
        state.viewport.height = height;
        state.needs_frame = true;
    });
}

/// Pan and zoom. `x`/`y` are the pan offset, so page point `(-x, -y)` lands at the canvas
/// origin — the same convention as render-wasm's `Viewbox::set_all`.
#[unsafe(no_mangle)]
pub extern "C" fn set_view(zoom: f32, x: f32, y: f32) {
    with_state(|state| {
        state.viewport.zoom = if zoom > 0.0 { zoom } else { 1.0 };
        state.viewport.pan_x = x;
        state.viewport.pan_y = y;
        state.needs_frame = true;
    });
}

/// Bracket an interactive pan/zoom. render-wasm uses these to switch to a cheaper cached path
/// and to time the interaction; this module has no such path yet, so they are accepted and
/// ignored rather than left undefined for the host to trip over.
#[unsafe(no_mangle)]
pub extern "C" fn set_view_start() {}

#[unsafe(no_mangle)]
pub extern "C" fn set_view_end() {}

/// Request a frame.
///
/// This does not draw. render-wasm's `render()` also schedules rather than drawing, and Phase 0
/// deliberately left the frame loop with the host — so the request is recorded and the host's
/// `requestAnimationFrame` performs it. The `i32` argument is a timestamp render-wasm ignores.
#[unsafe(no_mangle)]
pub extern "C" fn render(_timestamp: i32) {
    with_state(|state| state.needs_frame = true);
}

#[unsafe(no_mangle)]
pub extern "C" fn render_sync() {
    with_state(|state| state.needs_frame = true);
}

/// Packed ARGB, matching Skia's word order — the same convention as a solid fill.
#[unsafe(no_mangle)]
pub extern "C" fn set_canvas_background(raw_color: u32) {
    with_state(|state| {
        state.viewport.background = argb_to_color(raw_color);
        state.needs_frame = true;
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn reset_canvas() {
    with_state(|state| state.needs_frame = true);
}

/// Pre-size the node map. render-wasm allocates a real pool of `Shape`s; here it only avoids
/// rehashing on the way up to a known shape count.
#[unsafe(no_mangle)]
pub extern "C" fn init_shapes_pool(capacity: usize) {
    with_state(|state| state.scene.reserve(capacity));
}

/// Drop everything. The surface is owned by the host's `FocusRenderer`, so this clears document
/// state only.
#[unsafe(no_mangle)]
pub extern "C" fn clean_up() {
    with_state(|state| {
        state.scene.clear();
        state.current = None;
        state.viewport = Viewport::default();
        state.needs_frame = false;
    });
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
            0 => ShapeKind::Frame,
            1 => ShapeKind::Group,
            4 => ShapeKind::Path,
            6 => ShapeKind::Circle,
            // Bool, Text and SVGRaw have no model kind yet; a rect is the least surprising
            // stand-in, and they carry no children, so nothing below them is lost.
            _ => ShapeKind::Rect,
        };
    });
}

/// Whether this node clips its children to its own geometry.
///
/// Projected verbatim, with no type check: render-wasm gates only on this flag, and it is the
/// host that decides only frames and slots may clip.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_clip_content(clip_content: bool) {
    with_current(|node| node.clip = clip_content);
}

// --- hierarchy -------------------------------------------------------------------------
//
// Paint order comes from each container's `children`, which is what `set_children*` writes.
// `set_parent` records the back-reference only — that is all render-wasm does with it too
// (it uses the parent link to invalidate cached bounds, which this module does not cache).

#[unsafe(no_mangle)]
pub extern "C" fn set_parent(a: u32, b: u32, c: u32, d: u32) {
    let parent = uuid_u128(a, b, c, d);
    with_current(|node| node.parent = Some(parent));
}

#[unsafe(no_mangle)]
pub extern "C" fn add_shape_child(a: u32, b: u32, c: u32, d: u32) {
    let child = uuid_u128(a, b, c, d);
    with_current(|node| node.children.push(child));
}

#[unsafe(no_mangle)]
pub extern "C" fn set_children_0() {
    with_state(|state| state.set_children(Vec::new()));
}

#[unsafe(no_mangle)]
pub extern "C" fn set_children_1(a1: u32, b1: u32, c1: u32, d1: u32) {
    with_state(|state| state.set_children(vec![uuid_u128(a1, b1, c1, d1)]));
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_children_2(
    a1: u32,
    b1: u32,
    c1: u32,
    d1: u32,
    a2: u32,
    b2: u32,
    c2: u32,
    d2: u32,
) {
    with_state(|state| {
        state.set_children(vec![uuid_u128(a1, b1, c1, d1), uuid_u128(a2, b2, c2, d2)])
    });
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_children_3(
    a1: u32,
    b1: u32,
    c1: u32,
    d1: u32,
    a2: u32,
    b2: u32,
    c2: u32,
    d2: u32,
    a3: u32,
    b3: u32,
    c3: u32,
    d3: u32,
) {
    with_state(|state| {
        state.set_children(vec![
            uuid_u128(a1, b1, c1, d1),
            uuid_u128(a2, b2, c2, d2),
            uuid_u128(a3, b3, c3, d3),
        ])
    });
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_children_4(
    a1: u32,
    b1: u32,
    c1: u32,
    d1: u32,
    a2: u32,
    b2: u32,
    c2: u32,
    d2: u32,
    a3: u32,
    b3: u32,
    c3: u32,
    d3: u32,
    a4: u32,
    b4: u32,
    c4: u32,
    d4: u32,
) {
    with_state(|state| {
        state.set_children(vec![
            uuid_u128(a1, b1, c1, d1),
            uuid_u128(a2, b2, c2, d2),
            uuid_u128(a3, b3, c3, d3),
            uuid_u128(a4, b4, c4, d4),
        ])
    });
}

#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn set_children_5(
    a1: u32,
    b1: u32,
    c1: u32,
    d1: u32,
    a2: u32,
    b2: u32,
    c2: u32,
    d2: u32,
    a3: u32,
    b3: u32,
    c3: u32,
    d3: u32,
    a4: u32,
    b4: u32,
    c4: u32,
    d4: u32,
    a5: u32,
    b5: u32,
    c5: u32,
    d5: u32,
) {
    with_state(|state| {
        state.set_children(vec![
            uuid_u128(a1, b1, c1, d1),
            uuid_u128(a2, b2, c2, d2),
            uuid_u128(a3, b3, c3, d3),
            uuid_u128(a4, b4, c4, d4),
            uuid_u128(a5, b5, c5, d5),
        ])
    });
}

/// The unbounded form: ids packed into the shared buffer, sixteen bytes each.
///
/// A UUID is four little-endian `u32`s in the same order the quartet entry points take, so this
/// and `use_shape` agree by construction. A ragged buffer drops the whole list rather than
/// building a half-tree out of misaligned ids.
#[unsafe(no_mangle)]
pub extern "C" fn set_children() {
    const UUID_SIZE: usize = 16;
    let bytes = take_bytes();

    if !bytes.len().is_multiple_of(UUID_SIZE) {
        return;
    }
    let children = bytes
        .chunks_exact(UUID_SIZE)
        .map(|c| {
            uuid_u128(
                u32::from_le_bytes([c[0], c[1], c[2], c[3]]),
                u32::from_le_bytes([c[4], c[5], c[6], c[7]]),
                u32::from_le_bytes([c[8], c[9], c[10], c[11]]),
                u32::from_le_bytes([c[12], c[13], c[14], c[15]]),
            )
        })
        .collect();

    with_state(|state| state.set_children(children));
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

// --- strokes ----------------------------------------------------------------------------
//
// Penpot's stroke arrives in pieces: `add_shape_*_stroke` opens one, then `add_shape_stroke_fill`
// gives it paint and `set_shape_stroke_props`/`set_shape_stroke_dashes` refine it — all three
// acting on "the last stroke added". That implicit cursor is the same accepted debt as the
// current-shape one (D17), and mirroring it is what lets the host drive both backends.
//
// **Inner and outer strokes are dropped, not approximated.** They are offsetting decisions —
// the outline is displaced by half the width before it is stroked — and kurbo has no slot for
// that. Drawing them centred would put paint visibly in the wrong place, which is worse than
// drawing nothing, because it looks like a rendering bug rather than a missing feature. They
// come back with path offsetting.

/// Open a centred stroke. `style` is `RawStrokeStyle`; the cap bytes are `RawStrokeCap`.
#[unsafe(no_mangle)]
pub extern "C" fn add_shape_center_stroke(width: f32, style: u8, cap_start: u8, cap_end: u8) {
    // Start from **Skia's** defaults, not kurbo's. `kurbo::Stroke::new` gives a round join and
    // round caps; Skia gives a miter join and butt caps, and render-wasm leaves those untouched
    // when the host sends nothing (`_ => {} // Miter / None → Skia default`). Inheriting kurbo's
    // would make every unstyled stroke differ between the two backends — round-ended and
    // round-cornered on one side, square on the other — with nothing in the document to explain
    // it.
    let mut kstroke = render_core::kurbo::Stroke::new(f64::from(width))
        .with_join(render_core::kurbo::Join::Miter)
        .with_caps(render_core::kurbo::Cap::Butt);
    if let Some(cap) = cap_from_wire(cap_start) {
        kstroke.start_cap = cap;
    }
    if let Some(cap) = cap_from_wire(cap_end) {
        kstroke.end_cap = cap;
    }
    render_core::model::apply_stroke_style(
        &mut kstroke,
        render_core::model::StrokeStyle::from_wire(style),
        width,
        &[],
    );

    with_current(|node| {
        node.strokes.push(render_core::model::Stroke {
            style: kstroke.clone(),
            // Penpot sends the paint separately, in `add_shape_stroke_fill`. Black is the
            // stand-in until it arrives, matching what an unpainted stroke defaults to.
            brush: render_core::peniko::Brush::Solid(render_core::peniko::Color::BLACK),
        });
    });
}

/// Inner and outer strokes are accepted and dropped — see the note above.
#[unsafe(no_mangle)]
pub extern "C" fn add_shape_inner_stroke(_width: f32, _style: u8, _cap_start: u8, _cap_end: u8) {}

#[unsafe(no_mangle)]
pub extern "C" fn add_shape_outer_stroke(_width: f32, _style: u8, _cap_start: u8, _cap_end: u8) {}

/// Paint for the most recently added stroke, read from the shared buffer as one fill record.
#[unsafe(no_mangle)]
pub extern "C" fn add_shape_stroke_fill() {
    let bytes = take_bytes();
    let Some(brush) = decode_fill(&bytes).ok().and_then(brush_from_raw) else {
        return;
    };
    with_current(|node| {
        if let Some(stroke) = node.strokes.last_mut() {
            stroke.brush = brush;
        }
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_strokes() {
    with_current(|node| node.strokes.clear());
}

/// Override join, cap and miter limit on the last stroke.
///
/// `join` and `cap` use `-1` for "leave unchanged", and `miter` any negative value — the host's
/// convention, not ours. Reading `-1` as an enum index would silently pick a join.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_stroke_props(join: i32, cap: i32, miter: f32) {
    use render_core::kurbo::{Cap, Join};
    with_current(|node| {
        let Some(stroke) = node.strokes.last_mut() else {
            return;
        };
        match join {
            0 => stroke.style.join = Join::Miter,
            1 => stroke.style.join = Join::Round,
            2 => stroke.style.join = Join::Bevel,
            _ => {}
        }
        match cap {
            0 => {
                stroke.style.start_cap = Cap::Butt;
                stroke.style.end_cap = Cap::Butt;
            }
            1 => {
                stroke.style.start_cap = Cap::Round;
                stroke.style.end_cap = Cap::Round;
            }
            2 => {
                stroke.style.start_cap = Cap::Square;
                stroke.style.end_cap = Cap::Square;
            }
            _ => {}
        }
        if miter >= 0.0 {
            stroke.style.miter_limit = f64::from(miter);
        }
    });
}

/// A custom dash pattern for the last stroke: `[dash, gap, …]` as little-endian `f32`s in the
/// shared buffer.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_stroke_dashes() {
    let bytes = take_bytes();
    let dashes: Vec<f64> = bytes
        .chunks_exact(4)
        .map(|c| f64::from(f32::from_le_bytes([c[0], c[1], c[2], c[3]])))
        .collect();

    with_current(|node| {
        if let Some(stroke) = node.strokes.last_mut() {
            stroke.style.dash_pattern = dashes.iter().copied().collect();
        }
    });
}

/// `RawStrokeCap` to a kurbo cap. The marker caps — arrows, diamonds, squares — are decorations
/// stamped at the ends rather than cap styles, so they have no kurbo equivalent and leave the
/// cap alone; they belong with the Phase-4 effect work.
fn cap_from_wire(value: u8) -> Option<render_core::kurbo::Cap> {
    use render_core::kurbo::Cap;
    match value {
        6 => Some(Cap::Round),
        7 => Some(Cap::Square),
        _ => None,
    }
}

// --- introspection ---------------------------------------------------------------------

/// Node count, so the host and tests can assert the scene took without reading pixels.
#[unsafe(no_mangle)]
pub extern "C" fn scene_node_count() -> u32 {
    with_state(|state| state.scene.len() as u32)
}

/// How many delivered nodes would actually put paint on the canvas — see
/// [`Scene::paintable_count`].
///
/// `scene_node_count` counts what the host *sent*; this counts what would be *drawn*. A blank
/// canvas with a healthy node count means the shapes arrived unreachable from the root, or with
/// no fill and no stroke — a distinction no screenshot can make.
#[unsafe(no_mangle)]
pub extern "C" fn scene_paintable_count() -> u32 {
    with_state(|state| state.scene.paintable_count())
}

/// A fingerprint of everything that would be drawn — see [`Scene::digest`].
///
/// The differential harness's read-out: replay one recorded byte stream into both backends and
/// compare this. Equal digests mean they agree on what the document *is*, which separates a
/// wire-format divergence from a rasteriser difference.
///
/// Folded to 32 bits so it crosses the ABI as a plain `i32`. A 64-bit return arrives in JS as a
/// `BigInt`, which is a papercut for callers and buys nothing at this collision domain.
#[unsafe(no_mangle)]
pub extern "C" fn scene_digest() -> u32 {
    with_state(|state| {
        let full = state.scene.digest();
        (full as u32) ^ ((full >> 32) as u32)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_scene() {
    with_state(|state| {
        state.scene.clear();
        state.current = None;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_core::kurbo::Point;
    use render_core::model::ROOT_ID;
    use render_core::peniko::Brush;

    /// The ABI is built on module-global state — the implicit current-shape cursor D17 accepts
    /// as debt. The test harness runs tests in parallel threads, so without serialising them
    /// one test's `clear_scene()` lands between another's `use_shape` and its assertions and
    /// the failure looks flaky. Every test holds this for its duration.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// A snapshot of the live scene. Production reads it by reference through `with_scene`;
    /// cloning is fine in a test and keeps the assertions readable.
    fn current_scene() -> Scene {
        with_scene(|scene, _| scene.clone())
    }

    fn reset() -> std::sync::MutexGuard<'static, ()> {
        // A panicking test poisons the lock; the state is reset here anyway, so recover.
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // `clean_up` rather than `clear_scene`: the viewport and the pending-frame flag are
        // module-global too, and a leftover `set_view` from the previous test would otherwise
        // leak into this one.
        clean_up();
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
        let node = scene.get(7).unwrap();
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
            scene.get(1).unwrap().transform.as_coeffs(),
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
            scene.get(1).unwrap().fills,
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
        let path = scene
            .get(1)
            .unwrap()
            .path
            .as_ref()
            .expect("path must be set");
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
        assert_eq!(
            scene
                .get(1)
                .unwrap()
                .path
                .as_ref()
                .unwrap()
                .elements()
                .len(),
            4
        );

        // Committing drains the accumulator, so a second commit does not replay the path.
        use_shape(0, 0, 0, 2);
        set_shape_type(4);
        set_shape_path_buffer();
        let scene = current_scene();
        assert!(scene.get(2).unwrap().path.as_ref().unwrap().is_empty());
    }

    /// Mirrors render-wasm's `set_path_segments`, which ignores anything that is not a path.
    #[test]
    fn path_content_is_ignored_on_a_non_path_shape() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_type(3); // Rect

        upload(&triangle_bytes());
        set_shape_path_content();

        assert!(current_scene().get(1).unwrap().path.is_none());
    }

    /// A ragged buffer must drop the geometry, not panic — there is no panic-to-JS channel.
    #[test]
    fn a_malformed_path_buffer_is_dropped() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_type(4);

        upload(&[0u8; render_core::abi::RAW_SEGMENT_DATA_SIZE + 5]);
        set_shape_path_content();

        assert!(current_scene().get(1).unwrap().path.is_none());
    }

    #[test]
    fn corners_collapse_when_square() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        set_shape_corners(0.0, 0.0, 0.0, 0.0);
        assert!(current_scene().get(1).unwrap().corners.is_none());

        set_shape_corners(1.0, 2.0, 3.0, 4.0);
        let corners = current_scene()
            .get(1)
            .unwrap()
            .corners
            .expect("radii must be set");
        assert_eq!(corners.top_left, 1.0);
        assert_eq!(corners.bottom_left, 4.0);
    }

    /// The shape the host addresses as `use_shape(0,0,0,0)` is the root; `roots()` reads its
    /// children, and the root itself never paints.
    #[test]
    fn the_nil_uuid_is_the_root() {
        let _guard = reset();
        use_shape(0, 0, 0, 0);
        set_shape_type(1); // Group
        set_children_2(0, 0, 0, 10, 0, 0, 0, 20);

        use_shape(0, 0, 0, 10);
        use_shape(0, 0, 0, 20);

        let scene = current_scene();
        assert_eq!(scene.roots(), &[10, 20]);
        assert_eq!(scene.get(ROOT_ID).unwrap().kind, ShapeKind::Group);
    }

    /// The host sends nodes in no guaranteed order, so a parent may list children that have
    /// not arrived yet. The tree must survive that rather than dropping them.
    #[test]
    fn children_may_be_listed_before_they_arrive() {
        let _guard = reset();
        use_shape(0, 0, 0, 0);
        set_children_1(0, 0, 0, 42);

        assert_eq!(current_scene().roots(), &[42]);
        assert!(current_scene().get(42).is_none());

        use_shape(0, 0, 0, 42);
        assert!(current_scene().get(42).is_some());
    }

    #[test]
    fn set_children_replaces_and_add_shape_child_appends() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        set_children_3(0, 0, 0, 7, 0, 0, 0, 8, 0, 0, 0, 9);
        assert_eq!(current_scene().get(1).unwrap().children, vec![7, 8, 9]);

        add_shape_child(0, 0, 0, 10);
        assert_eq!(current_scene().get(1).unwrap().children, vec![7, 8, 9, 10]);

        // Replace, not merge — and the dropped ids simply stop being reachable.
        set_children_1(0, 0, 0, 99);
        assert_eq!(current_scene().get(1).unwrap().children, vec![99]);

        set_children_0();
        assert!(current_scene().get(1).unwrap().children.is_empty());
    }

    /// The buffered form must agree with the quartet form byte for byte: a UUID on the wire is
    /// four little-endian u32s in the same order `use_shape` takes them.
    #[test]
    fn buffered_set_children_matches_the_quartet_form() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        let ids: [[u32; 4]; 2] = [[1, 2, 3, 4], [0, 0, 0, 77]];
        let mut payload = Vec::new();
        for id in ids {
            for word in id {
                payload.extend_from_slice(&word.to_le_bytes());
            }
        }
        upload(&payload);
        set_children();

        let children = current_scene().get(1).unwrap().children.clone();
        assert_eq!(children.len(), 2);
        assert_eq!(children[1], 77);

        // Same id via the quartet entry point lands on the same u128.
        use_shape(0, 0, 0, 2);
        set_children_1(1, 2, 3, 4);
        assert_eq!(current_scene().get(2).unwrap().children[0], children[0]);
    }

    /// A ragged buffer must not produce a half-tree of misaligned ids.
    #[test]
    fn buffered_set_children_rejects_a_ragged_buffer() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_children_1(0, 0, 0, 5);

        upload(&[0u8; 20]);
        set_children();

        assert_eq!(current_scene().get(1).unwrap().children, vec![5]);
    }

    #[test]
    fn parent_and_clip_are_recorded() {
        let _guard = reset();
        use_shape(0, 0, 0, 3);
        set_parent(0, 0, 0, 1);
        set_shape_clip_content(true);

        let scene = current_scene();
        assert_eq!(scene.get(3).unwrap().parent, Some(1));
        assert!(scene.get(3).unwrap().clip);

        set_shape_clip_content(false);
        assert!(!current_scene().get(3).unwrap().clip);
    }

    // --- lifecycle and viewport ---------------------------------------------------------

    fn viewport_transform() -> Affine {
        with_scene(|_, t| t)
    }

    /// The load-bearing viewport property: page point `(-pan_x, -pan_y)` must land on the canvas
    /// origin, which is what render-wasm's `Viewbox::set_all` encodes as the visible area's
    /// top-left. Get the sign wrong and the page slides the wrong way under a pan.
    #[test]
    fn pan_puts_the_view_origin_at_the_canvas_origin() {
        let _guard = reset();
        set_view(1.0, -300.0, -200.0);

        let origin = viewport_transform() * Point::new(300.0, 200.0);
        assert!((origin - Point::ZERO).hypot() < 1e-9);
    }

    #[test]
    fn zoom_and_dpr_multiply() {
        let _guard = reset();
        set_view(2.0, 0.0, 0.0);
        set_render_options(0, 3.0);

        // A 10-unit page span becomes 60 device pixels.
        let t = viewport_transform();
        let span = (t * Point::new(10.0, 0.0)) - (t * Point::ZERO);
        assert!((span.x - 60.0).abs() < 1e-9);
    }

    /// Pan is applied in page units *before* the scale, so panning by one page unit at 4×
    /// moves the image four device pixels — not one.
    #[test]
    fn pan_is_scaled_by_zoom() {
        let _guard = reset();
        set_view(4.0, 5.0, 0.0);

        let at_origin = viewport_transform() * Point::ZERO;
        assert!((at_origin.x - 20.0).abs() < 1e-9);
    }

    /// Nonsense from the host must not produce a degenerate matrix that collapses the page to a
    /// point — that renders as a blank canvas, which is indistinguishable from a broken module.
    #[test]
    fn a_zero_or_negative_scale_falls_back_to_one() {
        let _guard = reset();
        set_view(0.0, 0.0, 0.0);
        set_render_options(0, 0.0);
        assert_eq!(viewport_transform(), Affine::IDENTITY);
    }

    #[test]
    fn render_requests_a_frame_and_the_request_is_taken_once() {
        let _guard = reset();
        assert!(!take_needs_frame());

        render(0);
        assert!(take_needs_frame());
        assert!(!take_needs_frame());

        // Anything that changes what is on screen also requests one.
        set_view(1.5, 0.0, 0.0);
        assert!(take_needs_frame());
        resize_viewbox(800, 600);
        assert!(take_needs_frame());
    }

    #[test]
    fn background_decodes_as_argb() {
        let _guard = reset();
        set_canvas_background(0xff_11_22_33);
        assert_eq!(background(), Color::from_rgba8(0x11, 0x22, 0x33, 0xff));
    }

    #[test]
    fn clean_up_resets_document_and_viewport() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_view(3.0, 10.0, 20.0);
        set_canvas_background(0xff_ff_ff_ff);

        clean_up();

        assert_eq!(scene_node_count(), 0);
        assert_eq!(viewport_transform(), Affine::IDENTITY);
        assert_eq!(background().components[3], 0.0);
        assert!(!take_needs_frame());
    }

    /// The two counts answer different questions, and a blank canvas is diagnosed by their gap:
    /// `scene_node_count` is what the host sent, `scene_paintable_count` is what would be drawn.
    ///
    /// This is the shape of the real false alarm it was written for — a delivered, filled shape
    /// that paints nothing because it was never parented to the root.
    #[test]
    fn paintable_count_separates_delivered_from_drawn() {
        let _guard = reset();

        use_shape(0, 0, 0, 1);
        set_shape_type(2);
        set_shape_selrect(0.0, 0.0, 10.0, 10.0);
        let mut fills = vec![0u8; 4 + render_core::abi::RAW_FILL_DATA_SIZE];
        fills[0] = 1; // count header
        fills[8..12].copy_from_slice(&0xff_ff_00_00_u32.to_le_bytes());
        upload(&fills);
        set_shape_fills();

        assert_eq!(scene_node_count(), 1);
        assert_eq!(scene_paintable_count(), 0, "unreachable from the root");

        use_shape(0, 0, 0, 0);
        add_shape_child(0, 0, 0, 1);
        assert_eq!(scene_paintable_count(), 1);

        use_shape(0, 0, 0, 1);
        clear_shape_fills();
        assert_eq!(
            scene_paintable_count(),
            0,
            "reachable, but with nothing to draw with"
        );
        assert_eq!(scene_node_count(), 2, "still delivered");
    }

    /// The host announces its shape count before sending shapes; reserving must not invent
    /// nodes.
    #[test]
    fn init_shapes_pool_reserves_without_adding_nodes() {
        let _guard = reset();
        init_shapes_pool(512);
        assert_eq!(scene_node_count(), 0);

        use_shape(0, 0, 0, 1);
        assert_eq!(scene_node_count(), 1);
    }

    // --- strokes -------------------------------------------------------------------------

    /// One solid fill record in the shared buffer, as `add_shape_stroke_fill` expects — no
    /// count header, unlike `set_shape_fills`.
    fn upload_solid_fill(argb: u32) {
        let mut payload = vec![0u8; render_core::abi::RAW_FILL_DATA_SIZE];
        payload[0] = 0x00;
        payload[4..8].copy_from_slice(&argb.to_le_bytes());
        upload(&payload);
    }

    #[test]
    fn a_centre_stroke_takes_width_caps_and_paint() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        // RawStrokeCap: 6 = Round, 7 = Square. Style 0 = Solid.
        add_shape_center_stroke(4.0, 0, 6, 7);
        upload_solid_fill(0xff_11_22_33);
        add_shape_stroke_fill();

        let scene = current_scene();
        let strokes = &scene.get(1).unwrap().strokes;
        assert_eq!(strokes.len(), 1);
        assert_eq!(strokes[0].style.width, 4.0);
        assert_eq!(strokes[0].style.start_cap, render_core::kurbo::Cap::Round);
        assert_eq!(strokes[0].style.end_cap, render_core::kurbo::Cap::Square);
        assert_eq!(
            strokes[0].brush,
            Brush::Solid(render_core::peniko::Color::from_rgba8(
                0x11, 0x22, 0x33, 0xff
            ))
        );
    }

    /// Inner and outer strokes are offsetting decisions kurbo cannot express. Drawing them
    /// centred would put paint visibly in the wrong place — worse than drawing nothing, because
    /// it reads as a rendering bug rather than a missing feature.
    #[test]
    fn inner_and_outer_strokes_are_dropped_not_centred() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        add_shape_inner_stroke(4.0, 0, 0, 0);
        add_shape_outer_stroke(4.0, 0, 0, 0);
        assert!(current_scene().get(1).unwrap().strokes.is_empty());

        add_shape_center_stroke(4.0, 0, 0, 0);
        assert_eq!(current_scene().get(1).unwrap().strokes.len(), 1);
    }

    /// `add_shape_stroke_fill`, `set_shape_stroke_props` and `set_shape_stroke_dashes` all act
    /// on the *last* stroke. Getting that cursor wrong paints the second stroke's colour onto
    /// the first, which looks like a colour bug rather than an ordering one.
    #[test]
    fn stroke_refinements_apply_to_the_last_stroke() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        add_shape_center_stroke(2.0, 0, 0, 0);
        upload_solid_fill(0xff_ff_00_00);
        add_shape_stroke_fill();

        add_shape_center_stroke(8.0, 0, 0, 0);
        upload_solid_fill(0xff_00_ff_00);
        add_shape_stroke_fill();
        set_shape_stroke_props(2, -1, 3.5); // join = Bevel, cap unchanged, miter = 3.5

        let scene = current_scene();
        let strokes = &scene.get(1).unwrap().strokes;
        assert_eq!(strokes.len(), 2);
        assert_eq!(strokes[0].style.width, 2.0);
        assert_eq!(strokes[0].style.join, render_core::kurbo::Join::Miter);
        assert_eq!(strokes[1].style.join, render_core::kurbo::Join::Bevel);
        assert_eq!(strokes[1].style.miter_limit, 3.5);
        assert_eq!(
            strokes[0].brush,
            Brush::Solid(render_core::peniko::Color::from_rgba8(0xff, 0, 0, 0xff))
        );
    }

    /// `-1` means "leave unchanged"; reading it as an enum index would silently pick a join.
    #[test]
    fn negative_stroke_props_leave_the_style_alone() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        add_shape_center_stroke(2.0, 0, 6, 6);
        set_shape_stroke_props(1, 1, 9.0);
        set_shape_stroke_props(-1, -1, -1.0);

        let scene = current_scene();
        let stroke = &scene.get(1).unwrap().strokes[0];
        assert_eq!(stroke.style.join, render_core::kurbo::Join::Round);
        assert_eq!(stroke.style.start_cap, render_core::kurbo::Cap::Round);
        assert_eq!(stroke.style.miter_limit, 9.0);
    }

    /// The style constants live in render-core so both backends derive the same pattern.
    #[test]
    fn stroke_styles_become_dash_patterns() {
        let _guard = reset();

        let pattern_for = |style: u8, width: f32| {
            use_shape(0, 0, 0, 1);
            clear_shape_strokes();
            add_shape_center_stroke(width, style, 0, 0);
            current_scene().get(1).unwrap().strokes[0]
                .style
                .dash_pattern
                .to_vec()
        };

        assert!(pattern_for(0, 4.0).is_empty()); // Solid
        assert_eq!(pattern_for(2, 4.0), vec![14.0, 14.0]); // Dashed: width + 10
        assert_eq!(pattern_for(3, 4.0), vec![9.0, 9.0, 5.0, 9.0]); // Mixed
        assert_eq!(pattern_for(1, 4.0), vec![0.01, 8.99]); // Dotted: near-zero dash, round caps
    }

    #[test]
    fn custom_dashes_replace_the_style_pattern() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        add_shape_center_stroke(4.0, 2, 0, 0);

        let mut payload = Vec::new();
        for v in [3.0f32, 7.0] {
            payload.extend_from_slice(&v.to_le_bytes());
        }
        upload(&payload);
        set_shape_stroke_dashes();

        let scene = current_scene();
        assert_eq!(
            scene.get(1).unwrap().strokes[0].style.dash_pattern.to_vec(),
            vec![3.0, 7.0]
        );
    }

    #[test]
    fn clear_shape_strokes_empties_them() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        add_shape_center_stroke(4.0, 0, 0, 0);
        add_shape_center_stroke(2.0, 0, 0, 0);
        clear_shape_strokes();
        assert!(current_scene().get(1).unwrap().strokes.is_empty());
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
