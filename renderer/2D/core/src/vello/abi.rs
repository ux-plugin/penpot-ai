//! The C-style ABI, mirroring render-wasm's so the host drives both backends identically.
//!
//! D17: the Skia and Vello modules share one wire format and one calling convention. The host
//! reaches this through the `Module`-shaped facade in `zoetrope-editor`
//! (`vello-module-facade.ts`), which maps `Module._use_shape(…)` onto `exports.use_shape(…)`
//! and republishes `HEAPU8` over `exports.memory`. So `api/*.ts` drives this module unmodified.
//!
//! Two differences from render-wasm, both spelling rather than semantics:
//! - This crate is edition 2024, so exports are `#[unsafe(no_mangle)]` rather than
//!   `#[no_mangle]`. Copying a signature across without the wrap fails to compile.
//! - Decoding builds `crate::model` values instead of Skia-typed ones. Same bytes,
//!   different construction — that divergence is the point.
//!
//! The implicit current-shape cursor is inherited deliberately (D17, "accepted debt"): the
//! host's existing call sequence is proven, and matching it is what lets the two modules be
//! driven interchangeably. Explicit `upsert(id, payload)` is the Phase-3 target.

use std::sync::Mutex;

use crate::abi::decode_fill;
use crate::kurbo;
use crate::kurbo::{Affine, Rect};
use crate::model::{Node, Scene, ShapeKind};
use crate::peniko::Color;
use crate::text::{
    FontRef, TextAlign, TextBlock, TextDecoration, TextDirection, TextGrow, TextParagraph,
    TextSpan, TextTransform, VerticalAlign,
};

/// The shared byte buffer. The host allocates, writes through `HEAPU8`, then calls a no-arg
/// export that drains it — exactly render-wasm's protocol.
static BUFFER: Mutex<Option<Vec<u8>>> = Mutex::new(None);

static STATE: Mutex<Option<SceneState>> = Mutex::new(None);

pub use crate::host::{Modifiers, SceneState, Viewport};

fn with_state<R>(f: impl FnOnce(&mut SceneState) -> R) -> R {
    let mut guard = STATE.lock().expect("scene state poisoned");
    f(guard.get_or_insert_with(SceneState::default))
}

fn with_current<R>(f: impl FnOnce(&mut Node) -> R) -> Option<R> {
    crate::host::bump_scene_epoch();
    with_state(|state| {
        let id = state.current?;
        let before = state.shape_rect(id);
        let qt_before = state.leaf_rect(id);
        let out = state.scene.get_mut(id).map(f)?;
        let after = state.shape_rect(id);
        let qt_after = state.leaf_rect(id);
        if let Some(r) = before {
            state.mark_dirty(r);
        }
        if let Some(r) = after {
            state.mark_dirty(r);
        }
        state.note_leaf_moved(id, qt_before, qt_after);
        Some(out)
    })
}

/// Take the pending buffer, leaving it empty. Mirrors render-wasm's `mem::bytes()`.
pub fn take_bytes() -> Vec<u8> {
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
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn with_scene<R>(f: impl FnOnce(&Scene, Affine, &Modifiers) -> R) -> R {
    with_state(|state| {
        let transform = state.viewport.transform();
        f(&state.scene, transform, &state.modifiers)
    })
}

/// Build one frame's schedule for the given target tiles. On an incremental frame (`!dirty_all`) this
/// ensures the leaf spatial index is current and hands it to the builder, so a flat scene walks only
/// the shapes near the dirty region (O(k)) instead of every shape (O(n)). A `dirty_all` frame passes
/// no index and walks the whole tree, exactly as before. Centralised here because only the ABI shell
/// owns the `SceneState` that holds both the scene and the index.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn build_schedule(
    root: Affine,
    dirty_set: &std::collections::HashSet<crate::tiling::TileKey>,
    dirty_all: bool,
) -> crate::schedule::builder::Schedule {
    use crate::schedule::builder::{build_visible, buildprof, DirtyIndex};
    with_state(|state| {
        if !dirty_all {
            state.ensure_quadtree();
        }
        let view = root * state.viewport.transform();
        let index = if dirty_all {
            None
        } else {
            state.quadtree.as_ref().map(|qt| DirtyIndex {
                quadtree: qt,
                seq_of: &state.seq_of,
                flat: state.qt_flat,
            })
        };
        buildprof::set_clock(crate::vello::prof::now);
        buildprof::reset();
        let sched = build_visible(&state.scene, view, &state.modifiers, dirty_set, index);
        let (walk, gather, assemble) = buildprof::read();
        crate::vello::prof::dbg_add(20, walk);
        crate::vello::prof::dbg_add(21, gather);
        crate::vello::prof::dbg_add(22, assemble);
        sched
    })
}

/// Drain the dirty region accumulated since the last frame: `(dirty_all, page_rects)`. The tile cache
/// invalidates the tiles these rects cover (or everything when `dirty_all`), then rebuilds them.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn take_dirty() -> (bool, Vec<Rect>) {
    with_state(|state| {
        let all = std::mem::replace(&mut state.dirty_all, false);
        let rects = std::mem::take(&mut state.dirty_rects);
        (all, rects)
    })
}

/// The canvas clear colour the host set, if any.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn background() -> Color {
    with_state(|state| state.viewport.background)
}

/// The full page→device transform the draw pass will actually use for `root`, mirroring
/// `NeutralModelScene::render` exactly: the host viewport composes on top of the harness `root`
/// when a live scene is present, and is ignored for the demo fallback. The tile store needs this
/// (not the bare `root`) to place tiles, because when the host drives, `root` is identity and all
/// the pan/zoom lives in the viewport.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn effective_view(root: Affine) -> Affine {
    with_state(|state| {
        if state.scene.is_empty() {
            root
        } else {
            root * state.viewport.transform()
        }
    })
}

/// Whether the native **whole-viewport** path can render the current scene without silently dropping
/// an effect. Whole-viewport handles fills/strokes, box (`Rect`/`Frame`/`Circle`) drop+inner shadows,
/// non-box (path) drop shadows, layer blur (`node.blur`), groups/opacity/blend, clip, mask, and gathers
/// (glass / background blur / backdrop shaders). It does **not** yet handle: body/spread custom shaders
/// (filter graphs) or **non-box inset / text** shadows. If any visible node needs one of those, this
/// returns `false` and the caller must route the frame to the tiled scheduler, which renders every
/// effect correctly. This gate shrinks as each effect is brought native, and is removed at phase 5.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn whole_viewport_can_render() -> bool {
    fn node_ok(scene: &Scene, id: u128) -> bool {
        let Some(node) = scene.get(id) else { return true };
        if node.hidden {
            return true;
        }
        let needs_tiled = node.filter_graph.is_some();
        if needs_tiled {
            return false;
        }
        node.children.iter().all(|&c| node_ok(scene, c))
    }
    with_scene(|scene, _, _| scene.roots().iter().all(|&r| node_ok(scene, r)))
}

/// Whether a frame was requested since the last check, clearing the flag.
///
/// The Vello module does not own a frame loop — Phase 0 put that in the host deliberately
/// (D3), and render-wasm's own `render()` schedules rather than draws. So the C entry point
/// records the request and the host's `requestAnimationFrame` picks it up.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn take_needs_frame() -> bool {
    with_state(|state| std::mem::take(&mut state.needs_frame))
}

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

/// An image whose pixels have arrived but are not yet in the atlas.
pub struct PendingImage {
    pub id: u128,
    pub width: u32,
    pub height: u32,
    /// Straight (unpremultiplied) RGBA, row-major, top-left origin — exactly what `getImageData`
    /// yields. Premultiplied when the `Pixmap` is built, in Rust rather than in a JS pixel loop.
    pub rgba: Vec<u8>,
}

static PENDING_IMAGES: Mutex<Vec<PendingImage>> = Mutex::new(Vec::new());
static RESOLVED_IMAGES: Mutex<Option<std::collections::HashMap<u128, vello_common::paint::ImageId>>> =
    Mutex::new(None);

/// Stage one image's pixels for upload. Buffer layout: id (four LE `u32`), width and height
/// (`u32` each), then `width * height * 4` bytes of RGBA.
///
/// The host reaches this only for the Vello backend. render-wasm's image path hands over a WebGL
/// texture id, which is meaningless to wgpu — so the host decodes the `ImageBitmap` it already
/// holds back to RGBA and sends the pixels here instead. See the plan's image-fill decision.
#[unsafe(no_mangle)]
pub extern "C" fn store_image_rgba() {
    let bytes = take_bytes();
    let word = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    if bytes.len() < 24 {
        return;
    }
    let id = uuid_u128(word(0), word(4), word(8), word(12));
    let width = word(16);
    let height = word(20);
    let expected = 24 + (width as usize) * (height as usize) * 4;
    if bytes.len() < expected {
        return;
    }
    let rgba = bytes[24..expected].to_vec();

    PENDING_IMAGES
        .lock()
        .expect("pending images poisoned")
        .push(PendingImage {
            id,
            width,
            height,
            rgba,
        });
    with_state(|state| state.needs_frame = true);
}

/// Hand the renderer everything staged since the last call, leaving the queue empty.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn take_pending_images() -> Vec<PendingImage> {
    std::mem::take(&mut *PENDING_IMAGES.lock().expect("pending images poisoned"))
}

/// Record where an uploaded image landed, so `scene.rs` can resolve it.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn record_image(id: u128, image_id: vello_common::paint::ImageId) {
    RESOLVED_IMAGES
        .lock()
        .expect("resolved images poisoned")
        .get_or_insert_with(Default::default)
        .insert(id, image_id);
}

/// One published font face in the registry. The bytes are an Arc-backed [`peniko::Blob`], so
/// handing a face to a consumer is a refcount bump, never a copy.
#[derive(Clone)]
pub struct FontFace {
    /// The family alias to register under — see [`font_alias`]. The draw path builds
    /// the same alias from a span's [`crate::text::FontRef`], so the two meet by string.
    pub alias: String,
    pub bytes: peniko::Blob<u8>,
    /// A colour-emoji face. Registered like any other, but also wired into Parley's `Emoji`
    /// generic family so an emoji the primary font lacks falls through to it (glifo then draws its
    /// COLR/bitmap layers). Text never references it by name.
    pub is_emoji: bool,
}

/// The family name a face is registered under, and the name a span looks it up by. Internal to
/// render-vello: it only has to be consistent between [`store_font`] and the draw path, not match
/// render-wasm's Skia alias. Keyed by the family UUID plus weight and slant, so two weights of one
/// family are distinct faces — then Parley needs no weight matching, because each alias resolves to
/// exactly one face. Lives here (not in the wasm-only `scene`) so `store_font` can build it on
/// every target.
pub fn font_alias(id: u128, weight: u16, italic: bool) -> String {
    format!("penpot-{id:032x}-{weight}-{}", if italic { 'i' } else { 'n' })
}

/// The publish-once font registry: every face the host has ever uploaded, in upload order,
/// never removed. Consumers (each backend's Parley collection, text measurement, any renderer
/// created at any time) read it through [`fonts_since`] with their own cursor, so a face reaches
/// every consumer no matter how many exist or in what order they were created — the draining
/// queue this replaces lost faces to whichever single consumer synced first.
static FONT_REGISTRY: Mutex<Vec<FontFace>> = Mutex::new(Vec::new());
/// Aliases the host has ever uploaded, so `is_font_uploaded` can answer without re-sending and a
/// repeated `store_font` is a no-op. Deliberately *not* cleared by `clean_up`: a face is a device
/// resource that survives a page change, like the registered fonts in render-wasm's `FontStore`.
static KNOWN_FONTS: Mutex<std::collections::BTreeSet<String>> =
    Mutex::new(std::collections::BTreeSet::new());

/// Publish one font face into the registry. The bytes arrive through the shared heap buffer; the
/// identity comes as the family UUID (four LE `u32`), a CSS weight, and a style byte
/// (`0` normal, `1` italic), matching render-wasm's `store_font`. `is_emoji`/`is_fallback` are
/// accepted for wire compatibility but not acted on yet — emoji and fallback chaining are a later
/// slice, so those faces are simply stored like any other.
#[unsafe(no_mangle)]
pub extern "C" fn store_font(
    a: u32,
    b: u32,
    c: u32,
    d: u32,
    weight: u32,
    style: u8,
    is_emoji: bool,
    _is_fallback: bool,
) {
    let bytes = take_bytes();
    if bytes.is_empty() {
        return;
    }
    let alias = font_alias(uuid_u128(a, b, c, d), weight as u16, style == 1);
    if !KNOWN_FONTS
        .lock()
        .expect("known fonts poisoned")
        .insert(alias.clone())
    {
        return;
    }
    FONT_REGISTRY.lock().expect("font registry poisoned").push(FontFace {
        alias,
        bytes: peniko::Blob::new(std::sync::Arc::new(bytes)),
        is_emoji,
    });
    with_state(|state| state.needs_frame = true);
}

