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
/// `group` scopes slot reuse: a freed slot is retaken only by an item of the same group. Host
/// packing groups by owner gid — the per-tile PTCL walk early-breaks at the first marker past the
/// window, so a tile's marker rounds must be stream-monotone, which holds within one gid's
/// round-sorted marks and cannot be promised across gids. Lease packing passes one group for all.
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
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by_key(|&i| (items[i].birth, i));
    let mut slots: std::collections::HashMap<(u32, u32), Vec<(u32, u128, [u32; 2])>> =
        std::collections::HashMap::new();
    let (mut cur_x, mut cur_y, mut row_h) = (0u32, 0u32, 0u32);
    let mut out = vec![None; items.len()];
    for &i in &order {
        let it = items[i];
        if it.w == 0 || it.h == 0 || it.w > width {
            continue;
        }
        let class = slots.entry((it.w, it.h)).or_default();
        if let Some(s) = class
            .iter_mut()
            .find(|(until, group, _)| *until < it.birth && *group == it.group)
        {
            s.0 = it.death;
            out[i] = Some(s.2);
            continue;
        }
        if cur_x + it.w > width {
            cur_y += row_h;
            cur_x = 0;
            row_h = 0;
        }
        if cur_y + it.h > cap {
            continue;
        }
        let pos = [cur_x, cur_y];
        cur_x += it.w;
        row_h = row_h.max(it.h);
        class.push((it.death, it.group, pos));
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
        let cross = [
            IntervalRect { w: 96, h: 32, birth: 1, death: 2, group: 7 },
            IntervalRect { w: 96, h: 32, birth: 3, death: 4, group: 9 },
        ];
        let c = interval_shelf(&cross, 256, 1024);
        assert_ne!(c[0], c[1], "a slot never crosses gid groups");
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
