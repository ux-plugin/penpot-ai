//! Versioned per-tile backdrop snapshot pool — the shared cache the batched gather stage reads from.
//!
//! The batched gather collapse defers every independent gather's blur, runs them in one pass, and
//! scatters the results back. To do that it must hold each gather's **backdrop** (the below-z content
//! in its sample region) until the batch runs. Rather than freeze a whole backdrop per gather, it
//! snapshots **per tile**, keyed by `(tile, version)`:
//!
//! - A tile shared by several gathers **and unwritten between them** is copied **once** and reused
//!   (refcount > 1) — the common "many panels over one static background" case costs one copy.
//! - When a write would advance a tile whose current version is still referenced, the old version is
//!   already materialised in the pool (copy-on-write), so both versions coexist for their readers.
//!
//! The pool knows nothing about gathers — a gather is just a set of `(tile, version)` references, and
//! eviction is pure refcount. A [cap](SnapshotPool::over_cap) bounds live snapshots so a pathological
//! version-piling scene flushes early instead of growing without bound (the same discipline the sink's
//! submit-batching uses to stay OOM-safe).
//!
//! This module is the data structure + copy-on-write bookkeeping only; the scheduler that walks
//! z-order, calls [`SnapshotPool::on_write`]/[`SnapshotPool::capture`], and drives the batched blur
//! lives in the sink.

use std::collections::HashMap;

use render_core::tiling::TileKey;

use crate::sink::{PoolKey, TexturePool};

/// A specific frozen version of one tile's pixels. `version` bumps on every write to the tile, so two
/// reads of the same tile at different z-levels resolve to different keys and can be held at once.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct SnapshotKey {
    pub tile: TileKey,
    pub version: u32,
}

/// The usage a snapshot texture carries: copied *into* from the live tile (`COPY_DST`), sampled by the
/// batched effect (`TEXTURE_BINDING`), and copyable *out* so it can also back a `register_texture`
/// inline draw or a masked scatter (`COPY_SRC`).
fn snapshot_usage() -> wgpu::TextureUsages {
    wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC
}

struct Entry {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    /// Pending gathers still referencing this exact `(tile, version)`. Released when it hits zero.
    refs: u32,
}

/// A frame-scoped pool of versioned tile snapshots (see the module docs).
pub struct SnapshotPool {
    entries: HashMap<SnapshotKey, Entry>,
    /// Current (latest-written) version of each tile. Absent ⇒ version 0.
    version: HashMap<TileKey, u32>,
    /// Maximum live snapshots before the scheduler must flush a wave (memory bound).
    cap: usize,
}

impl SnapshotPool {
    /// A pool bounded to `cap` live snapshots (e.g. 64 → ~64 MB at 512²·RGBA8).
    #[must_use]
    pub fn new(cap: usize) -> Self {
        Self { entries: HashMap::new(), version: HashMap::new(), cap }
    }

    /// The tile's current version — what a [`capture`](Self::capture) right now would reference.
    #[must_use]
    pub fn current_version(&self, tile: TileKey) -> u32 {
        self.version.get(&tile).copied().unwrap_or(0)
    }

    /// Record that `tile` was written: its next reads see a fresh version. Any snapshot of the *old*
    /// version stays live (copy-on-write) until its readers release it — this only advances the
    /// counter, it does not touch existing entries.
    pub fn on_write(&mut self, tile: TileKey) {
        *self.version.entry(tile).or_insert(0) += 1;
    }

    /// Reference the tile's current version, snapshotting `src` into the pool if that version is not
    /// already held. `src` must be `COPY_SRC` (the sink's tile surfaces are). Returns the key the caller
    /// records against the gather; call [`release`](Self::release) once per capture when the gather has
    /// been flushed.
    pub fn capture(
        &mut self,
        tile: TileKey,
        src: &wgpu::Texture,
        device: &wgpu::Device,
        pool: &mut TexturePool,
        enc: &mut wgpu::CommandEncoder,
    ) -> SnapshotKey {
        let key = SnapshotKey { tile, version: self.current_version(tile) };
        if let Some(e) = self.entries.get_mut(&key) {
            e.refs += 1;
            return key;
        }
        let (w, h, format) = (src.width(), src.height(), src.format());
        let texture = pool.acquire(device, PoolKey::new(w, h, format, snapshot_usage()), "tile snapshot");
        enc.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: src,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 },
        );
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.entries.insert(key, Entry { texture, view, refs: 1 });
        key
    }

    /// A held snapshot's view, for the batched effect to sample.
    #[must_use]
    pub fn view(&self, key: SnapshotKey) -> Option<&wgpu::TextureView> {
        self.entries.get(&key).map(|e| &e.view)
    }

    /// Drop one reference to `key`; when the last reader releases it the texture returns to `pool`.
    pub fn release(&mut self, key: SnapshotKey, pool: &mut TexturePool) {
        if let Some(e) = self.entries.get_mut(&key) {
            e.refs = e.refs.saturating_sub(1);
            if e.refs == 0 {
                if let Some(e) = self.entries.remove(&key) {
                    pool.release(e.texture);
                }
            }
        }
    }

    /// Live snapshot count (each ~one tile of VRAM).
    #[must_use]
    pub fn live(&self) -> usize {
        self.entries.len()
    }

    /// Whether the pool has reached its cap and the scheduler should flush a wave before capturing more.
    #[must_use]
    pub fn over_cap(&self) -> bool {
        self.entries.len() >= self.cap
    }

    /// Return every remaining texture to `pool` and forget all versions — called at frame end.
    pub fn clear(&mut self, pool: &mut TexturePool) {
        for (_, e) in self.entries.drain() {
            pool.release(e.texture);
        }
        self.version.clear();
    }
}
