use macros::ToJs;

use crate::mem;
use crate::shapes::{self, StrokeCap, StrokeLineCap, StrokeLineJoin, StrokeStyle};
use crate::with_current_shape_mut;
use crate::STATE;

#[derive(Debug, Clone, PartialEq, Copy, ToJs)]
#[repr(u8)]
#[allow(dead_code)]
pub enum RawStrokeStyle {
    Solid = 0,
    Dotted = 1,
    Dashed = 2,
    Mixed = 3,
}

impl From<u8> for RawStrokeStyle {
    fn from(value: u8) -> Self {
        unsafe { std::mem::transmute(value) }
    }
}

impl From<RawStrokeStyle> for StrokeStyle {
    fn from(value: RawStrokeStyle) -> Self {
        match value {
            RawStrokeStyle::Solid => StrokeStyle::Solid,
            RawStrokeStyle::Dotted => StrokeStyle::Dotted,
            RawStrokeStyle::Dashed => StrokeStyle::Dashed,
            RawStrokeStyle::Mixed => StrokeStyle::Mixed,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, ToJs)]
#[repr(u8)]
#[allow(dead_code)]
pub enum RawStrokeCap {
    None = 0,
    LineArrow = 1,
    TriangleArrow = 2,
    SquareMarker = 3,
    CircleMarker = 4,
    DiamondMarker = 5,
    Round = 6,
    Square = 7,
}

impl From<u8> for RawStrokeCap {
    fn from(value: u8) -> Self {
        unsafe { std::mem::transmute(value) }
    }
}

impl TryFrom<RawStrokeCap> for StrokeCap {
    type Error = ();

    fn try_from(value: RawStrokeCap) -> Result<Self, Self::Error> {
        match value {
            RawStrokeCap::None => Err(()),
            RawStrokeCap::LineArrow => Ok(StrokeCap::LineArrow),
            RawStrokeCap::TriangleArrow => Ok(StrokeCap::TriangleArrow),
            RawStrokeCap::SquareMarker => Ok(StrokeCap::SquareMarker),
            RawStrokeCap::CircleMarker => Ok(StrokeCap::CircleMarker),
            RawStrokeCap::DiamondMarker => Ok(StrokeCap::DiamondMarker),
            RawStrokeCap::Round => Ok(StrokeCap::Round),
            RawStrokeCap::Square => Ok(StrokeCap::Square),
        }
    }
}

#[no_mangle]
pub extern "C" fn add_shape_center_stroke(width: f32, style: u8, cap_start: u8, cap_end: u8) {
    let stroke_style = RawStrokeStyle::from(style);
    let cap_start = RawStrokeCap::from(cap_start);
    let cap_end = RawStrokeCap::from(cap_end);

    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.add_stroke(shapes::Stroke::new_center_stroke(
            width,
            stroke_style.into(),
            cap_start.try_into().ok(),
            cap_end.try_into().ok(),
        ));
    });
}

#[no_mangle]
pub extern "C" fn add_shape_inner_stroke(width: f32, style: u8, cap_start: u8, cap_end: u8) {
    let stroke_style = RawStrokeStyle::from(style);
    let cap_start = RawStrokeCap::from(cap_start);
    let cap_end = RawStrokeCap::from(cap_end);

    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.add_stroke(shapes::Stroke::new_inner_stroke(
            width,
            stroke_style.into(),
            cap_start.try_into().ok(),
            cap_end.try_into().ok(),
        ));
    });
}

#[no_mangle]
pub extern "C" fn add_shape_outer_stroke(width: f32, style: u8, cap_start: u8, cap_end: u8) {
    let stroke_style = RawStrokeStyle::from(style);
    let cap_start = RawStrokeCap::from(cap_start);
    let cap_end = RawStrokeCap::from(cap_end);

    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.add_stroke(shapes::Stroke::new_outer_stroke(
            width,
            stroke_style.into(),
            cap_start.try_into().ok(),
            cap_end.try_into().ok(),
        ));
    });
}

#[no_mangle]
pub extern "C" fn add_shape_stroke_fill() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        let bytes = mem::bytes();
        let raw_fill = super::fills::RawFillData::try_from(&bytes[..]).expect("Invalid fill data");
        shape
            .set_stroke_fill(raw_fill.into())
            .expect("could not add stroke fill");
    });
}

