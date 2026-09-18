//! Where a value lives in the store.
//!
//! The scheduler knows each value's size and the span of rounds it must survive: the round it is
//! first written, and the last round anything reads it. [`StorePacker::place`] hands back a slot
//! for each, such that two values whose spans meet never share a tile and two whose spans are
//! disjoint may. Values arrive in any order, and the rounds stage tries a chain at a shift and
//! takes it back: every placement and removal since the last [`StorePacker::commit`] is undone by
//! [`StorePacker::rollback`].
//!
//! Everything here is in TILES. A fine workgroup writes one whole tile, so a texel-exact packing
//! would let one value's mark clobber the edge of its neighbour. The caller converts pixels.
//!
//! One obligation on the caller: a value's span covers every write to it, not merely the first.
//!
//! Memory is one bitmap per round over the rows handed out: bounded by the rounds in use and the
//! rows the values reached. A placement scans those bitmaps, so its cost does not grow with the
//! number of values alive.

const BITS: usize = u64::BITS as usize;

/// A value's footprint, in tiles, and the rounds it holds it.
#[derive(Clone, Copy, Debug)]
struct Slot {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    birth: u32,
    death: u32,
    live: bool,
}

enum Entry {
    Placed(u32),
    Removed(u32),
}

/// The store's tiles, handed out to values as their lifetimes allow.
pub struct StorePacker {
    width: u32,
    words: usize,
    /// Per round, one bit per tile, set while a value alive in that round owns it; row `r` is
    /// words `r * words ..`.
    rounds: Vec<Vec<u64>>,
    /// Per round, the tiles owned.
    used: Vec<u32>,
    slots: Vec<Slot>,
    journal: Vec<Entry>,
}

impl StorePacker {
    /// A packer over a store `width` tiles wide.
    pub fn new(width: u32) -> Self {
        assert!(width > 0, "a store has width");
        Self { width, words: (width as usize).div_ceil(BITS), rounds: Vec::new(), used: Vec::new(), slots: Vec::new(), journal: Vec::new() }
    }

    /// The rows handed out to live values, in tiles: the store needs this many below its origin.
    pub fn height(&self) -> u32 {
        self.slots.iter().filter(|s| s.live).map(|s| s.y + s.h).max().unwrap_or(0)
    }

    /// Where slot `id` sits, in tiles from the store's origin.
    pub fn at(&self, id: u32) -> [u32; 2] {
        let s = &self.slots[id as usize];
        [s.x, s.y]
    }

    /// The tiles owned in round `q`.
    pub fn used(&self, q: u32) -> u32 {
        self.used.get(q as usize).copied().unwrap_or(0)
    }

    /// A slot for a `w`×`h` value alive over rounds `birth..=death`: inside the width, overlapping
    /// nothing alive in any of those rounds; the highest, then the leftmost, such spot.
    ///
    /// Panics if the value is empty or wider than the store, or dies before it is born.
    pub fn place(&mut self, w: u32, h: u32, birth: u32, death: u32) -> u32 {
        assert!(w > 0 && h > 0, "an empty value has no place");
        assert!(w <= self.width, "a value is wider than the store");
        assert!(death >= birth, "a value dies before it is born");
        if self.rounds.len() <= death as usize {
            self.rounds.resize(death as usize + 1, Vec::new());
            self.used.resize(death as usize + 1, 0);
        }
        let deepest = (birth..=death).map(|q| self.rounds[q as usize].len() / self.words).max().unwrap_or(0) as u32;
        let mut band = vec![0u64; self.words];
        let mut y = 0u32;
        let [x, y] = loop {
            if y >= deepest {
                break [0, y];
            }
            band.fill(0);
            for q in birth..=death {
                let rows = &self.rounds[q as usize];
                for row in y..y + h {
                    let base = row as usize * self.words;
                    if base >= rows.len() {
                        break;
                    }
                    for (k, word) in band.iter_mut().enumerate() {
                        *word |= rows[base + k];
                    }
                }
            }
            if let Some(x) = run_of(&band, self.width, w) {
                break [x, y];
            }
            y += 1;
        };
        let id = self.slots.len() as u32;
        self.slots.push(Slot { x, y, w, h, birth, death, live: true });
        self.take(id, true);
        self.journal.push(Entry::Placed(id));
        id
    }

