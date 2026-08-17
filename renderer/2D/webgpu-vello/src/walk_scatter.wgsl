// GPU walk — pass 3: SCATTER. One invocation per FlatShape; recomputes the shape's visible tile range
// (identical to the count pass) and writes one record per tile into its slot, `offsets[i]` onward. The
// exclusive prefix-sum in `offsets` (pass 2, `walk_scan`) guarantees the per-shape slots are disjoint
// and gap-free, so no atomics are needed and z-order is preserved (records land in shape order, and
// within a shape in tiles_overlapping's y-outer / x-inner order — matching the host oracle exactly).

struct Shape {
    bounds: vec4<f32>,
    affected: vec4<f32>,
};

struct Uniforms {
    lin: vec4<f32>,
    trans: vec2<f32>,
    tile_size: f32,
    n: u32,
    dirty: vec4<f32>,
    vtile: vec4<i32>,
    zoom_bucket: i32,
    _pad: vec3<i32>,
};

// Mirrors `render_core::schedule::flatten::StepRecord` (std430): shape index + tile. The full `Step`
// is rebuilt CPU-side from this + view, so nothing here stores a Rect or a surface ref.
struct Record {
    shape_idx: u32,
    tile_x: i32,
    tile_y: i32,
    zoom_bucket: i32,
};

@group(0) @binding(0) var<storage, read>       shapes: array<Shape>;
@group(0) @binding(1) var<uniform>             u: Uniforms;
// INCLUSIVE prefix sum from walk_scan: offsets[i] = counts[0]+…+counts[i]. Shape i's exclusive start
// is therefore offsets[i-1] (0 for i == 0).
@group(0) @binding(2) var<storage, read>       offsets: array<u32>;
@group(0) @binding(3) var<storage, read_write> records: array<Record>;

// Identical to walk_count's `visible_tile_range` — kept in lockstep so scatter emits exactly the tiles
// count counted.
fn visible_tile_range(b: vec4<f32>) -> vec4<i32> {
    let a = u.lin.x; let bb = u.lin.y; let c = u.lin.z; let d = u.lin.w;
    let e = u.trans.x; let f = u.trans.y;
    let p0 = vec2(a * b.x + c * b.y + e, bb * b.x + d * b.y + f);
    let p1 = vec2(a * b.z + c * b.y + e, bb * b.z + d * b.y + f);
    let p2 = vec2(a * b.z + c * b.w + e, bb * b.z + d * b.w + f);
    let p3 = vec2(a * b.x + c * b.w + e, bb * b.x + d * b.w + f);
    let dmin = min(min(p0, p1), min(p2, p3));
    let dmax = max(max(p0, p1), max(p2, p3));
    let ts = u.tile_size;
    var x0 = i32(floor((dmin.x - e) / ts));
    var x1 = i32(ceil((dmax.x - e) / ts)) - 1;
    var y0 = i32(floor((dmin.y - f) / ts));
    var y1 = i32(ceil((dmax.y - f) / ts)) - 1;
    x0 = max(x0, u.vtile.x); x1 = min(x1, u.vtile.y);
    y0 = max(y0, u.vtile.z); y1 = min(y1, u.vtile.w);
    return vec4(x0, x1, y0, y1);
}

@compute @workgroup_size(64)
fn scatter(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= u.n) { return; }
    let s = shapes[i];
    let af = s.affected;
    if (af.z <= u.dirty.x || af.x >= u.dirty.z || af.w <= u.dirty.y || af.y >= u.dirty.w) { return; }
    let r = visible_tile_range(s.bounds);
    if (r.y < r.x || r.w < r.z) { return; }
    // Exclusive start = the inclusive sum of everything strictly before i (0 for the first shape).
    var slot = 0u;
    if (i > 0u) { slot = offsets[i - 1u]; }
    // y-outer, x-inner — the order `tiles_overlapping_page_rect` yields, so records match the oracle.
    for (var ty = r.z; ty <= r.w; ty = ty + 1) {
        for (var tx = r.x; tx <= r.y; tx = tx + 1) {
            records[slot] = Record(i, tx, ty, u.zoom_bucket);
            slot = slot + 1u;
        }
    }
}
