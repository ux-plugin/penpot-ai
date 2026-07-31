#![allow(unused_mut, unused_variables)]
use mem::SerializableResult;
use render_macros::wasm_error;
use std::sync::{Mutex, OnceLock};

use crate::error::{Error, Result};
use crate::shapes::{stroke_to_path, Path, Segment, ToPath};
use crate::{mem, with_current_shape, with_current_shape_mut, STATE};

// D17: the layout and the codec live in `render_core::abi` so that the Vello module parses
// identical bytes through identical definitions. What stays here is the Skia-facing half —
// the conversions to and from this engine's `Segment`.
use render_core::abi::{
    decode_path, encode_segment, RawCurveCommand, RawLineCommand, RawMoveCommand,
};
pub use render_core::abi::{RawSegmentData, RAW_SEGMENT_DATA_SIZE};

pub mod bools;

pub(super) fn raw_segment_from(segment: Segment) -> RawSegmentData {
    match segment {
        Segment::MoveTo(to) => RawSegmentData::MoveTo(RawMoveCommand::new(to)),
        Segment::LineTo(to) => RawSegmentData::LineTo(RawLineCommand::new(to)),
        Segment::CurveTo((c1, c2, to)) => RawSegmentData::CurveTo(RawCurveCommand::new(c1, c2, to)),
        Segment::Close => RawSegmentData::Close,
    }
}

/// Decode a packed segment buffer into this engine's `Segment`s.
///
/// Errors rather than dropping malformed records. The code this replaces printed a warning and
/// carried on, which turns a framing bug into silently wrong geometry.
fn segments_from_bytes(bytes: &[u8]) -> Result<Vec<Segment>> {
    let raw = decode_path(bytes)
        .map_err(|e| Error::CriticalError(format!("Invalid path data: {}", e)))?;
    Ok(raw.into_iter().map(Segment::from).collect())
}

impl SerializableResult for RawSegmentData {
    type BytesType = [u8; RAW_SEGMENT_DATA_SIZE];

    // The generic trait doesn't know the size of the array. This is why the
    // clone needs to be here even if it could be generic.
    fn clone_to_slice(&self, slice: &mut [u8]) {
        encode_segment(self, slice).expect("segment slice is sized by RAW_SEGMENT_DATA_SIZE");
    }
}

impl From<RawSegmentData> for Segment {
    fn from(value: RawSegmentData) -> Self {
        match value {
            RawSegmentData::MoveTo(cmd) => Segment::MoveTo((cmd.x, cmd.y)),
            RawSegmentData::LineTo(cmd) => Segment::LineTo((cmd.x, cmd.y)),
            RawSegmentData::CurveTo(cmd) => {
                Segment::CurveTo(((cmd.c1_x, cmd.c1_y), (cmd.c2_x, cmd.c2_y), (cmd.x, cmd.y)))
            }
            RawSegmentData::Close => Segment::Close,
        }
    }
}

impl From<Vec<RawSegmentData>> for Path {
    fn from(value: Vec<RawSegmentData>) -> Self {
        let segments = value.into_iter().map(Segment::from).collect();
        Path::new(segments)
    }
}

static PATH_UPLOAD_BUFFER: OnceLock<Mutex<Vec<u8>>> = OnceLock::new();

fn get_path_upload_buffer() -> &'static Mutex<Vec<u8>> {
    PATH_UPLOAD_BUFFER.get_or_init(|| Mutex::new(Vec::new()))
}

#[no_mangle]
#[wasm_error]
pub extern "C" fn start_shape_path_buffer() -> Result<()> {
    let buffer = get_path_upload_buffer();
    let mut buffer = buffer
        .lock()
        .map_err(|_| Error::CriticalError("Failed to lock path buffer".to_string()))?;
    buffer.clear();
    Ok(())
}

#[no_mangle]
#[wasm_error]
pub extern "C" fn set_shape_path_chunk_buffer() -> Result<()> {
    let bytes = mem::bytes();
    let buffer = get_path_upload_buffer();
    let mut buffer = buffer
        .lock()
        .map_err(|_| Error::CriticalError("Failed to lock path buffer".to_string()))?;
    buffer.extend_from_slice(&bytes);
    mem::free_bytes()?;
    Ok(())
}

#[no_mangle]
#[wasm_error]
pub extern "C" fn set_shape_path_buffer() -> Result<()> {
    let buffer = get_path_upload_buffer();
    let mut buffer = buffer
        .lock()
        .map_err(|_| Error::CriticalError("Failed to lock path buffer".to_string()))?;
    let segments = segments_from_bytes(&buffer)?;

    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.set_path_segments(segments);
    });
    buffer.clear();

    Ok(())
}