/// The implicit current-shape cursor (set by `use_shape`), so entry points that operate "on the
/// current shape" outside this module — text measurement — can read it.
pub fn current_shape() -> Option<u128> {
    with_state(|state| state.current)
}

/// Whether an image's pixels are already staged or resolved, so the host can skip re-fetching them.
/// Mirrors render-wasm's `is_image_cached`; the thumbnail flag is part of the wire signature but
/// both resolutions share one cache entry here.
#[unsafe(no_mangle)]
pub extern "C" fn is_image_cached(a: u32, b: u32, c: u32, d: u32, _thumbnail: bool) -> bool {
    let id = uuid_u128(a, b, c, d);
    if resolve_image(id).is_some() {
        return true;
    }
    PENDING_IMAGES
        .lock()
        .expect("pending images poisoned")
        .iter()
        .any(|img| img.id == id)
}

/// Whether a face is already uploaded, so the host can skip re-sending its bytes. Mirrors
/// render-wasm's `is_font_uploaded`. `is_emoji` is part of the wire signature but not the alias
/// yet (see `store_font`).
#[unsafe(no_mangle)]
pub extern "C" fn is_font_uploaded(
    a: u32,
    b: u32,
    c: u32,
    d: u32,
    weight: u32,
    style: u8,
    _is_emoji: bool,
) -> bool {
    let alias = font_alias(uuid_u128(a, b, c, d), weight as u16, style == 1);
    KNOWN_FONTS
        .lock()
        .expect("known fonts poisoned")
        .contains(&alias)
}

/// Every face published since the consumer's last call, advancing its cursor to the end of the
/// registry. Reading never removes: each consumer owns a cursor (starting at 0, so a consumer
/// created after uploads still receives everything) and the returned faces share their bytes with
/// the registry via [`peniko::Blob`]. The registry is append-only, so a cursor is always valid.
pub fn fonts_since(cursor: &mut usize) -> Vec<FontFace> {
    let registry = FONT_REGISTRY.lock().expect("font registry poisoned");
    let fresh = registry[(*cursor).min(registry.len())..].to_vec();
    *cursor = registry.len();
    fresh
}

/// Publish the embedded parity font (idempotent) so the parity fixture's **text** cell resolves in
/// a bare harness that never calls [`store_font`] (e.g. bench.html). It registers the bundled
/// Roboto under exactly the alias the fixture's `FontRef { PARITY_FONT_ID, 400, normal }` resolves
/// to; consumers pick it up on their next `sync_fonts`. Real hosts upload their own faces and
/// never call this.
pub fn stage_parity_font() {
    const PARITY_FONT_BYTES: &[u8] =
        include_bytes!("../../../vello/examples/assets/roboto/Roboto-Regular.ttf");
    let alias = font_alias(crate::parity::PARITY_FONT_ID, 400, false);
    if !KNOWN_FONTS
        .lock()
        .expect("known fonts poisoned")
        .insert(alias.clone())
    {
        return;
    }
    FONT_REGISTRY.lock().expect("font registry poisoned").push(FontFace {
        alias,
        bytes: peniko::Blob::new(std::sync::Arc::new(PARITY_FONT_BYTES)),
        is_emoji: false,
    });
    with_state(|state| state.needs_frame = true);
}

/// Size of `RawParagraphData` (`span_count: u32`, four align/dir/decoration/transform bytes,
/// `line_height: f32`, `letter_spacing: f32`). `#[repr(C, align(4))]`, so exactly 16.
const RAW_PARAGRAPH_DATA_SIZE: usize = 16;
/// The fixed attribute header of a `RawTextSpan`, before its fill array — 64 bytes.
const RAW_SPAN_HEADER_SIZE: usize = 64;
/// A `RawTextSpan` is its header plus a fixed array of eight fill records. `MAX_TEXT_FILLS == 8`.
const RAW_SPAN_DATA_SIZE: usize = RAW_SPAN_HEADER_SIZE + 8 * crate::abi::RAW_FILL_DATA_SIZE;

#[inline]
fn le_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

#[inline]
fn le_f32(bytes: &[u8], offset: usize) -> f32 {
    f32::from_bits(le_u32(bytes, offset))
}

/// Decode one paragraph from the wire buffer into a neutral [`TextParagraph`], or `None` if the
/// buffer is too short for what its header claims (a truncated stream is dropped, not guessed).
fn parse_paragraph(bytes: &[u8]) -> Option<TextParagraph> {
    if bytes.len() < RAW_PARAGRAPH_DATA_SIZE {
        return None;
    }
    let span_count = le_u32(bytes, 0) as usize;
    let align = TextAlign::from_wire(bytes[4]);
    let direction = TextDirection::from_wire(bytes[5]);
    let para_line_height = le_f32(bytes, 8);
    let para_letter_spacing = le_f32(bytes, 12);

    let spans_end = RAW_PARAGRAPH_DATA_SIZE + span_count.checked_mul(RAW_SPAN_DATA_SIZE)?;
    if bytes.len() < spans_end {
        return None;
    }

    let mut text_offset = spans_end;
    let mut spans = Vec::with_capacity(span_count);
    for i in 0..span_count {
        let base = RAW_PARAGRAPH_DATA_SIZE + i * RAW_SPAN_DATA_SIZE;
        let span = &bytes[base..base + RAW_SPAN_DATA_SIZE];

        let italic = span[0] == 1;
        let font_size = le_f32(span, 4);
        let line_height = le_f32(span, 8);
        let letter_spacing = le_f32(span, 12);
        let font_weight = le_u32(span, 16);
        let font_id = uuid_u128(
            le_u32(span, 20),
            le_u32(span, 24),
            le_u32(span, 28),
            le_u32(span, 32),
        );
        let text_length = le_u32(span, 56) as usize;
        let decoration = TextDecoration::from_wire(span[1]);
        let transform = TextTransform::from_wire(span[2]);

        let fill_count = le_u32(span, 60) as usize;
        let fills = span
            .get(RAW_SPAN_HEADER_SIZE..)
            .map(|body| {
                body.chunks_exact(crate::abi::RAW_FILL_DATA_SIZE)
                    .take(fill_count)
                    .filter_map(|chunk| decode_fill(chunk).ok())
                    .filter_map(paint_from_raw)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let text = bytes
            .get(text_offset..text_offset + text_length)
            .map(|slice| String::from_utf8_lossy(slice).into_owned())
            .unwrap_or_default();
        text_offset += text_length;

        spans.push(TextSpan {
            text,
            font: FontRef {
                id: font_id,
                weight: font_weight as u16,
                italic,
            },
            size: font_size,
            line_height,
            letter_spacing,
            fills,
            decoration,
            transform,
        });
    }

    Some(TextParagraph {
        align,
        direction,
        line_height: para_line_height,
        letter_spacing: para_letter_spacing,
        spans,
    })
}

/// Get the current node's text block, creating an empty one if needed so `grow`/`vertical_align`
/// can be set before any content arrives.
fn with_text<R>(f: impl FnOnce(&mut TextBlock) -> R) -> Option<R> {
    with_current(|node| {
        let block = node.text.get_or_insert_with(|| TextBlock {
            paragraphs: Vec::new(),
            grow: TextGrow::Fixed,
            vertical_align: VerticalAlign::Top,
        });
        f(block)
    })
}

/// Append one paragraph. The host calls this once per paragraph after `clear_shape_text`.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_text_content() {
    let bytes = take_bytes();
    let Some(paragraph) = parse_paragraph(&bytes) else {
        return;
    };
    with_text(|block| block.paragraphs.push(paragraph));
}

/// Drop the accumulated paragraphs, keeping `grow`/`vertical_align` — the host clears before
/// re-sending content, and those two arrive through their own setters.
#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_text() {
    with_current(|node| {
        if let Some(block) = node.text.as_mut() {
            block.paragraphs.clear();
        }
    });
}

/// How the text box sizes to its content: `0` fixed, `1` auto-width, `2` auto-height.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_grow_type(grow_type: u8) {
    with_text(|block| block.grow = TextGrow::from_wire(grow_type));
}

/// Vertical placement of the block in its box: `0` top, `1` centre, `2` bottom.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_vertical_align(align: u8) {
    with_text(|block| block.vertical_align = VerticalAlign::from_wire(align));
}

/// The atlas slot for an image, if it has been uploaded.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn resolve_image(id: u128) -> Option<vello_common::paint::ImageId> {
    RESOLVED_IMAGES
        .lock()
        .expect("resolved images poisoned")
        .as_ref()
        .and_then(|m| m.get(&id).copied())
}

/// Side of the square tile each diamond is baked into (re-exported from render-core, where the draw
/// path also keys off it). 512² keeps a smooth ramp crisp at normal zoom; the tradeoff is softness
/// far in, which is the documented cost of baking rather than a live shader.
pub use crate::gradient::DIAMOND_TILE;

/// Bake any reachable diamond gradient that has not been baked yet, staging it as an image.
///
/// A diamond has no peniko kind, so it is drawn by rasterising its L1 field to a tile and
/// sampling it through the image atlas. This runs in the renderer's pre-pass, *before*
/// `take_pending_images`, so the bakes ride the same upload path as real images — keyed by
/// [`DiamondGradient::content_key`], so an unchanged diamond is baked once and reused.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn stage_diamond_bakes() {
    if !with_state(|state| std::mem::replace(&mut state.diamonds_dirty, false)) {
        return;
    }
    let diamonds = with_state(|state| state.scene.diamonds());
    if diamonds.is_empty() {
        return;
    }
    let mut seen = std::collections::HashSet::new();
    for d in diamonds {
        let key = d.content_key();
        if !seen.insert(key) {
            continue;
        }
        if resolve_image(key).is_some() {
            continue;
        }
        let already_pending = PENDING_IMAGES
            .lock()
            .expect("pending images poisoned")
            .iter()
            .any(|p| p.id == key);
        if already_pending {
            continue;
        }
        let stops: Vec<_> = d.stops.iter().copied().collect();
        let Some(rgba) = crate::gradient::bake_diamond_rgba(d.geometry, &stops, DIAMOND_TILE)
        else {
            continue;
        };
        PENDING_IMAGES
            .lock()
            .expect("pending images poisoned")
            .push(PendingImage {
                id: key,
                width: DIAMOND_TILE,
                height: DIAMOND_TILE,
                rgba,
            });
    }
}

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

