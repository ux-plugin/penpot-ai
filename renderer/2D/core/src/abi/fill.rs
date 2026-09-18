//! Fill payloads: solid, the four gradient flavours, and image.
//!
//! See the [module docs](super) for why the codec is hand-written.

use render_macros::ToJs;

use super::{f32_at, i32_at, u32_at, AbiError};

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
        (self.flags & FLAG_HAS_DEST != 0).then_some([
            self.dest_l,
            self.dest_t,
            self.dest_r,
            self.dest_b,
        ])
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

/// Byte offsets within a fill record. Part of the wire contract.
///
/// `RawGradientData` has three reserved bytes after `opacity` and three after `stop_count`;
/// those are the padding the encoder zeroes.
mod layout {
    /// Variant tag.
    pub const TAG: usize = 0;
    /// Payload start. Bytes 1..4 are alignment padding.
    pub const PAYLOAD: usize = 4;

    pub mod solid {
        pub const COLOR: usize = 0;
        pub const SIZE: usize = 4;
    }

    pub mod gradient {
        pub const START_X: usize = 0;
        pub const START_Y: usize = 4;
        pub const END_X: usize = 8;
        pub const END_Y: usize = 12;
        pub const OPACITY: usize = 16;
        pub const WIDTH_X: usize = 20;
        pub const WIDTH_Y: usize = 24;
        pub const STOP_COUNT: usize = 28;
        pub const STOPS: usize = 32;
        pub const STOP_SIZE: usize = 8;
        pub const SIZE: usize = STOPS + STOP_SIZE * super::super::MAX_GRADIENT_STOPS;
    }

    pub mod image {
        pub const A: usize = 0;
        pub const B: usize = 4;
        pub const C: usize = 8;
        pub const D: usize = 12;
        pub const OPACITY: usize = 16;
        pub const FLAGS: usize = 17;
        pub const WIDTH: usize = 20;
        pub const HEIGHT: usize = 24;
        pub const DEST_L: usize = 28;
        pub const DEST_T: usize = 32;
        pub const DEST_R: usize = 36;
        pub const DEST_B: usize = 40;
        pub const SIZE: usize = 44;
    }
}

const _: () = assert!(RAW_FILL_DATA_SIZE == layout::PAYLOAD + layout::gradient::SIZE);
const _: () = assert!(layout::solid::SIZE <= layout::gradient::SIZE);
const _: () = assert!(layout::image::SIZE <= layout::gradient::SIZE);

/// Decode one fill record. `bytes` may be longer; the tail is ignored.
pub fn decode_fill(bytes: &[u8]) -> Result<RawFillData, AbiError> {
    if bytes.len() < RAW_FILL_DATA_SIZE {
        return Err(AbiError::Truncated {
            need: RAW_FILL_DATA_SIZE,
            got: bytes.len(),
        });
    }
    let p = &bytes[layout::PAYLOAD..RAW_FILL_DATA_SIZE];

    Ok(match bytes[layout::TAG] {
        0x00 => RawFillData::Solid(decode_solid(p)),
        0x01 => RawFillData::Linear(decode_gradient(p)),
        0x02 => RawFillData::Radial(decode_gradient(p)),
        0x03 => RawFillData::Image(decode_image(p)),
        0x04 => RawFillData::Angular(decode_gradient(p)),
        0x05 => RawFillData::Diamond(decode_gradient(p)),
        t => return Err(AbiError::UnknownFillTag(t)),
    })
}

fn decode_solid(p: &[u8]) -> RawSolidData {
    RawSolidData {
        color: u32_at(p, layout::solid::COLOR),
    }
}

