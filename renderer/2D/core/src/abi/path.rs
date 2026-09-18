//! Path-segment payloads: the vector geometry the host streams in, one fixed-size record per
//! segment.
//!
//! See the [module docs](super) for why the codec is hand-written.
//!
//! The one thing worth knowing about this layout: **every variant puts its end point at the
//! same offset**. `MoveTo` and `LineTo` carry sixteen bytes of leading padding purely so their
//! `x`/`y` land where `CurveTo`'s do. That is deliberate on the host side — see the writer in
//! `api/path.ts`, which zeroes the slot and then writes `x` at +20 and `y` at +24 regardless of
//! the segment type.

use render_macros::ToJs;

use super::{f32_at, u16_at, AbiError};

/// Wire tags, little-endian `u16`. Part of the format; the host has the same four constants.
pub const TAG_MOVE_TO: u16 = 0x01;
pub const TAG_LINE_TO: u16 = 0x02;
pub const TAG_CURVE_TO: u16 = 0x03;
pub const TAG_CLOSE: u16 = 0x04;

/// A `move-to`. The leading padding is load-bearing: it places `x`/`y` at the shared end-point
/// offset, so the fields cannot simply be dropped.
#[repr(C, align(4))]
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct RawMoveCommand {
    _padding: [u32; 4],
    pub x: f32,
    pub y: f32,
}

impl RawMoveCommand {
    #[inline]
    pub fn new((x, y): (f32, f32)) -> Self {
        Self {
            _padding: [0u32; 4],
            x,
            y,
        }
    }
}

/// A `line-to`. Same shape as [`RawMoveCommand`]; they are distinct types only because the
/// variants are.
#[repr(C, align(4))]
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct RawLineCommand {
    _padding: [u32; 4],
    pub x: f32,
    pub y: f32,
}

impl RawLineCommand {
    #[inline]
    pub fn new((x, y): (f32, f32)) -> Self {
        Self {
            _padding: [0u32; 4],
            x,
            y,
        }
    }
}

/// A cubic. Both control points then the end point — no padding needed, it fills the payload.
#[repr(C, align(4))]
#[derive(Debug, PartialEq, Clone, Copy)]
pub struct RawCurveCommand {
    pub c1_x: f32,
    pub c1_y: f32,
    pub c2_x: f32,
    pub c2_y: f32,
    pub x: f32,
    pub y: f32,
}

impl RawCurveCommand {
    #[inline]
    pub fn new((c1_x, c1_y): (f32, f32), (c2_x, c2_y): (f32, f32), (x, y): (f32, f32)) -> Self {
        Self {
            c1_x,
            c1_y,
            c2_x,
            c2_y,
            x,
            y,
        }
    }
}

/// One path segment on the wire. Discriminants are part of the format; `ToJs` mirrors them into
/// the TypeScript side at compile time, so they are single-sourced here.
#[repr(C, u16, align(4))]
#[derive(Debug, PartialEq, Clone, Copy, ToJs)]
/// The discriminants are literals rather than the `TAG_*` constants because the `ToJs` derive
/// only parses literal values; `tags_match_discriminants` keeps the two in step.
pub enum RawSegmentData {
    MoveTo(RawMoveCommand) = 0x01,
    LineTo(RawLineCommand) = 0x02,
    CurveTo(RawCurveCommand) = 0x03,
    Close = 0x04,
}

impl RawSegmentData {
    /// The point the segment ends at, or `None` for a close. Available uniformly because the
    /// layout puts it at one offset for every variant.
    #[inline]
    pub fn end_point(&self) -> Option<(f32, f32)> {
        match self {
            Self::MoveTo(c) => Some((c.x, c.y)),
            Self::LineTo(c) => Some((c.x, c.y)),
            Self::CurveTo(c) => Some((c.x, c.y)),
            Self::Close => None,
        }
    }
}

/// Size of one segment record on the wire. Both backends must agree, and the host strides by
/// it — `api/path.ts` calls the same number `SEGMENT_U8_SIZE`.
pub const RAW_SEGMENT_DATA_SIZE: usize = core::mem::size_of::<RawSegmentData>();

/// Byte offsets within a segment record. Part of the wire contract.
mod layout {
    /// Variant tag, `u16`.
    pub const TAG: usize = 0;
    /// Payload start. Bytes 2..4 are alignment padding.
    pub const PAYLOAD: usize = 4;

    /// `MoveTo` and `RawLineCommand` share this layout.
    pub mod point {
        /// 0..16 is the explicit padding that aligns the end point with `CurveTo`'s.
        pub const X: usize = 16;
        pub const Y: usize = 20;
        pub const SIZE: usize = 24;
    }