thread_local! {
    /// Diagnostic toggle: when set, the renderer draws the whole scene in one pass instead of
    /// per-tile, so a rendering artifact can be attributed to (or cleared of) the tiling buffer
    /// path. Not part of the product ABI — a bring-up aid driven from the tiling harness.
    static TILING_BYPASS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[unsafe(no_mangle)]
pub extern "C" fn set_tiling_bypass(on: u32) {
    TILING_BYPASS.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn tiling_bypass() -> bool {
    TILING_BYPASS.with(std::cell::Cell::get)
}

thread_local! {
    /// Diagnostic: when set, effects are *not* gated off while tiling, so the harness can measure
    /// whether spatially-spreading effects (blur/shadow) still seam per-tile now that the
    /// submit-per-tile corruption is fixed. Default off (effects gated) — the current shipping
    /// behaviour. The tile grid is 512-aligned in device space, so a shape rendered into two
    /// adjacent tile buffers is shifted by exactly 512 px (an integer at every decimation level a
    /// capped σ reaches), which *should* make the fork's pyramid blur agree at the seam — this
    /// toggle is how that hypothesis gets a pixel test before any per-shape-surface machinery.
    static TILE_EFFECTS: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

#[unsafe(no_mangle)]
pub extern "C" fn set_tile_effects(on: u32) {
    TILE_EFFECTS.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn tile_effects() -> bool {
    TILE_EFFECTS.with(std::cell::Cell::get)
}

thread_local! {
    /// Route rendering through the render-core schedule + GPU production sink (the "one pipeline"
    /// scheduler) instead of the whole-scene-per-tile bypass. Default ON — this is the production
    /// path; `set_scheduler(0)` remains only for bring-up style bypass comparisons.
    static SCHEDULER: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

#[unsafe(no_mangle)]
pub extern "C" fn set_scheduler(on: u32) {
    SCHEDULER.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn scheduler() -> bool {
    SCHEDULER.with(std::cell::Cell::get)
}

thread_local! {
    /// How many sink steps share one command encoder before it is submitted. Bounds peak GPU memory
    /// (wgpu holds every resource an unsubmitted encoder references), while collapsing the ~1
    /// submit-per-step into ~steps/BATCH. Runtime-tunable so the bench can prove the memory effect by
    /// sweeping it — a large value reproduces the one-encoder-per-frame blow-up, 32 is the shipping
    /// default. `0` is treated as "unbounded" (whole frame in one encoder).
    static SINK_BATCH: std::cell::Cell<u32> = const { std::cell::Cell::new(32) };
}

/// Set the sink's submit-batch size (steps per encoder). `0` = unbounded.
#[unsafe(no_mangle)]
pub extern "C" fn set_sink_batch(n: u32) {
    SINK_BATCH.with(|c| c.set(n));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn sink_batch() -> u32 {
    SINK_BATCH.with(std::cell::Cell::get)
}

thread_local! {
    /// Whether the batched background-blur gather collapse is on. It was default-OFF for a while:
    /// the atlas composed each lens's backdrop with an *unclipped* tile blit, so a tile overhanging
    /// the lens's sample rect spilled into the neighbouring cell and the lens blurred another
    /// region's content (~50/255 against a linear-light Gaussian of the true backdrop, vs 1.2 for
    /// the inline path). Only 2+ deferrable lenses batch (`GATHER_MIN`), which is why every
    /// single-lens test passed — those silently ran inline. With the clip in place the collapse is
    /// **bit-identical** to the inline path on the bench's 25-lens idle and editMulti frames, so it
    /// ships on; the flag stays as the A/B baseline.
    static GATHER_BATCH: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

thread_local! {
    /// DEBUG: which batched-gather atlas to blit over the swapchain — 0 off, 1 backdrop, 2 blurred,
    /// 3 mask. Lets the atlas intermediates be inspected directly instead of inferred.
    static DEBUG_ATLAS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

thread_local! {
    /// Which stages of the batched gather actually run, as a bit mask — `1` compose the backdrop
    /// atlas, `2` blur it, `4` rasterize the mask atlas, `8` scatter into the tiles. All on by
    /// default. Turning one off leaves the rest running on whatever the previous stage left behind,
    /// which is visually wrong but timing-valid: it is how the frame cost is attributed to a stage
    /// without needing GPU timestamp queries.
    static GATHER_STAGES: std::cell::Cell<u32> = const { std::cell::Cell::new(0xF) };
}

/// Ablate stages of the batched gather to attribute its GPU cost. `0xF` = normal rendering.
#[unsafe(no_mangle)]
pub extern "C" fn set_gather_stages(mask: u32) {
    GATHER_STAGES.with(|c| c.set(mask));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn gather_stages() -> u32 {
    GATHER_STAGES.with(std::cell::Cell::get)
}

/// Select which gather atlas to draw over the frame (0 = off).
#[unsafe(no_mangle)]
pub extern "C" fn set_debug_atlas(which: u32) {
    DEBUG_ATLAS.with(|c| c.set(which));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn debug_atlas() -> u32 {
    DEBUG_ATLAS.with(std::cell::Cell::get)
}

/// Enable/disable the batched gather collapse. `0` forces the inline path (the A/B baseline).
#[unsafe(no_mangle)]
pub extern "C" fn set_gather_batch(on: u32) {
    GATHER_BATCH.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn gather_batch() -> bool {
    GATHER_BATCH.with(std::cell::Cell::get)
}

thread_local! {
    /// Let `atlas_fuse` fuse a spread tile even when an **inline** gather touches it, as long as the
    /// gather is topmost for that tile (no fusible content painted above it). Off by default: a
    /// single inline gather currently disqualifies its tiles wholesale, which shatters every shadowed
    /// tile into a rasterize per composite (measured 176 renders vs 2 for the same scene without the
    /// gather). With it on, only a tile with fusible content *above* the gather is disqualified — the
    /// gather runs in the main loop reading the fused result, identical pixels, far fewer rasters.
    static FUSE_GATHERS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[unsafe(no_mangle)]
pub extern "C" fn set_fuse_gathers(on: u32) {
    FUSE_GATHERS.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn fuse_gathers() -> bool {
    FUSE_GATHERS.with(std::cell::Cell::get)
}

thread_local! {
    /// TEST knob: force `atlas_fuse` to handle nothing, sending every tile through the per-paint main
    /// loop instead. This is the A/B substrate for fuse correctness — the fused frame must be
    /// pixel-identical to the `no_fuse` frame. Kept (not debug-only) so the tile-fuse can be regressed
    /// against the main-loop path whenever it changes. Default off (fuse runs normally).
    static NO_FUSE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[unsafe(no_mangle)]
pub extern "C" fn set_no_fuse(on: u32) {
    NO_FUSE.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn no_fuse() -> bool {
    NO_FUSE.with(std::cell::Cell::get)
}

/// A/B lever for the flat (GPU-walk-oracle) scheduler path vs the recursive `visit` walk. Default on;
/// `set_flat_walk(0)` forces `visit` so the bench can time flat-vs-recursive `build`.
#[unsafe(no_mangle)]
pub extern "C" fn set_flat_walk(on: u32) {
    crate::schedule::flatten::set_flat_walk(on != 0);
}

/// Diagnostic: how many builds took the flat (linearised) walk since start. `0` ⇒ every build fell
/// back to `visit` — the scene was never eligible. Lets the bench confirm a nested-group stress scene
/// actually engages the flat path.
#[unsafe(no_mangle)]
pub extern "C" fn flat_walk_used_count() -> u32 {
    crate::schedule::flatten::flat_walk_used()
}

thread_local! {
    /// Whole-viewport render path: bypass the 512-tile schedule and draw the whole document into ONE
    /// vello scene (its own native internal tiling), rasterized via `render_full`, phasing at top-level
    /// gather roots for background-blur/glass. This is the **default for the classic (WebGPU) backend**
    /// — it has no 512-tile boundaries, so it cannot produce the tile-row/column seams the tiled path
    /// does, and it maxes out the compute GPU. The tiled schedule stays the WebGL2/coarse *hybrid*
    /// backend's path (which never reads this flag). `set_whole_viewport(0)` forces classic back onto
    /// the tiled path for A/B comparison. Handles native effects, layer blur, filter graphs and gathers
    /// (an earlier revision of this note predated the gather-phasing + layer-blur support).
    static WHOLE_VIEWPORT: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };
}

#[unsafe(no_mangle)]
pub extern "C" fn set_whole_viewport(on: u32) {
    WHOLE_VIEWPORT.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn whole_viewport() -> bool {
    WHOLE_VIEWPORT.with(std::cell::Cell::get)
}

thread_local! {
    /// Bbox-scope each gather's effect: run its passes over the lens's device bounding box (expanded
    /// by the blur reach) instead of the full viewport, then stamp the small result back through the
    /// shape silhouette. Glass + background blur (bounded reach); custom shaders sample anywhere so they
    /// stay full-viewport. DEFAULT ON — it is the gather cost fix; `set_wv_scope(0)` forces the old
    /// full-viewport effect for A/B.
    static WV_SCOPE: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };

    /// Whole-viewport atlas prepass gate — see [`set_wv_atlas`]. Default on.
    static WV_ATLAS: std::cell::Cell<bool> = const { std::cell::Cell::new(true) };



    /// Per-pass GPU profiling: stamp a timestamp boundary between each effect-graph pass (glass
    /// displacement / refraction / blur / composite) so the host can read the GPU ms of each
    /// individual dispatch out of the DBG buckets. Default off — it adds empty boundary passes and
    /// is a diagnostic, not a shipping path.
    static PROF_PASSES: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };

    /// Present-on-demand: when set, the whole-viewport path retains the composited frame in a
    /// persistent canvas texture and, when nothing changed (no `mark_dirty` and the view is
    /// unchanged), skips the whole render and just re-presents the retained canvas. Default off.
    static PRESENT_ON_DEMAND: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };

    /// Zoom/pan proxy: when set (and present-on-demand is on), a view-change frame first blits the
    /// retained canvas transformed by the relative view delta — an instant, cheap proxy — before the
    /// real render replaces it. Default off.
    static ZOOM_PROXY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[unsafe(no_mangle)]
pub extern "C" fn set_prof_passes(on: u32) {
    PROF_PASSES.with(|c| c.set(on != 0));
}

#[unsafe(no_mangle)]
pub extern "C" fn set_present_on_demand(on: u32) {
    PRESENT_ON_DEMAND.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn present_on_demand() -> bool {
    PRESENT_ON_DEMAND.with(std::cell::Cell::get)
}

/// Flag the whole next frame as needing a real render. Content edits already mark themselves dirty
/// through `with_current`; this is the escape hatch for the host to force a render (or for the bench
/// to drive a dirty-every-frame A/B), reusing the same `dirty_all` state `take_dirty` drains.
#[unsafe(no_mangle)]
pub extern "C" fn mark_dirty() {
    with_state(|state| state.dirty_all = true);
}

#[unsafe(no_mangle)]
pub extern "C" fn set_zoom_proxy(on: u32) {
    ZOOM_PROXY.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn zoom_proxy() -> bool {
    ZOOM_PROXY.with(std::cell::Cell::get)
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn prof_passes() -> bool {
    PROF_PASSES.with(std::cell::Cell::get)
}

#[unsafe(no_mangle)]
pub extern "C" fn set_wv_scope(on: u32) {
    WV_SCOPE.with(|c| c.set(on != 0));
}

/// Whole-viewport effect-surface atlas prepass gate. Default ON (one shared front-end for every
/// effect surface). `set_wv_atlas(0)` forces the per-node fallback front-ends — the A/B lever for
/// isolating atlas-specific rendering bugs (browser-only artifact hunts).
#[unsafe(no_mangle)]
pub extern "C" fn set_wv_atlas(on: u32) {
    WV_ATLAS.with(|c| c.set(on != 0));
}

#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn wv_atlas() -> bool {
    WV_ATLAS.with(std::cell::Cell::get)
}



#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn wv_scope() -> bool {
    WV_SCOPE.with(std::cell::Cell::get)
}

thread_local! {
    /// The most recent frame's tile counts, packed `(rendered << 16) | reused`. A machine-readable
    /// proof that the page-space cache reuses tiles across a pan (rendered ≈ the newly-exposed
    /// strip, reused ≈ the rest) and re-renders a full screen on a zoom. Read via `last_tile_stats`.
    static TILE_STATS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Record the last frame's tile render/reuse split (called by the tile store).
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub fn set_tile_stats(rendered: u32, reused: u32) {
    TILE_STATS.with(|c| c.set((rendered << 16) | (reused & 0xffff)));
}

/// The last frame's tile counts, packed `(rendered << 16) | reused`.
#[unsafe(no_mangle)]
pub extern "C" fn last_tile_stats() -> u32 {
    TILE_STATS.with(std::cell::Cell::get)
}

/// Zero the scheduler-sink phase profiler. Host calls this, renders K frames, then reads the
/// accumulated per-phase ms via `prof_read` and divides by K.
#[unsafe(no_mangle)]
pub extern "C" fn prof_reset() {
    crate::vello::prof::reset();
}

/// Read a profiler bucket: 0 build · 1 scene · 2 render · 3 submit · 4 tex (ms) · 5 steps · 6 texn.
#[unsafe(no_mangle)]
pub extern "C" fn prof_read(which: u32) -> f64 {
    crate::vello::prof::read(which)
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
    crate::host::bump_scene_epoch();
    with_state(|state| {
        state.scene.clear();
        state.current = None;
        state.dirty_all = true;
        state.invalidate_quadtree();
        state.diamonds_dirty = true;
        let Viewport {
            dpr, width, height, ..
        } = state.viewport;
        state.viewport = Viewport {
            dpr,
            width,
            height,
            ..Viewport::default()
        };
        state.needs_frame = false;
        state.modifiers.clear();
    });
    PENDING_IMAGES.lock().expect("pending images poisoned").clear();
    *RESOLVED_IMAGES.lock().expect("resolved images poisoned") = None;
}

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
/// 5 Text, 6 Circle, 7 SVGRaw. Anything this module cannot draw yet becomes `Unsupported`.
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
            3 => ShapeKind::Rect,
            4 => ShapeKind::Path,
            5 => ShapeKind::Text,
            6 => ShapeKind::Circle,
            _ => ShapeKind::Unsupported,
        };
    });
}

/// How this node composites against the backdrop.
///
/// `mode` is Penpot's `RawBlendMode` byte. The neutral value comes from
/// [`crate::blend::blend_from_raw`] — the same authority render-wasm's projection is pinned
/// to — so the two backends cannot disagree on what a given byte means. Without this entry point
/// the facade would stub the call to a no-op, leaving every blend at the default and silently
/// desyncing the digest the moment the host set one.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_blend_mode(mode: u8) {
    with_current(|node| node.blend = crate::blend::blend_from_raw(mode));
}

/// A blur on this shape. `blur_type` is Penpot's `RawBlurType` — `0` layer, `1` background;
/// `value` is a radius. A layer blur is a *spread* effect over the shape's own paint; a background
/// blur is a *gather* effect over the backdrop beneath. A hidden one clears its slot.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_blur(blur_type: u8, hidden: bool, value: f32) {
    let v = (!hidden).then_some(value);
    with_current(|node| match blur_type {
        1 => node.background_blur = v,
        _ => node.blur = v,
    });
}

/// Clear every blur — both the layer and the background slot.
#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_blur() {
    with_current(|node| {
        node.blur = None;
        node.background_blur = None;
    });
}

/// Clear one blur kind (`0` layer, `1` background), matching render-wasm's per-kind clear.
#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_blur_of_kind(blur_type: u8) {
    with_current(|node| match blur_type {
        1 => node.background_blur = None,
        _ => node.blur = None,
    });
}

/// The frosted-glass gather effect. Parameter order mirrors render-wasm's `set_shape_glass`; a
/// hidden glass clears the slot.
#[unsafe(no_mangle)]
#[expect(clippy::too_many_arguments, reason = "the wire signature mirrors render-wasm's setter")]
pub extern "C" fn set_shape_glass(
    surface_type: i32,
    bezel_width: f32,
    glass_thickness: f32,
    refractive_index: f32,
    specular_angle: f32,
    specular_opacity: f32,
    specular_saturation: f32,
    chromatic_aberration: f32,
    splay: f32,
    tilt_angle: f32,
    edge_boost: f32,
    zoom: f32,
    blur: f32,
    frost: f32,
    acceptable_downscale: f32,
    tile_mode: u32,
    hidden: u8,
) {
    let glass = (hidden == 0).then_some(crate::model::Glass {
        surface_type,
        bezel_width,
        thickness: glass_thickness,
        refractive_index,
        specular_angle,
        specular_opacity,
        specular_saturation,
        chromatic_aberration,
        splay,
        tilt_angle,
        edge_boost,
        zoom,
        blur,
        frost,
        acceptable_downscale: if acceptable_downscale > 0.0 { acceptable_downscale.min(1.0) } else { 1.0 },
        tile_mode: match tile_mode {
            2 => crate::model::TileMode::Black,
            1 => crate::model::TileMode::Clamp,
            _ => crate::model::TileMode::Decal,
        },
    });
    with_current(|node| node.glass = glass);
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_glass() {
    with_current(|node| node.glass = None);
}

/// A custom WGSL effect on this shape — the raw escape hatch. The staged byte buffer holds
/// `[nparams: u32 LE][nparams × f32 LE][wgsl UTF-8...]`; `reach` (the author-declared page-space
/// extent it samples) comes as a direct arg. `reads_backdrop` declares its class: non-zero → it
/// samples the backdrop beneath (a gather, resolution-capped); zero → it reads only the shape's own
/// body (a spread, like a layer blur). Pass non-zero for an opaque shader — the safe worst case.
/// `param_vec4s` is the exact `N` the shader declares in `@binding(0)`'s `array<vec4<f32>, N>`: the
/// backend sizes the uniform to exactly `N` vec4s (resolution + params, zero-filled), so however many
/// `params` are staged, the bound buffer always matches the shader — no size mismatch is possible.
/// `acceptable_downscale` is the effect's declared quality floor `k ∈ (0, 1]` — the fraction of device
/// resolution it may be rendered at before upscaling (`1.0` = full res, no downscale; `0.5` = half).
/// The shader must read the resolution uniform rather than assume full res; a value `≤ 0` is treated
/// as `1.0`. The effective scale is `min(resolution_cap, acceptable_downscale)`.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_custom_shader(reach: f32, reads_backdrop: u32, param_vec4s: u32, acceptable_downscale: f32) {
    let bytes = take_bytes();
    if bytes.len() < 4 {
        return;
    }
    let word = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let nparams = word(0) as usize;
    let params_end = 4 + nparams * 4;
    if bytes.len() < params_end {
        return;
    }
    let params: Vec<f32> = (0..nparams)
        .map(|i| {
            let o = 4 + i * 4;
            f32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]])
        })
        .collect();
    let wgsl = String::from_utf8_lossy(&bytes[params_end..]).into_owned();
    with_current(|node| {
        node.upsert_effect(
            crate::model::EffectSlot::Custom,
            crate::model::CustomShader {
                wgsl,
                reach,
                param_vec4s,
                params,
                reads_backdrop: reads_backdrop != 0,
                acceptable_downscale: if acceptable_downscale > 0.0 { acceptable_downscale.min(1.0) } else { 1.0 },
            },
        );
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_custom_shader() {
    with_current(|node| node.remove_effect(crate::model::EffectSlot::Custom));
}

/// **Texture** effect — a fractal-noise displacement warp of the shape's own body (fill included),
/// matching render-wasm's `set_shape_texture(noise_size, radius, clip_to_shape, hidden)`. Lowered to a
/// spread [`CustomShader`] with the built-in [`crate::vello::effects::TEXTURE_WGSL`]; a hidden / zero-radius
/// texture clears the slot.
///
/// Texture and noise are separate [`EffectSlot`]s in the node's ordered effect list, so a shape can
/// carry both and they **chain** in the order they were set (see [`set_shape_noise`] and the sink's
/// `custom_over_body`). Setting texture upserts its slot (updating in place on a param edit); a hidden
/// / zero-radius texture removes it.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_texture(noise_size: f32, radius: f32, clip_to_shape: u32, hidden: u32) {
    let shader = crate::vello::effects::texture_shader(noise_size, radius, clip_to_shape != 0, hidden != 0);
    with_current(|node| match shader {
        Some(s) => node.upsert_effect(crate::model::EffectSlot::Texture, s),
        None => node.remove_effect(crate::model::EffectSlot::Texture),
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_texture() {
    with_current(|node| node.remove_effect(crate::model::EffectSlot::Texture));
}

/// **Noise** effect — coloured fractal-noise grain composited over the shape's body, matching
/// render-wasm's `set_shape_noise(noise_size, density, softness, apply_to_fill, hidden)`. The slots are
/// staged in the byte buffer, laid out exactly like render-wasm's writer:
///   `[u32 count][u8 kind_0..kind_{n-1}][pad to 4B][u32 rgba_0][u32 rgba_1]…` (each color 0xAARRGGBB LE).
/// Lowered to a spread [`CustomShader`] in the [`EffectSlot::Noise`](crate::model::EffectSlot)
/// slot with the built-in [`crate::vello::effects::NOISE_WGSL`]; a hidden / slotless noise removes it. Because
/// it is its own slot, noise composes with texture — the order the two were set is the chain order.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_noise(noise_size: f32, density: f32, softness: f32, apply_to_fill: u32, hidden: u32) {
    let bytes = take_bytes();
    let count = if bytes.len() >= 4 {
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize
    } else {
        0
    }
    .min(crate::vello::effects::MAX_NOISE_SLOTS);

    let colors_offset = 4 + ((count + 3) & !3);
    let mut slots: Vec<crate::vello::effects::NoiseSlot> = Vec::with_capacity(count);
    for i in 0..count {
        let kind = bytes.get(4 + i).copied().unwrap_or(0);
        let off = colors_offset + i * 4;
        if off + 4 > bytes.len() {
            break;
        }
        let rgba = [
            f32::from(bytes[off + 2]) / 255.0,
            f32::from(bytes[off + 1]) / 255.0,
            f32::from(bytes[off]) / 255.0,
            f32::from(bytes[off + 3]) / 255.0,
        ];
        slots.push(crate::vello::effects::NoiseSlot { kind, rgba });
    }

    let shader = crate::vello::effects::noise_shader(&slots, noise_size, density, softness, apply_to_fill != 0, hidden != 0);
    with_current(|node| match shader {
        Some(s) => node.upsert_effect(crate::model::EffectSlot::Noise, s),
        None => node.remove_effect(crate::model::EffectSlot::Noise),
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_noise() {
    with_current(|node| node.remove_effect(crate::model::EffectSlot::Noise));
}

/// Append a shadow. `raw_style` is Penpot's `RawShadowStyle` — `0` drop, `1` inner; `blur` is a
/// radius, `(x, y)` the offset. Both drop and inner (inset) shadows are carried now that the fork
/// draws inner shadows; only *hidden* shadows are dropped, matching `model_export`.
#[unsafe(no_mangle)]
pub extern "C" fn add_shape_shadow(
    raw_color: u32,
    blur: f32,
    spread: f32,
    x: f32,
    y: f32,
    raw_style: u8,
    hidden: bool,
) {
    if hidden {
        return;
    }
    with_current(|node| {
        node.shadows.push(crate::model::Shadow {
            color: argb_to_color(raw_color),
            blur,
            spread,
            offset: crate::kurbo::Vec2::new(f64::from(x), f64::from(y)),
            inset: raw_style == 1,
        });
    });
}

/// Drop every shadow on this shape.
#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_shadows() {
    with_current(|node| node.shadows.clear());
}

/// Set this shape's filter graph — a chain of custom passes, drawn Vello-only as nested filter
/// layers. The graph is read from the shared byte buffer (host `alloc_bytes` + writes it first) as a
/// little-endian stream:
///
/// ```text
/// [u32 node_count]
/// per node: [u32 tag]
///   tag 0 Blur:   [f32 sigma]
///   tag 1 Offset: [f32 dx][f32 dy]
///   tag 2 Custom: [u32 effect][u32 param_count][f32 × param_count]
/// ```
///
/// A malformed stream or zero nodes clears the graph, so a truncated write never leaves a
/// half-decoded chain applied.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_filter_graph() {
    let graph = parse_filter_graph(&take_bytes());
    with_current(|node| node.filter_graph = graph);
}

/// Remove any filter graph from this shape.
#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_filter_graph() {
    with_current(|node| node.filter_graph = None);
}

/// Decode the filter-graph wire stream. Returns `None` on any truncation or unknown tag, and on an
/// empty chain — the node carries `Option`, so "no graph" and "empty graph" are the same thing.
fn parse_filter_graph(bytes: &[u8]) -> Option<crate::model::FilterGraph> {
    use crate::model::{FilterGraph, FilterNode};

    let mut cur = 0usize;
    let u32_at = |cur: &mut usize| -> Option<u32> {
        let c = bytes.get(*cur..*cur + 4)?;
        *cur += 4;
        Some(u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
    };
    let f32_at = |cur: &mut usize| -> Option<f32> {
        let c = bytes.get(*cur..*cur + 4)?;
        *cur += 4;
        Some(f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
    };

    let count = u32_at(&mut cur)? as usize;
    let mut nodes = Vec::with_capacity(count);
    for _ in 0..count {
        let node = match u32_at(&mut cur)? {
            0 => FilterNode::Blur { sigma: f32_at(&mut cur)? },
            1 => FilterNode::Offset { dx: f32_at(&mut cur)?, dy: f32_at(&mut cur)? },
            3 => FilterNode::InnerShadow {
                dx: f32_at(&mut cur)?,
                dy: f32_at(&mut cur)?,
                sigma: f32_at(&mut cur)?,
                color: argb_to_color(u32_at(&mut cur)?),
            },
            2 => {
                let effect = u32_at(&mut cur)?;
                let param_count = u32_at(&mut cur)? as usize;
                let mut params = Vec::with_capacity(param_count);
                for _ in 0..param_count {
                    params.push(f32_at(&mut cur)?);
                }
                FilterNode::Shader { effect, params }
            }
            _ => return None,
        };
        nodes.push(node);
    }
    (!nodes.is_empty()).then_some(FilterGraph { nodes })
}

/// Whether this node clips its children to its own geometry.
///
/// Projected verbatim, with no type check: render-wasm gates only on this flag, and it is the
/// host that decides only frames and slots may clip.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_clip_content(clip_content: bool) {
    with_current(|node| node.clip = clip_content);
}

/// Mark this node a masked group: its first child becomes a mask over the rest.
///
/// The host only calls this for groups; the flag is stored on whatever node is current, exactly
/// as render-wasm's `set_shape_masked_group` does. Without this export the facade would stub the
/// call to a silent no-op, so a masked group would reach Vello as a plain one and the digest would
/// disagree with render-wasm's projection.
#[unsafe(no_mangle)]
pub extern "C" fn set_shape_masked_group(masked: bool) {
    with_current(|node| node.masked = masked);
}

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
    let corners = crate::model::corners_from_raw(r1, r2, r3, r4);
    with_current(|node| node.corners = corners);
}

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
    let Ok(segments) = crate::abi::decode_path(bytes) else {
        return;
    };
    let path = crate::model::bez_path_from_raw(&segments);
    with_current(|node| {
        if node.kind == ShapeKind::Path {
            node.path = Some(path);
        }
    });
}

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
            body.chunks_exact(crate::abi::RAW_FILL_DATA_SIZE)
                .take(count)
                .filter_map(|chunk| decode_fill(chunk).ok())
                .filter_map(paint_from_raw)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    with_current(|node| node.fills = fills);
    with_state(|state| state.diamonds_dirty = true);
}

#[unsafe(no_mangle)]
pub extern "C" fn clear_shape_fills() {
    with_current(|node| node.fills.clear());
    with_state(|state| state.diamonds_dirty = true);
}

/// Raw fill payload to a peniko brush. The Vello counterpart of render-wasm's
/// `From<RawFillData> for shapes::Fill` — same input, different construction.
fn paint_from_raw(raw: crate::abi::RawFillData) -> Option<crate::model::Paint> {
    use crate::abi::RawFillData as R;
    use crate::gradient::{GradientGeometry, GradientShape, gradient_paint};
    use crate::model::{Brush, ImageFill, Paint};
    use crate::peniko::ColorStop;

    let stops = |g: &crate::abi::RawGradientData| {
        g.active_stops()
            .iter()
            .map(|s| ColorStop {
                offset: s.offset,
                color: argb_to_color(s.color).into(),
            })
            .collect::<Vec<_>>()
    };
    let geometry = |g: &crate::abi::RawGradientData| GradientGeometry {
        start: g.start(),
        end: g.end(),
        width: (g.width_x, g.width_y),
    };
    let gradient = |shape: GradientShape, g: &crate::abi::RawGradientData| {
        gradient_paint(shape, geometry(g), &stops(g)[..]).map(|(gradient, transform)| Paint {
            brush: Brush::Gradient(gradient),
            transform,
        })
    };

    match raw {
        R::Solid(s) => Some(Paint::plain(Brush::Solid(argb_to_color(s.color)))),
        R::Linear(g) => gradient(GradientShape::Linear, &g),
        R::Radial(g) => gradient(GradientShape::Radial, &g),
        R::Angular(g) => gradient(GradientShape::Angular, &g),
        R::Diamond(g) => Some(Paint::plain(Brush::Diamond(crate::model::DiamondGradient {
            geometry: geometry(&g),
            stops: stops(&g)[..].into(),
        }))),
        R::Image(i) => Some(Paint::plain(Brush::Image(ImageFill {
            id: uuid_u128(i.a, i.b, i.c, i.d),
            width: i.width.max(0) as u32,
            height: i.height.max(0) as u32,
            opacity: i.opacity,
            keep_aspect: i.keep_aspect_ratio(),
            dest: i.dest().map(|[l, t, r, b]| {
                crate::kurbo::Rect::new(f64::from(l), f64::from(t), f64::from(r), f64::from(b))
            }),
        }))),
    }
}

/// The wire carries packed ARGB, matching Skia's word order.
#[inline]
pub fn argb_to_color(argb: u32) -> crate::peniko::Color {
    crate::peniko::Color::from_rgba8(
        ((argb >> 16) & 0xff) as u8,
        ((argb >> 8) & 0xff) as u8,
        (argb & 0xff) as u8,
        ((argb >> 24) & 0xff) as u8,
    )
}

#[inline]
pub fn uuid_u128(a: u32, b: u32, c: u32, d: u32) -> u128 {
    ((a as u128) << 96) | ((b as u128) << 64) | ((c as u128) << 32) | (d as u128)
}

/// Split a packed id back into the wire's `(a, b, c, d)` quartet — the inverse of [`uuid_u128`].
pub fn uuid_to_quartet(id: u128) -> (u32, u32, u32, u32) {
    (
        (id >> 96) as u32,
        (id >> 64) as u32,
        (id >> 32) as u32,
        id as u32,
    )
}

/// Ask the host's frame loop to draw again — the editor's caret blink and selection changes are
/// only visible once a frame runs (the render pass owns the font context, so it is where the
/// editor's layout and geometry are computed).
pub fn request_frame() {
    with_state(|state| state.needs_frame = true);
}

/// Build a kurbo stroke from the wire parameters, shared by all three alignment entry points.
fn build_wire_stroke(width: f32, style: u8, cap_start: u8, cap_end: u8) -> crate::kurbo::Stroke {
    let mut kstroke = crate::kurbo::Stroke::new(f64::from(width))
        .with_join(crate::kurbo::Join::Miter)
        .with_caps(crate::kurbo::Cap::Butt);
    if let Some(cap) = cap_from_wire(cap_start) {
        kstroke.start_cap = cap;
    }
    if let Some(cap) = cap_from_wire(cap_end) {
        kstroke.end_cap = cap;
    }
    crate::model::apply_stroke_style(
        &mut kstroke,
        crate::model::StrokeStyle::from_wire(style),
        width,
        &[],
    );
    kstroke
}

fn add_aligned_stroke(
    width: f32,
    style: u8,
    cap_start: u8,
    cap_end: u8,
    align: crate::model::StrokeAlign,
) {
    let kstroke = build_wire_stroke(width, style, cap_start, cap_end);
    with_current(|node| {
        node.strokes.push(crate::model::Stroke {
            style: kstroke.clone(),
            paint: crate::model::Paint::plain(crate::model::Brush::Solid(
                crate::peniko::Color::BLACK,
            )),
            align,
        });
    });
}

/// Open a centred stroke. `style` is `RawStrokeStyle`; the cap bytes are `RawStrokeCap`.
#[unsafe(no_mangle)]
pub extern "C" fn add_shape_center_stroke(width: f32, style: u8, cap_start: u8, cap_end: u8) {
    add_aligned_stroke(width, style, cap_start, cap_end, crate::model::StrokeAlign::Center);
}

/// Open an inner-aligned stroke — the full weight sits inside the shape's edge.
#[unsafe(no_mangle)]
pub extern "C" fn add_shape_inner_stroke(width: f32, style: u8, cap_start: u8, cap_end: u8) {
    add_aligned_stroke(width, style, cap_start, cap_end, crate::model::StrokeAlign::Inner);
}

/// Open an outer-aligned stroke — the full weight sits outside the shape's edge.
#[unsafe(no_mangle)]
pub extern "C" fn add_shape_outer_stroke(width: f32, style: u8, cap_start: u8, cap_end: u8) {
    add_aligned_stroke(width, style, cap_start, cap_end, crate::model::StrokeAlign::Outer);
}

/// Paint for the most recently added stroke, read from the shared buffer as one fill record.
#[unsafe(no_mangle)]
pub extern "C" fn add_shape_stroke_fill() {
    let bytes = take_bytes();
    let Some(paint) = decode_fill(&bytes).ok().and_then(paint_from_raw) else {
        return;
    };
    with_current(|node| {
        if let Some(stroke) = node.strokes.last_mut() {
            stroke.paint = paint;
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
    use crate::kurbo::{Cap, Join};
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
fn cap_from_wire(value: u8) -> Option<crate::kurbo::Cap> {
    use crate::kurbo::Cap;
    match value {
        6 => Some(Cap::Round),
        7 => Some(Cap::Square),
        _ => None,
    }
}

/// One wire entry: uuid (four `u32`) then six `f32`, optionally followed by a `u32` kind.
const MODIFIER_ENTRY: usize = 40;
const PROPAGATE_ENTRY: usize = 44;

/// Decode `uuid + matrix` at the start of a chunk.
///
/// The six floats are `a, b, c, d, e, f` in CSS-matrix order, which is *already* kurbo's
/// column-major `Affine::new` layout — `a, b` is the x-basis and `c, d` the y-basis. No swap
/// here, unlike the Skia side, which reorders them into its row-major `Matrix::new_all`.
fn decode_modifier_entry(chunk: &[u8]) -> (u128, Affine) {
    let word = |i: usize| u32::from_le_bytes([chunk[i], chunk[i + 1], chunk[i + 2], chunk[i + 3]]);
    let float = |i: usize| f32::from_le_bytes([chunk[i], chunk[i + 1], chunk[i + 2], chunk[i + 3]]);
    let id = uuid_u128(word(0), word(4), word(8), word(12));
    let m = Affine::new([
        float(16) as f64,
        float(20) as f64,
        float(24) as f64,
        float(28) as f64,
        float(32) as f64,
        float(36) as f64,
    ]);
    (id, m)
}

/// Apply gesture transforms to shapes. Replaces the whole set, matching render-wasm.
#[unsafe(no_mangle)]
pub extern "C" fn set_modifiers() {
    let bytes = take_bytes();
    let entries: Vec<(u128, Affine)> = bytes
        .chunks_exact(MODIFIER_ENTRY)
        .map(decode_modifier_entry)
        .collect();

    with_state(|state| {
        let new: Modifiers = entries.into_iter().collect();
        let ids: std::collections::HashSet<u128> =
            state.modifiers.keys().chain(new.keys()).copied().collect();
        let mut rects = Vec::new();
        for id in ids {
            let om = state.modifiers.get(&id).copied().unwrap_or(Affine::IDENTITY);
            let nm = new.get(&id).copied().unwrap_or(Affine::IDENTITY);
            if om != nm {
                if let Some(node) = state.scene.get(id) {
                    rects.push(crate::schedule::affected_page_rect(node, om));
                    rects.push(crate::schedule::affected_page_rect(node, nm));
                }
            }
        }
        for r in rects {
            state.mark_dirty(r);
        }
        state.modifiers = new;
        state.needs_frame = true;
    });
}

/// Drop every gesture transform, returning the scene to its committed geometry.
#[unsafe(no_mangle)]
pub extern "C" fn clean_modifiers() {
    with_state(|state| {
        let mut rects = Vec::new();
        for (&id, &m) in &state.modifiers {
            if let Some(node) = state.scene.get(id) {
                rects.push(crate::schedule::affected_page_rect(node, m));
                rects.push(crate::schedule::affected_page_rect(node, Affine::IDENTITY));
            }
        }
        for r in rects {
            state.mark_dirty(r);
        }
        state.modifiers.clear();
        state.needs_frame = true;
    });
}

/// Expand the host's entries into the full set of shapes a gesture moves.
///
/// **This is the rigid slice.** A `Child` entry carries its transform to every descendant, which
/// is what makes dragging a group or a frame move its contents. What it does *not* do is
/// render-wasm's constraint and layout work: a child pinned to its container's right edge will
/// not stretch when the container is resized, and flex/grid containers do not reflow. Those need
/// the constraint solver, and doing half of it would be worse than doing none — a shape that
/// moves *nearly* right is harder to trust than one that plainly does not move at all.
///
/// `pixel_precision` is accepted and ignored: it asks for integral snapping, which is a
/// refinement of a result we do not yet compute.
#[unsafe(no_mangle)]
pub extern "C" fn propagate_modifiers(_pixel_precision: bool) -> *mut u8 {
    let bytes = take_bytes();

    let mut out: Vec<(u128, Affine)> = Vec::new();
    with_state(|state| {
        for chunk in bytes.chunks_exact(PROPAGATE_ENTRY) {
            let (id, matrix) = decode_modifier_entry(chunk);
            out.push((id, matrix));

            let kind = u32::from_le_bytes([chunk[40], chunk[41], chunk[42], chunk[43]]);
            if kind == 1 {
                collect_descendants(&state.scene, id, matrix, &mut out, 0);
            }
        }
    });

    let mut words = Vec::with_capacity(1 + out.len() * (MODIFIER_ENTRY / 4));
    words.push(out.len() as u32);
    for (id, m) in &out {
        for shift in [96, 64, 32, 0] {
            words.push((*id >> shift) as u32);
        }
        for coeff in m.as_coeffs() {
            words.push((coeff as f32).to_bits());
        }
    }

    let mut guard = RESULT.lock().expect("result buffer poisoned");
    *guard = words;
    guard.as_mut_ptr().cast()
}

/// Carry a transform down to every descendant, depth-capped like the renderer's own walk — the
/// tree comes off the wire and a cycle would otherwise spin here instead of on screen.
fn collect_descendants(
    scene: &Scene,
    id: u128,
    matrix: Affine,
    out: &mut Vec<(u128, Affine)>,
    depth: u32,
) {
    if depth >= 128 {
        return;
    }
    let Some(node) = scene.get(id) else {
        return;
    };
    for child in &node.children {
        out.push((*child, matrix));
        collect_descendants(scene, *child, matrix, out, depth + 1);
    }
}

/// Reparenting and layout-track edits mid-gesture. Accepted and ignored — this backend has no
/// layout engine, so there is no track to edit and no flow to opt out of.
///
/// It still *drains* the buffer. A handler that ignores its input without taking it leaves the
/// shared buffer occupied, and the next `alloc_bytes` then returns null.
#[unsafe(no_mangle)]
pub extern "C" fn set_structure_modifiers() {
    let _ = take_bytes();
}

/// Shapes to treat as layout-absolute for this gesture. Same reasoning as above.
#[unsafe(no_mangle)]
pub extern "C" fn set_absolute_modifiers() {
    let _ = take_bytes();
}

/// The last query result, kept alive for the host to read.
///
/// `Vec<u32>` rather than `Vec<u8>` on purpose: the host divides the returned pointer by four to
/// index `HEAPF32`, so it must be four-byte aligned, and a `Vec<u8>` only promises alignment 1.
static RESULT: Mutex<Vec<u32>> = Mutex::new(Vec::new());

/// The selection's bounding box, as ten little-endian `f32`s:
/// `width, height, cx, cy, a, b, c, d, e, f`.
///
/// The rule itself is [`crate::selection::selection_rect`] — shared rather than mirrored,
/// because its wire layout and its single-vs-multi asymmetry are exactly the sort of arbitrary
/// convention two backends drift apart on. All that is left here is transport: ids in, quads
/// across, floats out.
#[unsafe(no_mangle)]
pub extern "C" fn get_selection_rect() -> *mut u8 {
    let ids: Vec<u128> = take_bytes()
        .chunks_exact(16)
        .map(|c| {
            let word = |i: usize| u32::from_le_bytes([c[i], c[i + 1], c[i + 2], c[i + 3]]);
            uuid_u128(word(0), word(4), word(8), word(12))
        })
        .collect();

    let quads: Vec<[kurbo::Point; 4]> = with_state(|state| {
        ids.iter()
            .filter_map(|id| state.scene.get(*id).map(|node| (id, node)))
            .map(|(id, node)| {
                let modifier = state.modifiers.get(id).copied().unwrap_or(Affine::IDENTITY);
                crate::selection::node_quad(node, modifier)
            })
            .collect()
    });

    let values = crate::selection::selection_rect(&quads);

    let mut guard = RESULT.lock().expect("result buffer poisoned");
    *guard = values.iter().map(|v| v.to_bits()).collect();
    guard.as_mut_ptr().cast()
}

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
    crate::host::bump_scene_epoch();
    with_state(|state| {
        state.scene.clear();
        state.current = None;
    });
}

/// Install the shared parity fixture ([`crate::parity`]) as the live scene — every neutral-model
/// feature in a labelled grid, rendered through the full scheduler sink so the **gather** cells
/// (background blur, glass, and their *scoped* variants) actually execute, unlike the native
/// tree-walk example. The host frames it with `set_view` + surface metrics. Returns the cell count so
/// the harness can size the canvas.
#[unsafe(no_mangle)]
pub extern "C" fn load_parity_scene() -> u32 {
    stage_parity_font();
    install_fixture(crate::parity::build_parity_scene())
}

/// Install the **showcase scene** ([`crate::parity::build_showcase_scene`]) — one composed
/// document with every effect family (fills, gradients, strokes, shadows, layer blur, glass +
/// background-blur gathers, a masked group, a clipped scope) overlapping at depth. The standard scene
/// for classic-vs-hybrid backend comparison. Frame it at `SHOWCASE_W`×`SHOWCASE_H` (1200×800).
#[unsafe(no_mangle)]
pub extern "C" fn load_showcase_scene() -> u32 {
    install_fixture((crate::parity::build_showcase_scene(), Vec::new()))
}

/// Install the **image-fill test** ([`crate::parity::build_image_test_scene`]) — a grid of the
/// placements Penpot's image fill can take (stretch, cover, circle-clip, rounded, half-opacity), all
/// pointing at one staged synthetic image. Unlike the pure neutral-model fixtures this also **stages
/// pixels**: it pushes [`crate::parity::image_test_pixels`] onto the same `PENDING_IMAGES`
/// queue `store_image_rgba` feeds, so the backend's per-frame `upload_pending_images` mints an
/// `ImageId` for [`IMAGE_TEST_ID`](crate::parity::IMAGE_TEST_ID) and the fills resolve to real
/// pixels — the classic image path end-to-end. Returns the cell count.
/// Install the **path drop-shadow test** ([`crate::parity::build_path_shadow_scene`]) — a
/// bezier arrow with a soft drop shadow beside the same arrow without one. The shadow renders through
/// the sink's silhouette-blur path (a non-box shape has no inline blur), so this is driven through the
/// full scheduler + sink, not the tree walk. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_path_shadow_scene() -> u32 {
    stage_parity_font();
    install_fixture(crate::parity::build_path_shadow_scene())
}

/// Install the **layer-blur test** ([`crate::parity::build_layer_blur_scene`]) — a shape with a
/// layer blur beside the same shape without one. Classic has no inline layer blur, so this is driven
/// through the sink (`layer_blur_over_body`), not the tree walk. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_layer_blur_scene() -> u32 {
    install_fixture(crate::parity::build_layer_blur_scene())
}

/// Install the **boolean test** ([`crate::parity::build_boolean_scene`]) — union / difference /
/// union-with-drop-shadow, all as precomputed paths (a boolean reaches a renderer flattened to a
/// `Path`). Verify-only: the result draws like any path. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_boolean_scene() -> u32 {
    install_fixture(crate::parity::build_boolean_scene())
}

/// Install the **stress test** ([`crate::parity::build_stress_scene`]) — a grid of shapes each carrying
/// a heavy effect stack (2 drop + 1 inner shadow + layer blur + tint shader), for pass-count / frame-time
/// comparison of the whole-viewport vs tiled paths. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_scale_scene(n: u32, effect_every: u32) -> u32 {
    install_fixture(crate::parity::build_scale_scene(n as usize, effect_every as usize))
}

/// [`load_scale_scene`] with geometry knobs: `step` = grid pitch px, `size` = shape edge as a
/// multiple of the pitch (stacking depth ≈ `size²`), `opacity_every` = every k-th shape translucent.
#[unsafe(no_mangle)]
pub extern "C" fn load_scale_scene_sized(n: u32, effect_every: u32, step: f32, size: f32, opacity_every: u32) -> u32 {
    install_fixture(crate::parity::build_scale_scene_sized(
        n as usize, effect_every as usize, f64::from(step), f64::from(size), opacity_every as usize,
    ))
}

/// Install the **glass grid** ([`crate::parity::build_glass_grid_scene`]) — `n` disjoint lenses that
/// all land in one round, the case the batched glass stages exist for. `frost != 0` uses the frosted
/// lens (warp → blur → scatter tail); `0` the sharp one (one fused unit pass). Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_glass_grid_scene(n: u32, frost: u32) -> u32 {
    install_fixture(crate::parity::build_glass_grid_scene(n as usize, frost != 0, 1.0))
}

/// Install the **blur grid** ([`crate::parity::build_blur_grid_scene`]) — `n` disjoint background-blur
/// gathers, the non-self-clipping counterpart of the glass grid, for the batched masked composite.
#[unsafe(no_mangle)]
pub extern "C" fn load_blur_grid_scene(n: u32, radius: u32) -> u32 {
    install_fixture(crate::parity::build_blur_grid_scene(n as usize, radius as f32))
}

/// [`load_glass_grid_scene`] with each lens's `acceptable_downscale` forced to `downscale_milli/1000`
/// — the k-triggering fixture for the batch's scaled-stamp (`stage::SHARP`) path. A value below 1000
/// makes every lens render at a reduced `k` and be upscaled, which the un-scaled grid never exercises.
#[unsafe(no_mangle)]
pub extern "C" fn load_glass_grid_scene_k(n: u32, frost: u32, downscale_milli: u32) -> u32 {
    install_fixture(crate::parity::build_glass_grid_scene(n as usize, frost != 0, downscale_milli as f32 / 1000.0))
}

/// Install the **matrix** fixture (every effect combination). Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_matrix_scene() -> u32 {
    install_fixture(crate::parity::build_matrix_scene())
}

/// Install the **stress** fixture. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_stress_scene() -> u32 {
    install_fixture(crate::parity::build_stress_scene())
}

/// The stress fixture with an effect **ablation mask** ([`crate::parity::build_stress_scene_mask`]):
/// bits `1` drop, `2` inner, `4` layer blur, `8` custom shader; `0` = plain bodies. Turning one bit
/// off and re-measuring attributes that effect's GPU cost. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_stress_scene_mask(n: u32, mask: u32) -> u32 {
    install_fixture(crate::parity::build_stress_scene_mask(n as usize, mask))
}

/// Install the **combined-effects test** ([`crate::parity::build_combined_scene`]) — several effects
/// stacked on one shape (drop + inner shadow; drop shadow + layer blur; tint shader + drop shadow),
/// each list kept in authored order. Drives the whole-viewport effect stack. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_combined_scene() -> u32 {
    install_fixture(crate::parity::build_combined_scene())
}

/// Install the **inner-shadow test** ([`crate::parity::build_inner_shadow_scene`]) — a filled path and
/// a text block with inset shadows, beside the same path with none. Classic has no inline non-box inner
/// shadow, so this is driven through the sink (`paint_inner_shadow`). Stages the parity font for the
/// text cell. Returns the cell count.
#[unsafe(no_mangle)]
pub extern "C" fn load_inner_shadow_scene() -> u32 {
    stage_parity_font();
    install_fixture(crate::parity::build_inner_shadow_scene())
}

#[unsafe(no_mangle)]
pub extern "C" fn load_image_test_scene() -> u32 {
    let (width, height, rgba) = crate::parity::image_test_pixels();
    PENDING_IMAGES
        .lock()
        .expect("pending images poisoned")
        .push(PendingImage { id: crate::parity::IMAGE_TEST_ID, width, height, rgba });
    install_fixture(crate::parity::build_image_test_scene())
}

/// Install the **nested scope test** ([`crate::parity::build_scope_test_scene`]) as the live
/// scene — grandparent/parent isolation scopes with two differently-scoped glass gathers crossing
/// non-clipping borders. Rendered through the sink so the gathers execute. Returns the shape count.
#[unsafe(no_mangle)]
pub extern "C" fn load_scope_scene() -> u32 {
    install_fixture(crate::parity::build_scope_test_scene())
}

/// Same nested scope test as [`load_scope_scene`] but with the two glass lenses replaced by dashed
/// outlines of their footprint — reveals the backdrop content sitting behind each lens.
#[unsafe(no_mangle)]
pub extern "C" fn load_scope_scene_nolens() -> u32 {
    install_fixture(crate::parity::build_scope_test_scene_nolens())
}

/// Same nested scope test but with background-blur lenses instead of glass — a diagnostic to tell a
/// glass-specific black-lens bug apart from a scoped-backdrop-compose bug.
#[unsafe(no_mangle)]
pub extern "C" fn load_scope_scene_blur() -> u32 {
    install_fixture(crate::parity::build_scope_test_scene_blur())
}

/// Same nested scope test with the three frame **backdrop fills removed** (borders only) — the
/// gathers read an empty scope and must render transparent, not black. Paired with `load_scope_scene`
/// as the with/without-backdrop proof.
#[unsafe(no_mangle)]
pub extern "C" fn load_scope_scene_nobg() -> u32 {
    install_fixture(crate::parity::build_scope_test_scene_nobg())
}

/// The glass scope test with the lenses' past-scope `TileMode` = **Black** — the lens fills a black
/// block past its scope instead of the default transparent (Decal). Demonstrates the configurable mode.
#[unsafe(no_mangle)]
pub extern "C" fn load_scope_scene_black() -> u32 {
    install_fixture(crate::parity::build_scope_test_scene_black())
}

/// The glass scope test with the lenses' past-scope `TileMode` = **Clamp** — the lens extends its
/// scope's edge pixels outward past the border instead of going transparent.
#[unsafe(no_mangle)]
pub extern "C" fn load_scope_scene_clamp() -> u32 {
    install_fixture(crate::parity::build_scope_test_scene_clamp())
}

/// Install the **texture/noise effect** fixture ([`crate::parity::build_texture_scene`]) — the
/// noise-displacement effect at several magnitudes and grains, with and without clipping to the
/// original coverage, plus the noise overlay and the two chained. Returns the shape count.
#[unsafe(no_mangle)]
pub extern "C" fn load_texture_scene() -> u32 {
    install_fixture(crate::parity::build_texture_scene())
}

/// Swap a prebuilt fixture in as the live scene and mark everything dirty so the next frame rebuilds.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
fn install_fixture((scene, legend): (Scene, Vec<(usize, &'static str)>)) -> u32 {
    crate::host::bump_scene_epoch();
    with_state(|state| {
        state.scene = scene;
        state.current = None;
        state.dirty_all = true;
        state.invalidate_quadtree();
        state.diamonds_dirty = true;
        state.needs_frame = true;
        legend.len() as u32
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kurbo::Point;
    use crate::model::ROOT_ID;
    use crate::model::Brush;

    /// The ABI is built on module-global state — the implicit current-shape cursor D17 accepts
    /// as debt. The test harness runs tests in parallel threads, so without serialising them
    /// one test's `clear_scene()` lands between another's `use_shape` and its assertions and
    /// the failure looks flaky. Every test holds this for its duration.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// A snapshot of the live scene. Production reads it by reference through `with_scene`;
    /// cloning is fine in a test and keeps the assertions readable.
    fn current_scene() -> Scene {
        with_scene(|scene, _, _| scene.clone())
    }

    fn reset() -> std::sync::MutexGuard<'static, ()> {
        let guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        clean_up();
        with_state(|state| state.viewport = Viewport::default());
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

    /// A blend byte maps through the shared authority, so this side lands on the exact value
    /// render-wasm projects; an unset shape carries the default. If this entry point were missing,
    /// the facade would stub it and every blend would silently stay default.
    #[test]
    fn blend_mode_maps_through_the_shared_authority() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_blend_mode(24);
        assert_eq!(
            current_scene().get(1).unwrap().blend,
            crate::blend::blend_from_raw(24)
        );

        use_shape(0, 0, 0, 2);
        assert_eq!(
            current_scene().get(2).unwrap().blend,
            crate::blend::DEFAULT_BLEND,
            "unset → default"
        );
    }

    /// Layer blur, background blur and both shadow styles reach the model; hidden shadows are
    /// dropped at the wire. Layer blur is a spread effect, background blur a gather effect — they
    /// live in separate slots and don't disturb each other. Inner shadows cross too, tagged `inset`.
    #[test]
    fn blur_and_shadows_reach_the_model_but_the_undrawable_do_not() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_blur(0, false, 12.0);
        add_shape_shadow(0xff_00_00_00, 6.0, 1.0, 4.0, 5.0, 0, false);
        add_shape_shadow(0xff_00_00_00, 7.0, 0.0, 1.0, 1.0, 1, false);
        add_shape_shadow(0xff_00_00_00, 6.0, 0.0, 1.0, 1.0, 0, true);
        set_shape_blur(1, false, 9.0);

        {
            let scene = current_scene();
            let node = scene.get(1).unwrap();
            assert_eq!(node.blur, Some(12.0));
            assert_eq!(node.background_blur, Some(9.0), "background blur lands in its own slot");
            assert_eq!(node.shadows.len(), 2, "the drop and the inner shadow, not the hidden one");
            assert_eq!(node.shadows[0].blur, 6.0);
            assert_eq!(node.shadows[0].spread, 1.0);
            assert_eq!(node.shadows[0].offset, crate::kurbo::Vec2::new(4.0, 5.0));
            assert!(!node.shadows[0].inset, "the first is a drop shadow");
            assert_eq!(node.shadows[1].blur, 7.0);
            assert!(node.shadows[1].inset, "the second is an inner shadow");
        }

        set_shape_blur(0, true, 12.0);
        assert_eq!(current_scene().get(1).unwrap().blur, None);
        assert_eq!(current_scene().get(1).unwrap().background_blur, Some(9.0));
        clear_shape_shadows();
        assert!(current_scene().get(1).unwrap().shadows.is_empty());
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

        let size = crate::abi::RAW_FILL_DATA_SIZE;
        let mut payload = vec![0u8; 4 + size];
        payload[0] = 1;
        payload[4] = 0x00;
        payload[8..12].copy_from_slice(&0xff112233u32.to_le_bytes());

        let ptr = alloc_bytes(payload.len());
        assert!(!ptr.is_null());
        {
            let mut guard = BUFFER.lock().unwrap();
            guard.as_mut().unwrap().copy_from_slice(&payload);
        }
        set_shape_fills();

        let scene = current_scene();
        assert_eq!(
            scene.get(1).unwrap().fills,
            vec![crate::model::Paint::plain(Brush::Solid(
                crate::peniko::Color::from_rgba8(0x11, 0x22, 0x33, 0xff)
            ))]
        );
    }

    /// The filter-graph setter decodes a chain of mixed node types (blur · offset · custom) from the
    /// shared buffer, in order; clearing removes it. If this entry point were missing the facade
    /// would stub it and every effect would silently vanish.
    #[test]
    fn filter_graph_decodes_a_mixed_node_chain() {
        use crate::model::FilterNode;
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        let mut payload = Vec::new();
        let push_u32 = |p: &mut Vec<u8>, v: u32| p.extend_from_slice(&v.to_le_bytes());
        let push_f32 = |p: &mut Vec<u8>, v: f32| p.extend_from_slice(&v.to_le_bytes());
        push_u32(&mut payload, 4);
        push_u32(&mut payload, 0);
        push_f32(&mut payload, 4.0);
        push_u32(&mut payload, 1);
        push_f32(&mut payload, 10.0);
        push_f32(&mut payload, 0.0);
        push_u32(&mut payload, 3);
        push_f32(&mut payload, 6.0);
        push_f32(&mut payload, 6.0);
        push_f32(&mut payload, 4.0);
        push_u32(&mut payload, 0x80ff_0000);
        push_u32(&mut payload, 2);
        push_u32(&mut payload, 0);
        push_u32(&mut payload, 4);
        for v in [1.0_f32, 0.45, 0.0, 0.7] {
            push_f32(&mut payload, v);
        }

        let ptr = alloc_bytes(payload.len());
        assert!(!ptr.is_null());
        {
            let mut guard = BUFFER.lock().unwrap();
            guard.as_mut().unwrap().copy_from_slice(&payload);
        }
        set_shape_filter_graph();

        let graph = current_scene().get(1).unwrap().filter_graph.clone().unwrap();
        assert_eq!(
            graph.nodes,
            vec![
                FilterNode::Blur { sigma: 4.0 },
                FilterNode::Offset { dx: 10.0, dy: 0.0 },
                FilterNode::InnerShadow { dx: 6.0, dy: 6.0, sigma: 4.0, color: argb_to_color(0x80ff_0000) },
                FilterNode::Shader { effect: 0, params: vec![1.0, 0.45, 0.0, 0.7] },
            ]
        );

        clear_shape_filter_graph();
        assert!(current_scene().get(1).unwrap().filter_graph.is_none());
    }

    /// Text (5), Bool (2) and SVGRaw (7) have no model kind yet; each becomes `Unsupported`,
    /// not a stand-in rect. A rect would paint a phantom box that could never match render-wasm
    /// — which drops these shapes — so the node must read as inert even though it arrived
    /// carrying a fill. The rect-vs-text contrast below is what makes the paintable count mean
    /// something: the same fill draws as a rect and draws nothing once the kind is Text.
    #[test]
    fn unknown_shape_types_become_unsupported_and_paint_nothing() {
        let _guard = reset();

        use_shape(0, 0, 0, 1);
        set_shape_selrect(0.0, 0.0, 50.0, 50.0);
        let mut fill = vec![0u8; 4 + crate::abi::RAW_FILL_DATA_SIZE];
        fill[0] = 1;
        fill[8..12].copy_from_slice(&0xff112233u32.to_le_bytes());
        upload(&fill);
        set_shape_fills();
        use_shape(0, 0, 0, 0);
        add_shape_child(0, 0, 0, 1);

        use_shape(0, 0, 0, 1);
        set_shape_type(3);
        assert_eq!(scene_paintable_count(), 1);

        set_shape_type(5);
        assert_eq!(current_scene().get(1).unwrap().kind, ShapeKind::Text);
        assert_eq!(scene_paintable_count(), 0, "text with no content draws nothing");

        for raw in [2u8, 7] {
            use_shape(0, 0, 0, 1);
            set_shape_type(raw);
            assert_eq!(current_scene().get(1).unwrap().kind, ShapeKind::Unsupported);
        }
        assert_eq!(scene_paintable_count(), 0, "unsupported draws nothing, fill or not");
    }

    /// Text content decodes off the wire into the neutral block: a paragraph with one span, its
    /// font reference, size and text. Built by hand to the exact `RawParagraphData`/`RawTextSpan`
    /// byte layout the host writes, so this pins the parser to that layout.
    #[test]
    fn text_content_decodes_into_the_block() {
        let _guard = reset();
        use_shape(0, 0, 0, 7);
        set_shape_type(5);
        set_shape_grow_type(2);
        set_shape_vertical_align(1);

        let word = "Hi";
        let mut buf = vec![0u8; RAW_PARAGRAPH_DATA_SIZE + RAW_SPAN_DATA_SIZE + word.len()];
        buf[0..4].copy_from_slice(&1u32.to_le_bytes());
        buf[4] = 1;
        buf[5] = 1;
        buf[8..12].copy_from_slice(&1.5f32.to_le_bytes());
        let s = RAW_PARAGRAPH_DATA_SIZE;
        buf[s] = 1;
        buf[s + 1] = 1;
        buf[s + 2] = 1;
        buf[s + 4..s + 8].copy_from_slice(&24.0f32.to_le_bytes());
        buf[s + 8..s + 12].copy_from_slice(&1.3f32.to_le_bytes());
        buf[s + 16..s + 20].copy_from_slice(&700i32.to_le_bytes());
        buf[s + 20..s + 24].copy_from_slice(&0xAAu32.to_le_bytes());
        buf[s + 56..s + 60].copy_from_slice(&(word.len() as u32).to_le_bytes());
        buf[s + 60..s + 64].copy_from_slice(&1u32.to_le_bytes());
        let f = s + RAW_SPAN_HEADER_SIZE;
        buf[f] = 0x00;
        buf[f + 4..f + 8].copy_from_slice(&0xff_11_22_33u32.to_le_bytes());
        let t = RAW_PARAGRAPH_DATA_SIZE + RAW_SPAN_DATA_SIZE;
        buf[t..t + word.len()].copy_from_slice(word.as_bytes());
        upload(&buf);
        set_shape_text_content();

        use_shape(0, 0, 0, 0);
        add_shape_child(0, 0, 0, 7);

        let scene = current_scene();
        let block = scene.get(7).unwrap().text.as_ref().expect("a text block");
        assert_eq!(block.grow, TextGrow::AutoHeight);
        assert_eq!(block.vertical_align, VerticalAlign::Center);
        assert_eq!(block.paragraphs.len(), 1);
        let para = &block.paragraphs[0];
        assert_eq!(para.align, TextAlign::Center);
        assert_eq!(para.direction, TextDirection::Rtl);
        assert_eq!(para.spans.len(), 1);
        let span = &para.spans[0];
        assert_eq!(span.text, "Hi");
        assert_eq!(span.transform, TextTransform::Uppercase);
        assert_eq!(span.size, 24.0);
        assert_eq!(span.font.weight, 700);
        assert!(span.font.italic);
        assert_eq!(span.font.id, uuid_u128(0xAA, 0, 0, 0));
        assert_eq!(span.decoration, TextDecoration::Underline);
        assert_eq!(span.fills.len(), 1, "the one solid fill decodes");
        assert_eq!(
            span.fills[0].brush,
            crate::model::Brush::Solid(crate::peniko::Color::from_rgba8(
                0x11, 0x22, 0x33, 0xff
            ))
        );
        assert_eq!(scene_paintable_count(), 1, "text with content paints");

        use_shape(0, 0, 0, 7);
        clear_shape_text();
        assert!(current_scene().get(7).unwrap().text.as_ref().unwrap().paragraphs.is_empty());
    }

    /// Write `payload` through the real transport, as the host's `HEAPU8.set(bytes, ptr)` does.
    fn upload(payload: &[u8]) {
        let ptr = alloc_bytes(payload.len());
        assert!(!ptr.is_null());
        let mut guard = BUFFER.lock().unwrap();
        guard.as_mut().unwrap().copy_from_slice(payload);
    }

    fn triangle_bytes() -> Vec<u8> {
        use crate::abi::{
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
        set_shape_type(4);

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
        let (head, tail) = bytes.split_at(crate::abi::RAW_SEGMENT_DATA_SIZE * 2);

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
        set_shape_type(3);

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

        upload(&[0u8; crate::abi::RAW_SEGMENT_DATA_SIZE + 5]);
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
        set_shape_type(1);
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

    /// The masked flag must reach the node — without this export the facade stubs the call and a
    /// masked group would silently arrive as a plain one, disagreeing with render-wasm's digest.
    #[test]
    fn masked_group_flag_is_recorded() {
        let _guard = reset();
        use_shape(0, 0, 0, 4);
        assert!(!current_scene().get(4).unwrap().masked, "default is unmasked");

        set_shape_masked_group(true);
        assert!(current_scene().get(4).unwrap().masked);

        set_shape_masked_group(false);
        assert!(!current_scene().get(4).unwrap().masked);
    }

    fn viewport_transform() -> Affine {
        with_scene(|_, t, _| t)
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

        set_view(1.5, 0.0, 0.0);
        assert!(take_needs_frame());
        resize_viewbox(800, 600);
        assert!(take_needs_frame());
    }

    /// The registry is publish-once: every consumer reads every face through its own cursor, no
    /// matter when the consumer was created — the draining queue this replaced handed each face to
    /// whichever single consumer synced first and lost it for everyone else.
    #[test]
    fn font_registry_serves_late_consumers_and_never_drains() {
        let _guard = reset();
        stage_parity_font();
        let parity_alias = font_alias(crate::parity::PARITY_FONT_ID, 400, false);

        let mut first = 0usize;
        let early = fonts_since(&mut first);
        assert!(early.iter().any(|f| f.alias == parity_alias));

        let mut second = 0usize;
        let late = fonts_since(&mut second);
        assert_eq!(early.len(), late.len());
        assert!(late.iter().any(|f| f.alias == parity_alias));

        assert!(fonts_since(&mut first).is_empty());
        assert!(fonts_since(&mut second).is_empty());
    }

    #[test]
    fn background_decodes_as_argb() {
        let _guard = reset();
        set_canvas_background(0xff_11_22_33);
        assert_eq!(background(), Color::from_rgba8(0x11, 0x22, 0x33, 0xff));
    }

    #[test]
    fn clean_up_resets_the_document_and_camera_but_keeps_surface_metrics() {
        let _guard = reset();
        set_render_options(0, 2.0);
        resize_viewbox(1280, 720);
        use_shape(0, 0, 0, 1);
        set_view(3.0, 10.0, 20.0);
        set_canvas_background(0xff_ff_ff_ff);

        clean_up();

        assert_eq!(scene_node_count(), 0);
        assert_eq!(background().components[3], 0.0);
        assert!(!take_needs_frame());
        assert_eq!(viewport_transform(), Affine::scale(2.0));
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
        set_shape_type(3);
        set_shape_selrect(0.0, 0.0, 10.0, 10.0);
        let mut fills = vec![0u8; 4 + crate::abi::RAW_FILL_DATA_SIZE];
        fills[0] = 1;
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

    fn uuid_bytes(id: u128) -> Vec<u8> {
        let mut out = Vec::new();
        for shift in [96, 64, 32, 0] {
            out.extend_from_slice(&((id >> shift) as u32).to_le_bytes());
        }
        out
    }

    fn matrix_bytes(m: Affine) -> Vec<u8> {
        let mut out = Vec::new();
        for coeff in m.as_coeffs() {
            out.extend_from_slice(&(coeff as f32).to_le_bytes());
        }
        out
    }

    fn upload_modifiers(entries: &[(u128, Affine)]) {
        let mut payload = Vec::new();
        for (id, m) in entries {
            payload.extend_from_slice(&uuid_bytes(*id));
            payload.extend_from_slice(&matrix_bytes(*m));
        }
        upload(&payload);
    }

    /// Read back what `propagate_modifiers` left for the host: `[len, (uuid, matrix)…]`.
    fn read_propagated(ptr: *mut u8, len_hint: usize) -> Vec<(u128, Affine)> {
        let words = unsafe { std::slice::from_raw_parts(ptr.cast::<u32>(), 1 + len_hint * 10) };
        let count = words[0] as usize;
        (0..count)
            .map(|i| {
                let e = &words[1 + i * 10..1 + i * 10 + 10];
                let id = ((e[0] as u128) << 96)
                    | ((e[1] as u128) << 64)
                    | ((e[2] as u128) << 32)
                    | (e[3] as u128);
                let c: Vec<f64> = e[4..10].iter().map(|w| f32::from_bits(*w) as f64).collect();
                (id, Affine::new([c[0], c[1], c[2], c[3], c[4], c[5]]))
            })
            .collect()
    }

    #[test]
    fn modifiers_round_trip_and_clear() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_selrect(0.0, 0.0, 10.0, 10.0);

        upload_modifiers(&[(1, Affine::translate((5.0, 7.0)))]);
        set_modifiers();
        let moved = with_state(|s| s.modifiers.get(&1).copied());
        assert_eq!(moved, Some(Affine::translate((5.0, 7.0))));
        assert!(take_needs_frame(), "a gesture must schedule a frame");

        clean_modifiers();
        assert!(with_state(|s| s.modifiers.is_empty()));
    }

    /// A `Child` entry must reach every descendant, which is what makes dragging a group move
    /// its contents; a `Parent` entry must not, or a container's drag lands on its children
    /// twice.
    #[test]
    fn propagation_reaches_descendants_only_for_child_entries() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        add_shape_child(0, 0, 0, 2);
        use_shape(0, 0, 0, 2);
        add_shape_child(0, 0, 0, 3);
        use_shape(0, 0, 0, 3);

        let drag = Affine::translate((4.0, 0.0));
        let entry = |kind: u32| {
            let mut payload = uuid_bytes(1);
            payload.extend_from_slice(&matrix_bytes(drag));
            payload.extend_from_slice(&kind.to_le_bytes());
            payload
        };

        upload(&entry(1));
        let child = read_propagated(propagate_modifiers(false), 8);
        assert_eq!(child.len(), 3, "the container and both descendants");
        assert!(child.iter().all(|(_, m)| *m == drag));
        assert_eq!(child.iter().map(|(id, _)| *id).collect::<Vec<_>>(), [1, 2, 3]);

        upload(&entry(0));
        let parent = read_propagated(propagate_modifiers(false), 8);
        assert_eq!(parent.len(), 1, "parent entries stand alone");
    }

    /// The selection box has to follow the gesture; a box left at the committed position is the
    /// bug this whole entry point exists to avoid.
    #[test]
    fn selection_rect_follows_a_modifier() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_selrect(0.0, 0.0, 100.0, 50.0);

        let at_rest = selection_rect(&[1]);
        assert!((at_rest[2] - 50.0).abs() < 1e-3);

        upload_modifiers(&[(1, Affine::translate((30.0, -10.0)))]);
        set_modifiers();

        let dragged = selection_rect(&[1]);
        assert!((dragged[2] - 80.0).abs() < 1e-3, "centre followed: {dragged:?}");
        assert!((dragged[3] - 15.0).abs() < 1e-3, "centre followed: {dragged:?}");
        assert!((dragged[0] - 100.0).abs() < 1e-3, "a drag is not a resize");
    }

    /// These two are accepted and ignored, but they must still drain the shared buffer —
    /// otherwise the next `alloc_bytes` returns null and every later upload silently fails.
    #[test]
    fn ignored_modifier_entry_points_still_drain_the_buffer() {
        let _guard = reset();
        upload(&[0u8; 44]);
        set_structure_modifiers();
        assert!(!alloc_bytes(8).is_null(), "buffer left occupied");
        free_bytes();

        upload(&[0u8; 16]);
        set_absolute_modifiers();
        assert!(!alloc_bytes(8).is_null(), "buffer left occupied");
        free_bytes();
    }

    /// Read back the ten `f32`s `get_selection_rect` leaves for the host.
    fn selection_rect(ids: &[u128]) -> [f32; 10] {
        let mut payload = Vec::new();
        for id in ids {
            for shift in [96, 64, 32, 0] {
                payload.extend_from_slice(&(((*id >> shift) as u32).to_le_bytes()));
            }
        }
        upload(&payload);

        let ptr = get_selection_rect();
        let words = unsafe { std::slice::from_raw_parts(ptr.cast::<u32>(), 10) };
        let mut out = [0.0f32; 10];
        for (slot, word) in out.iter_mut().zip(words) {
            *slot = f32::from_bits(*word);
        }
        out
    }

    /// One rotated shape reports its *own* box with the rotation in the matrix — not the
    /// axis-aligned hull, which would make the width jump the moment a shape is turned.
    #[test]
    fn selection_rect_of_one_shape_is_oriented() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_selrect(0.0, 0.0, 100.0, 50.0);
        set_shape_transform(0.0, -1.0, 1.0, 0.0, 0.0, 0.0);

        let [w, h, cx, cy, a, b, c, d, e, f] = selection_rect(&[1]);
        assert!((w - 100.0).abs() < 1e-3, "width stays the shape's own: {w}");
        assert!((h - 50.0).abs() < 1e-3, "height stays the shape's own: {h}");
        assert!((cx - 50.0).abs() < 1e-3 && (cy - 25.0).abs() < 1e-3);
        assert!((a - 0.0).abs() < 1e-3 && (b + 1.0).abs() < 1e-3, "{a},{b}");
        assert!((c - 1.0).abs() < 1e-3 && (d - 0.0).abs() < 1e-3, "{c},{d}");
        assert!((e - cx).abs() < 1e-3 && (f - cy).abs() < 1e-3);
    }

    /// Two shapes report the axis-aligned hull, unrotated — render-wasm's `join_bounds`.
    #[test]
    fn selection_rect_of_several_shapes_is_the_axis_aligned_hull() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_selrect(0.0, 0.0, 10.0, 10.0);
        use_shape(0, 0, 0, 2);
        set_shape_selrect(30.0, 20.0, 50.0, 60.0);

        let [w, h, cx, cy, a, b, c, d, ..] = selection_rect(&[1, 2]);
        assert!((w - 50.0).abs() < 1e-3 && (h - 60.0).abs() < 1e-3, "{w}x{h}");
        assert!((cx - 25.0).abs() < 1e-3 && (cy - 30.0).abs() < 1e-3);
        assert_eq!((a, b, c, d), (1.0, 0.0, 0.0, 1.0), "hull is never rotated");
    }

    /// Ids the host has not delivered must not produce a rect — the caller's finite-check turns
    /// this into "no selection box" rather than one anchored at the origin.
    #[test]
    fn selection_rect_of_unknown_ids_is_empty() {
        let _guard = reset();
        assert_eq!(selection_rect(&[404]), [0.0; 10]);
    }

    /// The host divides the returned pointer by four to index `HEAPF32`; a misaligned buffer
    /// would silently read from the wrong place.
    #[test]
    fn selection_rect_result_is_four_byte_aligned() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);
        set_shape_selrect(0.0, 0.0, 10.0, 10.0);
        let mut payload = Vec::new();
        payload.extend_from_slice(&0u32.to_le_bytes());
        payload.extend_from_slice(&0u32.to_le_bytes());
        payload.extend_from_slice(&0u32.to_le_bytes());
        payload.extend_from_slice(&1u32.to_le_bytes());
        upload(&payload);
        assert_eq!(get_selection_rect() as usize % 4, 0);
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

    /// One solid fill record in the shared buffer, as `add_shape_stroke_fill` expects — no
    /// count header, unlike `set_shape_fills`.
    fn upload_solid_fill(argb: u32) {
        let mut payload = vec![0u8; crate::abi::RAW_FILL_DATA_SIZE];
        payload[0] = 0x00;
        payload[4..8].copy_from_slice(&argb.to_le_bytes());
        upload(&payload);
    }

    #[test]
    fn a_centre_stroke_takes_width_caps_and_paint() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        add_shape_center_stroke(4.0, 0, 6, 7);
        upload_solid_fill(0xff_11_22_33);
        add_shape_stroke_fill();

        let scene = current_scene();
        let strokes = &scene.get(1).unwrap().strokes;
        assert_eq!(strokes.len(), 1);
        assert_eq!(strokes[0].style.width, 4.0);
        assert_eq!(strokes[0].style.start_cap, crate::kurbo::Cap::Round);
        assert_eq!(strokes[0].style.end_cap, crate::kurbo::Cap::Square);
        assert_eq!(
            strokes[0].paint.brush,
            Brush::Solid(crate::peniko::Color::from_rgba8(
                0x11, 0x22, 0x33, 0xff
            ))
        );
    }

    /// Inner and outer strokes put the whole weight on one side of the edge, which a plain
    /// centre-aligned `kurbo::Stroke` cannot express. They were once dropped here on the grounds
    /// that painting them centred puts paint visibly in the wrong place — worse than drawing
    /// nothing. `draw.rs` now expresses them exactly (a double-width centre stroke clipped to the
    /// shape's interior for inner, to its complement for outer), so the ABI has to *preserve* the
    /// alignment: dropping one now loses a stroke the renderer can draw correctly, and silently
    /// flattening one to `Center` would resurrect the misplaced-paint bug.
    #[test]
    fn stroke_alignment_survives_the_abi() {
        let _guard = reset();
        use_shape(0, 0, 0, 1);

        add_shape_inner_stroke(4.0, 0, 0, 0);
        add_shape_outer_stroke(4.0, 0, 0, 0);
        add_shape_center_stroke(4.0, 0, 0, 0);

        let scene = current_scene();
        let aligns: Vec<crate::model::StrokeAlign> =
            scene.get(1).unwrap().strokes.iter().map(|s| s.align).collect();
        assert_eq!(
            aligns,
            vec![
                crate::model::StrokeAlign::Inner,
                crate::model::StrokeAlign::Outer,
                crate::model::StrokeAlign::Center
            ]
        );
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
        set_shape_stroke_props(2, -1, 3.5);

        let scene = current_scene();
        let strokes = &scene.get(1).unwrap().strokes;
        assert_eq!(strokes.len(), 2);
        assert_eq!(strokes[0].style.width, 2.0);
        assert_eq!(strokes[0].style.join, crate::kurbo::Join::Miter);
        assert_eq!(strokes[1].style.join, crate::kurbo::Join::Bevel);
        assert_eq!(strokes[1].style.miter_limit, 3.5);
        assert_eq!(
            strokes[0].paint.brush,
            Brush::Solid(crate::peniko::Color::from_rgba8(0xff, 0, 0, 0xff))
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
        assert_eq!(stroke.style.join, crate::kurbo::Join::Round);
        assert_eq!(stroke.style.start_cap, crate::kurbo::Cap::Round);
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

        assert!(pattern_for(0, 4.0).is_empty());
        assert_eq!(pattern_for(2, 4.0), vec![14.0, 14.0]);
        assert_eq!(pattern_for(3, 4.0), vec![9.0, 9.0, 5.0, 9.0]);
        assert_eq!(pattern_for(1, 4.0), vec![0.01, 8.99]);
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
