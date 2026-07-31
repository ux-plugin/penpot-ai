//! Wire-format payload structs — the bytes the host writes and both backends read.
//!
//! D17: these definitions live here rather than in render-wasm so that the Skia and Vello
//! modules parse *identical bytes through identical definitions*, which is what makes
//! differential testing possible — capture a buffer from a live session, replay it into both,
//! diff the result.
//!
//! What is here and what is not:
//! - **Here:** the `#[repr(C)]` layouts, pure accessors, and a safe explicit codec.
//! - **Not here:** conversions into engine types. `From<Raw…> for shapes::Fill` targets Skia
//!   (`shapes::Color` is `skia::Color`) and stays in render-wasm; the Vello module gets its own
//!   conversions. That divergence is the point — same bytes, different construction.
//! - **Borderline, and deliberately excluded:** conversions into [`crate::model`]. kurbo and
//!   peniko are not engine types, but keeping this module to plain layouts means the wire
//!   format can be read and diffed without pulling in the model at all. The `RawSegmentData` →
//!   [`kurbo::BezPath`] step lives in [`crate::model::bez_path_from_raw`].
//!
//! Fields are `pub` because these are wire types: the whole point is that other crates read
//! them field by field. They are not an abstraction, they are a memory layout.
//!
//! # Why a hand-written codec
//!
//! Both submodules decode with explicit little-endian reads at stated offsets rather than by
//! transmuting bytes into the struct. Three reasons:
//!
//! 1. This crate is `#![forbid(unsafe_code)]`, and both backends need to decode.
//! 2. The *encode* direction was unsound in the code this replaces. These layouts carry
//!    padding, and transmuting a struct into bytes exposes uninitialised memory. Here padding
//!    is written as zero.
//! 3. A wire format shared by two separately-compiled binaries should be *stated*, not
//!    inherited from whatever the compiler happened to lay out.
//!
//! Each submodule's offsets reproduce the existing `#[repr(C)]` layout exactly, so this is not
//! a wire change, and a `layout_matches_repr_c` test pins that with `offset_of!` — if a field
//! is added or reordered, the test fails rather than the format silently drifting.

pub mod fill;
pub mod path;

pub use fill::*;
pub use path::*;

/// Anything that can go wrong reading a record off the wire.
///
/// Both payload families share it, so a caller decoding a mixed buffer has one error type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AbiError {
    /// The buffer ended before a full record.
    Truncated { need: usize, got: usize },
    /// A fill tag this build does not know. Carries the byte so the caller can report it.
    UnknownFillTag(u8),
    /// A path-segment tag this build does not know.
    UnknownSegmentTag(u16),
}

impl core::fmt::Display for AbiError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Truncated { need, got } => {
                write!(f, "truncated record: need {need} bytes, got {got}")
            }
            Self::UnknownFillTag(t) => write!(f, "unknown fill tag {t:#04x}"),
            Self::UnknownSegmentTag(t) => write!(f, "unknown path segment tag {t:#06x}"),
        }
    }
}

// Little-endian readers shared by both payload families. The wire is always little-endian:
// both wasm targets are, and so is every host that writes these buffers.

#[inline]
pub(crate) fn u16_at(b: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([b[off], b[off + 1]])
}

#[inline]
pub(crate) fn u32_at(b: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

#[inline]
pub(crate) fn i32_at(b: &[u8], off: usize) -> i32 {
    i32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}

#[inline]
pub(crate) fn f32_at(b: &[u8], off: usize) -> f32 {
    f32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
}