fn decode_gradient(p: &[u8]) -> RawGradientData {
    use layout::gradient as g;

    let mut stops = [RawStopData {
        color: 0,
        offset: 0.0,
    }; MAX_GRADIENT_STOPS];
    for (i, stop) in stops.iter_mut().enumerate() {
        let at = g::STOPS + i * g::STOP_SIZE;
        *stop = RawStopData {
            color: u32_at(p, at),
            offset: f32_at(p, at + 4),
        };
    }

    RawGradientData {
        start_x: f32_at(p, g::START_X),
        start_y: f32_at(p, g::START_Y),
        end_x: f32_at(p, g::END_X),
        end_y: f32_at(p, g::END_Y),
        opacity: p[g::OPACITY],
        width_x: f32_at(p, g::WIDTH_X),
        width_y: f32_at(p, g::WIDTH_Y),
        stop_count: p[g::STOP_COUNT],
        stops,
    }
}

fn decode_image(p: &[u8]) -> RawImageFillData {
    use layout::image as i;
    RawImageFillData {
        a: u32_at(p, i::A),
        b: u32_at(p, i::B),
        c: u32_at(p, i::C),
        d: u32_at(p, i::D),
        opacity: p[i::OPACITY],
        flags: p[i::FLAGS],
        width: i32_at(p, i::WIDTH),
        height: i32_at(p, i::HEIGHT),
        dest_l: f32_at(p, i::DEST_L),
        dest_t: f32_at(p, i::DEST_T),
        dest_r: f32_at(p, i::DEST_R),
        dest_b: f32_at(p, i::DEST_B),
    }
}

/// Encode one fill record into `out`, which must be at least [`RAW_FILL_DATA_SIZE`].
///
/// Padding is written as zero, which is the whole point: the transmute this replaces exposed
/// whatever happened to be in those bytes.
pub fn encode_fill(fill: &RawFillData, out: &mut [u8]) -> Result<(), AbiError> {
    if out.len() < RAW_FILL_DATA_SIZE {
        return Err(AbiError::Truncated {
            need: RAW_FILL_DATA_SIZE,
            got: out.len(),
        });
    }
    out[..RAW_FILL_DATA_SIZE].fill(0);

    let (tag, ()) = match fill {
        RawFillData::Solid(s) => (0x00, encode_solid(s, &mut out[layout::PAYLOAD..])),
        RawFillData::Linear(g) => (0x01, encode_gradient(g, &mut out[layout::PAYLOAD..])),
        RawFillData::Radial(g) => (0x02, encode_gradient(g, &mut out[layout::PAYLOAD..])),
        RawFillData::Image(i) => (0x03, encode_image(i, &mut out[layout::PAYLOAD..])),
        RawFillData::Angular(g) => (0x04, encode_gradient(g, &mut out[layout::PAYLOAD..])),
        RawFillData::Diamond(g) => (0x05, encode_gradient(g, &mut out[layout::PAYLOAD..])),
    };
    out[layout::TAG] = tag;
    Ok(())
}

fn encode_solid(s: &RawSolidData, p: &mut [u8]) {
    p[layout::solid::COLOR..layout::solid::COLOR + 4].copy_from_slice(&s.color.to_le_bytes());
}

fn encode_gradient(gr: &RawGradientData, p: &mut [u8]) {
    use layout::gradient as g;
    p[g::START_X..g::START_X + 4].copy_from_slice(&gr.start_x.to_le_bytes());
    p[g::START_Y..g::START_Y + 4].copy_from_slice(&gr.start_y.to_le_bytes());
    p[g::END_X..g::END_X + 4].copy_from_slice(&gr.end_x.to_le_bytes());
    p[g::END_Y..g::END_Y + 4].copy_from_slice(&gr.end_y.to_le_bytes());
    p[g::OPACITY] = gr.opacity;
    p[g::WIDTH_X..g::WIDTH_X + 4].copy_from_slice(&gr.width_x.to_le_bytes());
    p[g::WIDTH_Y..g::WIDTH_Y + 4].copy_from_slice(&gr.width_y.to_le_bytes());
    p[g::STOP_COUNT] = gr.stop_count;
    for (i, stop) in gr.stops.iter().enumerate() {
        let at = g::STOPS + i * g::STOP_SIZE;
        p[at..at + 4].copy_from_slice(&stop.color.to_le_bytes());
        p[at + 4..at + 8].copy_from_slice(&stop.offset.to_le_bytes());
    }
}

