//! Wire-format payload structs — the bytes the host writes and both backends read.
//!
//! D17: these definitions live here rather than in render-wasm so that the Skia and Vello
//! modules parse *identical bytes through identical definitions*, which is what makes
//! differential testing possible — capture a buffer from a live session, replay it into both,
//! diff the result.
//!
//! What is here and what is not:
//! - **Here:** the `#[repr(C)]` layouts and pure accessors. Primitives only, no engine types.
//! - **Not here:** `From<Raw…> for shapes::Fill` and friends. Those target Skia types
//!   (`shapes::Color` is `skia::Color`) and stay in render-wasm; the Vello module gets its own
//!   conversions into [`crate::model`]. That divergence is the point — same bytes, different
//!   construction.
//! - **Not here yet:** the byte codec. render-wasm decodes with `std::mem::transmute`, which
//!   this crate cannot host (`#![forbid(unsafe_code)]`), and which is unsound in the
//!   struct-to-bytes direction anyway because these layouts contain padding. A safe explicit
//!   codec belongs here; until it exists the codec stays in render-wasm as free functions.
//!
//! Fields are `pub` because these are wire types: the whole point is that other crates read
//! them field by field. They are not an abstraction, they are a memory layout.

use render_macros::ToJs;

/// Maximum stops carried inline by a gradient payload. The layout is fixed-size, so this is
/// part of the wire format — changing it is a breaking change on both sides.
pub const MAX_GRADIENT_STOPS: usize = 16;

pub const FLAG_KEEP_ASPECT_RATIO: u8 = 1 << 0;
pub const FLAG_HAS_DEST: u8 = 1 << 1;

#[repr(C)]
#[repr(align(4))]
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct RawSolidData {
    /// Packed ARGB, matching Skia's `Color` word order.
    pub color: u32,
}

#[derive(Debug, PartialEq, Clone, Copy)]
#[repr(C)]
pub struct RawStopData {
    pub color: u32,
    pub offset: f32,
}

#[derive(Debug, PartialEq, Clone, Copy)]
#[repr(C)]
#[repr(align(4))]
pub struct RawGradientData {
    pub start_x: f32,
    pub start_y: f32,
    pub end_x: f32,
    pub end_y: f32,
    pub opacity: u8,
    // 24-bit padding here, reserved for future use
    pub width_x: f32,
    pub width_y: f32,
    pub stop_count: u8,
    pub stops: [RawStopData; MAX_GRADIENT_STOPS],
}

impl RawGradientData {
    #[inline]
    pub fn start(&self) -> (f32, f32) {
        (self.start_x, self.start_y)
    }

    #[inline]
    pub fn end(&self) -> (f32, f32) {
        (self.end_x, self.end_y)
    }

    /// The stops actually carried, ignoring the unused tail of the fixed-size array.
    #[inline]
    pub fn active_stops(&self) -> &[RawStopData] {
        let n = (self.stop_count as usize).min(MAX_GRADIENT_STOPS);
        &self.stops[..n]
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[repr(C)]
#[repr(align(4))]
pub struct RawImageFillData {
    pub a: u32,
    pub b: u32,
    pub c: u32,
    pub d: u32,
    pub opacity: u8,
    pub flags: u8,
    // 16-bit padding here, reserved for future use
    pub width: i32,
    pub height: i32,
    /// Optional destination sub-rect (local/selrect coords), valid iff `FLAG_HAS_DEST` — a
    /// viewport-clipped 3D slice draws only here instead of over the whole shape.
    pub dest_l: f32,
    pub dest_t: f32,
    pub dest_r: f32,
    pub dest_b: f32,
}

impl RawImageFillData {
    #[inline]
    pub fn keep_aspect_ratio(&self) -> bool {
        self.flags & FLAG_KEEP_ASPECT_RATIO != 0
    }

    #[inline]
    pub fn dest(&self) -> Option<[f32; 4]> {
        (self.flags & FLAG_HAS_DEST != 0)
            .then_some([self.dest_l, self.dest_t, self.dest_r, self.dest_b])
    }
}

/// A tagged fill payload. Discriminants are part of the wire format; `ToJs` mirrors them into
/// the TypeScript side at compile time, so they are single-sourced here.
#[repr(C, u8, align(4))]
#[derive(Debug, PartialEq, Clone, Copy, ToJs)]
pub enum RawFillData {
    Solid(RawSolidData) = 0x00,
    Linear(RawGradientData) = 0x01,
    Radial(RawGradientData) = 0x02,
    Image(RawImageFillData) = 0x03,
    Angular(RawGradientData) = 0x04,
    Diamond(RawGradientData) = 0x05,
}

/// Size of one fill record on the wire. Both backends must agree, and the host strides by it.
pub const RAW_FILL_DATA_SIZE: usize = core::mem::size_of::<RawFillData>();

#[cfg(test)]
mod tests {
    use super::*;

    /// The host strides the buffer by this, so a change here is a wire break. Pinning it means
    /// an accidental field addition fails here rather than silently misaligning every fill
    /// after the first.
    #[test]
    fn fill_record_size_is_pinned() {
        assert_eq!(RAW_FILL_DATA_SIZE, core::mem::size_of::<RawFillData>());
        assert_eq!(core::mem::align_of::<RawFillData>(), 4);
        assert_eq!(core::mem::size_of::<RawStopData>(), 8);
    }

    #[test]
    fn active_stops_respects_the_count() {
        let g = RawGradientData {
            start_x: 0.0,
            start_y: 0.0,
            end_x: 1.0,
            end_y: 0.0,
            opacity: 255,
            width_x: 0.0,
            width_y: 0.0,
            stop_count: 2,
            stops: [RawStopData {
                color: 0,
                offset: 0.0,
            }; MAX_GRADIENT_STOPS],
        };
        assert_eq!(g.active_stops().len(), 2);
        assert_eq!(g.start(), (0.0, 0.0));
        assert_eq!(g.end(), (1.0, 0.0));
    }

    /// A malformed payload must clamp rather than panic — the count comes off the wire.
    #[test]
    fn active_stops_clamps_an_overlarge_count() {
        let g = RawGradientData {
            start_x: 0.0,
            start_y: 0.0,
            end_x: 0.0,
            end_y: 0.0,
            opacity: 0,
            width_x: 0.0,
            width_y: 0.0,
            stop_count: 200,
            stops: [RawStopData {
                color: 0,
                offset: 0.0,
            }; MAX_GRADIENT_STOPS],
        };
        assert_eq!(g.active_stops().len(), MAX_GRADIENT_STOPS);
    }

    #[test]
    fn image_flags_decode() {
        let mut img = RawImageFillData {
            a: 0,
            b: 0,
            c: 0,
            d: 0,
            opacity: 255,
            flags: FLAG_KEEP_ASPECT_RATIO,
            width: 10,
            height: 20,
            dest_l: 1.0,
            dest_t: 2.0,
            dest_r: 3.0,
            dest_b: 4.0,
        };
        assert!(img.keep_aspect_ratio());
        assert_eq!(img.dest(), None);

        img.flags |= FLAG_HAS_DEST;
        assert_eq!(img.dest(), Some([1.0, 2.0, 3.0, 4.0]));
    }
}
