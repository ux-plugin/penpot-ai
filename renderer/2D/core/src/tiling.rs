//! Tile-grid policy, backend-neutral (decision D18).
//!
//! "Tiling" is two things with different homes. The **policy** — which page-space tiles cover
//! the viewport, how a tile's content maps into its render buffer, and where the buffer's centre
//! lands on screen — is pure geometry with no GPU in it, so it lives here and both backends share
//! it (identical tiling is what makes the two-URL comparison to Skia honest). The **store** — how
//! a tile is physically rendered, cached, and composited — is backend-specific and lives behind
//! [`TileStore`], implemented in each backend.
//!
//! ## Why tiles at all (the correctness reason, not just performance)
//!
//! `vello_hybrid` applies filters in **viewport space**: it clips a filter layer's content to the
//! active render target and rasterizes only into that target's tiles. So an effect (blur, shadow)
//! run against a viewport-sized target sees the viewport edge as a *false shape edge*, and the
//! effect changes with pan and zoom instead of being welded to the shape. The fix, mirroring
//! render-wasm, is to render each device tile into its own **content + margin** buffer: the buffer
//! becomes the render target, so `active_bbox` is the tile+margin, not the screen. Interior tiles
//! are fully covered (no false edge) and effects bleed into the margin of real content.
//!
//! Geometry mirrors render-wasm exactly: [`TILE_SIZE`] content, [`TILE_MARGIN`] each side →
//! a [`TILE_BUFFER`]² buffer; the shadow/blur device-sigma cap is `TILE_MARGIN / 3`, so an
//! effect always fits inside the margin.
//!
//! ## Reuse scope
//!
//! This module is pure geometry; the reuse happens in the backend store keyed by [`TileKey`].
//! Because a tile's device index is *pan-anchored* (a pan shifts which indices are visible but a
//! given index keeps its page-space content — see `a_pan_shifts_which_tiles_are_visible_by_an_int`)
//! the store reuses a tile's rendered buffer across a **pan** and re-renders only newly-exposed
//! indices. The composite is 1:1 at the *exact* current scale, so a **scale change** (any zoom)
//! invalidates that reuse; [`TileKey::zoom_bucket`] is computed here but not yet used for reuse —
//! zoom reuse (render at the bucket scale, composite scaled) is the next slice. The visible-set
//! math assumes the view is scale + translation (canvas pan/zoom, no view rotation);
//! [`tile_render_transform`] itself is rotation-general.

use kurbo::{Affine, Point, Rect};

/// The content side of a tile, in device pixels — the region composited to screen. Mirrors
/// render-wasm's `TILE_SIZE`.
pub const TILE_SIZE: u32 = 512;

/// The apron added on every side of the content, in device pixels. Mirrors render-wasm's tile
/// margin.
///
/// This is **not** only for effect bleed — it is the apron that keeps the tile boundary *out* of
/// the composited region. Each tile is rendered at `TILE_BUFFER`² and only its centre `TILE_SIZE`
/// is copied out, so the composite seam sits `TILE_MARGIN` px inside the buffer, where content
/// crossing it (a stroke, an anti-aliased edge) is fully present rather than cut at the render
/// target's edge. With no apron the seam falls on the buffer's clip edge and strokes/AA reconcile
/// inconsistently between neighbours — visible tile seams even on plain shapes. So an apron is
/// required for *all* content; spatially-spreading effects (blur/shadow) need more reach than this
/// and are handled separately, on their own `extrect`-anchored surfaces, not per-tile.
pub const TILE_MARGIN: u32 = 256;

/// The full tile render-buffer side, in device pixels: content plus a margin on both sides.
pub const TILE_BUFFER: u32 = TILE_SIZE + 2 * TILE_MARGIN;

/// Identifies one tile. `tile_x`/`tile_y` index the pan-anchored device grid (so a pan shifts
/// which indices are visible but a given index keeps its page-space content — the basis for reuse);
/// `zoom_bucket` quantises the scale so a zoom re-renders rather than reusing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TileKey {
    pub tile_x: i32,
    pub tile_y: i32,
    pub zoom_bucket: i32,
}