fn encode_image(im: &RawImageFillData, p: &mut [u8]) {
    use layout::image as i;
    p[i::A..i::A + 4].copy_from_slice(&im.a.to_le_bytes());
    p[i::B..i::B + 4].copy_from_slice(&im.b.to_le_bytes());
    p[i::C..i::C + 4].copy_from_slice(&im.c.to_le_bytes());
    p[i::D..i::D + 4].copy_from_slice(&im.d.to_le_bytes());
    p[i::OPACITY] = im.opacity;
    p[i::FLAGS] = im.flags;
    p[i::WIDTH..i::WIDTH + 4].copy_from_slice(&im.width.to_le_bytes());
    p[i::HEIGHT..i::HEIGHT + 4].copy_from_slice(&im.height.to_le_bytes());
    p[i::DEST_L..i::DEST_L + 4].copy_from_slice(&im.dest_l.to_le_bytes());
    p[i::DEST_T..i::DEST_T + 4].copy_from_slice(&im.dest_t.to_le_bytes());
    p[i::DEST_R..i::DEST_R + 4].copy_from_slice(&im.dest_r.to_le_bytes());
    p[i::DEST_B..i::DEST_B + 4].copy_from_slice(&im.dest_b.to_le_bytes());
}

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

    /// The load-bearing test. The codec writes explicit offsets; these must stay equal to what
    /// `#[repr(C)]` produces, or the safe codec and the layouts silently disagree and every
    /// fill after the first is misread. Adding or reordering a field fails here.
    #[test]
    fn layout_matches_repr_c() {
        use core::mem::offset_of;
        use layout::{gradient as g, image as i, solid as s};

        assert_eq!(offset_of!(RawSolidData, color), s::COLOR);

        assert_eq!(offset_of!(RawGradientData, start_x), g::START_X);
        assert_eq!(offset_of!(RawGradientData, start_y), g::START_Y);
        assert_eq!(offset_of!(RawGradientData, end_x), g::END_X);
        assert_eq!(offset_of!(RawGradientData, end_y), g::END_Y);
        assert_eq!(offset_of!(RawGradientData, opacity), g::OPACITY);
        assert_eq!(offset_of!(RawGradientData, width_x), g::WIDTH_X);
        assert_eq!(offset_of!(RawGradientData, width_y), g::WIDTH_Y);
        assert_eq!(offset_of!(RawGradientData, stop_count), g::STOP_COUNT);
        assert_eq!(offset_of!(RawGradientData, stops), g::STOPS);
        assert_eq!(core::mem::size_of::<RawGradientData>(), g::SIZE);

        assert_eq!(offset_of!(RawImageFillData, a), i::A);
        assert_eq!(offset_of!(RawImageFillData, opacity), i::OPACITY);
        assert_eq!(offset_of!(RawImageFillData, flags), i::FLAGS);
        assert_eq!(offset_of!(RawImageFillData, width), i::WIDTH);
        assert_eq!(offset_of!(RawImageFillData, height), i::HEIGHT);
        assert_eq!(offset_of!(RawImageFillData, dest_l), i::DEST_L);
        assert_eq!(offset_of!(RawImageFillData, dest_b), i::DEST_B);
        assert_eq!(core::mem::size_of::<RawImageFillData>(), i::SIZE);

        assert_eq!(RAW_FILL_DATA_SIZE, layout::PAYLOAD + g::SIZE);
        assert_eq!(RAW_FILL_DATA_SIZE, 164);
    }

    /// Byte-for-byte compatibility with the transmute codec this replaces, using the exact
    /// fixture render-wasm's own test used: tag at byte 0, solid colour as u32 LE at byte 4.
    #[test]
    fn decodes_the_legacy_solid_fixture() {
        let mut bytes = vec![0x00; RAW_FILL_DATA_SIZE];
        bytes[0] = 0x00;
        bytes[4..8].copy_from_slice(&0xfffabada_u32.to_le_bytes());

        assert_eq!(
            decode_fill(&bytes).unwrap(),
            RawFillData::Solid(RawSolidData { color: 0xfffabada })
        );
    }

    fn sample_gradient() -> RawGradientData {
        let mut stops = [RawStopData {
            color: 0,
            offset: 0.0,
        }; MAX_GRADIENT_STOPS];
        stops[0] = RawStopData {
            color: 0xff0000ff,
            offset: 0.0,
        };
        stops[1] = RawStopData {
            color: 0x00ff00ff,
            offset: 1.0,
        };
        RawGradientData {
            start_x: 1.5,
            start_y: -2.25,
            end_x: 100.0,
            end_y: 0.125,
            opacity: 200,
            width_x: 7.0,
            width_y: 8.0,
            stop_count: 2,
            stops,
        }
    }

    #[test]
    fn every_variant_round_trips() {
        let cases = [
            RawFillData::Solid(RawSolidData { color: 0x11223344 }),
            RawFillData::Linear(sample_gradient()),
            RawFillData::Radial(sample_gradient()),
            RawFillData::Angular(sample_gradient()),
            RawFillData::Diamond(sample_gradient()),
            RawFillData::Image(RawImageFillData {
                a: 1,
                b: 2,
                c: 3,
                d: 4,
                opacity: 128,
                flags: FLAG_KEEP_ASPECT_RATIO | FLAG_HAS_DEST,
                width: 640,
                height: -480,
                dest_l: 0.5,
                dest_t: 1.5,
                dest_r: 2.5,
                dest_b: 3.5,
            }),
        ];

        let mut buf = vec![0u8; RAW_FILL_DATA_SIZE];
        for case in cases {
            encode_fill(&case, &mut buf).unwrap();
            assert_eq!(decode_fill(&buf).unwrap(), case);
        }
    }

    /// Padding must be written, not left to chance — that is what made the transmute unsound.
    #[test]
    fn encode_zeroes_padding_and_reuses_a_dirty_buffer() {
        let mut buf = vec![0xAAu8; RAW_FILL_DATA_SIZE];
        encode_fill(
            &RawFillData::Solid(RawSolidData { color: 0x01020304 }),
            &mut buf,
        )
        .unwrap();

        assert_eq!(&buf[1..4], &[0, 0, 0]);
        assert!(buf[8..].iter().all(|&b| b == 0));
    }

    #[test]
    fn rejects_truncated_and_unknown() {
        let short = vec![0u8; RAW_FILL_DATA_SIZE - 1];
        assert_eq!(
            decode_fill(&short),
            Err(AbiError::Truncated {
                need: RAW_FILL_DATA_SIZE,
                got: RAW_FILL_DATA_SIZE - 1,
            })
        );

        let mut unknown = vec![0u8; RAW_FILL_DATA_SIZE];
        unknown[0] = 0x42;
        assert_eq!(decode_fill(&unknown), Err(AbiError::UnknownFillTag(0x42)));

        let mut out = vec![0u8; 3];
        assert!(encode_fill(&RawFillData::Solid(RawSolidData { color: 0 }), &mut out).is_err());
    }

    /// A longer buffer is fine — the host packs records back to back and strides by the size.
    #[test]
    fn ignores_trailing_bytes() {
        let mut bytes = vec![0u8; RAW_FILL_DATA_SIZE * 2];
        bytes[4..8].copy_from_slice(&7u32.to_le_bytes());
        assert_eq!(
            decode_fill(&bytes).unwrap(),
            RawFillData::Solid(RawSolidData { color: 7 })
        );
    }
}