    /// Give slot `id`'s tiles back for every round it held them.
    pub fn remove(&mut self, id: u32) {
        assert!(self.slots[id as usize].live, "a slot is removed once");
        self.take(id, false);
        self.journal.push(Entry::Removed(id));
    }

    /// Keep everything placed and removed so far.
    pub fn commit(&mut self) {
        self.journal.clear();
    }

    /// Undo every placement and removal since the last commit, latest first.
    pub fn rollback(&mut self) {
        while let Some(e) = self.journal.pop() {
            match e {
                Entry::Placed(id) => self.take(id, false),
                Entry::Removed(id) => self.take(id, true),
            }
        }
    }

    /// Take (`taken`) or release slot `id`'s tiles in every round of its span.
    fn take(&mut self, id: u32, taken: bool) {
        let s = self.slots[id as usize];
        for q in s.birth..=s.death {
            self.mark(q, s.x, s.y, s.w, s.h, taken);
            if taken {
                self.used[q as usize] += s.w * s.h;
            } else {
                self.used[q as usize] -= s.w * s.h;
            }
        }
        self.slots[id as usize].live = taken;
    }

    /// Whether every tile of the `w`×`h` rect at `(x, y)` is unowned in round `q`.
    #[cfg(test)]
    fn free(&self, q: u32, x: u32, y: u32, w: u32, h: u32) -> bool {
        let rows = &self.rounds[q as usize];
        (y..y + h).all(|row| {
            let base = row as usize * self.words;
            base >= rows.len() || masks(x, w).all(|(word, mask)| rows[base + word] & mask == 0)
        })
    }

    /// Take (`taken`) or release the tiles of the `w`×`h` rect at `(x, y)` in round `q`.
    fn mark(&mut self, q: u32, x: u32, y: u32, w: u32, h: u32, taken: bool) {
        let words = self.words;
        let rows = &mut self.rounds[q as usize];
        let need = (y + h) as usize * words;
        if rows.len() < need {
            rows.resize(need, 0);
        }
        for row in y..y + h {
            let base = row as usize * words;
            for (word, mask) in masks(x, w) {
                if taken {
                    rows[base + word] |= mask;
                } else {
                    rows[base + word] &= !mask;
                }
            }
        }
    }
}