#[no_mangle]
pub extern "C" fn set_shape_path_content() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        let bytes = mem::bytes();
        let segments = segments_from_bytes(&bytes).expect("Invalid path data");
        shape.set_path_segments(segments);
    });
}

#[no_mangle]
pub extern "C" fn current_to_path() -> *mut u8 {
    let mut result = Vec::<RawSegmentData>::default();
    with_current_shape!(state, |shape: &Shape| {
        let path = shape.to_path(&state.shapes);
        result = path
            .segments()
            .iter()
            .copied()
            .map(raw_segment_from)
            .collect();
    });

    mem::write_vec(result)
}

/// Converts a shape's stroke (at the given index) into a filled path.
///
/// This uses Skia's `fill_path_with_paint` to convert the stroke outline
/// into a filled path, properly handling inner/outer/center alignment
/// via boolean path operations.
#[no_mangle]
pub extern "C" fn convert_stroke_to_path(stroke_index: i32) -> *mut u8 {
    let mut result = Vec::<RawSegmentData>::default();
    with_current_shape!(state, |shape: &Shape| {
        let idx = stroke_index as usize;
        if let Some(stroke) = shape.strokes.get(idx) {
            let shape_path = shape.to_path(&state.shapes);
            let path_transform = shape.to_path_transform();

            if let Some(path) = stroke_to_path(
                stroke,
                &shape_path,
                path_transform.as_ref(),
                &shape.selrect,
                shape.svg_attrs.as_ref(),
            ) {
                result = path
                    .segments()
                    .iter()
                    .copied()
                    .map(raw_segment_from)
                    .collect();
            }
        }
    });

    mem::write_vec(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use render_core::abi::decode_segment;

    #[test]
    fn test_move_command_deserialization() {
        let mut bytes = [0x00; RAW_SEGMENT_DATA_SIZE];
        bytes[0..2].copy_from_slice(&0x01_u16.to_le_bytes());
        bytes[20..24].copy_from_slice(&1.0_f32.to_le_bytes());
        bytes[24..28].copy_from_slice(&2.0_f32.to_le_bytes());

        let raw_segment = decode_segment(&bytes).unwrap();
        let segment = Segment::from(raw_segment);

        assert_eq!(segment, Segment::MoveTo((1.0, 2.0)));
    }

    #[test]
    fn test_line_command_deserialization() {
        let mut bytes = [0x00; RAW_SEGMENT_DATA_SIZE];
        bytes[0..2].copy_from_slice(&0x02_u16.to_le_bytes());
        bytes[20..24].copy_from_slice(&3.0_f32.to_le_bytes());
        bytes[24..28].copy_from_slice(&4.0_f32.to_le_bytes());

        let raw_segment = decode_segment(&bytes).unwrap();
        let segment = Segment::from(raw_segment);

        assert_eq!(segment, Segment::LineTo((3.0, 4.0)));
    }

    #[test]
    fn test_curve_command_deserialization() {
        let mut bytes = [0x00; RAW_SEGMENT_DATA_SIZE];
        bytes[0..2].copy_from_slice(&0x03_u16.to_le_bytes());
        bytes[4..8].copy_from_slice(&1.0_f32.to_le_bytes());
        bytes[8..12].copy_from_slice(&2.0_f32.to_le_bytes());
        bytes[12..16].copy_from_slice(&3.0_f32.to_le_bytes());
        bytes[16..20].copy_from_slice(&4.0_f32.to_le_bytes());
        bytes[20..24].copy_from_slice(&5.0_f32.to_le_bytes());
        bytes[24..28].copy_from_slice(&6.0_f32.to_le_bytes());

        let raw_segment = decode_segment(&bytes).unwrap();
        let segment = Segment::from(raw_segment);

        assert_eq!(
            segment,
            Segment::CurveTo(((1.0, 2.0), (3.0, 4.0), (5.0, 6.0)))
        );
    }

    #[test]
    fn test_close_command_deserialization() {
        let mut bytes = [0x00; RAW_SEGMENT_DATA_SIZE];
        bytes[0..2].copy_from_slice(&0x04_u16.to_le_bytes());

        let raw_segment = decode_segment(&bytes).unwrap();
        let segment = Segment::from(raw_segment);

        assert_eq!(segment, Segment::Close);
    }
}
