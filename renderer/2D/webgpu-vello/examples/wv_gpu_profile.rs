//! Full-frame CPU/GPU/boundary decomposition of the classic whole-viewport path.
//!
//! Renders the document-scale fixture through the real sink at 4K and attributes the frame three
//! ways at once:
//!   - CPU lane: the sink's wall-clock phase buckets (gather detect, encode walk, phased-begin
//!     resolve+upload, phase-loop record, submit);
//!   - GPU lane, per dispatch: the vello fork's `wgpu-profiler` integration, patched to stamp every
//!     compute pass at its boundaries (Metal has no in-pass timestamps), aggregated by shader label;
//!   - GPU lane, per role: the sink's own `PassProfiler` region stamps (crop/blur/refraction/
//!     composite/stamp/swap) covering the effect passes vello's engine never sees;
//!   - the boundary: scene-encoding upload bytes, `queue.submit` CPU cost, and the post-submit
//!     `device.poll` wait (what the CPU spends blocked on the GPU).
//!
//! Requires the `gpu-profiler` feature: `cargo run --release --features gpu-profiler --example
//! wv_gpu_profile [N] [EVERY]`.

use std::collections::BTreeMap;
use std::time::Instant;

use render_core::kurbo::Affine;
use render_core::vello::sink::Sink;
use vello_gpu_renderer::ClassicBackend;

const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;