/// The mean axis scale of a page→device transform — the same factor the shadow/blur cap uses
/// (`geometry::cap_sigma_to_device`) and that the fork applies to filter params. For a pure
/// scale+translate view this is just the zoom.
#[must_use]
pub fn view_scale(view: Affine) -> f64 {
    let [a, b, c, d, _, _] = view.as_coeffs();
    ((a * a + b * b).sqrt() + (c * c + d * d).sqrt()) / 2.0
}

/// Quantise a scale into a zoom bucket (quarter-octave steps). Equal buckets are the reuse
/// equality key from slice 3 on; in slice 1 it only distinguishes keys.
#[must_use]
pub fn zoom_bucket(scale: f64) -> i32 {
    let s = scale.max(f64::EPSILON);
    (s.log2() * 4.0).round() as i32
}

/// The page-space tiles whose content region intersects the `viewport_w × viewport_h` device
/// viewport under `view`. Empty when the viewport or the scale is degenerate. Assumes `view` is
/// scale + translation (the canvas case); a rotated view would need a device-space sweep instead.
#[must_use]
pub fn visible_tiles(view: Affine, viewport_w: u32, viewport_h: u32) -> Vec<TileKey> {
    if viewport_w == 0 || viewport_h == 0 {
        return Vec::new();
    }
    let scale = view_scale(view);
    if scale <= f64::EPSILON {
        return Vec::new();
    }
    let [.., e, f] = view.as_coeffs();
    let size = f64::from(TILE_SIZE);

    let w = f64::from(viewport_w);
    let h = f64::from(viewport_h);
    let x_min = ((0.0 - e) / size).floor() as i32;
    let x_max = ((w - e) / size).ceil() as i32 - 1;
    let y_min = ((0.0 - f) / size).floor() as i32;
    let y_max = ((h - f) / size).ceil() as i32 - 1;

    let bucket = zoom_bucket(scale);
    let mut tiles = Vec::new();
    for tile_y in y_min..=y_max {
        for tile_x in x_min..=x_max {
            tiles.push(TileKey {
                tile_x,
                tile_y,
                zoom_bucket: bucket,
            });
        }
    }
    tiles
}

/// Where a tile's content-square (its centre [`TILE_SIZE`]) lands on the device viewport, as
/// `(x, y)` of its top-left corner. In slice 1 this is a 1:1 composite target.
#[must_use]
pub fn tile_device_origin(key: TileKey, view: Affine) -> (f64, f64) {
    let [.., e, f] = view.as_coeffs();
    let size = f64::from(TILE_SIZE);
    (e + f64::from(key.tile_x) * size, f + f64::from(key.tile_y) * size)
}

/// A page rect grown to cover whole tiles — the region that actually gets re-rendered when this
/// rect is dirty.
///
/// Dirty tracking is per-rect but rendering is per-tile, so a one-pixel edit re-renders its whole
/// [`TILE_SIZE`] tile. Anything reasoning about *what a frame will repaint* (rather than what the
/// user touched) has to work in these units: a gather whose sample rect misses the edit but overlaps
/// the edit's tile still has its blur re-run there, and so still has to be invalidated as a whole.
#[must_use]
pub fn tile_aligned_page_rect(view: Affine, page: Rect) -> Rect {
    let (dx, dy, dw, dh) = device_rect(view, page);
    let [.., e, f] = view.as_coeffs();
    let size = f64::from(TILE_SIZE);
    let snap = |v: f64, origin: f64, up: bool| {
        let t = (v - origin) / size;
        origin + (if up { t.ceil() } else { t.floor() }) * size
    };
    let (x0, y0) = (snap(dx, e, false), snap(dy, f, false));
    let (x1, y1) = (snap(dx + dw, e, true), snap(dy + dh, f, true));
    let inv = view.inverse();
    let mut r = Rect::from_points(inv * Point::new(x0, y0), inv * Point::new(x1, y1));
    for p in [inv * Point::new(x1, y0), inv * Point::new(x0, y1)] {
        r = r.union_pt(p);
    }
    r
}

