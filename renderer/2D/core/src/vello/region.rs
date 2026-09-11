//! Interest regions — rectangular slices of device space the frame materializes as values.
//!
//! A region names four things: a **source rect** in device space (what content it shows), a
//! **density** `k` (the texel scale its value is produced at), a **host** rect (`grid` — the tile
//! rows its windows bin and draw into), and a **lease** origin (where its value lives in the
//! atlas). The frame itself is region 0 — source rect = the viewport, `k = 1`, host = the frame
//! rows — so nothing downstream is "the frame plus special extras": the pipeline renders N
//! regions, one of which happens to be big.
//!
//! Hosts and leases are allocated by the sink's interval packers ([`interval_shelf`]) AFTER the
//! schedule exists: a host is rented only for the rounds the region's windows run, a lease only
//! for the rounds its value is written and read, so rows recycle across time instead of renting
//! for the whole frame. [`RegionTable::allocate`] just registers the region's size;
//! [`RegionTable::place`] lands the packed addresses.

/// Grid rows and lease coordinates are tile-aligned; this mirrors the fine pass's 16px tile.
const TILE_PX: u32 = 16;

/// One region: a device-space source rect materialized at density `k` into a value, hosted at
/// `grid` (a tile-aligned pixel rect of the shared grid) and stored at `lease` (its atlas origin).
#[derive(Clone, Debug, PartialEq)]
pub struct RegionDesc {
    /// Device-space rect this region's value shows (region 0: the viewport).
    pub source: [f64; 4],
    /// Texel density relative to device scale (region 0: exactly 1).
    pub k: f64,
    /// The HOST: the grid rect its windows bin and draw into, `[x0, y0, x1, y1]` in pixels,
    /// tile-aligned. Region 0: the frame rows. Regions 1..N: rows below `frame_height`, shared
    /// across regions whose windows run in disjoint rounds.
    pub grid: [u32; 4],
    /// The LEASE: the value's origin in the region atlas. Same texel size as the host rect.
    pub lease: [u32; 2],
}

impl RegionDesc {
    /// The region's value size in texels — its grid rect's dimensions.
    #[must_use]
    pub fn texel_size(&self) -> (u32, u32) {
        (self.grid[2] - self.grid[0], self.grid[3] - self.grid[1])
    }
}

/// The frame's region set: region 0 (the frame) plus any demand regions, and the derived grid
/// geometry. Built fresh each frame by the planner; the executor only reads it.
#[derive(Clone, Debug)]
pub struct RegionTable {
    pub regions: Vec<RegionDesc>,
    frame_w: u32,
    frame_h: u32,
    host_h: u32,
    atlas_h: u32,
}

impl RegionTable {
    /// A table holding only region 0: the viewport at density 1 on the frame rows.
    #[must_use]
    pub fn frame(width: u32, height: u32) -> Self {
        Self {
            regions: vec![RegionDesc {
                source: [0.0, 0.0, f64::from(width), f64::from(height)],
                k: 1.0,
                grid: [0, 0, width, height],
                lease: [0, 0],
            }],
            frame_w: width,
            frame_h: height,
            host_h: 0,
            atlas_h: 0,
        }
    }

    /// Register a region showing `source` at density `k`. Sizes only — the host and lease
    /// addresses land later via [`Self::place`], once the schedule's rounds let the packers
    /// time-share rows. `None` when the scaled rect is degenerate or wider than the grid.
    pub fn allocate(&mut self, source: [f64; 4], k: f64) -> Option<usize> {
        let w = (((source[2] - source[0]) * k).ceil() as u32).div_ceil(TILE_PX) * TILE_PX;
        let h = (((source[3] - source[1]) * k).ceil() as u32).div_ceil(TILE_PX) * TILE_PX;
        if w == 0 || h == 0 || w > self.frame_w {
            return None;
        }
        self.regions.push(RegionDesc { source, k, grid: [0, 0, w, h], lease: [0, 0] });
        Some(self.regions.len() - 1)
    }

    /// Register a lease-only region: a combine block wider than the grid. It owns store rows but
    /// no grid host — its content arrives through chunk regions whose leases tile its span — so
    /// the grid-width gate does not apply. `None` only when degenerate or wider than the store.
    pub fn allocate_lease_only(&mut self, source: [f64; 4], k: f64) -> Option<usize> {
        let w = (((source[2] - source[0]) * k).ceil() as u32).div_ceil(TILE_PX) * TILE_PX;
        let h = (((source[3] - source[1]) * k).ceil() as u32).div_ceil(TILE_PX) * TILE_PX;
        if w == 0 || h == 0 || w > 8192 {
            return None;
        }
        self.regions.push(RegionDesc { source, k, grid: [0, 0, w, h], lease: [0, 0] });
        Some(self.regions.len() - 1)
    }

    /// Land a lease-only region's store address. The grid keeps its size-only origin form —
    /// nothing ever draws into this region directly, so it rents no host rows;
    /// [`Self::atlas_height`] still accounts its lease rows.
    pub fn place_lease_only(&mut self, i: usize, lease: [u32; 2]) {
        let (_, h) = self.regions[i].texel_size();
        self.regions[i].lease = lease;
        self.atlas_h = self.atlas_h.max(lease[1] + h);
    }

