//! A quadtree spatial index over page-space shape bounds.
//!
//! A faithful port of the selection worker's `quadtree.ts` — itself Penpot's
//! `frontend/src/app/util/quadtree.js` — so the renderer indexes shapes exactly the way the editor
//! already does for hit-testing: the same split policy ([`MAX_OBJECTS`] per leaf, [`MAX_LEVELS`]
//! deep), the same "insert a shape into every quad its bounds overlap, dedup on query" scheme. A
//! quadtree is density-adaptive (it only subdivides where content clusters), which fits a real
//! design canvas — sparse space with wildly unequal shape sizes — where a uniform grid's single
//! cell size cannot. A page-spanning shape simply lands in every overlapping leaf and is returned by
//! any query that reaches it, which is correct; [`MAX_LEVELS`] caps that at 4⁴ = 256 leaves.
//!
//! One addition over the worker's version: in-place [`Quadtree::remove`]. The worker rebuilds the
//! whole tree on removal (fine for discrete hit-test edits), but the renderer queries this every
//! frame, so a committed shape move must be O(depth), not an O(n) rebuild.

use std::collections::HashSet;

use kurbo::Rect;

/// A leaf splits once it holds more than this many shapes (and it is not yet at [`MAX_LEVELS`]).
pub const MAX_OBJECTS: usize = 10;
/// The deepest a leaf subdivides. 4⁴ = 256 leaves is the worst-case fan-out of one shape.
pub const MAX_LEVELS: u32 = 4;

#[derive(Clone, Copy)]
struct Obj {
    id: u128,
    bounds: Rect,
}

/// A quadtree node: a leaf holds `objects`; an internal node holds four `children` (top-right,
/// top-left, bottom-left, bottom-right — the worker's index order) and no objects.
pub struct Quadtree {
    level: u32,
    bounds: Rect,
    objects: Vec<Obj>,
    children: Vec<Quadtree>,
}

impl Quadtree {
    /// A fresh empty tree spanning `bounds` (the page/document extent). Shapes outside `bounds` still
    /// index — they route to the nearest edge quads — but the tree balances best when `bounds` covers
    /// the content.
    #[must_use]
    pub fn new(bounds: Rect) -> Self {
        Self::at_level(bounds, 0)
    }

    fn at_level(bounds: Rect, level: u32) -> Self {
        Self { level, bounds, objects: Vec::new(), children: Vec::new() }
    }

    /// Subdivide this leaf into four quads (mirrors `split()`).
    fn split(&mut self) {
        let next = self.level + 1;
        let (sw, sh) = (self.bounds.width() / 2.0, self.bounds.height() / 2.0);
        let (x, y) = (self.bounds.x0, self.bounds.y0);
        let quad = |qx: f64, qy: f64| Rect::new(qx, qy, qx + sw, qy + sh);
        self.children = vec![
            Self::at_level(quad(x + sw, y), next),
            Self::at_level(quad(x, y), next),
            Self::at_level(quad(x, y + sh), next),
            Self::at_level(quad(x + sw, y + sh), next),
        ];
    }

    /// Which of the four child quads `r` overlaps (mirrors `getIndexes`): `[TR, TL, BL, BR]`.
    fn indexes(&self, r: Rect) -> [bool; 4] {
        let vmid = self.bounds.x0 + self.bounds.width() / 2.0;
        let hmid = self.bounds.y0 + self.bounds.height() / 2.0;
        let north = r.y0 < hmid;
        let west = r.x0 < vmid;
        let east = r.x1 > vmid;
        let south = r.y1 > hmid;
        [north && east, west && north, west && south, east && south]
    }

    /// Index `id` under `bounds` (page space). A shape spanning several quads is stored in each; a
    /// later query dedups. Idempotent only if the caller does not double-insert the same id.
    pub fn insert(&mut self, id: u128, bounds: Rect) {
        self.insert_obj(Obj { id, bounds });
    }

    fn insert_obj(&mut self, obj: Obj) {
        if !self.children.is_empty() {
            let hits = self.indexes(obj.bounds);
            for (i, &hit) in hits.iter().enumerate() {
                if hit {
                    self.children[i].insert_obj(obj);
                }
            }
            return;
        }
        self.objects.push(obj);
        if self.objects.len() > MAX_OBJECTS && self.level < MAX_LEVELS {
            self.split();
            for obj in std::mem::take(&mut self.objects) {
                let hits = self.indexes(obj.bounds);
                for (i, &hit) in hits.iter().enumerate() {
                    if hit {
                        self.children[i].insert_obj(obj);
                    }
                }
            }
        }
    }