/// The part of a tile's content-square that falls inside a device-space rect, as
/// `(x, y, w, h)` in device space, or `None` when they do not overlap.
///
/// A tile is a full [`TILE_SIZE`] square and generally overhangs whatever region is being composed
/// from it, so anything that composes tiles into a **shared** target — the batched gather atlas,
/// where each lens owns only its own cell — has to clip explicitly. A dedicated per-lens surface
/// gets the same clip for free from its own bounds; an atlas cell does not, and an unclipped blit
/// silently paints its neighbour's cell (a lens then blurs another region's content).
#[must_use]
pub fn tile_clip_device(key: TileKey, view: Affine, rect: (f64, f64, f64, f64)) -> Option<(f64, f64, f64, f64)> {
    let (ox, oy) = tile_device_origin(key, view);
    let size = f64::from(TILE_SIZE);
    let (rx, ry, rw, rh) = rect;
    let x0 = ox.max(rx);
    let y0 = oy.max(ry);
    let x1 = (ox + size).min(rx + rw);
    let y1 = (oy + size).min(ry + rh);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some((x0, y0, x1 - x0, y1 - y0))
}

/// The page→buffer transform for rendering one tile into its [`TILE_BUFFER`]² buffer: the same
/// view transform, post-translated in device space so the tile's content-origin lands at
/// `(TILE_MARGIN, TILE_MARGIN)` — i.e. the content sits centred with a full margin all around.
/// Rotation-general (it is a device-space translation composed onto `view`).
#[must_use]
pub fn tile_render_transform(key: TileKey, view: Affine) -> Affine {
    let (ox, oy) = tile_device_origin(key, view);
    let margin = f64::from(TILE_MARGIN);
    Affine::translate((margin - ox, margin - oy)) * view
}

