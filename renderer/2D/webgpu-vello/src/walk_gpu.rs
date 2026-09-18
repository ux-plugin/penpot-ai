//! GPU walk kernel (V1) — the wgpu plumbing behind `walk_count.wgsl` / `walk_scan.wgsl` /
//! `walk_scatter.wgsl`. It takes the flattened, page-space [`FlatShape`] array (built once per
//! structural edit by [`render_core::schedule::flatten::flatten_leaves`]) and runs the scheduler's
//! hot per-shape walk as three compute passes: **count** the visible tiles each shape covers,
//! **scan** those counts into per-shape output offsets, **scatter** one [`StepRecord`] per covered
//! tile. The output is the exact record stream that
//! [`render_core::schedule::flatten::count_and_scatter`] produces on the CPU — that host function is
//! the *oracle* this transliterates, and [`walk_on_gpu`] is diffed against it (see the tests) so the
//! algorithm and the GPU are never debugged at the same time.
//!
//! Classic (WebGPU) backend only — the kernel needs compute + storage buffers + a prefix-scan, none
//! of which WebGL2 has, which is *why* the hybrid backend keeps the CPU walk (the platform forces the
//! split). Readback here is the blocking `poll(wait)` form, correct for native tests; the browser hot
//! path (S3) swaps in the async `map_async` + inflight-flag readback (mirrors
//! `render_core::vello::gputime`) so the frame never stalls on the map.

use std::collections::HashSet;

use render_core::kurbo::{Affine, Rect};
use render_core::schedule::flatten::{FlatShape, StepRecord};
use render_core::tiling::{TileKey, TILE_SIZE};
use wgpu::util::DeviceExt;

/// One `FlatShape` as the GPU reads it: bounds + affected as `f32`, `std430` (two `vec4` = 32 bytes).
/// The `f32` narrowing of the `f64` page-space rects is deliberate and is the one place GPU and oracle
/// can legitimately disagree — a shape bound that lands *exactly* on a tile boundary can round to the
/// far side under `f32` — which is precisely what the diff test is here to surface.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuShape {
    bounds: [f32; 4],
    affected: [f32; 4],
}

/// Uniforms shared by the count + scatter passes. Field offsets match the `Uniforms` struct in
/// `walk_count.wgsl` / `walk_scatter.wgsl` (the `vec4`s land at 16-aligned offsets in both). In the
/// *uniform* address space WGSL rounds the whole struct up to a 16-byte multiple — its trailing
/// `vec3<i32>` sits at offset 80, making the struct 96 bytes — so the tail padding here is sized to
/// 96 too, or `create_bind_group` rejects the binding as under the shader's minimum. Only the fields
/// through `zoom_bucket` (offsets 0..68) are read; the rest is inert padding.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct WalkUniforms {
    lin: [f32; 4],
    trans: [f32; 2],
    tile_size: f32,
    n: u32,
    dirty: [f32; 4],
    vtile: [i32; 4],
    zoom_bucket: i32,
    _pad: [i32; 7],
}

/// `std430` params for one scan round — matches `Params` in `walk_scan.wgsl`.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ScanParams {
    n: u32,
    stride: u32,
    _pad: [u32; 2],
}

/// The scatter row as written by `walk_scatter.wgsl` — identical layout to [`StepRecord`]
/// (`u32, i32, i32, i32`). Read back and mapped into `StepRecord` so the rest of render-core never
/// sees a GPU type.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct GpuRecord {
    shape_idx: u32,
    tile_x: i32,
    tile_y: i32,
    zoom_bucket: i32,
}

/// The three compute pipelines, built once and reused every frame. Bind-group layouts are inferred
/// from the shaders (`layout: None`), so the binding order here is fixed by the `@binding(_)`
/// declarations in the WGSL, not restated.
pub struct WalkPipelines {
    count: wgpu::ComputePipeline,
    scan: wgpu::ComputePipeline,
    scatter: wgpu::ComputePipeline,
}

