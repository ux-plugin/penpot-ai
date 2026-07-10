use std::collections::HashMap;
use std::iter;

use crate::performance;
use crate::shapes;
use crate::shapes::Shape;
use crate::uuid::Uuid;

use crate::shapes::StructureEntry;
use crate::skia;

use std::cell::OnceCell;

use crate::math;
use crate::math::bools as math_bools;
use crate::math::Matrix;

const SHAPES_POOL_ALLOC_MULTIPLIER: f32 = 1.3;

/// A pool allocator for `Shape` objects that attempts to minimize memory reallocations.
///
/// `ShapesPoolImpl` pre-allocates a contiguous vector of `Shape` instances,
/// which can be reused and indexed efficiently. This design helps avoid
/// memory reallocation overhead by reserving enough space in advance.
///
/// # Memory Layout
///
/// Shapes are stored in a `Vec<Shape>`, which keeps the `Shape` instances
/// in a contiguous memory block.
///
/// # Index-based Design
///
/// All auxiliary HashMaps (modifiers, structure, scale_content, modified_shape_cache)
/// use `usize` indices instead of `&'a Uuid` references. This eliminates:
/// - Unsafe lifetime extensions
/// - The need for `rebuild_references()` after Vec reallocation
/// - Complex lifetime annotations
///
/// The `uuid_to_idx` HashMap maps `Uuid` (owned) to indices, avoiding lifetime issues.
///
/// Transient, per-shape overrides layered onto the base shape by `get()` for the
/// duration of a gesture (move / resize / reparent drag). Replaces the former
/// parallel `modifiers` / `structure` / `scale_content` / `absolute` maps with a
/// single per-index record.
///
/// Fields are applied by `get()` in a FIXED order — transform, structure,
/// (bool rebuild), scale-content, (fills), absolute — matching the original
/// hand-ordered sequence. The order is deliberate, not the call order: e.g.
/// resize-with-scale-content sets the transform and the scale in separate WASM
/// calls, but the transform must apply first. Don't reorder without checking that
/// gesture. Fill overrides stay in their own `fill_modifiers` map (UUID-keyed,
/// separate lifecycle) but are still applied at their original point below.
#[derive(Default, Clone)]
struct ShapeOverrides {
    transform: Option<skia::Matrix>,
    structure: Option<Vec<StructureEntry>>,
    scale_content: Option<f32>,
    absolute: bool,
}

impl ShapeOverrides {
    fn is_active(&self) -> bool {
        self.transform.is_some()
            || self.structure.is_some()
            || self.scale_content.is_some()
            || self.absolute
    }
}

pub struct ShapesPoolImpl {
    shapes: Vec<Shape>,
    counter: usize,

    /// Maps UUID to index in the shapes Vec. Uses owned Uuid, no lifetime needed.
    uuid_to_idx: HashMap<Uuid, usize>,

    /// Cache for modified shapes, keyed by index
    modified_shape_cache: HashMap<usize, OnceCell<Shape>>,
    /// Transient per-shape overrides (transform / structure / scale-content /
    /// absolute), keyed by index. Applied by `get()` in a fixed order; cleared on
    /// `clean_all`. See `ShapeOverrides`.
    overrides: HashMap<usize, ShapeOverrides>,
    /// Temporary fill overrides for live preview (gradient drag). Keyed by UUID.
    /// Kept separate from `overrides`: it has its own `clean_fill_modifiers`
    /// lifecycle that reports touched shapes to the render state.
    fill_modifiers: HashMap<Uuid, Vec<shapes::Fill>>,
}

// Type aliases - no longer need lifetimes!
pub type ShapesPool = ShapesPoolImpl;
pub type ShapesPoolRef<'a> = &'a ShapesPoolImpl;
pub type ShapesPoolMutRef<'a> = &'a mut ShapesPoolImpl;

impl ShapesPoolImpl {
    pub fn new() -> Self {
        ShapesPoolImpl {
            shapes: vec![],
            counter: 0,
            uuid_to_idx: HashMap::default(),

            modified_shape_cache: HashMap::default(),
            overrides: HashMap::default(),
            fill_modifiers: HashMap::default(),
        }
    }