/// Viewport and frame counts, env-tunable (`WV_W`/`WV_H`/`WV_WARMUP`/`WV_FRAMES`) so a pathological
/// configuration — the per-node front-end fallback (`WV_ATLAS=0`) at a high effect count runs ~1.1 s
/// per frame at 4K — can be measured small. A run whose frames each hold the queue for ~a second
/// starves the window server for as long as it lasts, so shrink the viewport and the frame count
/// before measuring anything known to be slow.
fn env_u32(key: &str, default: u32) -> u32 {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

#[cfg(feature = "gpu-profiler")]
fn collect(node: &wgpu_profiler::GpuTimerQueryResult, agg: &mut BTreeMap<String, (f64, u32)>) {
    if let Some(t) = &node.time {
        let e = agg.entry(node.label.clone()).or_insert((0.0, 0));
        e.0 += (t.end - t.start) * 1000.0;
        e.1 += 1;
    }
    for child in &node.nested_queries {
        collect(child, agg);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n: u32 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(20000);
    let every: u32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(25);
    let w = env_u32("WV_W", 3840);
    let h = env_u32("WV_H", 2160);
    let warmup = env_u32("WV_WARMUP", 3) as usize;
    let timed = env_u32("WV_FRAMES", 12) as usize;

    let instance = wgpu::Instance::default();
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .expect("adapter");
    let feats = adapter.features()
        & (wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES);
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("wv_gpu_profile"),
        required_features: feats,
        ..Default::default()
    }))
    .expect("device");
    println!(
        "adapter: {} | timestamps: {} | rw-format-caps: {}",
        adapter.get_info().name,
        feats.contains(wgpu::Features::TIMESTAMP_QUERY),
        feats.contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES),
    );

    let cells = render_core::vello::abi::load_scale_scene(n, every);
    render_core::vello::abi::set_render_options(0, 1.0);
    render_core::vello::abi::set_view(1.0, 0.0, 0.0);
    render_core::vello::abi::set_canvas_background(0xffff_ffff);
    render_core::vello::abi::set_scheduler(1);
    render_core::vello::abi::set_tile_effects(1);
    let stamps = std::env::var("WV_STAMPS").map_or(true, |v| v != "0");
    if stamps {
        render_core::vello::abi::set_prof_passes(1);
    }
    if std::env::var("WV_ATLAS").as_deref() == Ok("0") {
        render_core::vello::abi::set_wv_atlas(0);
        println!("effect-surface atlas: OFF (per-node front-ends)");
    }
    println!("scene: {n} shapes, effect every {every} ({cells} effect cells), {w}x{h}\n");

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("profile target"),
        size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::STORAGE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });

    let mut backend = ClassicBackend::new(&device);
    let mut sink = Sink::new(&device, FORMAT);
    backend.sync_fonts();
    backend.upload_pending_images();

    {
        let mut scene = backend.new_scene(w as u16, h as u16);
        use render_core::vello::rasterize::RasterBackend;
        RasterBackend::draw_scene_range(&mut backend, &mut scene, Affine::IDENTITY, 0, usize::MAX);
        let enc = scene.scene().encoding();
        let ptag = enc.path_tags.len();
        let pdata = enc.path_data.len();
        let dtag = enc.draw_tags.len() * 4;
        let ddata = enc.draw_data.len() * 4;
        let tf = enc.transforms.len() * 24;
        let sty = enc.styles.len() * 8;
        let total = ptag + pdata + dtag + ddata + tf + sty;
        println!("== scene encoding (uploaded every dirty frame) ==");
        println!("path tags   {:>10} B", ptag);
        println!("path data   {:>10} B", pdata);
        println!("draw tags   {:>10} B", dtag);
        println!("draw data   {:>10} B", ddata);
        println!("transforms  {:>10} B", tf);
        println!("styles      {:>10} B", sty);
        println!("~total      {:>10.2} MB  ({} paths, {} draw tags)\n", total as f64 / 1e6, enc.n_paths, enc.draw_tags.len());
    }

    let mut gpu_agg: BTreeMap<String, (f64, u32)> = BTreeMap::new();
    let mut cpu_ms = 0.0f64;
    let mut poll_ms = 0.0f64;
    let mut wall_ms = 0.0f64;
    let mut profiled_frames = 0u32;

    let mut frame = |sink: &mut Sink, backend: &mut ClassicBackend, timed: bool| {
        render_core::vello::abi::set_view(1.0, 0.0, 0.0);
        let t0 = Instant::now();
        sink.render_whole_viewport(backend, &device, &queue, &target, Affine::IDENTITY, w, h, true);
        let t1 = Instant::now();
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
        let t2 = Instant::now();
        #[cfg(feature = "gpu-profiler")]
        if let Some(results) = backend.profiler_frame(&queue) {
            if timed {
                for r in &results {
                    collect(r, &mut gpu_agg);
                }
                profiled_frames += 1;
            }
        }
        if timed {
            cpu_ms += (t1 - t0).as_secs_f64() * 1000.0;
            poll_ms += (t2 - t1).as_secs_f64() * 1000.0;
            wall_ms += (t2 - t0).as_secs_f64() * 1000.0;
        }
    };

    for _ in 0..warmup {
        frame(&mut sink, &mut backend, false);
    }

    let read = |b: u32| render_core::vello::abi::prof_read(b);
    let cpu_base: Vec<f64> = [126u32, 130, 131, 127, 3, 118, 119, 120, 121, 116, 117, 122, 123, 128, 18, 19]
        .iter()
        .map(|&b| read(b))
        .collect();
    for _ in 0..timed {
        frame(&mut sink, &mut backend, true);
    }
    for _ in 0..8 {
        let enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("drain") });
        queue.submit([enc.finish()]);
        device.poll(wgpu::PollType::Wait { submission_index: None, timeout: None }).expect("poll");
    }

    let idx = |b: u32| -> usize {
        [126u32, 130, 131, 127, 3, 118, 119, 120, 121, 116, 117, 122, 123, 128, 18, 19]
            .iter()
            .position(|&x| x == b)
            .unwrap()
    };
    let delta = |b: u32| read(b) - cpu_base[idx(b)];
    let per_frame = |b: u32| delta(b) / timed as f64;

    let k = timed as f64;
    println!("== frame wall (avg of {timed}) ==");
    println!("wall/frame              {:8.3} ms", wall_ms / k);
    println!("  cpu (record+submit)   {:8.3} ms", cpu_ms / k);
    println!("  poll wait (GPU drain) {:8.3} ms", poll_ms / k);

    println!("\n== CPU lane (sink buckets) ==");
    println!("gather detect           {:8.3} ms", per_frame(126));
    println!("encode walk             {:8.3} ms", per_frame(130));
    println!("phased begin (resolve)  {:8.3} ms", per_frame(131));
    println!("phase loop record       {:8.3} ms", per_frame(127));
    println!("queue.submit            {:8.3} ms", per_frame(3));

    println!("\n== GPU lane: vello dispatches (avg/frame over {profiled_frames} profiled frames) ==");
    let mut rows: Vec<(&String, &(f64, u32))> = gpu_agg.iter().collect();
    rows.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap());
    let pf = f64::from(profiled_frames.max(1));
    let mut vello_total = 0.0;
    for (label, (ms, cnt)) in &rows {
        vello_total += *ms;
        println!("{label:<28} {:8.3} ms  ({:.1} passes/frame)", *ms / pf, f64::from(*cnt) / pf);
    }
    println!("{:<28} {:8.3} ms", "TOTAL vello", vello_total / pf);

    let frames_prof = delta(128).max(1e-9);
    println!("\n== GPU lane: sink role regions (PassProfiler, avg over {frames_prof:.0} profiled frames) ==");
    let role = |b: u32| delta(b) / frames_prof;
    println!("other (incl vello work) {:8.3} ms", role(123));
    println!("crop                    {:8.3} ms", role(116));
    println!("displacement            {:8.3} ms", role(117));
    println!("refraction              {:8.3} ms", role(118));
    println!("blur                    {:8.3} ms", role(119));
    println!("composite               {:8.3} ms", role(120));
    println!("stamp                   {:8.3} ms", role(121));
    println!("swap blit               {:8.3} ms", role(122));

    let gpun = delta(19).max(1e-9);
    println!("\n== GPU whole-frame span (GpuTimer) ==");
    println!("gpu busy/frame          {:8.3} ms  ({:.0} samples)", delta(18) / gpun, gpun);
}