impl WalkPipelines {
    /// Compile the three shaders and build their pipelines. Cheap to hold for the process lifetime;
    /// nothing here is per-frame or per-scene.
    #[must_use]
    pub fn new(device: &wgpu::Device) -> Self {
        let module = |src: &str, label: &str| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(src.into()),
            })
        };
        let pipeline = |m: &wgpu::ShaderModule, entry: &str, label: &str| {
            device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                label: Some(label),
                layout: None,
                module: m,
                entry_point: Some(entry),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                cache: None,
            })
        };
        let count_m = module(include_str!("walk_count.wgsl"), "walk_count");
        let scan_m = module(include_str!("walk_scan.wgsl"), "walk_scan");
        let scatter_m = module(include_str!("walk_scatter.wgsl"), "walk_scatter");
        Self {
            count: pipeline(&count_m, "count", "walk_count"),
            scan: pipeline(&scan_m, "scan", "walk_scan"),
            scatter: pipeline(&scatter_m, "scatter", "walk_scatter"),
        }
    }
}

/// Threads per workgroup — must equal the `@workgroup_size(64)` in every walk shader.
const WG: u32 = 64;

#[inline]
fn workgroups(n: u32) -> u32 {
    n.div_ceil(WG).max(1)
}

/// Derive the count/scatter uniforms from the frame's `view`, the visible tile *range*, and the dirty
/// region. `visible` on a full rebuild is the solid viewport rectangle, so its bounding tile range is
/// exact (the WGSL clamps each shape's tile span to it, matching `visible.contains`). Returns `None`
/// when nothing is visible (empty set) — the caller then has no work.
fn uniforms(n: u32, view: Affine, visible: &HashSet<TileKey>, dirty_bbox: Option<Rect>) -> Option<WalkUniforms> {
    let mut it = visible.iter();
    let first = it.next()?;
    let (mut vx0, mut vx1) = (first.tile_x, first.tile_x);
    let (mut vy0, mut vy1) = (first.tile_y, first.tile_y);
    let zoom_bucket = first.zoom_bucket;
    for t in it {
        vx0 = vx0.min(t.tile_x);
        vx1 = vx1.max(t.tile_x);
        vy0 = vy0.min(t.tile_y);
        vy1 = vy1.max(t.tile_y);
    }
    let [a, b, c, d, e, f] = view.as_coeffs().map(|v| v as f32);
    let dirty = dirty_bbox.map_or([f32::MIN, f32::MIN, f32::MAX, f32::MAX], |r| {
        [r.x0 as f32, r.y0 as f32, r.x1 as f32, r.y1 as f32]
    });
    Some(WalkUniforms {
        lin: [a, b, c, d],
        trans: [e, f],
        tile_size: TILE_SIZE as f32,
        n,
        dirty,
        vtile: [vx0, vx1, vy0, vy1],
        zoom_bucket,
        _pad: [0; 7],
    })
}