    pub fn initialize(&mut self, capacity: usize) {
        performance::begin_measure!("shapes_pool_initialize");
        self.counter = 0;
        self.uuid_to_idx = HashMap::with_capacity(capacity);

        let additional = capacity as i32 - self.shapes.len() as i32;
        if additional <= 0 {
            return;
        }

        // Reserve extra capacity to avoid future reallocations
        let target_capacity = (capacity as f32 * SHAPES_POOL_ALLOC_MULTIPLIER) as usize;
        self.shapes
            .reserve_exact(target_capacity.saturating_sub(self.shapes.len()));

        self.shapes
            .extend(iter::repeat_with(|| Shape::new(Uuid::nil())).take(additional as usize));
        performance::end_measure!("shapes_pool_initialize");
    }

    pub fn add_shape(&mut self, id: Uuid) -> &mut Shape {
        if self.counter >= self.shapes.len() {
            // We need more space
            let current_capacity = self.shapes.capacity();
            // Ensure we add at least 1 shape when the pool is empty
            let additional =
                ((self.shapes.len() as f32 * SHAPES_POOL_ALLOC_MULTIPLIER) as usize).max(1);
            let needed_capacity = self.shapes.len() + additional;

            if needed_capacity > current_capacity {
                // Reserve extra space to minimize future reallocations
                let extra_reserve = (needed_capacity as f32 * 0.5) as usize;
                self.shapes
                    .reserve(needed_capacity + extra_reserve - current_capacity);
            }

            self.shapes
                .extend(iter::repeat_with(|| Shape::new(Uuid::nil())).take(additional));
        }

        let idx = self.counter;
        let new_shape = &mut self.shapes[idx];
        new_shape.id = id;

        // Simply store the UUID -> index mapping. No unsafe lifetime tricks needed!
        self.uuid_to_idx.insert(id, idx);
        self.counter += 1;

        &mut self.shapes[idx]
    }
    // No longer needed! Index-based storage means no references to rebuild.
    // The old rebuild_references() function has been removed entirely.

    pub fn len(&self) -> usize {
        self.uuid_to_idx.len()
    }

    pub fn has(&self, id: &Uuid) -> bool {
        self.uuid_to_idx.contains_key(id)
    }

    pub fn get_mut(&mut self, id: &Uuid) -> Option<&mut Shape> {
        let idx = *self.uuid_to_idx.get(id)?;
        Some(&mut self.shapes[idx])
    }

    /// Get a shape by UUID. Returns the modified shape if modifiers/structure
    /// are applied, otherwise returns the base shape.
    pub fn get(&self, id: &Uuid) -> Option<&Shape> {
        let idx = *self.uuid_to_idx.get(id)?;

        let shape = &self.shapes[idx];

        let ovr = self.overrides.get(&idx);
        let needs_modification = shape.is_bool()
            || self.fill_modifiers.contains_key(id)
            || ovr.is_some_and(ShapeOverrides::is_active);

        if !needs_modification {
            return Some(shape);
        }

        // Without a cache cell there's nothing to memoize the modified shape in,
        // so fall back to the untouched base (matches the previous behavior).
        let Some(cell) = self.modified_shape_cache.get(&idx) else {
            return Some(shape);
        };

        Some(cell.get_or_init(|| {
            let mut modified_shape = shape.clone();

            // Geometry first — equivalent to the old `transformed(modifiers, structure)`.
            if let Some(o) = ovr {
                if let Some(transform) = &o.transform {
                    modified_shape.apply_transform(transform);
                }
                if let Some(structure) = &o.structure {
                    modified_shape.apply_structure(structure);
                }
            }

            // Bool paths are rebuilt right after transform + structure, as before.
            if self.to_update_bool(&modified_shape) {
                math_bools::update_bool_to_path(&mut modified_shape, self);
            }

            // Appearance / layout overlays, in the original order.
            if let Some(scale) = ovr.and_then(|o| o.scale_content) {
                modified_shape.scale_content(scale);
            }
            if let Some(fill_mod) = self.fill_modifiers.get(id) {
                modified_shape.fills = fill_mod.clone();
            }
            if ovr.is_some_and(|o| o.absolute) {
                modified_shape.set_layout_absolute(true);
            }

            modified_shape
        }))
    }

