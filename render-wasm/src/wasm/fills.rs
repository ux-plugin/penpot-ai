use render_macros::wasm_error;

use crate::error::Error;
use crate::mem;
use crate::shapes;
use crate::utils::uuid_from_u32_quartet;
use crate::with_current_shape_mut;
use crate::with_state_mut;
use crate::STATE;

mod gradient;
mod image;
mod solid;

// The wire layout and its discriminants live in render-core (D17), so the Vello module reads
// the same bytes through the same definitions. Everything Skia-facing stays in this file.
pub use render_core::abi::{RawFillData, RAW_FILL_DATA_SIZE};

impl From<RawFillData> for shapes::Fill {
    fn from(fill_data: RawFillData) -> Self {
        match fill_data {
            RawFillData::Solid(solid_fill_data) => shapes::Fill::Solid(solid_fill_data.into()),
            RawFillData::Linear(linear_fill_data) => {
                shapes::Fill::LinearGradient(linear_fill_data.into())
            }
            RawFillData::Radial(radial_fill_data) => {
                shapes::Fill::RadialGradient(radial_fill_data.into())
            }
            RawFillData::Image(image_fill_data) => shapes::Fill::Image(image_fill_data.into()),
            RawFillData::Angular(angular_fill_data) => {
                shapes::Fill::AngularGradient(angular_fill_data.into())
            }
            RawFillData::Diamond(diamond_fill_data) => {
                shapes::Fill::DiamondGradient(diamond_fill_data.into())
            }
        }
    }
}

impl TryFrom<&shapes::Fill> for RawFillData {
    type Error = String;

    fn try_from(fill: &shapes::Fill) -> Result<Self, Self::Error> {
        match fill {
            shapes::Fill::Solid(shapes::SolidColor(color)) => {
                Ok(RawFillData::Solid(solid::RawSolidData {
                    color: ((color.a() as u32) << 24)
                        | ((color.r() as u32) << 16)
                        | ((color.g() as u32) << 8)
                        | (color.b() as u32),
                }))
            }
            shapes::Fill::LinearGradient(_) => {
                Err("LinearGradient serialization is not implemented".to_string())
            }
            shapes::Fill::RadialGradient(_) => {
                Err("RadialGradient serialization is not implemented".to_string())
            }
            shapes::Fill::Image(_) => {
                Err("Image fill serialization is not implemented".to_string())
            }
            shapes::Fill::AngularGradient(_) => {
                Err("AngularGradient serialization is not implemented".to_string())
            }
            shapes::Fill::DiamondGradient(_) => {
                Err("DiamondGradient serialization is not implemented".to_string())
            }
        }
    }
}

// These were `From`/`TryFrom` impls. Now that `RawFillData` lives in render-core they would be
// foreign-trait-on-foreign-type, which the orphan rule forbids, so they are free functions.
//
// They also stay in render-wasm rather than moving with the struct, because render-core is
// `#![forbid(unsafe_code)]`. Worth flagging while we are here: `raw_fill_to_bytes` is unsound
// as written — these layouts carry padding (`RawGradientData` documents 24 reserved bits), and
// transmuting a struct *into* bytes exposes those uninitialised bytes. Decoding is fine; it is
// the encoding direction that is wrong. A safe explicit codec in render-core replaces both.

pub(crate) fn raw_fill_from_bytes(bytes: [u8; RAW_FILL_DATA_SIZE]) -> RawFillData {
    unsafe { std::mem::transmute(bytes) }
}

pub(crate) fn raw_fill_to_bytes(fill_data: RawFillData) -> [u8; RAW_FILL_DATA_SIZE] {
    unsafe { std::mem::transmute(fill_data) }
}

pub(crate) fn raw_fill_from_slice(bytes: &[u8]) -> Result<RawFillData, String> {
    let data: [u8; RAW_FILL_DATA_SIZE] = bytes
        .get(0..RAW_FILL_DATA_SIZE)
        .and_then(|slice| slice.try_into().ok())
        .ok_or("Invalid fill data".to_string())?;
    Ok(raw_fill_from_bytes(data))
}