    /// Remove `id` (whose bounds were `bounds` when inserted) in place. Descends the same quads
    /// `insert` routed it to, so it is O(depth × leaf occupancy). Passing bounds that differ from the
    /// insert bounds can leave a stale copy — always remove with the shape's *old* bounds before an
    /// edit, then re-insert with the new ones.
    pub fn remove(&mut self, id: u128, bounds: Rect) {
        if self.children.is_empty() {
            self.objects.retain(|o| o.id != id);
        } else {
            let hits = self.indexes(bounds);
            for (i, &hit) in hits.iter().enumerate() {
                if hit {
                    self.children[i].remove(id, bounds);
                }
            }
        }
    }

    /// Collect the ids of every shape whose quad overlaps `rect` into `out` (deduped). This is a
    /// superset of the shapes actually intersecting `rect` — a shape is returned if it shares a leaf
    /// with the query — so the caller still does a precise bounds test. That superset is exactly what
    /// makes it cheap: work is proportional to the shapes near `rect`, not the whole document.
    pub fn query(&self, rect: Rect, out: &mut HashSet<u128>) {
        if self.children.is_empty() {
            out.extend(self.objects.iter().map(|o| o.id));
        } else {
            let hits = self.indexes(rect);
            for (i, &hit) in hits.iter().enumerate() {
                if hit {
                    self.children[i].query(rect, out);
                }
            }
        }
    }

    /// Drop every shape, keeping the root bounds (mirrors `clear`).
    pub fn clear(&mut self) {
        self.objects.clear();
        self.children.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(tree: &Quadtree, r: Rect) -> Vec<u128> {
        let mut out = HashSet::new();
        tree.query(r, &mut out);
        let mut v: Vec<u128> = out.into_iter().collect();
        v.sort_unstable();
        v
    }

    #[test]
    fn a_split_prunes_the_far_corner_from_a_query() {
        let mut t = Quadtree::new(Rect::new(0.0, 0.0, 1000.0, 1000.0));
        for i in 0..20u128 {
            let x = (i % 5) as f64 * 5.0;
            let y = (i / 5) as f64 * 5.0;
            t.insert(i, Rect::new(x, y, x + 2.0, y + 2.0));
        }
        t.insert(99, Rect::new(900.0, 900.0, 950.0, 950.0));
        let hits = ids(&t, Rect::new(0.0, 0.0, 40.0, 40.0));
        assert!(hits.contains(&0) && hits.contains(&19));
        assert!(!hits.contains(&99));
    }

    #[test]
    fn a_leaf_overflow_splits_and_still_finds_everything() {
        let mut t = Quadtree::new(Rect::new(0.0, 0.0, 1000.0, 1000.0));
        for i in 0..40u128 {
            let x = (i % 8) as f64 * 5.0;
            let y = (i / 8) as f64 * 5.0;
            t.insert(i, Rect::new(x, y, x + 2.0, y + 2.0));
        }
        assert_eq!(ids(&t, Rect::new(0.0, 0.0, 60.0, 60.0)).len(), 40);
    }

    #[test]
    fn a_page_spanning_shape_is_found_from_any_corner() {
        let mut t = Quadtree::new(Rect::new(0.0, 0.0, 1000.0, 1000.0));
        for i in 0..40u128 {
            let x = (i % 8) as f64 * 5.0;
            t.insert(i + 100, Rect::new(x, 0.0, x + 2.0, 2.0));
        }
        t.insert(7, Rect::new(-10.0, -10.0, 1010.0, 1010.0));
        assert!(ids(&t, Rect::new(0.0, 0.0, 10.0, 10.0)).contains(&7));
        assert!(ids(&t, Rect::new(980.0, 980.0, 1000.0, 1000.0)).contains(&7));
    }

    #[test]
    fn remove_takes_a_shape_out_including_after_a_split() {
        let mut t = Quadtree::new(Rect::new(0.0, 0.0, 1000.0, 1000.0));
        for i in 0..40u128 {
            let x = (i % 8) as f64 * 5.0;
            let y = (i / 8) as f64 * 5.0;
            t.insert(i, Rect::new(x, y, x + 2.0, y + 2.0));
        }
        let b = Rect::new(0.0, 0.0, 2.0, 2.0);
        t.remove(0, b);
        assert!(!ids(&t, Rect::new(0.0, 0.0, 60.0, 60.0)).contains(&0));
        assert_eq!(ids(&t, Rect::new(0.0, 0.0, 60.0, 60.0)).len(), 39);
    }
}
