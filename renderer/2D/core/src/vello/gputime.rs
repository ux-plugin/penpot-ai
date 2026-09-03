//! Real GPU execution time per frame, via a wgpu timestamp query.
//!
//! Every other bucket in [`crate::vello::prof`] is CPU wall clock. That matters more than it sounds: the
//! sink's `rasterize` and `blit` calls only *record* into a command encoder — nothing has executed
//! when they return, and the whole frame runs on the GPU later, at the single `queue.submit`. So
//! the CPU buckets cannot tell you whether the GPU is the limiter; they measure how long the CPU
//! took to describe the work.
//!
//! This closes that gap. WebGPU exposes timestamps only at *pass boundaries* (`writeTimestamp` on
//! the encoder was dropped from the spec), so the timer brackets the frame with the two passes the
//! sink already owns at either end: the background clear that opens the frame gets the start stamp,
//! and a dedicated empty pass recorded just before submit gets the end stamp. The span therefore
//! covers everything in between — including vello's own compute passes, which this crate cannot
//! annotate without patching the submodule.
//!
//! Readback is asynchronous: a frame's number arrives one to three frames after the frame that
//! produced it. An earlier version kept a *single* readback buffer and skipped every frame while a
//! map was outstanding — which on a slow scene yielded only a handful of samples over a whole run,
//! biased toward whichever frames happened to align with the map completing. Averaging six samples
//! produced a GPU figure that exceeded the achieved frame period, which is physically impossible
//! (one queue, serial execution: per-frame GPU busy time cannot exceed the period). So this uses a
//! **ring** of `SLOTS` independent query/resolve/staging triples, round-robining one per frame; with
//! the ring deeper than the readback latency, essentially every frame yields a sample and the
//! average is trustworthy.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Bytes for two `u64` timestamps.
const SPAN: u64 = 16;
/// Frames of readback in flight at once. Readback lags 1-3 frames, so a ring of 6 leaves a free
/// slot essentially every frame — the sample count then tracks the frame count.
const SLOTS: usize = 6;

struct Slot {
    /// `resolve_query_set` destination (`QUERY_RESOLVE | COPY_SRC`).
    resolve: wgpu::Buffer,
    /// Host-visible copy the map reads from (`MAP_READ | COPY_DST`).
    staging: wgpu::Buffer,
    /// This slot's map is outstanding — do not reuse it until the callback clears this. An atomic
    /// (not a `Cell`) only so the `map_async` callback satisfies wgpu's `WasmNotSend` bound, which is
    /// `Send` on native; access stays single-threaded, so `Relaxed` is all that's needed.
    inflight: Arc<AtomicBool>,
}

pub struct GpuTimer {
    /// One set of `2 * SLOTS` timestamps: slot `i` uses indices `2i` (start) and `2i+1` (end).
    set: wgpu::QuerySet,
    slots: Vec<Slot>,
    /// Nanoseconds per timestamp tick, from the queue.
    period_ns: f32,
    /// Slot chosen for the current frame, or `None` when the whole ring is still in flight (the
    /// frame goes untimed rather than stalling on a map).
    cur: Option<usize>,
}