    /// Land region `i`'s packed addresses: `host` is its grid origin (absolute, at or below
    /// [`Self::band_origin_y`]), `lease` its atlas origin.
    pub fn place(&mut self, i: usize, host: [u32; 2], lease: [u32; 2]) {
        let (w, h) = self.regions[i].texel_size();
        self.regions[i].grid = [host[0], host[1], host[0] + w, host[1] + h];
        self.regions[i].lease = lease;
        self.host_h = self.host_h.max(host[1] + h - self.band_origin_y());
        self.atlas_h = self.atlas_h.max(lease[1] + h);
    }

    /// The accumulator's height: the frame rows only. Region rows never land in the accumulator.
    #[must_use]
    pub fn frame_height(&self) -> u32 {
        self.frame_h
    }

    /// The first hosted grid row — where region hosts start (frame height, tile-ceiled).
    #[must_use]
    pub fn band_origin_y(&self) -> u32 {
        self.frame_h.div_ceil(TILE_PX) * TILE_PX
    }

    /// The tile grid's height: the frame rows plus every hosted row, tile-aligned. This is the
    /// scene/coarse/fine addressing domain — always ≥ [`Self::frame_height`].
    #[must_use]
    pub fn grid_height(&self) -> u32 {
        if self.host_h == 0 {
            return self.frame_h;
        }
        self.band_origin_y() + self.host_h
    }

    /// The region atlas height: the packed lease rows, tile-aligned. Zero when nothing placed.
    #[must_use]
    pub fn atlas_height(&self) -> u32 {
        self.atlas_h
    }

    /// The affine mapping device coordinates into region `i`'s host rect: translate the source
    /// origin away, scale by `k`, translate onto the grid allocation.
    #[must_use]
    pub fn device_to_grid(&self, i: usize) -> crate::kurbo::Affine {
        let r = &self.regions[i];
        crate::kurbo::Affine::translate((f64::from(r.grid[0]), f64::from(r.grid[1])))
            * crate::kurbo::Affine::scale(r.k)
            * crate::kurbo::Affine::translate((-r.source[0], -r.source[1]))
    }
}

/// One item for [`interval_shelf`]: a `w × h` rect alive over rounds `[birth, death]` (inclusive).
/// `group` ORDERS slot reuse: a freed slot is retaken only by an item whose group is ≥ the
/// tenant's. The per-tile PTCL walk early-breaks at the first marker past the window, so a tile's
/// marker rounds must be stream-monotone; host packing passes the owner gid's GATHER INDEX — a
/// stream-later gid whose rounds start after the tenant's death keeps the tile monotone, so
/// ordered reuse is sound where same-gid-only reuse was needlessly narrow. `u128::MAX` marks an
/// unknown owner: it never reuses and is never reused. Lease packing passes zero for all (leases
/// carry no markers, any disjoint interval may share).
#[derive(Clone, Copy, Debug)]
pub struct IntervalRect {
    pub w: u32,
    pub h: u32,
    pub birth: u32,
    pub death: u32,
    pub group: u128,
}

/// Interval shelf packing: place each item in a `width × cap` space so that two items share an
/// address only when their round intervals are disjoint (strictly — equal rounds share a dispatch,
/// so no barrier orders a reuse). Slots are exact-size classes: a slot's position is permanent for
/// the frame, its occupancy recycles by interval, and new slots come from one monotone shelf
/// cursor. Returns each item's origin, `None` for an item that cannot place (over `cap` at its
/// peak concurrency, or wider than `width`).
#[must_use]
pub fn interval_shelf(items: &[IntervalRect], width: u32, cap: u32) -> Vec<Option<[u32; 2]>> {
    interval_shelf_ext(items, width, cap, false)
}