#[no_mangle]
pub extern "C" fn clear_shape_strokes() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.clear_strokes();
    });
}

fn line_join_from_i32(value: i32) -> Option<StrokeLineJoin> {
    match value {
        0 => Some(StrokeLineJoin::Miter),
        1 => Some(StrokeLineJoin::Round),
        2 => Some(StrokeLineJoin::Bevel),
        _ => None,
    }
}

fn line_cap_from_i32(value: i32) -> Option<StrokeLineCap> {
    match value {
        0 => Some(StrokeLineCap::Butt),
        1 => Some(StrokeLineCap::Round),
        2 => Some(StrokeLineCap::Square),
        _ => None,
    }
}

/// Set a custom dash pattern on the current shape's last stroke. Dash values
/// (`[dash, gap, …]`, f32 little-endian) are read from the shared byte buffer,
/// mirroring the `add_shape_stroke_fill` convention.
#[no_mangle]
pub extern "C" fn set_shape_stroke_dashes() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        let bytes = mem::bytes();
        let dashes: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();
        if let Some(stroke) = shape.strokes.last_mut() {
            stroke.set_dashes(dashes);
        }
    });
}

/// Override join / dash-cap / miter-limit on the current shape's last stroke.
/// `join` and `cap` use `-1` to mean "leave unchanged" (else 0/1/2 enum index);
/// `miter` uses any negative value to mean "leave unchanged".
#[no_mangle]
pub extern "C" fn set_shape_stroke_props(join: i32, cap: i32, miter: f32) {
    let join = line_join_from_i32(join);
    let cap = line_cap_from_i32(cap);
    let miter = if miter >= 0.0 { Some(miter) } else { None };
    with_current_shape_mut!(state, |shape: &mut Shape| {
        if let Some(stroke) = shape.strokes.last_mut() {
            stroke.set_props(join, cap, miter);
        }
    });
}

/// Apply a "Dynamic" perturbation (frequency / wiggle / smoothen, all 0..1) to
/// the current shape's last stroke.
#[no_mangle]
pub extern "C" fn set_shape_stroke_dynamic(frequency: f32, wiggle: f32, smoothen: f32) {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        if let Some(stroke) = shape.strokes.last_mut() {
            stroke.set_dynamic(shapes::DynamicStroke {
                frequency,
                wiggle,
                smoothen,
            });
        }
    });
}

fn width_profile_from_u8(value: u8) -> shapes::WidthProfile {
    match value {
        1 => shapes::WidthProfile::TaperBoth,
        2 => shapes::WidthProfile::TaperStart,
        3 => shapes::WidthProfile::TaperEnd,
        4 => shapes::WidthProfile::Bulge,
        5 => shapes::WidthProfile::Custom,
        _ => shapes::WidthProfile::Uniform,
    }
}

/// Set hand-authored width points on the current shape's last stroke. Values
/// (`[t, left, right, …]`, f32 little-endian) are read from the shared byte
/// buffer, mirroring the `set_shape_stroke_dashes` convention.
#[no_mangle]
pub extern "C" fn set_shape_stroke_width_points() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        let bytes = mem::bytes();
        let points: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
            .collect();
        if let Some(stroke) = shape.strokes.last_mut() {
            stroke.set_width_points(points);
        }
    });
}

/// Select a PowerStroke (variable-width) brush on the current shape's last
/// stroke. `profile` is the width-envelope index; `nib` is the calligraphic nib
/// angle in degrees (`<= 0` = round / no nib).
#[no_mangle]
pub extern "C" fn set_shape_stroke_brush_power(profile: u8, nib: f32) {
    let profile = width_profile_from_u8(profile);
    with_current_shape_mut!(state, |shape: &mut Shape| {
        if let Some(stroke) = shape.strokes.last_mut() {
            stroke.set_brush(shapes::Brush::Power { profile, nib });
        }
    });
}

/// Select a Texture ("stretch") brush on the current shape's last stroke.
/// `scale` is the grain feature size (world units); `density` is solidity 0..1.
#[no_mangle]
pub extern "C" fn set_shape_stroke_brush_texture(scale: f32, density: f32) {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        if let Some(stroke) = shape.strokes.last_mut() {
            stroke.set_brush(shapes::Brush::Texture { scale, density });
        }
    });
}
