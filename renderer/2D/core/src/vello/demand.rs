//! Demand → regions: the off-frame content each effect's taps need, and the density the byte
//! budget affords it.
//!
//! Every gather whose (unclamped) reach escapes the frame emits a [`Demand`]: the device rect its
//! taps can touch plus a slack pad, and the density cap the effect is happy with (`desired_k` —
//! an effect fine with half-res backdrop asks 0.5 and saves budget). [`plan`] turns demands into
//! [`crate::vello::region::RegionTable`] allocations: per-demand `k = clamp(desired)`, then one
//! global √-scale squeeze when the summed bytes exceed the budget — floorless down to 1/64, so a
//! huge demand under a tight budget renders coarse rather than not at all. A demand that still
//! cannot rent grid rows (the texture ceiling) is dropped; its reader's taps keep today's
//! edge-clamp behavior.

use crate::vello::region::RegionTable;

/// One gather's appetite for off-frame backdrop.
#[derive(Clone, Copy, Debug)]
pub struct Demand {
    /// Device-space rect the reader's taps can touch (reach + slack pad), unclamped.
    pub rect: [f64; 4],
    /// The density cap the effect declares — a pure wish; the budget only ever lowers it.
    pub desired_k: f64,
    /// The gather that emitted this demand.
    pub reader: u128,
    /// How many leases of `rect`'s size serving this demand will rent (the band functor's fold
    /// allocates ground/window/chain leases beyond the primary value) — scales the demand's cost
    /// in the budget squeeze so k drops before the shelf overflows.
    pub leases: u32,
}

const K_FLOOR: f64 = 1.0 / 64.0;

/// Resolve demands into region allocations. Returns `(reader, region index)` per served demand,
/// in input order. Demands fully inside the frame, degenerate, or unplaceable are skipped.
pub fn plan(
    demands: &[Demand],
    table: &mut RegionTable,
    width: u32,
    height: u32,
    budget_bytes: u64,
    max_grid_h: u32,
) -> Vec<(u128, usize)> {
    let (w, h) = (f64::from(width), f64::from(height));
    let valid = |r: &[f64; 4]| r[2] > r[0] && r[3] > r[1] && r.iter().all(|v| v.is_finite());
    let live: Vec<&Demand> = demands
        .iter()
        .filter(|d| {
            valid(&d.rect)
                && !(d.rect[0] >= 0.0 && d.rect[1] >= 0.0 && d.rect[2] <= w && d.rect[3] <= h)
        })
        .collect();
    if live.is_empty() {
        return Vec::new();
    }
    let mut ks: Vec<f64> = live.iter().map(|d| d.desired_k.clamp(K_FLOOR, 1.0)).collect();
    let bytes: f64 = live
        .iter()
        .zip(&ks)
        .map(|(d, k)| {
            (d.rect[2] - d.rect[0]) * k * (d.rect[3] - d.rect[1]) * k * 4.0
                * f64::from(d.leases.max(1))
        })
        .sum();
    if bytes > budget_bytes as f64 {
        let squeeze = (budget_bytes as f64 / bytes).sqrt();
        for k in &mut ks {
            *k = (*k * squeeze).max(K_FLOOR);
        }
    }
    // The byte squeeze models VRAM; feasibility is SHELF ROWS under real first-fit packing —
    // a k the bytes afford can still overflow the grid once the band functor rents each
    // demand's extra leases, and a lease that fails to rent silently degrades its reader to
    // the edge clamp. Trial-pack the actual allocator in the real rental order (grounds
    // first, then every demand's extras) and lower k until the WHOLE plan places.
    let hopeless: Vec<bool> = live
        .iter()
        .map(|d| {
            let mut t = table.clone();
            t.allocate(d.rect, K_FLOOR, None, max_grid_h).is_none()
        })
        .collect();
    let fits = |ks: &[f64], table: &RegionTable| -> bool {
        let mut t = table.clone();
        let mut rent = |d: &Demand, k: f64| t.allocate(d.rect, k, None, max_grid_h).is_some();
        live.iter().zip(ks).zip(&hopeless).all(|((d, &k), &h)| h || rent(d, k))
            && live
                .iter()
                .zip(ks)
                .zip(&hopeless)
                .all(|((d, &k), &h)| h || (1..d.leases.max(1)).all(|_| rent(d, k)))
    };
    while !fits(&ks, table) && ks.iter().any(|&k| k > K_FLOOR) {
        for k in &mut ks {
            *k = (*k * 0.85).max(K_FLOOR);
        }
    }
    live.iter()
        .zip(&ks)
        .filter_map(|(d, &k)| {
            table.allocate(d.rect, k, Some(d.reader), max_grid_h).map(|i| (d.reader, i))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dem(rect: [f64; 4], desired_k: f64) -> Demand {
        Demand { rect, desired_k, reader: 7, leases: 1 }
    }

    #[test]
    fn in_frame_demand_is_skipped() {
        let mut t = RegionTable::frame(1216, 622);
        let out = plan(&[dem([10.0, 10.0, 100.0, 100.0], 1.0)], &mut t, 1216, 622, u64::MAX, 8192);
        assert!(out.is_empty());
        assert_eq!(t.regions.len(), 1);
    }

    #[test]
    fn escaping_demand_rents_a_region_at_desired_k() {
        let mut t = RegionTable::frame(1216, 622);
        let out =
            plan(&[dem([-80.0, 0.0, 40.0, 90.0], 0.5)], &mut t, 1216, 622, u64::MAX, 8192);
        assert_eq!(out.len(), 1);
        let r = &t.regions[out[0].1];
        assert_eq!(out[0].0, 7);
        assert!((r.k - 0.5).abs() < 1e-9);
        assert!(r.grid[1] >= 622);
    }

    #[test]
    fn budget_squeezes_k_floorlessly() {
        let mut t = RegionTable::frame(1216, 622);
        let big = dem([-4000.0, -4000.0, 0.0, 0.0], 1.0);
        let out = plan(&[big], &mut t, 1216, 622, 64 * 1024, 1_000_000);
        assert_eq!(out.len(), 1);
        let k = t.regions[out[0].1].k;
        assert!(k < 0.05, "k must drop as far as the budget demands, got {k}");
        assert!(k >= K_FLOOR);
    }

    #[test]
    fn unplaceable_demand_is_dropped_not_fatal() {
        let mut t = RegionTable::frame(256, 128);
        let out = plan(&[dem([-9000.0, 0.0, 0.0, 9000.0], 1.0)], &mut t, 256, 128, u64::MAX, 256);
        assert!(out.is_empty());
    }
}
