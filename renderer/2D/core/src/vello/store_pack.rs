//! Where a value lives in the store.
//!
//! The scheduler knows each value's size and the span of rounds it must survive: the round it is
//! first written, and the last round anything reads it. [`StorePacker::place`] hands back a
//! coordinate for each, such that two values whose spans meet never share a tile and two whose
//! spans are disjoint may.
//!
//! Everything here is in TILES. A fine workgroup writes one whole tile, so a texel-exact packing
//! would let one value's mark clobber the edge of its neighbour. The caller converts pixels.
//!
//! Two obligations on the caller: values arrive in non-decreasing birth order, and a value's span
//! covers every write to it, not merely the first. A served ground is written twice, by its draw
//! and again by its copy, and both fall inside its span.
//!
//! Memory is bounded by the values placed, whatever the round numbers are: the bitmap grows to the
//! lowest row handed out, and the death buckets hold only rounds some live value dies in.

use std::collections::BTreeMap;

const BITS: usize = u64::BITS as usize;

/// A value's footprint, in tiles. Its death is the bucket it is filed under.
struct Slot {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

/// The store's tiles, handed out to values as their lifetimes allow.
pub struct StorePacker {
    width: u32,
    words: usize,
    /// One bit per tile, set while a live value owns it; row `r` is words `r * words ..`.
    rows: Vec<u64>,
    /// Live slots by the round they die in. Every entry is at or after the current round.
    by_death: BTreeMap<u32, Vec<Slot>>,
    round: u32,
    height: u32,
}

impl StorePacker {
    /// A packer over a store `width` tiles wide.
    pub fn new(width: u32) -> Self {
        assert!(width > 0, "a store has width");
        Self { width, words: (width as usize).div_ceil(BITS), rows: Vec::new(), by_death: BTreeMap::new(), round: 0, height: 0 }
    }

    /// The rows handed out so far, in tiles: the store needs this many below its origin.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Where a `w`×`h` value alive over rounds `birth..=death` goes, in tiles from the store's
    /// origin. The rect returned lies inside the width and overlaps nothing still alive at `birth`;
    /// among such spots it is the highest, then the leftmost, that sits against the origin or a
    /// live value.
    ///
    /// Panics if `birth` precedes an earlier call's, if the value is empty or wider than the store,
    /// or if it dies before it is born.
    pub fn place(&mut self, w: u32, h: u32, birth: u32, death: u32) -> [u32; 2] {
        assert!(birth >= self.round, "values are placed in birth order");
        assert!(w > 0 && h > 0, "an empty value has no place");
        assert!(w <= self.width, "a value is wider than the store");
        assert!(death >= birth, "a value dies before it is born");
        self.retire(birth);

        let [x, y] = self.spot(w, h);
        self.mark(x, y, w, h, true);
        self.by_death.entry(death).or_default().push(Slot { x, y, w, h });
        self.height = self.height.max(y + h);
        [x, y]
    }

    /// Move to `round`, releasing every slot whose last reader ran before it.
    fn retire(&mut self, round: u32) {
        while let Some(entry) = self.by_death.first_entry() {
            if *entry.key() >= round {
                break;
            }
            for s in entry.remove() {
                self.mark(s.x, s.y, s.w, s.h, false);
            }
        }
        self.round = round;
    }

    /// Every slot that may still be read.
    fn live(&self) -> impl Iterator<Item = &Slot> {
        self.by_death.values().flatten()
    }

    /// The highest, then leftmost, free spot for a `w`×`h` rect among the origin and the corners
    /// of live slots; below every live slot when none of those fits.
    fn spot(&self, w: u32, h: u32) -> [u32; 2] {
        let mut spots: Vec<[u32; 2]> = vec![[0, 0]];
        for s in self.live() {
            spots.push([s.x + s.w, s.y]);
            spots.push([s.x, s.y + s.h]);
        }
        spots.sort_unstable_by_key(|&[x, y]| (y, x));
        spots.dedup();
        spots
            .into_iter()
            .find(|&[x, y]| x + w <= self.width && self.free(x, y, w, h))
            .unwrap_or_else(|| [0, self.live().map(|s| s.y + s.h).max().unwrap_or(0)])
    }

    /// Whether every tile of the `w`×`h` rect at `(x, y)` is unowned.
    fn free(&self, x: u32, y: u32, w: u32, h: u32) -> bool {
        (y..y + h).all(|row| {
            let base = row as usize * self.words;
            base >= self.rows.len() || masks(x, w).all(|(word, mask)| self.rows[base + word] & mask == 0)
        })
    }