/// Run the walk on the GPU and read the records back. Returns the same `Vec<StepRecord>` the host
/// [`count_and_scatter`](render_core::schedule::flatten::count_and_scatter) oracle produces for the
/// same inputs — so a caller can diff the two, or (S3) feed the records straight into
/// `records_to_steps`. Blocking readback: correct on native, not the browser hot path.
///
/// Empty result when `flat` is empty or nothing is visible.
#[must_use]
pub fn walk_on_gpu(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    pipes: &WalkPipelines,
    flat: &[FlatShape],
    view: Affine,
    visible: &HashSet<TileKey>,
    dirty_bbox: Option<Rect>,
) -> Vec<StepRecord> {
    let n = flat.len() as u32;
    if n == 0 {
        return Vec::new();
    }
    let Some(u) = uniforms(n, view, visible, dirty_bbox) else {
        return Vec::new();
    };

    let shapes: Vec<GpuShape> = flat
        .iter()
        .map(|fs| GpuShape {
            bounds: [fs.bounds.x0 as f32, fs.bounds.y0 as f32, fs.bounds.x1 as f32, fs.bounds.y1 as f32],
            affected: [fs.affected.x0 as f32, fs.affected.y0 as f32, fs.affected.x1 as f32, fs.affected.y1 as f32],
        })
        .collect();
    let shape_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("walk shapes"),
        contents: bytemuck::cast_slice(&shapes),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let uni_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("walk uniforms"),
        contents: bytemuck::bytes_of(&u),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let scan_buf = |label: &str| {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label),
            size: u64::from(n) * 4,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        })
    };
    let buf_a = scan_buf("walk counts/scan A");
    let buf_b = scan_buf("walk scan B");

    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("walk count+scan") });
    {
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("count bg"),
            layout: &pipes.count.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: shape_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: uni_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: buf_a.as_entire_binding() },
            ],
        });
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("count"), timestamp_writes: None });
        pass.set_pipeline(&pipes.count);
        pass.set_bind_group(0, &bg, &[]);
        pass.dispatch_workgroups(workgroups(n), 1, 1);
    }

    let mut src = &buf_a;
    let mut dst = &buf_b;
    let mut stride = 1u32;
    let mut round_params = Vec::new();
    while stride < n {
        let p = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("scan params"),
            contents: bytemuck::bytes_of(&ScanParams { n, stride, _pad: [0; 2] }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        round_params.push(p);
        let p = round_params.last().unwrap();
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scan bg"),
            layout: &pipes.scan.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: src.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: dst.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: p.as_entire_binding() },
            ],
        });
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("scan"), timestamp_writes: None });
        pass.set_pipeline(&pipes.scan);
        pass.set_bind_group(0, &bg, &[]);
        pass.dispatch_workgroups(workgroups(n), 1, 1);
        drop(pass);
        std::mem::swap(&mut src, &mut dst);
        stride <<= 1;
    }
    let offsets_buf = src;
    queue.submit([enc.finish()]);

    let offsets = read_u32(device, queue, offsets_buf, n);
    let total = *offsets.last().unwrap_or(&0);
    if total == 0 {
        return Vec::new();
    }

    let records_buf = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("walk records"),
        size: u64::from(total) * std::mem::size_of::<GpuRecord>() as u64,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("walk scatter") });
    {
        let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("scatter bg"),
            layout: &pipes.scatter.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: shape_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: uni_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: offsets_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: records_buf.as_entire_binding() },
            ],
        });
        let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("scatter"), timestamp_writes: None });
        pass.set_pipeline(&pipes.scatter);
        pass.set_bind_group(0, &bg, &[]);
        pass.dispatch_workgroups(workgroups(n), 1, 1);
    }
    queue.submit([enc.finish()]);

    let bytes = read_back(device, queue, &records_buf, u64::from(total) * std::mem::size_of::<GpuRecord>() as u64);
    let gpu: &[GpuRecord] = bytemuck::cast_slice(&bytes);
    gpu.iter()
        .map(|r| StepRecord {
            shape_idx: r.shape_idx,
            tile_x: r.tile_x,
            tile_y: r.tile_y,
            zoom_bucket: r.zoom_bucket,
        })
        .collect()
}

/// Resident GPU buffers for a flattened scene — the "persistent GPU scene" the endgame keeps across
/// frames, patched on structural edits, never re-uploaded on a mere zoom/pan. Holding these lets the
/// bench measure the *steady-state* per-frame dispatch cost (upload + allocation amortized to zero),
/// which is the number that actually decides whether a GPU walk beats the CPU. Native bench aid.
#[cfg(not(target_arch = "wasm32"))]
pub struct WalkResources {
    shape_buf: wgpu::Buffer,
    uni_buf: wgpu::Buffer,
    buf_a: wgpu::Buffer,
    buf_b: wgpu::Buffer,
    records_buf: wgpu::Buffer,
    n: u32,
}