/// The page-space tiles whose content region a page-space rectangle overlaps under `view`.
///
/// This is the *spatial half of scheduling an effect*: an effect (drop shadow, layer blur) is
/// produced once on a surface sized to the shape's `extrect` (the selrect grown by the shadow
/// offset, blur reach and spread), then composited into **every** tile that extrect overlaps —
/// including the neighbours it spills into. Running the blur per-tile instead truncates its input
/// at the tile margin and seams; producing once and scheduling the surface into each overlapped
/// tile is what keeps a large or offset effect correct at any zoom.
///
/// Mirrors [`visible_tiles`]'s grid convention — tile `k` spans the half-open device interval
/// `[e + k·512, e + (k+1)·512)` — but bounds the sweep to the rect's device bbox instead of the
/// viewport. Empty when the rect or the scale is degenerate. Assumes a scale + translation `view`
/// (the effect rect is axis-aligned in page space; a rotated view would need a device-space sweep).
#[must_use]
pub fn tiles_overlapping_page_rect(view: Affine, rect: Rect) -> Vec<TileKey> {
    let scale = view_scale(view);
    if scale <= f64::EPSILON || rect.width() <= 0.0 || rect.height() <= 0.0 {
        return Vec::new();
    }
    let corners = [
        view * Point::new(rect.x0, rect.y0),
        view * Point::new(rect.x1, rect.y0),
        view * Point::new(rect.x1, rect.y1),
        view * Point::new(rect.x0, rect.y1),
    ];
    let (mut dx0, mut dy0, mut dx1, mut dy1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in corners {
        dx0 = dx0.min(p.x);
        dy0 = dy0.min(p.y);
        dx1 = dx1.max(p.x);
        dy1 = dy1.max(p.y);
    }
    let [.., e, f] = view.as_coeffs();
    let size = f64::from(TILE_SIZE);
    let x_min = ((dx0 - e) / size).floor() as i32;
    let x_max = ((dx1 - e) / size).ceil() as i32 - 1;
    let y_min = ((dy0 - f) / size).floor() as i32;
    let y_max = ((dy1 - f) / size).ceil() as i32 - 1;
    if x_max < x_min || y_max < y_min {
        return Vec::new();
    }
    let bucket = zoom_bucket(scale);
    let mut tiles = Vec::new();
    for tile_y in y_min..=y_max {
        for tile_x in x_min..=x_max {
            tiles.push(TileKey { tile_x, tile_y, zoom_bucket: bucket });
        }
    }
    tiles
}

/// Device-space bbox `(x, y, w, h)` of a page-space rect under `view`, **snapped to integer pixels**
/// (floor the origin, ceil the far corner). Integer alignment is load-bearing for effect surfaces:
/// the surface is rendered at `translate(-origin)` and composited 1:1 at `origin`, so an integer
/// origin keeps the composite a pixel-exact blit (no bilinear resample of a shadow) *and* preserves
/// the shape's sub-pixel phase inside the surface — both needed to match the direct-draw ground
/// truth. Backend-neutral: every GPU sink needs this identically to place an effect surface, so it
/// lives here beside [`tile_device_origin`] rather than being re-derived per backend.
#[must_use]
pub fn device_rect(view: Affine, page: Rect) -> (f64, f64, f64, f64) {
    let corners = [
        view * Point::new(page.x0, page.y0),
        view * Point::new(page.x1, page.y0),
        view * Point::new(page.x1, page.y1),
        view * Point::new(page.x0, page.y1),
    ];
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in corners {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    let (x0, y0) = (x0.floor(), y0.floor());
    (x0, y0, (x1.ceil() - x0).max(1.0), (y1.ceil() - y0).max(1.0))
}

/// The resolution-cap factor `k ∈ (0, 1]` for an effect whose page-space reach is `reach`, under
/// `view`. `1.0` while the reach fits one tile in device space; below that it shrinks so
/// `reach · zoom · k == TILE_SIZE`, keeping every gather read/write inside the current tile's
/// one-tile ring. The stamp then upscales the reduced result by `1/k`. `reach ≤ 0` (no effect
/// spread) → `1.0`, i.e. draw at native zoom.
///
/// `zoom` here is the x-axis column norm (`√(a²+b²)`), matching the device-scale the sink uses for
/// sigma / glass geometry; for the scale+translate views the canvas produces this equals
/// [`view_scale`]. Backend-neutral policy: any GPU backend caps the same way, so it lives in core.
#[must_use]
pub fn resolution_cap(view: Affine, reach: f64) -> f64 {
    if reach <= 0.0 {
        return 1.0;
    }
    let [a, b, ..] = view.as_coeffs();
    let zoom = (a * a + b * b).sqrt();
    let device_reach = reach * zoom;
    let budget = f64::from(TILE_SIZE);
    if device_reach <= budget {
        1.0
    } else {
        budget / device_reach
    }
}

/// The backend-owned tile store (D18). `render-core` decides *which* tiles ([`visible_tiles`])
/// and *how they map* ([`tile_render_transform`] / [`tile_device_origin`]); the backend owns how a
/// tile is physically rendered and composited. Deliberately minimal — the cache, eviction, atlas
/// and any strip/picture caching live entirely behind this in the backend, so neither the Vello
/// texture-atlas path nor a Skia `SkPicture` path is constrained by a shape chosen here.
pub trait TileStore {
    /// Render the tile into a backend buffer using `render_transform` (from
    /// [`tile_render_transform`]) to place its content.
    fn render_tile(&mut self, key: TileKey, render_transform: Affine);

    /// Composite the given tiles' content-squares onto the frame target at their device rects
    /// (from [`tile_device_origin`], under `view`).
    fn composite(&mut self, keys: &[TileKey], view: Affine);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_is_content_plus_two_margins() {
        assert_eq!(TILE_BUFFER, TILE_SIZE + 2 * TILE_MARGIN);
        assert!(TILE_MARGIN > 0);
    }

    #[test]
    fn identity_view_tiles_the_viewport_from_the_origin() {
        let tiles = visible_tiles(Affine::IDENTITY, 1024, 512);
        assert_eq!(tiles.len(), 2);
        assert!(tiles.iter().any(|t| t.tile_x == 0 && t.tile_y == 0));
        assert!(tiles.iter().any(|t| t.tile_x == 1 && t.tile_y == 0));
        assert_eq!(visible_tiles(Affine::IDENTITY, 1025, 512).len(), 3);
    }

    #[test]
    fn a_pan_shifts_which_tiles_are_visible_by_an_integer() {
        let base = visible_tiles(Affine::IDENTITY, 1024, 512);
        let panned = visible_tiles(Affine::translate((-512.0, 0.0)), 1024, 512);
        assert_eq!(base.len(), panned.len());
        assert!(panned.iter().any(|t| t.tile_x == 1));
        assert!(panned.iter().any(|t| t.tile_x == 2));
    }

    #[test]
    fn a_sub_tile_pan_can_expose_one_more_column() {
        let tiles = visible_tiles(Affine::translate((256.0, 0.0)), 1024, 512);
        assert!(tiles.iter().any(|t| t.tile_x == -1));
        assert!(tiles.iter().any(|t| t.tile_x == 1));
        assert!(!tiles.iter().any(|t| t.tile_x == 2));
    }

    #[test]
    fn render_transform_centres_the_tile_content_in_the_buffer() {
        let view = Affine::new([2.0, 0.0, 0.0, 2.0, 30.0, 40.0]);
        let key = TileKey {
            tile_x: 3,
            tile_y: 1,
            zoom_bucket: zoom_bucket(2.0),
        };
        let (ox, oy) = tile_device_origin(key, view);
        let m = tile_render_transform(key, view);
        let page_origin = view.inverse() * kurbo::Point::new(ox, oy);
        let in_buffer = m * page_origin;
        assert!((in_buffer.x - f64::from(TILE_MARGIN)).abs() < 1e-9);
        assert!((in_buffer.y - f64::from(TILE_MARGIN)).abs() < 1e-9);
    }

    #[test]
    fn device_origin_steps_by_tile_size_and_tracks_the_pan() {
        let view = Affine::translate((10.0, 20.0));
        let a = tile_device_origin(
            TileKey { tile_x: 0, tile_y: 0, zoom_bucket: 0 },
            view,
        );
        let b = tile_device_origin(
            TileKey { tile_x: 1, tile_y: 2, zoom_bucket: 0 },
            view,
        );
        assert!((a.0 - 10.0).abs() < 1e-9 && (a.1 - 20.0).abs() < 1e-9);
        assert!((b.0 - (10.0 + 512.0)).abs() < 1e-9);
        assert!((b.1 - (20.0 + 2.0 * 512.0)).abs() < 1e-9);
    }

    #[test]
    fn a_small_effect_rect_schedules_into_only_its_own_tile() {
        let tiles = tiles_overlapping_page_rect(Affine::IDENTITY, Rect::new(40.0, 40.0, 300.0, 300.0));
        assert_eq!(tiles.len(), 1);
        assert_eq!((tiles[0].tile_x, tiles[0].tile_y), (0, 0));
    }

    #[test]
    fn an_effect_spilling_past_a_tile_edge_schedules_into_the_neighbour() {
        let tiles = tiles_overlapping_page_rect(Affine::IDENTITY, Rect::new(400.0, 100.0, 620.0, 300.0));
        assert!(tiles.iter().any(|t| (t.tile_x, t.tile_y) == (0, 0)));
        assert!(tiles.iter().any(|t| (t.tile_x, t.tile_y) == (1, 0)));
        assert_eq!(tiles.len(), 2);
    }

    #[test]
    fn zoom_grows_the_scheduled_tile_set() {
        let rect = Rect::new(100.0, 100.0, 400.0, 400.0);
        let at1 = tiles_overlapping_page_rect(Affine::IDENTITY, rect);
        let at2 = tiles_overlapping_page_rect(Affine::scale(2.0), rect);
        assert_eq!(at1.len(), 1);
        assert_eq!(at2.len(), 4);
        assert_ne!(at1[0].zoom_bucket, at2[0].zoom_bucket);
    }

    #[test]
    fn a_degenerate_effect_rect_schedules_nowhere() {
        assert!(tiles_overlapping_page_rect(Affine::IDENTITY, Rect::new(10.0, 10.0, 10.0, 40.0)).is_empty());
        assert!(tiles_overlapping_page_rect(Affine::scale(0.0), Rect::new(0.0, 0.0, 50.0, 50.0)).is_empty());
    }

    #[test]
    fn tile_clip_device_keeps_a_tile_inside_its_own_rect() {
        let view = Affine::IDENTITY;
        let b = (613.0, 613.0, 474.0, 474.0);
        let t11 = TileKey { tile_x: 1, tile_y: 1, zoom_bucket: 0 };
        assert_eq!(tile_clip_device(t11, view, b), Some((613.0, 613.0, 411.0, 411.0)));
        let t21 = TileKey { tile_x: 2, tile_y: 1, zoom_bucket: 0 };
        assert_eq!(tile_clip_device(t21, view, b), Some((1024.0, 613.0, 63.0, 411.0)));
        let a = (38.0, 38.0, 474.0, 474.0);
        let t00 = TileKey { tile_x: 0, tile_y: 0, zoom_bucket: 0 };
        assert_eq!(tile_clip_device(t00, view, a), Some((38.0, 38.0, 474.0, 474.0)));
        assert_eq!(tile_clip_device(t11, view, a), None);
        for tx in 0..4 {
            for ty in 0..4 {
                let k = TileKey { tile_x: tx, tile_y: ty, zoom_bucket: 0 };
                if let Some((x, y, w, h)) = tile_clip_device(k, view, b) {
                    assert!(x >= b.0 && y >= b.1, "clip starts before the rect");
                    assert!(x + w <= b.0 + b.2 && y + h <= b.1 + b.3, "clip runs past the rect");
                }
            }
        }
    }

    #[test]
    fn device_rect_snaps_to_integer_pixels_and_is_never_degenerate() {
        let view = Affine::new([2.0, 0.0, 0.0, 2.0, 10.5, 20.25]);
        let (x, y, w, h) = device_rect(view, Rect::new(5.0, 5.0, 6.0, 6.0));
        assert_eq!((x, y), (20.0, 30.0));
        assert_eq!((w, h), (3.0, 3.0));
        let (_, _, w0, h0) = device_rect(Affine::IDENTITY, Rect::new(4.0, 4.0, 4.0, 4.0));
        assert!(w0 >= 1.0 && h0 >= 1.0);
    }

    #[test]
    fn resolution_cap_is_one_until_the_reach_exceeds_a_tile_then_shrinks() {
        assert_eq!(resolution_cap(Affine::IDENTITY, 100.0), 1.0);
        assert_eq!(resolution_cap(Affine::IDENTITY, 0.0), 1.0);
        assert_eq!(resolution_cap(Affine::IDENTITY, -5.0), 1.0);
        assert_eq!(resolution_cap(Affine::IDENTITY, f64::from(TILE_SIZE)), 1.0);
        let k = resolution_cap(Affine::scale(4.0), f64::from(TILE_SIZE));
        assert!((k - 0.25).abs() < 1e-9);
        assert!((f64::from(TILE_SIZE) * 4.0 * k - f64::from(TILE_SIZE)).abs() < 1e-6);
    }

    #[test]
    fn zoom_buckets_separate_octaves_and_a_degenerate_view_has_no_tiles() {
        assert_ne!(zoom_bucket(1.0), zoom_bucket(4.0));
        assert_eq!(zoom_bucket(1.0), zoom_bucket(1.0));
        assert!(visible_tiles(Affine::scale(0.0), 800, 600).is_empty());
        assert!(visible_tiles(Affine::IDENTITY, 0, 600).is_empty());
    }
}