    pub mod curve {
        pub const C1_X: usize = 0;
        pub const C1_Y: usize = 4;
        pub const C2_X: usize = 8;
        pub const C2_Y: usize = 12;
        pub const X: usize = 16;
        pub const Y: usize = 20;
        pub const SIZE: usize = 24;
    }
}

const _: () = assert!(RAW_SEGMENT_DATA_SIZE == layout::PAYLOAD + layout::curve::SIZE);
const _: () = assert!(layout::point::SIZE <= layout::curve::SIZE);
const _: () = assert!(layout::point::X == layout::curve::X);
const _: () = assert!(layout::point::Y == layout::curve::Y);

/// Decode one segment record. `bytes` may be longer; the tail is ignored.
pub fn decode_segment(bytes: &[u8]) -> Result<RawSegmentData, AbiError> {
    if bytes.len() < RAW_SEGMENT_DATA_SIZE {
        return Err(AbiError::Truncated {
            need: RAW_SEGMENT_DATA_SIZE,
            got: bytes.len(),
        });
    }
    let p = &bytes[layout::PAYLOAD..RAW_SEGMENT_DATA_SIZE];

    Ok(match u16_at(bytes, layout::TAG) {
        TAG_MOVE_TO => RawSegmentData::MoveTo(RawMoveCommand::new(point_at(p))),
        TAG_LINE_TO => RawSegmentData::LineTo(RawLineCommand::new(point_at(p))),
        TAG_CURVE_TO => RawSegmentData::CurveTo(decode_curve(p)),
        TAG_CLOSE => RawSegmentData::Close,
        t => return Err(AbiError::UnknownSegmentTag(t)),
    })
}

fn point_at(p: &[u8]) -> (f32, f32) {
    (f32_at(p, layout::point::X), f32_at(p, layout::point::Y))
}

fn decode_curve(p: &[u8]) -> RawCurveCommand {
    use layout::curve as c;
    RawCurveCommand {
        c1_x: f32_at(p, c::C1_X),
        c1_y: f32_at(p, c::C1_Y),
        c2_x: f32_at(p, c::C2_X),
        c2_y: f32_at(p, c::C2_Y),
        x: f32_at(p, c::X),
        y: f32_at(p, c::Y),
    }
}

/// Decode a whole packed buffer of segments.
///
/// Strict on purpose. The code this replaces printed a warning and kept going when the buffer
/// was not a whole number of records, which turns a framing bug into silently wrong geometry —
/// every segment after the ragged one is misread, and the shape merely looks odd.
pub fn decode_path(bytes: &[u8]) -> Result<Vec<RawSegmentData>, AbiError> {
    if !bytes.len().is_multiple_of(RAW_SEGMENT_DATA_SIZE) {
        return Err(AbiError::Truncated {
            need: bytes.len().next_multiple_of(RAW_SEGMENT_DATA_SIZE),
            got: bytes.len(),
        });
    }
    bytes
        .chunks(RAW_SEGMENT_DATA_SIZE)
        .map(decode_segment)
        .collect()
}

/// Encode one segment record into `out`, which must be at least [`RAW_SEGMENT_DATA_SIZE`].
///
/// Padding is written as zero, which is the whole point: the transmute this replaces exposed
/// whatever happened to be in those bytes.
pub fn encode_segment(segment: &RawSegmentData, out: &mut [u8]) -> Result<(), AbiError> {
    if out.len() < RAW_SEGMENT_DATA_SIZE {
        return Err(AbiError::Truncated {
            need: RAW_SEGMENT_DATA_SIZE,
            got: out.len(),
        });
    }
    out[..RAW_SEGMENT_DATA_SIZE].fill(0);
    let p = &mut out[layout::PAYLOAD..RAW_SEGMENT_DATA_SIZE];

    let tag = match segment {
        RawSegmentData::MoveTo(c) => {
            write_point(p, (c.x, c.y));
            TAG_MOVE_TO
        }
        RawSegmentData::LineTo(c) => {
            write_point(p, (c.x, c.y));
            TAG_LINE_TO
        }
        RawSegmentData::CurveTo(c) => {
            encode_curve(c, p);
            TAG_CURVE_TO
        }
        RawSegmentData::Close => TAG_CLOSE,
    };
    out[layout::TAG..layout::TAG + 2].copy_from_slice(&tag.to_le_bytes());
    Ok(())
}

fn write_point(p: &mut [u8], (x, y): (f32, f32)) {
    use layout::point as pt;
    p[pt::X..pt::X + 4].copy_from_slice(&x.to_le_bytes());
    p[pt::Y..pt::Y + 4].copy_from_slice(&y.to_le_bytes());
}