impl GpuTimer {
    /// A timer, or `None` when the device was created without `TIMESTAMP_QUERY` (the hybrid backend,
    /// or any adapter that does not advertise it). Callers treat `None` as "GPU time unavailable"
    /// and report zero rather than guessing.
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<Self> {
        if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            return None;
        }
        let set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("frame gpu span"),
            ty: wgpu::QueryType::Timestamp,
            count: (2 * SLOTS) as u32,
        });
        let slots = (0..SLOTS)
            .map(|i| Slot {
                resolve: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("gpu span resolve {i}")),
                    size: SPAN,
                    usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                }),
                staging: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("gpu span staging {i}")),
                    size: SPAN,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                inflight: Arc::new(AtomicBool::new(false)),
            })
            .collect();
        Some(Self { set, slots, period_ns: queue.get_timestamp_period(), cur: None })
    }

    /// Claim a free ring slot for this frame. Call once, before recording any pass. Leaves `cur`
    /// `None` (frame untimed) when every slot is still awaiting readback.
    pub fn begin(&mut self) {
        self.cur = self.slots.iter().position(|s| !s.inflight.load(Ordering::Relaxed));
    }

    /// Timestamp writes for the frame's **first** pass — the background clear — into this frame's
    /// slot. `None` when no slot was free this frame, so the clear records without a stamp.
    pub fn start_writes(&self) -> Option<wgpu::RenderPassTimestampWrites<'_>> {
        self.cur.map(|i| wgpu::RenderPassTimestampWrites {
            query_set: &self.set,
            beginning_of_pass_write_index: Some((2 * i) as u32),
            end_of_pass_write_index: None,
        })
    }

    /// Record the OPENING stamp as an empty load/store pass over `view`, for callers with no natural
    /// first render pass to hang [`Self::start_writes`] on (the whole-viewport path opens with a vello
    /// compute pass this crate can't annotate). Call once, right after `begin`, before any real work.
    /// Pair with [`Self::end`]. No-op when the frame is untimed.
    pub fn begin_pass(&mut self, enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView) {
        let Some(i) = self.cur else { return };
        enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("gpu span begin"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: Some(wgpu::RenderPassTimestampWrites {
                query_set: &self.set,
                beginning_of_pass_write_index: Some((2 * i) as u32),
                end_of_pass_write_index: None,
            }),
            multiview_mask: None,
        });
    }

    /// Record the closing stamp as an empty load/store pass over `view`. Called after every other
    /// pass the frame records, immediately before [`Self::resolve`]. No-op when the frame is untimed.
    pub fn end(&mut self, enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView) {
        let Some(i) = self.cur else { return };
        enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("gpu span end"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: Some(wgpu::RenderPassTimestampWrites {
                query_set: &self.set,
                beginning_of_pass_write_index: None,
                end_of_pass_write_index: Some((2 * i + 1) as u32),
            }),
            multiview_mask: None,
        });
    }

    /// Resolve this frame's pair into its slot's staging buffer. No-op when the frame is untimed.
    pub fn resolve(&mut self, enc: &mut wgpu::CommandEncoder) {
        let Some(i) = self.cur else { return };
        let s = &self.slots[i];
        let base = (2 * i) as u32;
        enc.resolve_query_set(&self.set, base..base + 2, &s.resolve, 0);
        enc.copy_buffer_to_buffer(&s.resolve, 0, &s.staging, 0, SPAN);
    }

    /// Start the async map for this frame's slot. Call once the frame's encoder has been submitted;
    /// the callback lands on a later turn of the event loop and accumulates into [`crate::vello::prof`].
    /// The span is read as `abs_diff`: Metal samples empty-pass boundary stamps at encoder
    /// boundaries and can land the pair in either order (measured swapped on Apple M-series), so
    /// the magnitude is the frame span regardless of which stamp resolved later.
    pub fn after_submit(&mut self) {
        let Some(i) = self.cur.take() else { return };
        let s = &self.slots[i];
        s.inflight.store(true, Ordering::Relaxed);
        let inflight = s.inflight.clone();
        let staging = s.staging.clone();
        let period = f64::from(self.period_ns);
        s.staging.slice(..).map_async(wgpu::MapMode::Read, move |res| {
            if res.is_ok() {
                {
                    let view = staging.slice(..).get_mapped_range();
                    let mut t = [0u64; 2];
                    for (j, slot) in t.iter_mut().enumerate() {
                        let mut b = [0u8; 8];
                        b.copy_from_slice(&view[j * 8..j * 8 + 8]);
                        *slot = u64::from_le_bytes(b);
                    }
                    let ticks = t[0].abs_diff(t[1]);
                    #[cfg(not(target_arch = "wasm32"))]
                    if std::env::var("WV_DBG_GPUTIME").is_ok() {
                        eprintln!("WV_DBG_GPUTIME: t0={} t1={} ticks={ticks}", t[0], t[1]);
                    }
                    if ticks > 0 && t[0] > 0 && t[1] > 0 {
                        crate::vello::prof::add_gpu(ticks as f64 * period / 1.0e6);
                    }
                }
                staging.unmap();
            }
            inflight.store(false, Ordering::Relaxed);
        });
    }
}

/// Max timestamp boundaries [`PassProfiler`] records per frame. Sized for a deep stack: 8 gathers ×
/// ~6 stamps + the swap-blit pair ≈ 50, with headroom.
const PMAX: usize = 64;

/// Per-**region** GPU timing for the whole-viewport gather frame. Where [`GpuTimer`] brackets the
/// whole frame with two stamps, this records a stamp between every region of interest (empty
/// Load/Store boundary passes — on one queue the delta between two stamps is that region's GPU-busy
/// time). Each stamp carries the DBG **bucket** for the interval that ENDS at it, so on readback the
/// deltas accumulate BY ROLE (all gathers' `blur` into one bucket, etc.) — depth-independent, unlike
/// positional. Reliability rests on the caller anchoring each stamp on a texture the measured pass
/// wrote (a read dependency forces correct ordering on a TBDR GPU). Gated by [`crate::vello::abi::prof_passes`].
pub struct PassProfiler {
    set: wgpu::QuerySet,
    slots: Vec<Slot>,
    period_ns: f32,
    cur: Option<usize>,
    /// Stamps recorded in the current frame's slot so far (indices `0..n`).
    n: usize,
    /// DBG bucket for the interval ending at each stamp; `labels[k]` attributes delta `[k-1, k]`.
    /// `labels[0]` is unused (no interval precedes the first stamp).
    labels: Vec<usize>,
}

