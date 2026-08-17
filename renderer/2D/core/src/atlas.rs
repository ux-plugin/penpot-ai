//! Backend-neutral **atlas packing** (the geometry half of atlas batching).
//!
//! Rendering N independent surfaces as one atlas — pack each into its own cell of a single texture,
//! do ONE renderer pass, then copy each cell out — turns N render+submit pairs into one. *Which*
//! surfaces are independent (level-0 bodies / per-shape spread surfaces) is a schedule question; the
//! actual render and texture copies are backend wgpu; but deciding *where each cell goes* is pure
//! rectangle packing with no GPU in it, so it lives here and every backend shares it.
//!
//! Two shapes of packing, matching the two atlas call sites:
//! - [`pack_grid`]: equal fixed-size cells (the `TILE_BUFFER`² tile/scope bodies) in a near-square
//!   grid.
//! - [`shelf_pack`]: variable-size cells (each per-shape spread surface is its own `extrect`) laid
//!   out left-to-right with a gap, wrapping to a new shelf at a target width. The gap absorbs a
//!   blurred cell's 1px kernel spill so it cannot bleed into a neighbour.

/// Where one input cell lands in the atlas. `index` is the cell's position in the slice passed to
/// the packer, so the caller maps it back to its own candidate list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Placement {
    pub index: usize,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// A packed atlas: the texture size to allocate and where every cell goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packing {
    pub width: u32,
    pub height: u32,
    pub cells: Vec<Placement>,
}

/// Pack `count` equal `cell`×`cell` cells into a near-square grid (`ceil(√count)` columns). `None`
/// for `count == 0`, or if the atlas would exceed `max_dim` on either axis (the caller then falls
/// back to the per-surface path). Used for the fixed `TILE_BUFFER`² body atlas.
#[must_use]
pub fn pack_grid(count: usize, cell: u32, max_dim: u32) -> Option<Packing> {
    if count == 0 {
        return None;
    }
    let n = count as u32;
    let cols = (f64::from(n)).sqrt().ceil() as u32;
    let rows = n.div_ceil(cols);
    let (width, height) = (cols * cell, rows * cell);
    if width.max(height) > max_dim {
        return None;
    }
    let cells = (0..count)
        .map(|i| {
            let iu = i as u32;
            Placement { index: i, x: (iu % cols) * cell, y: (iu / cols) * cell, w: cell, h: cell }
        })
        .collect();
    Some(Packing { width, height, cells })
}

/// Shelf-pack variable-sized cells: place left-to-right, wrapping to a new shelf when the next cell
/// would pass `target_w` (itself clamped to `max_dim`), leaving `gap` px between cells and between
/// shelves. `None` for an empty input, or if the packed atlas would exceed `max_dim` on either axis.
/// Used for the per-shape spread-effect atlas, where `gap` keeps each cell's blur inside its bounds.
///
/// Cells wider than `target_w` still get placed (each alone on its shelf); the caller is expected to
/// have dropped any single cell already larger than `max_dim` before packing.
#[must_use]
pub fn shelf_pack(sizes: &[(u32, u32)], gap: u32, target_w: u32, max_dim: u32) -> Option<Packing> {
    if sizes.is_empty() {
        return None;
    }
    let target_w = target_w.min(max_dim);
    let mut cells = Vec::with_capacity(sizes.len());
    let (mut x, mut y, mut row_h, mut atlas_w) = (0u32, 0u32, 0u32, 0u32);
    for (i, &(w, h)) in sizes.iter().enumerate() {
        // Wrap to a new shelf when this cell would overflow the target width — but never on an empty
        // shelf (`x > 0`), so an oversize cell still gets placed rather than looping.
        if x + w > target_w && x > 0 {
            x = 0;
            y += row_h + gap;
            row_h = 0;
        }
        cells.push(Placement { index: i, x, y, w, h });
        x += w + gap;
        row_h = row_h.max(h);
        atlas_w = atlas_w.max(x);
    }
    let height = y + row_h;
    if atlas_w > max_dim || height > max_dim {
        return None;
    }
    Some(Packing { width: atlas_w, height, cells })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_packs_near_square_and_places_cells_in_row_major_order() {
        // 5 cells → 3 columns × 2 rows.
        let p = pack_grid(5, 100, 4096).unwrap();
        assert_eq!((p.width, p.height), (300, 200));
        assert_eq!(p.cells[0], Placement { index: 0, x: 0, y: 0, w: 100, h: 100 });
        assert_eq!(p.cells[3], Placement { index: 3, x: 0, y: 100, w: 100, h: 100 }); // wraps to row 2
        assert_eq!(p.cells[4], Placement { index: 4, x: 100, y: 100, w: 100, h: 100 });
    }

    #[test]
    fn grid_declines_when_it_would_exceed_the_device_max() {
        assert!(pack_grid(0, 100, 4096).is_none());
        // 4 cells → 2×2 grid of 3000px cells = 6000px, past a 4096 limit.
        assert!(pack_grid(4, 3000, 4096).is_none());
    }

    #[test]
    fn shelf_pack_wraps_at_target_width_with_a_gap_between_cells() {
        // Three 100-wide cells, target 250 → cells 0,1 on shelf 0 (x=0,104), cell 2 wraps to shelf 1.
        let p = shelf_pack(&[(100, 40), (100, 60), (100, 30)], 4, 250, 4096).unwrap();
        assert_eq!(p.cells[0], Placement { index: 0, x: 0, y: 0, w: 100, h: 40 });
        assert_eq!(p.cells[1], Placement { index: 1, x: 104, y: 0, w: 100, h: 60 });
        // shelf 0 height = max(40,60) = 60; shelf 1 starts at y = 60 + gap 4 = 64.
        assert_eq!(p.cells[2], Placement { index: 2, x: 0, y: 64, w: 100, h: 30 });
        assert_eq!(p.height, 64 + 30);
    }

    #[test]
    fn shelf_pack_keeps_a_gap_so_a_cell_cannot_touch_its_neighbour() {
        // Two cells that fit on one shelf: the second starts a full gap past the first's right edge.
        let p = shelf_pack(&[(50, 50), (50, 50)], 4, 2048, 4096).unwrap();
        assert_eq!(p.cells[1].x, 54); // 50 + gap 4 — never abutting
    }

    #[test]
    fn shelf_pack_declines_empty_or_oversize() {
        assert!(shelf_pack(&[], 4, 2048, 4096).is_none());
        // A shelf taller than max_dim (many rows of tall cells) is declined.
        let tall: Vec<(u32, u32)> = (0..10).map(|_| (2000, 1000)).collect();
        assert!(shelf_pack(&tall, 4, 2048, 4096).is_none());
    }
}
