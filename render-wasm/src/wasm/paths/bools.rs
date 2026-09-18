use render_macros::{wasm_error, ToJs};

use super::raw_segment_from;
use crate::math;
use crate::shapes::{BoolType, Segment};
use crate::uuid::Uuid;
use crate::{mem, SerializableResult};
use crate::{with_current_shape_mut, with_state, STATE};
use curve_bool::{BoolOp, Fill};
use kurbo::{BezPath, PathEl, Point as KPoint};
use std::mem::size_of;

#[allow(unused_imports)]
use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, ToJs)]
#[repr(u8)]
#[allow(dead_code)]
pub enum RawBoolType {
    Union = 0,
    Difference = 1,
    Intersection = 2,
    Exclude = 3,
}

impl From<u8> for RawBoolType {
    fn from(value: u8) -> Self {
        unsafe { std::mem::transmute(value) }
    }
}

impl From<RawBoolType> for BoolType {
    fn from(value: RawBoolType) -> Self {
        match value {
            RawBoolType::Union => BoolType::Union,
            RawBoolType::Difference => BoolType::Difference,
            RawBoolType::Intersection => BoolType::Intersection,
            RawBoolType::Exclude => BoolType::Exclusion,
        }
    }
}

#[no_mangle]
pub extern "C" fn set_shape_bool_type(raw_bool_type: u8) {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.set_bool_type(RawBoolType::from(raw_bool_type).into());
    });
}

#[no_mangle]
#[wasm_error]
pub extern "C" fn calculate_bool(raw_bool_type: u8) -> Result<*mut u8> {
    let bytes = mem::bytes_or_empty();

    let entries: Vec<Uuid> = bytes
        .chunks(size_of::<<Uuid as SerializableResult>::BytesType>())
        .map(|data| {
            // FIXME: Review if this should be an critical or a recoverable error.
            Uuid::try_from(data).map_err(|_| Error::RecoverableError("Invalid UUID".to_string()))
        })
        .collect::<Result<Vec<Uuid>>>()?;

    mem::free_bytes()?;

    let bool_type = RawBoolType::from(raw_bool_type).into();
    let result;
    with_state!(state, {
        let path = math::bools::bool_from_shapes(bool_type, &entries, &state.shapes);
        result = path
            .segments()
            .iter()
            .copied()
            .map(raw_segment_from)
            .collect();
    });
    Ok(mem::write_vec(result))
}

/// A render-wasm cubic-segment list → one [`kurbo::BezPath`]. Each `MoveTo` opens
/// a new sub-path within the single path, which is exactly how a compound fill
/// (outer ring plus holes, or a multi-piece brush band) is handed to the boolean
/// engine. Malformed input (a line/curve before any move) is skipped rather than
/// panicking, since a wasm panic would take down the whole module.
fn segments_to_bezpath(segments: &[Segment]) -> BezPath {
    let mut path = BezPath::new();
    let mut started = false;
    for seg in segments {
        match *seg {
            Segment::MoveTo((x, y)) => {
                path.move_to(KPoint::new(x as f64, y as f64));
                started = true;
            }
            Segment::LineTo((x, y)) if started => path.line_to(KPoint::new(x as f64, y as f64)),
            Segment::CurveTo(((c1x, c1y), (c2x, c2y), (x, y))) if started => path.curve_to(
                KPoint::new(c1x as f64, c1y as f64),
                KPoint::new(c2x as f64, c2y as f64),
                KPoint::new(x as f64, y as f64),
            ),
            Segment::Close if started => path.close_path(),
            _ => {}
        }
    }
    path
}

/// The boolean result (a set of closed contours) → a flat render-wasm segment
/// list, one `MoveTo … Close` run per contour. Any quadratic the engine emits is
/// elevated to a cubic so the segment model stays purely cubic.
fn bezpaths_to_segments(paths: &[BezPath]) -> Vec<Segment> {
    let mut out = Vec::new();
    for path in paths {
        let mut last = KPoint::ZERO;
        for el in path.elements() {
            match *el {
                PathEl::MoveTo(p) => {
                    out.push(Segment::MoveTo((p.x as f32, p.y as f32)));
                    last = p;
                }
                PathEl::LineTo(p) => {
                    out.push(Segment::LineTo((p.x as f32, p.y as f32)));
                    last = p;
                }
                PathEl::QuadTo(c, p) => {
                    let c1 = last + (c - last) * (2.0 / 3.0);
                    let c2 = p + (c - p) * (2.0 / 3.0);
                    out.push(Segment::CurveTo((
                        (c1.x as f32, c1.y as f32),
                        (c2.x as f32, c2.y as f32),
                        (p.x as f32, p.y as f32),
                    )));
                    last = p;
                }
                PathEl::CurveTo(c1, c2, p) => {
                    out.push(Segment::CurveTo((
                        (c1.x as f32, c1.y as f32),
                        (c2.x as f32, c2.y as f32),
                        (p.x as f32, p.y as f32),
                    )));
                    last = p;
                }
                PathEl::ClosePath => out.push(Segment::Close),
            }
        }
    }
    out
}

/// Curve-native `subject OP clip` for the vector eraser and boolean tools.
///
/// The memory buffer holds `subject_seg_count` subject segments followed by the
/// clip segments (both as [`RawSegmentData`]). The boolean runs on real béziers
/// via `curve-bool`/linesweeper — no flattening to polygons and no re-fitting
/// afterward — and the resulting closed contours are written back as a segment
/// list. `fill_rule`: 0 = non-zero, 1 = even-odd.
#[no_mangle]
#[wasm_error]
pub extern "C" fn path_boolean(
    raw_bool_type: u8,
    fill_rule: u8,
    subject_seg_count: u32,
) -> Result<*mut u8> {
    let bytes = mem::bytes_or_empty();
    let all: Vec<Segment> = bytes
        .chunks(size_of::<RawSegmentData>())
        .map(|chunk| RawSegmentData::try_from(chunk).map(Segment::from))
        .collect::<Result<Vec<Segment>>>()?;
    mem::free_bytes()?;

    let split = (subject_seg_count as usize).min(all.len());
    let subject = segments_to_bezpath(&all[..split]);
    let clip = segments_to_bezpath(&all[split..]);

    let op = match RawBoolType::from(raw_bool_type) {
        RawBoolType::Union => BoolOp::Union,
        RawBoolType::Difference => BoolOp::Difference,
        RawBoolType::Intersection => BoolOp::Intersection,
        RawBoolType::Exclude => BoolOp::Exclude,
    };
    let fill = if fill_rule == 1 { Fill::EvenOdd } else { Fill::NonZero };

    let contours = curve_bool::path_boolean(&subject, &clip, op, fill);
    let result: Vec<RawSegmentData> = bezpaths_to_segments(&contours)
        .into_iter()
        .map(RawSegmentData::from_segment)
        .collect();
    Ok(mem::write_vec(result))
}
