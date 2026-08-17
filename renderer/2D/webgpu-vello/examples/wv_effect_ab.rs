//! Headless A/B: render an effect fixture through BOTH classic paths — the tiled scheduler
//! (`build_schedule` + `sink.execute`, the proven reference) and the native whole-viewport path
//! (`sink.render_whole_viewport`) — read both textures back, and count differing pixels. This is the
//! definitive per-pixel proof that a whole-viewport effect matches its tiled reference, with no
//! browser/screenshot resampling in the loop.
//!
//! Scenes (SCENE env, default `layer-blur`): `layer-blur`, `path-shadow`, `inner-shadow`,
//! `combined`, `boolean`, and `matrix` — every effect combination, one per cell.
//! Whole-viewport mode: renders the DEFAULT (`wvPhased=0`, per-segment) AND the collapsed
//! (`wvPhased=1`, front-end-once) path, diffing each against the tiled reference.
//!
//! Run: `SCENE=layer-blur cargo run --release --example wv_effect_ab`.

use std::collections::HashSet;

use render_core::kurbo::Affine;
use render_core::tiling::TileKey;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const PROOFS: &str = "/Users/dhiat/coding/penpot-ai/.claude/worktrees/ai-chat-feature-status-bbf703/.vello-proofs";

fn install(scene: &str) -> u32 {
    match scene {
        "path-shadow" => render_core::vello::abi::load_path_shadow_scene(),
        "inner-shadow" => render_core::vello::abi::load_inner_shadow_scene(),
        "combined" => render_core::vello::abi::load_combined_scene(),
        "boolean" => render_core::vello::abi::load_boolean_scene(),
        "matrix" => render_core::vello::abi::load_matrix_scene(),
        _ => render_core::vello::abi::load_layer_blur_scene(),
    }
}

fn make_target(device: &wgpu::Device, w: u32, h: u32, label: &str) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

fn frame_setup(cells: u32) -> (u32, u32) {
    let (w, h) = render_core::parity::canvas_size(cells as usize);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(1.0, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff); // opaque white, so effects read
    (w, h)
}

fn main() {
    let scene = std::env::var("SCENE").unwrap_or_else(|_| "layer-blur".to_string());

    let instance = wgpu::Instance::default();
    let Some(adapter) = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default())).ok()
    else {
        eprintln!("no wgpu adapter — cannot run the wv A/B");
        return;
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_effect_ab"),
        ..Default::default()
    }))
    .expect("device");

    let mut backend = ClassicBackend::new(&device);
    let root = Affine::IDENTITY;

    // ---- Tiled reference (the proven path) ----
    let cells = install(&scene);
    let (w, h) = frame_setup(cells);
    println!("wv A/B [{scene}]: {cells} cells, {w}x{h}");
    backend.sync_fonts();
    backend.upload_pending_images();
    let mut tiled_sink = Sink::new(&device, FORMAT);
    let full_view = render_core::vello::abi::effective_view(root);
    let (dirty_all, dirty_rects) = render_core::vello::abi::take_dirty();
    let dirty = tiled_sink.plan_frame(full_view, w, h, dirty_all, &dirty_rects);
    let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();
    let schedule = render_core::vello::abi::build_schedule(root, &dirty_set, dirty_all);
    let tiled_target = make_target(&device, w, h, "wv ab tiled");
    tiled_sink.execute(&schedule, &dirty, &mut backend, &device, &queue, &tiled_target, root, w, h);
    let tiled_rgba = read_back(&device, &queue, &tiled_target, w, h);
    write_png(&format!("{PROOFS}/{scene}-tiled.png"), &tiled_rgba, w, h);

    // ---- Whole-viewport, both modes ----
    for phased in [false, true] {
        // Reinstall so the fixture's dirty state is fresh for this WV render.
        let cells = install(&scene);
        let (w2, h2) = frame_setup(cells);
        assert_eq!((w, h), (w2, h2), "fixture size must be stable across installs");
        render_core::vello::abi::set_wv_phased(u32::from(phased));
        backend.sync_fonts();
        backend.upload_pending_images();
        let mut wv_sink = Sink::new(&device, FORMAT);
        let wv_target = make_target(&device, w, h, "wv ab whole-viewport");
        // Drain dirty so present-on-demand doesn't matter; force the render with content_dirty=true.
        let _ = render_core::vello::abi::take_dirty();
        wv_sink.render_whole_viewport(&mut backend, &device, &queue, &wv_target, root, w, h, true);
        let wv_rgba = read_back(&device, &queue, &wv_target, w, h);
        let mode = if phased { "phased" } else { "default" };
        write_png(&format!("{PROOFS}/{scene}-wv-{mode}.png"), &wv_rgba, w, h);

        let (diff_px, max_delta) = diff(&tiled_rgba, &wv_rgba);
        let total = (w * h) as usize;
        let pct = 100.0 * diff_px as f64 / total as f64;
        println!(
            "  WV {mode:<7} vs tiled: {diff_px}/{total} px differ ({pct:.4}%), max channel delta {max_delta}"
        );
        // The matrix scene exists to find the ONE combination that broke, which an aggregate number
        // hides — a whole cell rendering blank is a few percent of the canvas, indistinguishable from
        // the soft-gradient noise the render-scale downscale leaves everywhere. So report per cell.
        if scene == "matrix" {
            per_cell_report(&tiled_rgba, &wv_rgba, w);
        }
    }
}