#[cfg(not(target_arch = "wasm32"))]
impl WalkResources {
    /// Upload `flat` once and allocate the scan + records buffers. `records_capacity` is the max
    /// records the scene can emit for the views to be measured (the bench passes the exact total).
    #[must_use]
    pub fn new(device: &wgpu::Device, flat: &[FlatShape], records_capacity: u32) -> Self {
        let shapes: Vec<GpuShape> = flat
            .iter()
            .map(|fs| GpuShape {
                bounds: [fs.bounds.x0 as f32, fs.bounds.y0 as f32, fs.bounds.x1 as f32, fs.bounds.y1 as f32],
                affected: [fs.affected.x0 as f32, fs.affected.y0 as f32, fs.affected.x1 as f32, fs.affected.y1 as f32],
            })
            .collect();
        let n = flat.len() as u32;
        let shape_buf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("resident shapes"),
            contents: bytemuck::cast_slice(&shapes),
            usage: wgpu::BufferUsages::STORAGE,
        });
        let uni_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("resident uniforms"),
            size: std::mem::size_of::<WalkUniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let scan_buf = |label: &str| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: u64::from(n.max(1)) * 4,
                usage: wgpu::BufferUsages::STORAGE,
                mapped_at_creation: false,
            })
        };
        let records_buf = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("resident records"),
            size: u64::from(records_capacity.max(1)) * std::mem::size_of::<GpuRecord>() as u64,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });
        Self { shape_buf, uni_buf, buf_a: scan_buf("resident scan A"), buf_b: scan_buf("resident scan B"), records_buf, n }
    }

    /// Steady-state per-frame GPU cost (ms): write the frame's uniform, record count→scan→scatter over
    /// the resident buffers, submit, block on `poll(wait)`. No upload, no allocation, no readback — the
    /// per-frame work a persistent GPU scene actually does. `0.0` when nothing is visible.
    #[must_use]
    pub fn dispatch_ms(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pipes: &WalkPipelines,
        view: Affine,
        visible: &HashSet<TileKey>,
        dirty_bbox: Option<Rect>,
    ) -> f64 {
        let Some(u) = uniforms(self.n, view, visible, dirty_bbox) else {
            return 0.0;
        };
        queue.write_buffer(&self.uni_buf, 0, bytemuck::bytes_of(&u));

        let start = std::time::Instant::now();
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("resident walk") });
        {
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipes.count.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.shape_buf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: self.uni_buf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: self.buf_a.as_entire_binding() },
                ],
            });
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
            pass.set_pipeline(&pipes.count);
            pass.set_bind_group(0, &bg, &[]);
            pass.dispatch_workgroups(workgroups(self.n), 1, 1);
        }
        let mut src = &self.buf_a;
        let mut dst = &self.buf_b;
        let mut stride = 1u32;
        let mut round_params = Vec::new();
        while stride < self.n {
            round_params.push(device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: None,
                contents: bytemuck::bytes_of(&ScanParams { n: self.n, stride, _pad: [0; 2] }),
                usage: wgpu::BufferUsages::UNIFORM,
            }));
            let p = round_params.last().unwrap();
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipes.scan.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: src.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: dst.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: p.as_entire_binding() },
                ],
            });
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
            pass.set_pipeline(&pipes.scan);
            pass.set_bind_group(0, &bg, &[]);
            pass.dispatch_workgroups(workgroups(self.n), 1, 1);
            drop(pass);
            std::mem::swap(&mut src, &mut dst);
            stride <<= 1;
        }
        let offsets_buf = src;
        {
            let bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &pipes.scatter.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: self.shape_buf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 1, resource: self.uni_buf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: offsets_buf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 3, resource: self.records_buf.as_entire_binding() },
                ],
            });
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
            pass.set_pipeline(&pipes.scatter);
            pass.set_bind_group(0, &bg, &[]);
            pass.dispatch_workgroups(workgroups(self.n), 1, 1);
        }
        queue.submit([enc.finish()]);
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        start.elapsed().as_secs_f64() * 1000.0
    }
}

/// Blocking copy-to-staging + map + `poll(wait)` readback of `len` `u32`s. Native only.
fn read_u32(device: &wgpu::Device, queue: &wgpu::Queue, src: &wgpu::Buffer, len: u32) -> Vec<u32> {
    let bytes = read_back(device, queue, src, u64::from(len) * 4);
    bytemuck::cast_slice(&bytes).to_vec()
}

/// Blocking readback of `size` bytes from `src`. Copies to a `MAP_READ` staging buffer, submits, maps,
/// and spins the device until the map lands. `poll(wait)` blocks the calling thread, so this is for
/// native tests; the browser path uses the async `map_async` + inflight-flag form instead.
fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, src: &wgpu::Buffer, size: u64) -> Vec<u8> {
    let staging = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("walk readback"),
        size,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    enc.copy_buffer_to_buffer(src, 0, &staging, 0, size);
    queue.submit([enc.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |r| r.expect("walk readback map"));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = slice.get_mapped_range().to_vec();
    staging.unmap();
    data
}