impl PassProfiler {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<Self> {
        if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            return None;
        }
        let set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("per-pass gpu"),
            ty: wgpu::QueryType::Timestamp,
            count: (PMAX * SLOTS) as u32,
        });
        let span = (PMAX * 8) as u64;
        let slots = (0..SLOTS)
            .map(|i| Slot {
                resolve: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("pass gpu resolve {i}")),
                    size: span,
                    usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                    mapped_at_creation: false,
                }),
                staging: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("pass gpu staging {i}")),
                    size: span,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                inflight: Arc::new(AtomicBool::new(false)),
            })
            .collect();
        Some(Self { set, slots, period_ns: queue.get_timestamp_period(), cur: None, n: 0, labels: Vec::new() })
    }

    /// Claim a free ring slot for this frame; leaves the frame unprofiled when the ring is saturated.
    pub fn begin(&mut self) {
        self.cur = self.slots.iter().position(|s| !s.inflight.load(Ordering::Relaxed));
        self.n = 0;
        self.labels.clear();
    }

    /// Record one boundary stamp as an empty Load/Store pass over `view`. Call once before the first
    /// pass and once after each pass; consecutive stamps bracket a pass. No-op when unprofiled or the
    /// per-frame budget is spent.
    ///
    /// `bucket` is the DBG bucket for the interval that ENDS at this stamp (the work between the
    /// previous stamp and this one). The first stamp of a frame has no preceding interval, so its
    /// bucket is ignored — pass any value.
    pub fn stamp(&mut self, enc: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, bucket: usize) {
        let Some(i) = self.cur else { return };
        if self.n >= PMAX {
            return;
        }
        self.labels.push(bucket);
        let idx = (i * PMAX + self.n) as u32;
        crate::vello::sink::note_passes(1);
        enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("pass gpu stamp"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            occlusion_query_set: None,
            timestamp_writes: Some(wgpu::RenderPassTimestampWrites {
                query_set: &self.set,
                beginning_of_pass_write_index: Some(idx),
                end_of_pass_write_index: None,
            }),
            multiview_mask: None,
        });
        self.n += 1;
    }

    /// Resolve this frame's stamps into staging. Call once, after the last stamp, before submit.
    pub fn resolve(&mut self, enc: &mut wgpu::CommandEncoder) {
        let Some(i) = self.cur else { return };
        if self.n < 2 {
            return;
        }
        let s = &self.slots[i];
        let base = (i * PMAX) as u32;
        enc.resolve_query_set(&self.set, base..base + self.n as u32, &s.resolve, 0);
        enc.copy_buffer_to_buffer(&s.resolve, 0, &s.staging, 0, (self.n * 8) as u64);
    }

    /// Map this frame's slot and, in the callback, accumulate each delta into the DBG bucket carried
    /// by its ending stamp (`labels[k+1]` for delta `[k, k+1]`) — so the same role across many gathers
    /// sums into one bucket. DBG bucket 28 counts profiled frames; the host divides bucket `b` by 28
    /// for that role's average per-frame GPU ms.
    pub fn after_submit(&mut self) {
        let Some(i) = self.cur.take() else { return };
        let n = self.n;
        if n < 2 {
            return;
        }
        let labels = self.labels.clone();
        let s = &self.slots[i];
        s.inflight.store(true, Ordering::Relaxed);
        let inflight = s.inflight.clone();
        let staging = s.staging.clone();
        let period = f64::from(self.period_ns);
        s.staging.slice(..(n * 8) as u64).map_async(wgpu::MapMode::Read, move |res| {
            if res.is_ok() {
                {
                    let view = staging.slice(..(n * 8) as u64).get_mapped_range();
                    let mut t = vec![0u64; n];
                    for (j, slot) in t.iter_mut().enumerate() {
                        let mut b = [0u8; 8];
                        b.copy_from_slice(&view[j * 8..j * 8 + 8]);
                        *slot = u64::from_le_bytes(b);
                    }
                    for k in 0..n - 1 {
                        let ticks = t[k + 1].saturating_sub(t[k]);
                        if ticks > 0 {
                            crate::vello::prof::dbg_add(labels[k + 1], ticks as f64 * period / 1.0e6);
                        }
                    }
                    crate::vello::prof::dbg_add(28, 1.0);
                }
                staging.unmap();
            }
            inflight.store(false, Ordering::Relaxed);
        });
    }
}