    // Given an id, returns the depth in the tree-shaped structure
    // of shapes.
    pub fn get_depth(&self, id: &Uuid) -> usize {
        if id == &Uuid::nil() {
            return 0;
        }

        let Some(idx) = self.uuid_to_idx.get(id) else {
            return 0;
        };

        let shape = &self.shapes[*idx];

        let Some(parent_id) = shape.parent_id else {
            return 0;
        };

        self.get_depth(&parent_id) + 1
    }

    #[allow(dead_code)]
    pub fn iter(&self) -> std::slice::Iter<'_, Shape> {
        self.shapes.iter()
    }

    #[allow(dead_code)]
    pub fn iter_mut(&mut self) -> std::slice::IterMut<'_, Shape> {
        self.shapes.iter_mut()
    }

    fn clean_shape_cache(&mut self) {
        self.modified_shape_cache.clear()
    }

    pub fn set_modifiers(&mut self, modifiers: HashMap<Uuid, skia::Matrix>) {
        // Wholesale replace of the transform layer: clear it everywhere, then set
        // the new values. Other override layers on the same shape are untouched.
        for ov in self.overrides.values_mut() {
            ov.transform = None;
        }

        let mut ids = Vec::<Uuid>::new();
        for (uuid, matrix) in modifiers {
            if let Some(idx) = self.uuid_to_idx.get(&uuid).copied() {
                self.overrides.entry(idx).or_default().transform = Some(matrix);
                ids.push(uuid);
            }
        }

        let all_ids = shapes::all_with_ancestors(&ids, self, true);
        for uuid in all_ids {
            if let Some(idx) = self.uuid_to_idx.get(&uuid).copied() {
                self.modified_shape_cache.insert(idx, OnceCell::new());
                // Drop the cached extrect so tile indexing recomputes against the live modifier.
                // Ancestors without their own modifier still need this: their extrect unions
                // descendant bounds, and those descendants now carry the new transform.
                self.shapes[idx].invalidate_extrect();
                self.shapes[idx].invalidate_bounds();
            }
        }
    }

    pub fn set_structure(&mut self, structure: HashMap<Uuid, Vec<StructureEntry>>) {
        // Wholesale replace of the structure layer.
        for ov in self.overrides.values_mut() {
            ov.structure = None;
        }

        let mut ids = Vec::<Uuid>::new();
        for (uuid, entries) in structure {
            if let Some(idx) = self.uuid_to_idx.get(&uuid).copied() {
                self.overrides.entry(idx).or_default().structure = Some(entries);
                ids.push(uuid);
            }
        }

        let all_ids = shapes::all_with_ancestors(&ids, self, true);
        for uuid in all_ids {
            if let Some(idx) = self.uuid_to_idx.get(&uuid).copied() {
                self.modified_shape_cache.insert(idx, OnceCell::new());
            }
        }
    }

    /// Set the transient "force layout-absolute" overrides (see the `absolute`
    /// field). Replaces the previous set and refreshes the modified-shape cache
    /// for the affected shapes and their ancestors so the flag takes effect.
    pub fn set_absolute(&mut self, ids: Vec<Uuid>) {
        // Wholesale replace of the absolute layer.
        for ov in self.overrides.values_mut() {
            ov.absolute = false;
        }

        let mut valid_ids = Vec::<Uuid>::new();
        for uuid in ids {
            if let Some(idx) = self.uuid_to_idx.get(&uuid).copied() {
                self.overrides.entry(idx).or_default().absolute = true;
                valid_ids.push(uuid);
            }
        }

        let all_ids = shapes::all_with_ancestors(&valid_ids, self, true);
        for uuid in all_ids {
            if let Some(idx) = self.uuid_to_idx.get(&uuid).copied() {
                self.modified_shape_cache.insert(idx, OnceCell::new());
            }
        }
    }

    pub fn set_scale_content(&mut self, scale_content: HashMap<Uuid, f32>) {
        // Wholesale replace of the scale-content layer.
        for ov in self.overrides.values_mut() {
            ov.scale_content = None;
        }

        let mut ids = Vec::<Uuid>::new();
        for (uuid, value) in scale_content {
            if let Some(idx) = self.uuid_to_idx.get(&uuid).copied() {
                self.overrides.entry(idx).or_default().scale_content = Some(value);
                ids.push(uuid);
            }
        }

        let all_ids = shapes::all_with_ancestors(&ids, self, true);
        for uuid in all_ids {
            if let Some(idx) = self.uuid_to_idx.get(&uuid).copied() {
                self.modified_shape_cache.insert(idx, OnceCell::new());
            }
        }
    }

    pub fn set_fill_modifier(&mut self, id: Uuid, fills: Vec<shapes::Fill>) {
        if let Some(&idx) = self.uuid_to_idx.get(&id) {
            if fills.is_empty() {
                self.fill_modifiers.remove(&id);
            } else {
                self.fill_modifiers.insert(id, fills);
            }
            self.modified_shape_cache.insert(idx, OnceCell::new());
        }
    }

    /// Clears all fill modifiers and invalidates the modified-shape cache for each.
    /// Returns the UUIDs of all shapes that had fill modifiers, so the caller can
    /// mark them as touched in the render state.
    pub fn clean_fill_modifiers(&mut self) -> Vec<Uuid> {
        let uuids: Vec<Uuid> = self.fill_modifiers.keys().copied().collect();
        for uuid in &uuids {
            if let Some(&idx) = self.uuid_to_idx.get(uuid) {
                self.modified_shape_cache.insert(idx, OnceCell::new());
            }
        }
        self.fill_modifiers.clear();
        uuids
    }

    pub fn clean_all(&mut self) {
        self.clean_shape_cache();
        self.overrides.clear();
        self.fill_modifiers.clear();
    }

    pub fn subtree(&self, id: &Uuid) -> ShapesPoolImpl {
        let Some(shape) = self.get(id) else {
            panic!("Subtree not found");
        };

        let mut shapes = vec![];
        let mut new_idx = 0;
        let mut uuid_to_idx = HashMap::default();

        for child_id in shape.all_children_iter(self, true, true) {
            let Some(child_shape) = self.get(&child_id) else {
                panic!("Not found");
            };
            shapes.push(child_shape.clone());
            uuid_to_idx.insert(child_id, new_idx);
            new_idx += 1;
        }

        ShapesPoolImpl {
            shapes,
            counter: new_idx,
            uuid_to_idx,
            modified_shape_cache: HashMap::default(),
            overrides: HashMap::default(),
            fill_modifiers: HashMap::default(),
        }
    }

    fn to_update_bool(&self, shape: &Shape) -> bool {
        if !shape.is_bool() {
            return false;
        }

        let default = &Matrix::default();

        // Get parent modifier by index
        let parent_idx = self.uuid_to_idx.get(&shape.id);
        let parent_modifier = parent_idx
            .and_then(|idx| self.overrides.get(idx).and_then(|o| o.transform.as_ref()))
            .unwrap_or(default);

        // Returns true if the transform of any child is different to the parent's
        shape.all_children_iter(self, true, false).any(|child_id| {
            let child_modifier = self
                .uuid_to_idx
                .get(&child_id)
                .and_then(|idx| self.overrides.get(idx).and_then(|o| o.transform.as_ref()))
                .unwrap_or(default);
            !math::is_close_matrix(parent_modifier, child_modifier)
        })
    }
}

