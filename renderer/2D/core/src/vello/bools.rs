//! Curve-native boolean of two raw paths — the vector eraser's cut.
//!
//! The same entry point render-wasm exposed (`path_boolean`), over the same wire format, so the
//! host's `pathBoolean` runs unchanged on either backend. Unlike render-wasm's `calculate_bool`
//! this takes geometry rather than scene shapes: the eraser subtracts a transient brush band or
//! lasso that is not a document shape. The boolean itself is `curve-bool` (linesweeper), which
//! keeps béziers as béziers — no flattening, no re-fit.

use curve_bool::{BoolOp, Fill};
use kurbo::{BezPath, PathEl, Point};

use crate::abi::{
    decode_path, encode_segment, RawCurveCommand, RawLineCommand, RawMoveCommand, RawSegmentData,
    RAW_SEGMENT_DATA_SIZE,
};
use crate::model::bez_path_from_raw;

/// render-wasm's `RawBoolType`: 0 union, 1 difference, 2 intersection, 3 exclude.
fn bool_op(raw: u8) -> Option<BoolOp> {
    match raw {
        0 => Some(BoolOp::Union),
        1 => Some(BoolOp::Difference),
        2 => Some(BoolOp::Intersection),
        3 => Some(BoolOp::Exclude),
        _ => None,
    }
}

/// `subject OP clip`, as closed contours. `fill_rule`: 0 non-zero, 1 even-odd.
pub fn boolean_segments(
    subject: &[RawSegmentData],
    clip: &[RawSegmentData],
    op: BoolOp,
    fill: Fill,
) -> Vec<RawSegmentData> {
    let contours = curve_bool::path_boolean(&bez_path_from_raw(subject), &bez_path_from_raw(clip), op, fill);
    segments_from_contours(&contours)
}

/// The engine's contours → one `MoveTo … Close` run each. A quadratic is elevated to a cubic so
/// the host's segment model stays purely cubic.
fn segments_from_contours(paths: &[BezPath]) -> Vec<RawSegmentData> {
    let pt = |p: Point| (p.x as f32, p.y as f32);
    let mut out = Vec::new();
    for path in paths {
        let mut last = Point::ZERO;
        for el in path.elements() {
            match *el {
                PathEl::MoveTo(p) => {
                    out.push(RawSegmentData::MoveTo(RawMoveCommand::new(pt(p))));
                    last = p;
                }
                PathEl::LineTo(p) => {
                    out.push(RawSegmentData::LineTo(RawLineCommand::new(pt(p))));
                    last = p;
                }
                PathEl::QuadTo(c, p) => {
                    let c1 = last + (c - last) * (2.0 / 3.0);
                    let c2 = p + (c - p) * (2.0 / 3.0);
                    out.push(RawSegmentData::CurveTo(RawCurveCommand::new(pt(c1), pt(c2), pt(p))));
                    last = p;
                }
                PathEl::CurveTo(c1, c2, p) => {
                    out.push(RawSegmentData::CurveTo(RawCurveCommand::new(pt(c1), pt(c2), pt(p))));
                    last = p;
                }
                PathEl::ClosePath => out.push(RawSegmentData::Close),
            }
        }
    }
    out
}

/// render-wasm's `mem::write_vec` layout: a little-endian `u32` count, then the records.
fn write_vec(segments: &[RawSegmentData]) -> Vec<u8> {
    let mut bytes = vec![0u8; 4 + segments.len() * RAW_SEGMENT_DATA_SIZE];
    bytes[..4].copy_from_slice(&(segments.len() as u32).to_le_bytes());
    for (i, seg) in segments.iter().enumerate() {
        let at = 4 + i * RAW_SEGMENT_DATA_SIZE;
        // Every variant fits a record, so encoding into an exact-size slot cannot fail.
        let _ = encode_segment(seg, &mut bytes[at..at + RAW_SEGMENT_DATA_SIZE]);
    }
    bytes
}

/// Curve-native `subject OP clip` for the vector eraser and boolean tools.
///
/// The shared buffer (`alloc_bytes`) holds `subject_seg_count` subject segments followed by the
/// clip segments. The result is left in that same buffer — count, then segments — and its
/// pointer returned, so the host reads it and releases it with `free_bytes`, exactly as against
/// render-wasm. Undecodable input or an unknown op yields an empty result rather than a trap.
#[unsafe(no_mangle)]
pub extern "C" fn path_boolean(raw_bool_type: u8, fill_rule: u8, subject_seg_count: u32) -> *mut u8 {
    let bytes = crate::vello::abi::take_bytes();
    let segments = match (decode_path(&bytes), bool_op(raw_bool_type)) {
        (Ok(all), Some(op)) => {
            let split = (subject_seg_count as usize).min(all.len());
            let fill = if fill_rule == 1 { Fill::EvenOdd } else { Fill::NonZero };
            boolean_segments(&all[..split], &all[split..], op, fill)
        }
        _ => Vec::new(),
    };
    crate::vello::abi::put_bytes(write_vec(&segments))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x0: f32, y0: f32, x1: f32, y1: f32) -> Vec<RawSegmentData> {
        vec![
            RawSegmentData::MoveTo(RawMoveCommand::new((x0, y0))),
            RawSegmentData::LineTo(RawLineCommand::new((x1, y0))),
            RawSegmentData::LineTo(RawLineCommand::new((x1, y1))),
            RawSegmentData::LineTo(RawLineCommand::new((x0, y1))),
            RawSegmentData::Close,
        ]
    }

    fn area(segments: &[RawSegmentData]) -> f64 {
        use kurbo::Shape;
        bez_path_from_raw(segments).area().abs()
    }

    #[test]
    fn difference_cuts_a_hole() {
        let out = boolean_segments(&rect(0., 0., 100., 100.), &rect(40., 40., 60., 60.), BoolOp::Difference, Fill::NonZero);
        let closes = out.iter().filter(|s| matches!(s, RawSegmentData::Close)).count();
        assert!(closes >= 2, "outer ring plus a hole, got {closes} contours");
    }

    #[test]
    fn edge_bite_removes_the_overlap() {
        let out = boolean_segments(&rect(0., 0., 100., 100.), &rect(80., 80., 140., 140.), BoolOp::Difference, Fill::NonZero);
        assert!((area(&out) - 9600.0).abs() < 1.0, "area {}", area(&out));
    }

    #[test]
    fn result_uses_render_wasm_layout() {
        let segs = rect(0., 0., 1., 1.);
        let bytes = write_vec(&segs);
        assert_eq!(u32::from_le_bytes(bytes[..4].try_into().unwrap()), segs.len() as u32);
        assert_eq!(bytes.len(), 4 + segs.len() * RAW_SEGMENT_DATA_SIZE);
        assert_eq!(decode_path(&bytes[4..]).unwrap(), segs);
    }
}
