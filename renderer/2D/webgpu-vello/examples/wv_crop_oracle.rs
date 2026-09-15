//! Ground-truth gate for viewport-edge rendering: the same view rendered DIRECT (target = the
//! viewport) must match a PADDED render (target enlarged by `MARGIN` on every side, view shifted
//! so the same page content lands in the centre) cropped back to the viewport. The padded render
//! has real content where the direct render's effect reads hit the frame, so it is exactly the
//! guard-band ground truth the static battery, the tiled oracle and the warm/cold stale gate all
//! lack — none of them can express "a shape with effects crossing the viewport edge".
//!
//! Verdicts per case: differences FARTHER than `EDGE_BAND` from the border are artifacts (FAIL —
//! nothing should change away from the frame); differences INSIDE the band are the documented
//! cost of the edge-extend clamps (reported, not failed — slice 3's guard band is the upgrade
//! that will shrink them to zero). Interior Δ≤2 up to a small count is tolerated: a framing change
//! moves f32 rounding at bilinear half-texel boundaries (LSB wobble), and a served ground draws
//! the scene past the frame without the effects below the chain (ruling 13), which a padded
//! render does carry; structural bugs climb into the tens of thousands of pixels. One case widens
//! the delta to its frost scatter's dither: `ed-zoom-06` refracts the sphere's edge through a
//! frosted lens and the scatter's hash flips with the framing (Δ10 on a few hundred pixels,
//! unchanged since before the rewrite, invisible at 4× zoom).
//!
//! Run: `cargo run --release --example wv_crop_oracle` (WV_RW=1 for the rw tier). Failing cases
//! dump direct/reference/diff PNGs into `.vello-proofs/`.

use std::collections::HashSet;

use render_core::kurbo::Affine;
use render_core::tiling::TileKey;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

#[path = "util/replay.rs"]
mod replay_util;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const W: u32 = 2560;
const H: u32 = 1086;
const MARGIN: u32 = 256;
const EDGE_BAND: u32 = 160;
const PROOFS: &str = ".vello-proofs";

/// The editor-doc fixture the browser capture produced (see `util/replay.rs`).
const EDITOR_FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/showcase-editor.abi.json");

#[derive(Clone, Copy, PartialEq)]
enum Doc {
    LensGrid,
    LensGridK,
    Editor,
    BgblurStack,
    BgblurStackDeep,
    BlendUnderBgblur,
    DropShadow,
    ShadowUnderBgblur,
}

/// Every zoom here divides `MARGIN` exactly in f32 — the padded render's device shift must be a
/// whole number of pixels or the oracle manufactures subpixel diffs of its own.
struct Case {
    name: &'static str,
    doc: Doc,
    zoom: f32,
    pan: (f32, f32),
    /// The interior (max channel delta, pixel count) tolerated: the LSB wobble of a framing
    /// change, or, where a frost scatter dithers a refracted high-contrast edge, the dither's own
    /// amplitude and reach.
    tol: (u8, u64),
}

fn cases() -> Vec<Case> {
    let c = |name, doc, zoom, pan| Case { name, doc, zoom, pan, tol: (2, 2000) };
    vec![
        c("lens-top", Doc::LensGrid, 8.0, (-434.0, -118.2)),
        c("lens-bottom", Doc::LensGrid, 8.0, (-434.0, 30.0)),
        c("lens-left", Doc::LensGrid, 8.0, (-478.5, -53.0)),
        c("lens-right", Doc::LensGrid, 8.0, (-102.3, -53.0)),
        c("lens-strided", Doc::LensGrid, 16.0, (-500.0, -99.1)),
        c("lens-left-k", Doc::LensGridK, 8.0, (-478.5, -53.0)),
        c("lens-right-k", Doc::LensGridK, 8.0, (-102.3, -53.0)),
        c("ed-glass-top", Doc::Editor, 4.0, (60.0, -230.0)),
        c("ed-glass-left", Doc::Editor, 4.0, (-450.0, -165.0)),
        c("ed-bgblur-bottom", Doc::Editor, 4.0, (-530.0, -278.5)),
        c("ed-layerblur-right", Doc::Editor, 4.0, (-145.0, -74.0)),
        c("ed-fit", Doc::Editor, 2.0, (0.0, 0.0)),
        Case { tol: (10, 2200), ..c("ed-zoom-06", Doc::Editor, 0.6, (0.0, 0.0)) },
        c("shadow-right", Doc::DropShadow, 8.0, (-1.0, -63.0)),
        c("shadow-writer-bottom", Doc::ShadowUnderBgblur, 4.0, (-1.0, 21.5)),
        c("bgblur-stack-right", Doc::BgblurStack, 2.0, (0.0, 0.0)),
        c("blend-under-bottom", Doc::BlendUnderBgblur, 2.0, (0.0, 0.0)),
        c("blend-under-z4", Doc::BlendUnderBgblur, 4.0, (-530.0, -288.5)),
        c("bgblur-stack-deep", Doc::BgblurStackDeep, 2.0, (0.0, 0.0)),
    ]
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
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING,
        view_formats: &[],
    })
}