    /// Take (`taken`) or release the tiles of the `w`×`h` rect at `(x, y)`.
    fn mark(&mut self, x: u32, y: u32, w: u32, h: u32, taken: bool) {
        let need = (y + h) as usize * self.words;
        if self.rows.len() < need {
            self.rows.resize(need, 0);
        }
        for row in y..y + h {
            let base = row as usize * self.words;
            for (word, mask) in masks(x, w) {
                if taken {
                    self.rows[base + word] |= mask;
                } else {
                    self.rows[base + word] &= !mask;
                }
            }
        }
    }
}

/// The row words and bit masks covering exactly the `w` tiles from column `x`; `w` is non-zero.
fn masks(x: u32, w: u32) -> impl Iterator<Item = (usize, u64)> {
    let (lo, hi) = (x as usize, (x + w) as usize);
    (lo / BITS..=(hi - 1) / BITS).map(move |word| {
        let start = lo.saturating_sub(word * BITS).min(BITS);
        let end = (hi - word * BITS).min(BITS);
        let span = end - start;
        let mask = if span == BITS { u64::MAX } else { ((1u64 << span) - 1) << start };
        (word, mask)
    })
}

#[cfg(test)]
mod tests {
    use super::StorePacker;

    fn next(seed: &mut u64) -> u32 {
        *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (*seed >> 33) as u32
    }

    #[test]
    fn disjoint_lives_share_a_slot() {
        let mut p = StorePacker::new(10);
        assert_eq!(p.place(4, 2, 0, 1), p.place(4, 2, 2, 3));
        assert_eq!(p.height(), 2);
    }

    #[test]
    fn a_death_meeting_a_birth_still_clashes() {
        let mut p = StorePacker::new(10);
        let a = p.place(4, 2, 0, 2);
        assert_ne!(a, p.place(4, 2, 2, 3));
    }

    #[test]
    fn values_sit_side_by_side_before_opening_a_row() {
        let mut p = StorePacker::new(10);
        assert_eq!(p.place(4, 2, 0, 9), [0, 0]);
        assert_eq!(p.place(4, 2, 0, 9), [4, 0]);
        assert_eq!(p.place(4, 2, 0, 9), [0, 2]);
        assert_eq!(p.height(), 4);
    }

    #[test]
    fn a_released_row_is_reused_before_the_store_grows() {
        let mut p = StorePacker::new(4);
        p.place(4, 3, 0, 0);
        p.place(4, 1, 0, 5);
        assert_eq!(p.place(4, 3, 1, 5), [0, 0]);
        assert_eq!(p.height(), 4);
    }

    #[test]
    fn a_huge_death_round_costs_no_memory() {
        let mut p = StorePacker::new(4);
        p.place(1, 1, 0, u32::MAX);
        p.place(1, 1, u32::MAX - 1, u32::MAX);
        assert_eq!(p.by_death.len(), 1);
    }

    #[test]
    fn a_run_masks_exactly_its_tiles_across_word_boundaries() {
        for x in 0..130u32 {
            for w in 1..70u32 {
                let mut p = StorePacker::new(200);
                p.mark(x, 0, w, 1, true);
                for t in 0..200u32 {
                    assert_eq!(!p.free(t, 0, 1, 1), t >= x && t < x + w, "tile {t}, run {x}+{w}");
                }
            }
        }
    }

    #[test]
    fn live_values_never_overlap_and_stay_in_width() {
        let mut seed = 0x2545_f491u64;
        let mut p = StorePacker::new(150);
        let mut placed: Vec<([u32; 2], u32, u32, u32)> = Vec::new();
        let mut birth = 0u32;
        for _ in 0..400 {
            birth += next(&mut seed) % 2;
            let (w, h) = (1 + next(&mut seed) % 80, 1 + next(&mut seed) % 12);
            let death = birth + next(&mut seed) % 6;
            let o = p.place(w, h, birth, death);
            assert!(o[0] + w <= 150, "value leaves the store");
            for &(q, qw, qh, qd) in &placed {
                if qd >= birth {
                    assert!(
                        o[0] >= q[0] + qw || q[0] >= o[0] + w || o[1] >= q[1] + qh || q[1] >= o[1] + h,
                        "live values overlap"
                    );
                }
            }
            placed.push((o, w, h, death));
        }
    }
}
