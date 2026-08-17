// GPU walk — pass 1: COUNT. One invocation per FlatShape; writes the number of visible tiles that
// shape covers into `counts[i]` (0 if dirty-culled or off-viewport). Transliteration of
// `render_core::schedule::flatten::count_and_scatter`'s count pass + `tiling::tiles_overlapping_page_rect`,
// which is proven byte-identical to the recursive walk on the host — so this is the reference, not a
// guess. `visible` is the viewport tile *range* (a full-rebuild's dirty set is the whole viewport),
// so the tiles-∩-visible intersection is just a clamp of two rectangular ranges.

struct Shape {
    bounds: vec4<f32>,    // page-space x0,y0,x1,y1 — drives tile coverage
    affected: vec4<f32>,  // page-space x0,y0,x1,y1 — drives the dirty-reject
};

struct Uniforms {
    lin: vec4<f32>,    // view linear part a,b,c,d  (kurbo: x'=a*x+c*y+e, y'=b*x+d*y+f)
    trans: vec2<f32>,  // view translation e,f
    tile_size: f32,    // TILE_SIZE (512)
    n: u32,            // shape count
    dirty: vec4<f32>,  // dirty-bbox page-space x0,y0,x1,y1 (the viewport page rect on a full rebuild)
    vtile: vec4<i32>,  // viewport tile range: vx_min, vx_max, vy_min, vy_max (inclusive) = `visible`
    zoom_bucket: i32,
    _pad: vec3<i32>,
};

@group(0) @binding(0) var<storage, read>       shapes: array<Shape>;
@group(0) @binding(1) var<uniform>             u: Uniforms;
@group(0) @binding(2) var<storage, read_write> counts: array<u32>;

// The shape's visible tile range [x0..x1]×[y0..y1] (inclusive), clamped to the viewport. `.x > .y`
// (or `.z > .w`) means empty. Shared verbatim with the scatter pass so counts and scatter agree.
fn visible_tile_range(b: vec4<f32>) -> vec4<i32> {
    let a = u.lin.x; let bb = u.lin.y; let c = u.lin.z; let d = u.lin.w;
    let e = u.trans.x; let f = u.trans.y;
    // Device bbox of the four transformed corners (general enough for a rotated view).
    let p0 = vec2(a * b.x + c * b.y + e, bb * b.x + d * b.y + f);
    let p1 = vec2(a * b.z + c * b.y + e, bb * b.z + d * b.y + f);
    let p2 = vec2(a * b.z + c * b.w + e, bb * b.z + d * b.w + f);
    let p3 = vec2(a * b.x + c * b.w + e, bb * b.x + d * b.w + f);
    let dmin = min(min(p0, p1), min(p2, p3));
    let dmax = max(max(p0, p1), max(p2, p3));
    let ts = u.tile_size;
    // Same floor / ceil-1 convention as `tiles_overlapping_page_rect`.
    var x0 = i32(floor((dmin.x - e) / ts));
    var x1 = i32(ceil((dmax.x - e) / ts)) - 1;
    var y0 = i32(floor((dmin.y - f) / ts));
    var y1 = i32(ceil((dmax.y - f) / ts)) - 1;
    // Intersect with the viewport tile range (= `visible.contains`).
    x0 = max(x0, u.vtile.x); x1 = min(x1, u.vtile.y);
    y0 = max(y0, u.vtile.z); y1 = min(y1, u.vtile.w);
    return vec4(x0, x1, y0, y1);
}

@compute @workgroup_size(64)
fn count(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= u.n) { return; }
    let s = shapes[i];
    // Dirty-reject on the effect-affected bounds (page space), same strict half-open test as the host.
    let af = s.affected;
    if (af.z <= u.dirty.x || af.x >= u.dirty.z || af.w <= u.dirty.y || af.y >= u.dirty.w) {
        counts[i] = 0u;
        return;
    }
    let r = visible_tile_range(s.bounds);
    if (r.y < r.x || r.w < r.z) {
        counts[i] = 0u;
        return;
    }
    counts[i] = u32((r.y - r.x + 1) * (r.w - r.z + 1));
}
