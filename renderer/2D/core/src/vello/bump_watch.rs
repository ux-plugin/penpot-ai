//! The front-end's overflow flag, read back after every frame.
//!
//! vello's bump allocators (binning, tiles, lines, segment counts, segments, the PTCL pool) are
//! sized before the front-end runs. When one runs out, its stage sets a bit in `failed` and
//! coarse writes nothing for the tiles it lost: fine paints nothing there and the frame is
//! silently black. The executor records a copy of the eight allocator words into one of these
//! ring slots before the session is freed, maps it after the submit, and takes the result the
//! next time it runs — on native right after the submit, on wasm one frame later. A frame that
//! overflowed raises the pool it lost by its watermark and is rendered again.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// Frames of readback in flight at once.
const SLOTS: usize = 4;
/// Eight `u32`s: `failed`, then the binning, ptcl, tile, seg_counts, segments, blend and lines
/// watermarks, in vello's `BumpAllocators` order.
const BYTES: u64 = 32;

pub struct BumpWatch {
    slots: Vec<(wgpu::Buffer, Arc<AtomicBool>)>,
    result: Arc<Mutex<Option<[u32; 8]>>>,
    cur: Option<usize>,
}

impl BumpWatch {
    #[must_use]
    pub fn new(device: &wgpu::Device) -> Self {
        let slots = (0..SLOTS)
            .map(|i| {
                let buf = device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("bump watch {i}")),
                    size: BYTES,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                });
                (buf, Arc::new(AtomicBool::new(false)))
            })
            .collect();
        Self { slots, result: Arc::new(Mutex::new(None)), cur: None }
    }

    /// Claim a free slot for this frame and return the buffer the copy goes into; `None` when
    /// every slot's map is still outstanding (the frame goes unwatched rather than stalling).
    pub fn begin(&mut self) -> Option<&wgpu::Buffer> {
        self.cur = self.slots.iter().position(|(_, inflight)| !inflight.load(Ordering::Relaxed));
        self.cur.map(|i| &self.slots[i].0)
    }

    /// Map this frame's slot; its words land in [`Self::take`] once the map completes.
    pub fn after_submit(&mut self) {
        let Some(i) = self.cur.take() else { return };
        let (buf, inflight) = &self.slots[i];
        inflight.store(true, Ordering::Relaxed);
        let inflight = inflight.clone();
        let staging = buf.clone();
        let result = self.result.clone();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |res| {
            if res.is_ok() {
                let words: [u32; 8] = {
                    let view = staging.slice(..).get_mapped_range();
                    let mut w = [0u32; 8];
                    for (k, slot) in w.iter_mut().enumerate() {
                        let mut b = [0u8; 4];
                        b.copy_from_slice(&view[k * 4..k * 4 + 4]);
                        *slot = u32::from_le_bytes(b);
                    }
                    w
                };
                staging.unmap();
                if let Ok(mut r) = result.lock() {
                    *r = Some(words);
                }
                if words[0] != 0 {
                    crate::vello::abi::mark_dirty();
                    crate::vello::abi::request_frame();
                }
            }
            inflight.store(false, Ordering::Relaxed);
        });
    }

    /// The most recent frame's allocator words, once; `None` until a map has completed.
    pub fn take(&mut self) -> Option<[u32; 8]> {
        self.result.lock().ok().and_then(|mut r| r.take())
    }
}