#[cfg(test)]
mod bench {
    use super::*;
    use std::time::Instant;

    fn make_uuid(n: u64) -> Uuid {
        // Offset away from the nil UUID (which `all_with_ancestors` treats as root).
        Uuid::from_u64_pair(0, n + 1)
    }

    /// Build a pool containing a single ancestor chain: root → mid_1 → … → leaf.
    /// Returns (pool, leaf_id) for driving `set_modifiers` during the bench.
    fn build_chain(depth: usize) -> (ShapesPoolImpl, Uuid) {
        let mut pool = ShapesPoolImpl::new();
        pool.initialize(depth + 1);
        let mut prev_id: Option<Uuid> = None;
        let mut last_id = Uuid::nil();
        for i in 0..=depth {
            let id = make_uuid(i as u64);
            {
                let shape = pool.add_shape(id);
                if let Some(parent) = prev_id {
                    shape.set_parent(parent);
                }
            }
            if let Some(parent_id) = prev_id {
                if let Some(parent) = pool.get_mut(&parent_id) {
                    parent.add_child(id);
                }
            }
            prev_id = Some(id);
            last_id = id;
        }
        (pool, last_id)
    }

    fn bench_set_modifiers_chain(depth: usize, iterations: usize) {
        let (mut pool, leaf_id) = build_chain(depth);
        let matrix = skia::Matrix::translate((10.0, 0.0));
        let start = Instant::now();
        for _ in 0..iterations {
            let mut m = HashMap::new();
            m.insert(leaf_id, matrix);
            pool.set_modifiers(m);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] set_modifiers leaf-in-chain depth={depth} x{iterations}: \
             {:.3}ms total, {:.2}µs/call",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / iterations as f64
        );
    }

    #[test]
    fn bench_set_modifiers_depth_3() {
        bench_set_modifiers_chain(3, 10_000);
    }

    #[test]
    fn bench_set_modifiers_depth_10() {
        bench_set_modifiers_chain(10, 10_000);
    }

    #[test]
    fn bench_set_modifiers_depth_30() {
        bench_set_modifiers_chain(30, 10_000);
    }

    /// Simulate a multi-select drag: N shapes all sharing a common parent chain
    /// get modifiers set together (frequent Penpot scenario).
    fn bench_set_modifiers_multi_select(
        depth: usize,
        fan_out: usize,
        iterations: usize,
    ) {
        let mut pool = ShapesPoolImpl::new();
        pool.initialize(depth + fan_out + 2);
        // Build ancestor chain up to a branching node.
        let mut prev_id: Option<Uuid> = None;
        for i in 0..=depth {
            let id = make_uuid(i as u64);
            {
                let shape = pool.add_shape(id);
                if let Some(parent) = prev_id {
                    shape.set_parent(parent);
                }
            }
            if let Some(parent_id) = prev_id {
                if let Some(parent) = pool.get_mut(&parent_id) {
                    parent.add_child(id);
                }
            }
            prev_id = Some(id);
        }
        let branch_parent = prev_id.expect("chain has at least root");
        // Fan out `fan_out` leaves under the branch parent.
        let mut leaves = Vec::with_capacity(fan_out);
        for j in 0..fan_out {
            let id = make_uuid((1000 + j) as u64);
            {
                let shape = pool.add_shape(id);
                shape.set_parent(branch_parent);
            }
            if let Some(parent) = pool.get_mut(&branch_parent) {
                parent.add_child(id);
            }
            leaves.push(id);
        }
        let matrix = skia::Matrix::translate((10.0, 0.0));
        let start = Instant::now();
        for _ in 0..iterations {
            let mut m = HashMap::with_capacity(leaves.len());
            for id in &leaves {
                m.insert(*id, matrix);
            }
            pool.set_modifiers(m);
        }
        let elapsed = start.elapsed();
        println!(
            "[bench] set_modifiers multi-select depth={depth} fan_out={fan_out} x{iterations}: \
             {:.3}ms total, {:.2}µs/call",
            elapsed.as_secs_f64() * 1000.0,
            elapsed.as_secs_f64() * 1_000_000.0 / iterations as f64
        );
    }

    #[test]
    fn bench_set_modifiers_multi_10_at_depth_5() {
        bench_set_modifiers_multi_select(5, 10, 10_000);
    }

    #[test]
    fn bench_set_modifiers_multi_100_at_depth_5() {
        bench_set_modifiers_multi_select(5, 100, 1_000);
    }
}
