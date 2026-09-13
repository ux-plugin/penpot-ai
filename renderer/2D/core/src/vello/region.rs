//! The interval shelf: the rect packer the scheduler places store rects with. An item is a
//! `w × h` rect alive over a round interval; two items share an address only when their intervals
//! are disjoint, so rows recycle across time instead of renting for the whole frame.

/// One item for [`interval_shelf`]: a `w × h` rect alive over rounds `[birth, death]` (inclusive).
/// `group` ORDERS slot reuse: a freed slot is retaken only by an item whose group is ≥ the
/// tenant's. The per-tile PTCL walk early-breaks at the first marker past the window, so a tile's
/// marker rounds must be stream-monotone; host packing passes the owner gid's GATHER INDEX — a
/// stream-later gid whose rounds start after the tenant's death keeps the tile monotone, so
/// ordered reuse is sound where same-gid-only reuse was needlessly narrow. `u128::MAX` marks an
/// unknown owner: it never reuses and is never reused. Lease packing passes zero for all (leases
/// carry no markers, any disjoint interval may share).
#[derive(Clone, Copy, Debug, Default)]
pub struct IntervalRect {
    /// Placement priority: lower tiers pack first regardless of birth, so on overflow the
    /// higher tier is what fails. Drafts pack at tier 0 (an evicted draft re-runs its chain at a
    /// different density — an interior-wide difference); region leases at tier 1 (a dropped
    /// lease only costs an edge-band clamp). Processing order never affects reuse soundness —
    /// interval disjointness is checked per pair.
    pub tier: u32,
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
    order.sort_by_key(|&i| (items[i].tier, items[i].birth, i));
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
    fn interval_shelf_reuses_disjoint_intervals_and_separates_live_ones() {
        let items = [
            IntervalRect { tier: 0, w: 96, h: 32, birth: 1, death: 2, group: 7 },
            IntervalRect { tier: 0, w: 96, h: 32, birth: 3, death: 4, group: 7 },
            IntervalRect { tier: 0, w: 96, h: 32, birth: 2, death: 5, group: 7 },
            IntervalRect { tier: 0, w: 96, h: 32, birth: 2, death: 2, group: 7 },
        ];
        let out = interval_shelf(&items, 256, 1024);
        assert_eq!(out[0], out[1], "disjoint intervals share one slot");
        assert_ne!(out[0], out[2], "overlapping intervals get distinct slots");
        assert_ne!(out[0], out[3], "an equal-round pair never shares (no barrier between)");
        assert!(out.iter().all(Option::is_some));
        let back = [
            IntervalRect { tier: 0, w: 96, h: 32, birth: 1, death: 2, group: 9 },
            IntervalRect { tier: 0, w: 96, h: 32, birth: 3, death: 4, group: 7 },
        ];
        let b = interval_shelf(&back, 256, 1024);
        assert_ne!(b[0], b[1], "a slot never flows to a stream-earlier group");
        let fwd = [
            IntervalRect { tier: 0, w: 96, h: 32, birth: 1, death: 2, group: 7 },
            IntervalRect { tier: 0, w: 96, h: 32, birth: 3, death: 4, group: 9 },
        ];
        let f = interval_shelf(&fwd, 256, 1024);
        assert_eq!(f[0], f[1], "a dead slot flows forward in stream order");
    }

    #[test]
    fn interval_shelf_caps_and_wraps() {
        let items = [
            IntervalRect { tier: 0, w: 200, h: 64, birth: 0, death: 9, group: 0 },
            IntervalRect { tier: 0, w: 200, h: 64, birth: 0, death: 9, group: 0 },
            IntervalRect { tier: 0, w: 200, h: 64, birth: 0, death: 9, group: 0 },
        ];
        let out = interval_shelf(&items, 256, 100);
        assert!(out[0].is_some());
        assert!(out[1].is_none(), "the second row would pass the cap");
        assert!(out[2].is_none());
    }
}