// FIXME: return Result
pub fn read_fills_from_bytes(buffer: &[u8], num_fills: usize) -> Vec<shapes::Fill> {
    buffer
        .chunks_exact(RAW_FILL_DATA_SIZE)
        .take(num_fills)
        .map(|bytes| {
            raw_fill_from_slice(bytes)
                .expect("Invalid fill data")
                .into()
        })
        .collect()
}

#[no_mangle]
#[wasm_error]
pub extern "C" fn set_shape_fills() -> Result<()> {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        let bytes = mem::bytes();
        // The first byte contains the actual number of fills
        let num_fills = bytes.first().copied().unwrap_or(0) as usize;
        // Skip the first 4 bytes (header with fill count) and parse only the actual fills
        let fills = read_fills_from_bytes(&bytes[4..], num_fills);
        shape.set_fills(fills);
        mem::free_bytes()?;
    });
    Ok(())
}

#[no_mangle]
pub extern "C" fn add_shape_fill() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        let bytes = mem::bytes();
        let raw_fill = raw_fill_from_slice(&bytes[..]).expect("Invalid fill data");
        shape.add_fill(raw_fill.into());
    });
}

#[no_mangle]
pub extern "C" fn clear_shape_fills() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.clear_fills();
    });
}

/// Set a temporary fill override for one shape (used for gradient drag preview).
/// Heap layout: [16 bytes UUID as 4×u32 LE] [4 bytes fill_count u32 LE] [fills…]
#[no_mangle]
#[wasm_error]
pub extern "C" fn set_fill_modifier() -> Result<()> {
    let bytes = mem::bytes();

    let a = u32::from_le_bytes(
        bytes[0..4].try_into().map_err(|_| Error::RecoverableError("uuid[0]".into()))?,
    );
    let b = u32::from_le_bytes(
        bytes[4..8].try_into().map_err(|_| Error::RecoverableError("uuid[1]".into()))?,
    );
    let c = u32::from_le_bytes(
        bytes[8..12].try_into().map_err(|_| Error::RecoverableError("uuid[2]".into()))?,
    );
    let d = u32::from_le_bytes(
        bytes[12..16].try_into().map_err(|_| Error::RecoverableError("uuid[3]".into()))?,
    );
    let uuid = uuid_from_u32_quartet(a, b, c, d);

    let num_fills = u32::from_le_bytes(
        bytes[16..20]
            .try_into()
            .map_err(|_| Error::RecoverableError("fill count".into()))?,
    ) as usize;
    let fills = read_fills_from_bytes(&bytes[20..], num_fills);

    with_state_mut!(state, {
        state.shapes.set_fill_modifier(uuid, fills);
        state.touch_shape(uuid);
    });

    mem::free_bytes()?;
    Ok(())
}

/// Remove all fill overrides, invalidate tile caches for affected shapes, and
/// mark them as touched so the next render re-draws them without the modifier.
#[no_mangle]
pub extern "C" fn clean_fill_modifiers() {
    with_state_mut!(state, {
        let uuids = state.shapes.clean_fill_modifiers();
        for uuid in uuids {
            state.touch_shape(uuid);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_raw_fill_data_layout() {
        assert_eq!(
            std::mem::size_of::<RawFillData>(),
            4 + std::mem::size_of::<gradient::RawGradientData>()
        );
        assert_eq!(std::mem::align_of::<RawFillData>(), 4);
    }

    #[test]
    fn test_raw_fill_data_from_bytes_to_solid_fill() {
        let mut bytes = vec![0x00; std::mem::size_of::<RawFillData>()];
        bytes[0] = 0x00;
        bytes[4..8].copy_from_slice(&0xfffabada_u32.to_le_bytes());

        let raw_fill = raw_fill_from_slice(&bytes[..]);

        assert!(raw_fill.is_ok());
        assert_eq!(
            raw_fill.unwrap(),
            RawFillData::Solid(solid::RawSolidData { color: 0xfffabada })
        );
    }
}