fn read_back(device: &wgpu::Device, queue: &wgpu::Queue, texture: &wgpu::Texture, w: u32, h: u32) -> Vec<u8> {
    let unpadded = w * 4;
    let padded = unpadded.div_ceil(256) * 256;
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("crop oracle readback"),
        size: u64::from(padded) * u64::from(h),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: None });
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded),
                rows_per_image: Some(h),
            },
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

fn write_png(path: &str, rgba: &[u8], w: u32, h: u32) {
    let file = std::fs::File::create(path).expect("create png");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().unwrap().write_image_data(rgba).unwrap();
    println!("  wrote {path}");
}

fn main() {
    let instance = wgpu::Instance::default();
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .expect("adapter");
    let rw = std::env::var("WV_RW").is_ok_and(|v| v == "1")
        && adapter
            .get_texture_format_features(wgpu::TextureFormat::Rgba8Unorm)
            .flags
            .contains(wgpu::TextureFormatFeatureFlags::STORAGE_READ_WRITE);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_crop_oracle"),
        required_features: if rw {
            wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES
        } else {
            wgpu::Features::empty()
        },
        ..Default::default()
    }))
    .expect("device");
    vello_gpu_renderer::set_rw_accumulator_supported(rw);
    println!("wv crop oracle: {W}x{H} direct vs +{MARGIN}px padded crop, rw-accumulator {rw}");

    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);

    let mut failures = 0u32;
    let mut installed: Option<Doc> = None;
    let only = std::env::var("WV_CASE").ok();
    for case in cases() {
        if only.as_deref().is_some_and(|f| !case.name.contains(f)) {
            continue;
        }
        if installed != Some(case.doc) {
            match case.doc {
                Doc::LensGrid => {
                    render_core::vello::abi::load_glass_grid_scene(1, 1);
                }
                Doc::LensGridK => {
                    render_core::vello::abi::load_glass_grid_scene_k(1, 1, 500);
                }
                Doc::Editor => {
                    let rep = replay_util::replay(EDITOR_FIXTURE);
                    println!("(editor fixture: {} calls replayed)", rep.applied);
                }
                Doc::BlendUnderBgblur => {
                    render_core::vello::abi::load_blend_under_bgblur_scene(24);
                }
                Doc::BgblurStack => {
                    render_core::vello::abi::load_bgblur_stack_scene(24);
                }
                Doc::BgblurStackDeep => {
                    render_core::vello::abi::load_bgblur_stack3_scene(24);
                }
                Doc::DropShadow => {
                    render_core::vello::abi::load_dropblur_diag_scene();
                }
                Doc::ShadowUnderBgblur => {
                    render_core::vello::abi::load_shadow_under_bgblur_scene();
                }
            }
            render_core::vello::abi::set_render_options(0, 1.0);
            render_core::vello::abi::set_canvas_background(0xffff_ffff);
            render_core::vello::abi::set_scheduler(1);
            render_core::vello::abi::set_tile_effects(1);
            installed = Some(case.doc);
        }

        let direct_target = make_target(&device, W, H, "crop oracle direct");
        let mut backend = ClassicBackend::new(&device);
        let mut sink = Sink::new(&device, FORMAT);
        backend.sync_fonts();
        backend.upload_pending_images();
        render_core::vello::abi::set_view(case.zoom, case.pan.0, case.pan.1);
        sink.render_whole_viewport(&mut backend, &device, &queue, &direct_target, Affine::IDENTITY, W, H, true);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        let direct = read_back(&device, &queue, &direct_target, W, H);

        let tiled_target = make_target(&device, W, H, "crop oracle tiled");
        let mut tiled_backend = ClassicBackend::new(&device);
        let mut tiled_sink = Sink::new(&device, FORMAT);
        tiled_backend.sync_fonts();
        tiled_backend.upload_pending_images();
        render_core::vello::abi::set_view(case.zoom, case.pan.0, case.pan.1);
        let full_view = render_core::vello::abi::effective_view(Affine::IDENTITY);
        let (dirty_all, dirty_rects) = render_core::vello::abi::take_dirty();
        let dirty = tiled_sink.plan_frame(full_view, W, H, dirty_all || true, &dirty_rects);
        let dirty_set: HashSet<TileKey> = dirty.iter().copied().collect();
        let schedule = render_core::vello::abi::build_schedule(Affine::IDENTITY, &dirty_set, true);
        tiled_sink.execute(&schedule, &dirty, &mut tiled_backend, &device, &queue, &tiled_target, Affine::IDENTITY, W, H);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        let tiled = read_back(&device, &queue, &tiled_target, W, H);
        let mut vs_tiled = 0u64;
        let mut vs_tiled_max = 0u8;
        for (a, b) in direct.chunks_exact(4).zip(tiled.chunks_exact(4)) {
            let d = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
            if d > 0 {
                vs_tiled += 1;
                vs_tiled_max = vs_tiled_max.max(d);
            }
        }

        let (pw, ph) = (W + 2 * MARGIN, H + 2 * MARGIN);
        let pad_target = make_target(&device, pw, ph, "crop oracle padded");
        let mut pad_backend = ClassicBackend::new(&device);
        let mut pad_sink = Sink::new(&device, FORMAT);
        pad_backend.sync_fonts();
        pad_backend.upload_pending_images();
        let m = MARGIN as f32 / case.zoom;
        render_core::vello::abi::set_view(case.zoom, case.pan.0 + m, case.pan.1 + m);
        pad_sink.render_whole_viewport(&mut pad_backend, &device, &queue, &pad_target, Affine::IDENTITY, pw, ph, true);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        let padded = read_back(&device, &queue, &pad_target, pw, ph);
        if std::env::var("WV_DUMP_PADDED").is_ok() {
            write_png(&format!("{PROOFS}/crop-{}-padded-full.png", case.name), &padded, pw, ph);
        }

        let mut interior = 0u64;
        let mut interior_max = 0u8;
        let mut band = 0u64;
        let mut band_max = 0u8;
        let mut reference = vec![0u8; (W * H * 4) as usize];
        for y in 0..H {
            let src = (((y + MARGIN) * pw + MARGIN) * 4) as usize;
            let dst = (y * W * 4) as usize;
            reference[dst..dst + (W * 4) as usize]
                .copy_from_slice(&padded[src..src + (W * 4) as usize]);
        }
        for y in 0..H {
            for x in 0..W {
                let i = ((y * W + x) * 4) as usize;
                let d = direct[i..i + 4]
                    .iter()
                    .zip(&reference[i..i + 4])
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap_or(0);
                if d == 0 {
                    continue;
                }
                let near = x < EDGE_BAND || y < EDGE_BAND || x >= W - EDGE_BAND || y >= H - EDGE_BAND;
                if near {
                    band += 1;
                    band_max = band_max.max(d);
                } else {
                    interior += 1;
                    interior_max = interior_max.max(d);
                }
            }
        }
        let ok = interior_max <= case.tol.0 && interior <= case.tol.1;
        if !ok {
            failures += 1;
        }
        println!(
            "{:<20} {:<6} interior {interior} px (max {interior_max})   edge band {band} px (max {band_max})   vs-tiled {vs_tiled} px (max {vs_tiled_max})",
            case.name,
            if ok { "PASS" } else { "FAIL" },
        );
        if !ok || std::env::var("WV_DUMP").is_ok() {
            write_png(&format!("{PROOFS}/crop-{}-direct.png", case.name), &direct, W, H);
            write_png(&format!("{PROOFS}/crop-{}-reference.png", case.name), &reference, W, H);
            write_png(&format!("{PROOFS}/crop-{}-tiled.png", case.name), &tiled, W, H);
        }
    }
    if failures > 0 {
        println!("\n{failures} case(s) FAILED — direct render diverges from ground truth away from the frame");
        std::process::exit(1);
    }
    println!("\nall cases match ground truth away from the frame; edge bands = clamp cost (slice 3 shrinks them)");
}