fn encode_curve(cmd: &RawCurveCommand, p: &mut [u8]) {
    use layout::curve as c;
    p[c::C1_X..c::C1_X + 4].copy_from_slice(&cmd.c1_x.to_le_bytes());
    p[c::C1_Y..c::C1_Y + 4].copy_from_slice(&cmd.c1_y.to_le_bytes());
    p[c::C2_X..c::C2_X + 4].copy_from_slice(&cmd.c2_x.to_le_bytes());
    p[c::C2_Y..c::C2_Y + 4].copy_from_slice(&cmd.c2_y.to_le_bytes());
    p[c::X..c::X + 4].copy_from_slice(&cmd.x.to_le_bytes());
    p[c::Y..c::Y + 4].copy_from_slice(&cmd.y.to_le_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The host strides the buffer by this, so a change here is a wire break. `api/path.ts`
    /// hardcodes 28 as `SEGMENT_U8_SIZE`.
    #[test]
    fn segment_record_size_is_pinned() {
        assert_eq!(RAW_SEGMENT_DATA_SIZE, 28);
        assert_eq!(core::mem::align_of::<RawSegmentData>(), 4);
    }

    /// The load-bearing test: the codec's explicit offsets must equal what `#[repr(C)]`
    /// produces, or the safe codec and the layouts silently disagree.
    #[test]
    fn layout_matches_repr_c() {
        use core::mem::offset_of;
        use layout::{curve as c, point as pt};

        assert_eq!(offset_of!(RawMoveCommand, x), pt::X);
        assert_eq!(offset_of!(RawMoveCommand, y), pt::Y);
        assert_eq!(core::mem::size_of::<RawMoveCommand>(), pt::SIZE);

        assert_eq!(offset_of!(RawLineCommand, x), pt::X);
        assert_eq!(offset_of!(RawLineCommand, y), pt::Y);
        assert_eq!(core::mem::size_of::<RawLineCommand>(), pt::SIZE);

        assert_eq!(offset_of!(RawCurveCommand, c1_x), c::C1_X);
        assert_eq!(offset_of!(RawCurveCommand, c1_y), c::C1_Y);
        assert_eq!(offset_of!(RawCurveCommand, c2_x), c::C2_X);
        assert_eq!(offset_of!(RawCurveCommand, c2_y), c::C2_Y);
        assert_eq!(offset_of!(RawCurveCommand, x), c::X);
        assert_eq!(offset_of!(RawCurveCommand, y), c::Y);
        assert_eq!(core::mem::size_of::<RawCurveCommand>(), c::SIZE);

        assert_eq!(RAW_SEGMENT_DATA_SIZE, layout::PAYLOAD + c::SIZE);
    }

    /// Byte-for-byte compatibility with the host's writer, transcribed from `api/path.ts`:
    /// tag as u16 LE at 0, end point at +20 and +24, controls at +4..+20.
    #[test]
    fn decodes_the_host_writer_layout() {
        let mut bytes = vec![0u8; RAW_SEGMENT_DATA_SIZE];
        bytes[0..2].copy_from_slice(&1u16.to_le_bytes());
        bytes[20..24].copy_from_slice(&3.5f32.to_le_bytes());
        bytes[24..28].copy_from_slice(&(-4.25f32).to_le_bytes());
        assert_eq!(
            decode_segment(&bytes).unwrap(),
            RawSegmentData::MoveTo(RawMoveCommand::new((3.5, -4.25)))
        );

        let mut bytes = vec![0u8; RAW_SEGMENT_DATA_SIZE];
        bytes[0..2].copy_from_slice(&3u16.to_le_bytes());
        for (i, v) in [1.0f32, 2.0, 3.0, 4.0, 5.0, 6.0].iter().enumerate() {
            let at = 4 + i * 4;
            bytes[at..at + 4].copy_from_slice(&v.to_le_bytes());
        }
        assert_eq!(
            decode_segment(&bytes).unwrap(),
            RawSegmentData::CurveTo(RawCurveCommand::new((1.0, 2.0), (3.0, 4.0), (5.0, 6.0)))
        );
    }

    /// The enum's discriminants are literals (the `ToJs` derive requires it) while the codec
    /// reads and writes the `TAG_*` constants. Nothing in the type system ties those together,
    /// so this does: encode each variant and read back the tag the compiler assigned.
    #[test]
    fn tags_match_discriminants() {
        let cases = [
            (
                RawSegmentData::MoveTo(RawMoveCommand::new((0.0, 0.0))),
                TAG_MOVE_TO,
            ),
            (
                RawSegmentData::LineTo(RawLineCommand::new((0.0, 0.0))),
                TAG_LINE_TO,
            ),
            (
                RawSegmentData::CurveTo(RawCurveCommand::new((0.0, 0.0), (0.0, 0.0), (0.0, 0.0))),
                TAG_CURVE_TO,
            ),
            (RawSegmentData::Close, TAG_CLOSE),
        ];

        let mut buf = vec![0u8; RAW_SEGMENT_DATA_SIZE];
        for (segment, tag) in cases {
            encode_segment(&segment, &mut buf).unwrap();
            assert_eq!(u16_at(&buf, 0), tag);
            assert_eq!(decode_segment(&buf).unwrap(), segment);
        }
        assert_eq!(
            [TAG_MOVE_TO, TAG_LINE_TO, TAG_CURVE_TO, TAG_CLOSE],
            [1, 2, 3, 4]
        );
    }

    #[test]
    fn every_variant_round_trips() {
        let cases = [
            RawSegmentData::MoveTo(RawMoveCommand::new((1.5, 2.5))),
            RawSegmentData::LineTo(RawLineCommand::new((-3.0, 0.125))),
            RawSegmentData::CurveTo(RawCurveCommand::new((1.0, 2.0), (3.0, 4.0), (5.0, 6.0))),
            RawSegmentData::Close,
        ];

        let mut buf = vec![0u8; RAW_SEGMENT_DATA_SIZE];
        for case in cases {
            encode_segment(&case, &mut buf).unwrap();
            assert_eq!(decode_segment(&buf).unwrap(), case);
        }
    }

    /// Padding must be written, not left to chance — that is what made the transmute unsound.
    #[test]
    fn encode_zeroes_padding_and_reuses_a_dirty_buffer() {
        let mut buf = vec![0xAAu8; RAW_SEGMENT_DATA_SIZE];
        encode_segment(
            &RawSegmentData::LineTo(RawLineCommand::new((1.0, 2.0))),
            &mut buf,
        )
        .unwrap();

        assert!(buf[2..20].iter().all(|&b| b == 0));

        let mut buf = vec![0xAAu8; RAW_SEGMENT_DATA_SIZE];
        encode_segment(&RawSegmentData::Close, &mut buf).unwrap();
        assert!(buf[2..].iter().all(|&b| b == 0));
    }

    #[test]
    fn end_point_is_uniform_across_variants() {
        assert_eq!(
            RawSegmentData::MoveTo(RawMoveCommand::new((7.0, 8.0))).end_point(),
            Some((7.0, 8.0))
        );
        assert_eq!(
            RawSegmentData::CurveTo(RawCurveCommand::new((0.0, 0.0), (0.0, 0.0), (7.0, 8.0)))
                .end_point(),
            Some((7.0, 8.0))
        );
        assert_eq!(RawSegmentData::Close.end_point(), None);
    }

    #[test]
    fn decodes_a_packed_buffer() {
        let segments = [
            RawSegmentData::MoveTo(RawMoveCommand::new((0.0, 0.0))),
            RawSegmentData::LineTo(RawLineCommand::new((10.0, 0.0))),
            RawSegmentData::Close,
        ];
        let mut buf = vec![0u8; RAW_SEGMENT_DATA_SIZE * segments.len()];
        for (i, s) in segments.iter().enumerate() {
            encode_segment(s, &mut buf[i * RAW_SEGMENT_DATA_SIZE..]).unwrap();
        }
        assert_eq!(decode_path(&buf).unwrap(), segments);
        assert_eq!(decode_path(&[]).unwrap(), vec![]);
    }

    #[test]
    fn rejects_ragged_buffers_and_unknown_tags() {
        let ragged = vec![0u8; RAW_SEGMENT_DATA_SIZE + 3];
        assert_eq!(
            decode_path(&ragged),
            Err(AbiError::Truncated {
                need: RAW_SEGMENT_DATA_SIZE * 2,
                got: RAW_SEGMENT_DATA_SIZE + 3,
            })
        );

        let zeroed = vec![0u8; RAW_SEGMENT_DATA_SIZE];
        assert_eq!(decode_segment(&zeroed), Err(AbiError::UnknownSegmentTag(0)));

        let mut unknown = vec![0u8; RAW_SEGMENT_DATA_SIZE];
        unknown[0..2].copy_from_slice(&9u16.to_le_bytes());
        assert_eq!(
            decode_segment(&unknown),
            Err(AbiError::UnknownSegmentTag(9))
        );

        let mut out = vec![0u8; 3];
        assert!(encode_segment(&RawSegmentData::Close, &mut out).is_err());
    }
}