/// The leftmost column of `w` clear bits within the first `width` bits of `band`, if any.
fn run_of(band: &[u64], width: u32, w: u32) -> Option<u32> {
    let mut x = 0u32;
    while x + w <= width {
        let mut run = 0u32;
        while run < w {
            let bit = (x + run) as usize;
            let word = band[bit / BITS] >> (bit % BITS);
            if word & 1 != 0 {
                break;
            }
            let zeros = word.trailing_zeros().min((BITS - bit % BITS) as u32);
            run += zeros;
        }
        if run >= w {
            return Some(x);
        }
        let bit = (x + run) as usize;
        let word = band[bit / BITS] >> (bit % BITS);
        let ones = word.trailing_ones().min((BITS - bit % BITS) as u32).max(1);
        x += run + ones;
    }
    None
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
        let a = p.place(4, 2, 0, 1);
        let b = p.place(4, 2, 2, 3);
        assert_eq!(p.at(a), p.at(b));
        assert_eq!(p.height(), 2);
    }

    #[test]
    fn a_death_meeting_a_birth_still_clashes() {
        let mut p = StorePacker::new(10);
        let a = p.place(4, 2, 0, 2);
        let b = p.place(4, 2, 2, 3);
        assert_ne!(p.at(a), p.at(b));
    }

    #[test]
    fn values_sit_side_by_side_before_opening_a_row() {
        let mut p = StorePacker::new(10);
        let id = p.place(4, 2, 0, 9);
        assert_eq!(p.at(id), [0, 0]);
        let id = p.place(4, 2, 0, 9);
        assert_eq!(p.at(id), [4, 0]);
        let id = p.place(4, 2, 0, 9);
        assert_eq!(p.at(id), [0, 2]);
        assert_eq!(p.height(), 4);
    }

    #[test]
    fn a_released_row_is_reused_before_the_store_grows() {
        let mut p = StorePacker::new(4);
        p.place(4, 3, 0, 0);
        p.place(4, 1, 0, 5);
        let id = p.place(4, 3, 1, 5);
        assert_eq!(p.at(id), [0, 0]);
        assert_eq!(p.height(), 4);
    }

    #[test]
    fn an_earlier_birth_placed_later_sees_what_is_alive_then() {
        let mut p = StorePacker::new(4);
        let late = p.place(4, 2, 3, 5);
        let early = p.place(4, 2, 0, 3);
        assert_ne!(p.at(late), p.at(early), "they meet at round 3");
        let gap = p.place(4, 2, 0, 2);
        assert_eq!(p.at(gap), p.at(late), "the rows are free until round 3");
    }

    #[test]
    fn a_rollback_forgets_placements_and_removals_alike() {
        let mut p = StorePacker::new(4);
        let a = p.place(4, 2, 0, 9);
        p.commit();
        p.remove(a);
        let b = p.place(4, 2, 0, 9);
        assert_eq!(p.at(b), [0, 0], "a's rows were free once it was removed");
        p.rollback();
        assert_eq!(p.height(), 2, "a is back, b is gone");
        let c = p.place(4, 2, 0, 9);
        assert_eq!(p.at(c), [0, 2], "a holds its rows again");
    }

    #[test]
    fn the_leftmost_clear_run_is_found_across_word_boundaries() {
        for x in 0..130u32 {
            for w in 1..70u32 {
                let mut p = StorePacker::new(200);
                p.rounds.push(Vec::new());
                p.mark(0, x, 0, w, 1, true);
                let band = p.rounds[0].clone();
                for need in [1u32, 5, 64, 70] {
                    let want = (0..=200 - need).find(|&c| (c + need <= x) || c >= x + w);
                    assert_eq!(super::run_of(&band, 200, need), want, "run {x}+{w}, need {need}");
                }
            }
        }
    }

    #[test]
    fn a_run_masks_exactly_its_tiles_across_word_boundaries() {
        for x in 0..130u32 {
            for w in 1..70u32 {
                let mut p = StorePacker::new(200);
                p.rounds.push(Vec::new());
                p.mark(0, x, 0, w, 1, true);
                for t in 0..200u32 {
                    assert_eq!(!p.free(0, t, 0, 1, 1), t >= x && t < x + w, "tile {t}, run {x}+{w}");
                }
            }
        }
    }

    #[test]
    fn live_values_never_overlap_and_stay_in_width() {
        let mut seed = 0x2545_f491u64;
        let mut p = StorePacker::new(150);
        let mut placed: Vec<([u32; 2], u32, u32, u32, u32)> = Vec::new();
        for _ in 0..400 {
            let birth = next(&mut seed) % 40;
            let (w, h) = (1 + next(&mut seed) % 80, 1 + next(&mut seed) % 12);
            let death = birth + next(&mut seed) % 6;
            let id = p.place(w, h, birth, death);
            let o = p.at(id);
            assert!(o[0] + w <= 150, "value leaves the store");
            for &(q, qw, qh, qb, qd) in &placed {
                if qd >= birth && qb <= death {
                    assert!(o[0] >= q[0] + qw || q[0] >= o[0] + w || o[1] >= q[1] + qh || q[1] >= o[1] + h, "live values overlap");
                }
            }
            placed.push((o, w, h, birth, death));
        }
    }
}
