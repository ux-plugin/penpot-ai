//! Interest regions — rectangular slices of device space the frame materializes as values.
//!
//! A region names three things at once: a **source rect** in device space (what content it shows),
//! a **density** `k` (the texel scale its value is produced at), and a **grid allocation** (the
//! tile rows its draws bin into, so the frontend has somewhere to route its commands). The frame
//! itself is region 0 — source rect = the viewport, `k = 1`, grid allocation = the frame rows —
//! so nothing downstream is "the frame plus special extras": the pipeline renders N regions, one
//! of which happens to be big.
//!
//! Regions 1..N rent tile rows BELOW the frame (the grid is one shared address space; per-region
//! grids are a later upgrade that would retire this renting). Their rows are pure bin/compute
//! addresses: content drawn there stores into scratch leases via the ordinary output-record
//! mechanism, never into the accumulator — which is why [`RegionTable::frame_height`] (the
//! accumulator's height) and [`RegionTable::grid_height`] (the tile grid's height) are distinct
//! numbers the sink must not conflate.

/// Grid rows and shelf coordinates are tile-aligned; this mirrors the fine pass's 16px tile.
const TILE_PX: u32 = 16;

/// One region: a device-space source rect materialized at density `k` into a value, binned into
/// `grid` (a tile-aligned pixel rect of the shared grid).
#[derive(Clone, Debug, PartialEq)]
pub struct RegionDesc {
    /// Device-space rect this region's value shows (region 0: the viewport).
    pub source: [f64; 4],
    /// Texel density relative to device scale (region 0: exactly 1).
    pub k: f64,
    /// The grid real estate its draws bin into: `[x0, y0, x1, y1]` in pixels, tile-aligned.
    /// Region 0: the frame rows. Regions 1..N: shelves below `frame_height`.
    pub grid: [u32; 4],
    /// The gather that demanded it (`None` for region 0).
    pub reader: Option<u128>,
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
    shelf_x: u32,
    shelf_y: u32,
    shelf_h: u32,
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
                reader: None,
            }],
            frame_w: width,
            frame_h: height,
            shelf_x: 0,
            shelf_y: height.div_ceil(TILE_PX) * TILE_PX,
            shelf_h: 0,
        }
    }

    /// Rent grid rows below the frame for a region showing `source` at density `k`, shelf-packed
    /// left-to-right, opening a new shelf row when the current one is full. Returns the region's
    /// index, or `None` when the scaled rect cannot fit the grid width or would push the grid past
    /// `max_grid_h` (the caller's texture-dimension ceiling).
    pub fn allocate(
        &mut self,
        source: [f64; 4],
        k: f64,
        reader: Option<u128>,
        max_grid_h: u32,
    ) -> Option<usize> {
        let w = (((source[2] - source[0]) * k).ceil() as u32).div_ceil(TILE_PX) * TILE_PX;
        let h = (((source[3] - source[1]) * k).ceil() as u32).div_ceil(TILE_PX) * TILE_PX;
        if w == 0 || h == 0 || w > self.frame_w {
            return None;
        }
        if self.shelf_x + w > self.frame_w {
            self.shelf_y += self.shelf_h;
            self.shelf_x = 0;
            self.shelf_h = 0;
        }
        if self.shelf_y + h > max_grid_h {
            return None;
        }
        let grid = [self.shelf_x, self.shelf_y, self.shelf_x + w, self.shelf_y + h];
        self.shelf_x += w;
        self.shelf_h = self.shelf_h.max(h);
        self.regions.push(RegionDesc { source, k, grid, reader });
        Some(self.regions.len() - 1)
    }

    /// The accumulator's height: the frame rows only. Region rows never land in the accumulator.
    #[must_use]
    pub fn frame_height(&self) -> u32 {
        self.frame_h
    }

    /// The first rented grid row — where region shelves start (frame height, tile-ceiled). The
    /// region atlas maps grid rows `[band_origin_y, grid_height)` one-to-one: a lease's atlas
    /// origin is its grid origin minus `(0, band_origin_y)`.
    #[must_use]
    pub fn band_origin_y(&self) -> u32 {
        self.frame_h.div_ceil(TILE_PX) * TILE_PX
    }

    /// The tile grid's height: the frame rows plus every rented shelf, tile-aligned. This is the
    /// scene/coarse/fine addressing domain — always ≥ [`Self::frame_height`].
    #[must_use]
    pub fn grid_height(&self) -> u32 {
        if self.regions.len() == 1 {
            return self.frame_h;
        }
        (self.shelf_y + self.shelf_h).div_ceil(TILE_PX) * TILE_PX
    }

    /// The affine mapping device coordinates into region `i`'s grid rect: translate the source
    /// origin away, scale by `k`, translate onto the grid allocation.
    #[must_use]
    pub fn device_to_grid(&self, i: usize) -> crate::kurbo::Affine {
        let r = &self.regions[i];
        crate::kurbo::Affine::translate((f64::from(r.grid[0]), f64::from(r.grid[1])))
            * crate::kurbo::Affine::scale(r.k)
            * crate::kurbo::Affine::translate((-r.source[0], -r.source[1]))
    }
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
    fn allocate_rents_rows_below_the_frame() {
        let mut t = RegionTable::frame(1216, 622);
        let a = t.allocate([-100.0, 0.0, 0.0, 50.0], 1.0, Some(7), 8192).unwrap();
        let g = t.regions[a].grid;
        assert_eq!(g[1], 624);
        assert_eq!(g[2] - g[0], 112);
        assert_eq!(g[3] - g[1], 64);
        assert!(t.grid_height() >= g[3]);
        assert_eq!(t.frame_height(), 622);
    }

    #[test]
    fn shelves_wrap_and_ceiling_holds() {
        let mut t = RegionTable::frame(256, 128);
        let mut last_y = 0;
        for i in 0..5 {
            let idx = t.allocate([0.0, 0.0, 100.0, 30.0], 1.0, Some(i), 8192).unwrap();
            last_y = t.regions[idx].grid[1];
        }
        assert!(last_y > 128);
        assert!(t.allocate([0.0, 0.0, 100.0, 30.0], 1.0, Some(9), 160).is_none());
    }

    #[test]
    fn k_scales_the_rented_rect_and_the_mapping() {
        let mut t = RegionTable::frame(1024, 512);
        let i = t.allocate([1024.0, 0.0, 1224.0, 100.0], 0.5, Some(3), 8192).unwrap();
        let (w, h) = t.regions[i].texel_size();
        assert_eq!(w, 112);
        assert_eq!(h, 64);
        let m = t.device_to_grid(i);
        let p = m * crate::kurbo::Point::new(1024.0, 0.0);
        assert!((p.x - f64::from(t.regions[i].grid[0])).abs() < 1e-9);
        assert!((p.y - f64::from(t.regions[i].grid[1])).abs() < 1e-9);
        let q = m * crate::kurbo::Point::new(1224.0, 100.0);
        assert!((q.x - f64::from(t.regions[i].grid[0]) - 100.0).abs() < 1e-9);
        assert!((q.y - f64::from(t.regions[i].grid[1]) - 50.0).abs() < 1e-9);
    }
}
