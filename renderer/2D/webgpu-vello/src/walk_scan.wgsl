// GPU walk — pass 2: SCAN (inclusive prefix sum of the per-shape `counts`, Hillis-Steele).
//
// This is the middle pass: it turns "how many records each shape emits" into "where each shape's block
// starts", so pass 3 can write in parallel without collisions. Hillis-Steele runs in log2(n) rounds;
// the host dispatches this kernel once per round with `stride = 1, 2, 4, …`, ping-ponging src↔dst:
//
//     dst[i] = src[i] + (i >= stride ? src[i - stride] : 0)
//
// After ceil(log2(n)) rounds, `offsets[i]` holds the INCLUSIVE sum `counts[0] + … + counts[i]`. The
// scatter pass reads the exclusive start it actually needs as `offsets[i-1]` (0 for i == 0), and the
// grand total (array size) is `offsets[n-1]`.
//
// Hillis-Steele does O(n·log n) adds — not work-efficient like Blelloch — but for n ≈ 20k that is a
// few hundred thousand trivial adds across log2(n) ≈ 15 fully-parallel rounds, nowhere near a
// bottleneck. Swapping in a work-efficient scan is a later optimization; correctness first.

struct Params {
    n: u32,
    stride: u32,
    _pad: vec2<u32>,
};

@group(0) @binding(0) var<storage, read>       src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform>             p: Params;

@compute @workgroup_size(64)
fn scan(@builtin(global_invocation_id) gid: vec3<u32>) {
    let i = gid.x;
    if (i >= p.n) { return; }
    var v = src[i];
    if (i >= p.stride) {
        v = v + src[i - p.stride];
    }
    dst[i] = v;
}