/// [`interval_shelf`] with `loose` slot reuse: a dead slot may be retaken by a SMALLER item
/// (up to 2× slot area waste) instead of only an exact size match. Hosts pack loose — windows
/// dispatch only the region's own tiles, so a larger slot's idle remainder costs rows, not
/// correctness; leases stay exact, their guard reads must never touch a stale margin.
pub fn interval_shelf_ext(
    items: &[IntervalRect],
    width: u32,
    cap: u32,
    loose: bool,
) -> Vec<Option<[u32; 2]>> {
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by_key(|&i| (items[i].birth, i));
    let mut slots: Vec<(u32, u128, [u32; 2], u32, u32)> = Vec::new();
    let mut rows: Vec<(u32, u32, u32)> = Vec::new();
    let mut cur_y = 0u32;
    let mut out = vec![None; items.len()];
    for &i in &order {
        let it = items[i];
        if it.w == 0 || it.h == 0 || it.w > width {
            continue;
        }
        let fit = slots
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                let size_ok = if loose {
                    s.3 >= it.w
                        && s.4 >= it.h
                        && u64::from(s.3) * u64::from(s.4) <= 4 * u64::from(it.w) * u64::from(it.h)
                } else {
                    s.3 == it.w && s.4 == it.h
                };
                s.0 < it.birth && it.group < u128::MAX && s.1 <= it.group && size_ok
            })
            .min_by_key(|(_, s)| u64::from(s.3) * u64::from(s.4))
            .map(|(j, _)| j);
        if let Some(j) = fit {
            slots[j].0 = it.death;
            slots[j].1 = it.group;
            out[i] = Some(slots[j].2);
            continue;
        }
        let row = rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r.1 >= it.h && r.2 + it.w <= width)
            .min_by_key(|(_, r)| r.1)
            .map(|(j, _)| j);
        let row = match row {
            Some(j) => j,
            None => {
                if cur_y + it.h > cap {
                    continue;
                }
                rows.push((cur_y, it.h, 0));
                cur_y += it.h;
                rows.len() - 1
            }
        };
        let pos = [rows[row].2, rows[row].0];
        rows[row].2 += it.w;
        slots.push((it.death, it.group, pos, it.w, it.h));
        out[i] = Some(pos);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_only_table_is_the_viewport() {
        let t = RegionTable::frame(1216, 622);
        assert_eq!(t.regions.len(), 1);
        assert_eq!(t.frame_height(), 622);
        assert_eq!(t.grid_height(), 622);
        assert_eq!(t.regions[0].grid, [0, 0, 1216, 622]);
        assert!((t.regions[0].k - 1.0).abs() < 1e-12);
    }

    #[test]
    fn place_lands_host_and_lease_and_extends_the_grid() {
        let mut t = RegionTable::frame(1216, 622);
        let a = t.allocate([-100.0, 0.0, 0.0, 50.0], 1.0).unwrap();
        let band = t.band_origin_y();
        t.place(a, [0, band], [0, 0]);
        let g = t.regions[a].grid;
        assert_eq!(g, [0, band, 112, band + 64]);
        assert_eq!(t.regions[a].lease, [0, 0]);
        assert_eq!(t.grid_height(), band + 64);
        assert_eq!(t.atlas_height(), 64);
        assert_eq!(t.frame_height(), 622);
    }

    #[test]
    fn k_scales_the_registered_rect_and_the_mapping() {
        let mut t = RegionTable::frame(1024, 512);
        let i = t.allocate([1024.0, 0.0, 1224.0, 100.0], 0.5).unwrap();
        let (w, h) = t.regions[i].texel_size();
        assert_eq!(w, 112);
        assert_eq!(h, 64);
        let band = t.band_origin_y();
        t.place(i, [64, band], [16, 32]);
        let m = t.device_to_grid(i);
        let p = m * crate::kurbo::Point::new(1024.0, 0.0);
        assert!((p.x - f64::from(t.regions[i].grid[0])).abs() < 1e-9);
        assert!((p.y - f64::from(t.regions[i].grid[1])).abs() < 1e-9);
        let q = m * crate::kurbo::Point::new(1224.0, 100.0);
        assert!((q.x - f64::from(t.regions[i].grid[0]) - 100.0).abs() < 1e-9);
        assert!((q.y - f64::from(t.regions[i].grid[1]) - 50.0).abs() < 1e-9);
    }

    #[test]
    fn interval_shelf_reuses_disjoint_intervals_and_separates_live_ones() {
        let items = [
            IntervalRect { w: 96, h: 32, birth: 1, death: 2, group: 7 },
            IntervalRect { w: 96, h: 32, birth: 3, death: 4, group: 7 },
            IntervalRect { w: 96, h: 32, birth: 2, death: 5, group: 7 },
            IntervalRect { w: 96, h: 32, birth: 2, death: 2, group: 7 },
        ];
        let out = interval_shelf(&items, 256, 1024);
        assert_eq!(out[0], out[1], "disjoint intervals share one slot");
        assert_ne!(out[0], out[2], "overlapping intervals get distinct slots");
        assert_ne!(out[0], out[3], "an equal-round pair never shares (no barrier between)");
        assert!(out.iter().all(Option::is_some));
        let back = [
            IntervalRect { w: 96, h: 32, birth: 1, death: 2, group: 9 },
            IntervalRect { w: 96, h: 32, birth: 3, death: 4, group: 7 },
        ];
        let b = interval_shelf(&back, 256, 1024);
        assert_ne!(b[0], b[1], "a slot never flows to a stream-earlier group");
        let fwd = [
            IntervalRect { w: 96, h: 32, birth: 1, death: 2, group: 7 },
            IntervalRect { w: 96, h: 32, birth: 3, death: 4, group: 9 },
        ];
        let f = interval_shelf(&fwd, 256, 1024);
        assert_eq!(f[0], f[1], "a dead slot flows forward in stream order");
    }

    #[test]
    fn interval_shelf_caps_and_wraps() {
        let items = [
            IntervalRect { w: 200, h: 64, birth: 0, death: 9, group: 0 },
            IntervalRect { w: 200, h: 64, birth: 0, death: 9, group: 0 },
            IntervalRect { w: 200, h: 64, birth: 0, death: 9, group: 0 },
        ];
        let out = interval_shelf(&items, 256, 100);
        assert!(out[0].is_some());
        assert!(out[1].is_none(), "the second row would pass the cap");
        assert!(out[2].is_none());
    }
}