/// Diff each fixture cell separately and print them worst-first, named.
fn per_cell_report(tiled: &[u8], wv: &[u8], w: u32) {
    let labels: Vec<&'static str> =
        render_core::parity::build_matrix_scene().1.into_iter().map(|(_, l)| l).collect();
    let cell = render_core::parity::CELL as u32;
    let margin = render_core::parity::MARGIN as u32;
    let cols = render_core::parity::COLS as u32;
    let mut rows: Vec<(String, usize, u8, f64)> = Vec::new();
    for (i, label) in labels.iter().enumerate() {
        let i = i as u32;
        let (x0, y0) = (margin + (i % cols) * cell, margin + (i / cols) * cell);
        let (mut count, mut max_delta) = (0usize, 0u8);
        for y in y0..(y0 + cell) {
            for x in x0..(x0 + cell) {
                let o = ((y * w + x) * 4) as usize;
                if o + 4 > tiled.len() {
                    continue;
                }
                let d = (0..4).map(|k| tiled[o + k].abs_diff(wv[o + k])).max().unwrap_or(0);
                max_delta = max_delta.max(d);
                if d > 1 {
                    count += 1;
                }
            }
        }
        let pct = 100.0 * count as f64 / (cell * cell) as f64;
        rows.push(((*label).to_string(), count, max_delta, pct));
    }
    rows.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap());
    println!("    {:<16} {:>10} {:>9} {:>7}", "cell", "px differ", "of cell", "max Δ");
    for (label, count, max_delta, pct) in rows {
        println!("    {label:<16} {count:>10} {pct:>8.2}% {max_delta:>7}");
    }
}

/// Per-pixel diff: count pixels whose max channel delta exceeds a small tolerance, and the overall max.
fn diff(a: &[u8], b: &[u8]) -> (usize, u8) {
    const TOL: u8 = 1; // ±1/255 rounding between an isolated-subtree blit and the tiled composite
    let mut count = 0usize;
    let mut max_delta = 0u8;
    for (pa, pb) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        let mut d = 0u8;
        for k in 0..4 {
            d = d.max(pa[k].abs_diff(pb[k]));
        }
        max_delta = max_delta.max(d);
        if d > TOL {
            count += 1;
        }
    }
    (count, max_delta)
}

fn write_png(path: &str, rgba: &[u8], w: u32, h: u32) {
    let file = std::fs::File::create(path).expect("create png");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().unwrap().write_image_data(rgba).unwrap();
    println!("  wrote {path}");
}

/// Copy the texture to a padded staging buffer, map it, and strip the 256-byte row padding.
fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
    let unpadded = w * 4;
    let padded = unpadded.div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("wv ab readback"),
        size: u64::from(padded) * u64::from(h),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(h) },
        },
        wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
    );
    queue.submit([enc.finish()]);
    let slice = buffer.slice(..);
    slice.map_async(wgpu::MapMode::Read, |r| r.expect("map"));
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    let data = slice.get_mapped_range();
    let mut out = Vec::with_capacity((unpadded * h) as usize);
    for row in 0..h {
        let start = (row * padded) as usize;
        out.extend_from_slice(&data[start..start + unpadded as usize]);
    }
    drop(data);
    buffer.unmap();
    out
}
