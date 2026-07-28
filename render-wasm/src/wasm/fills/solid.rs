use crate::shapes::{Color, SolidColor};

// The layout lives in render-core (D17) so the Vello module parses the same bytes; the
// conversion into Skia types stays here. Re-exported so `solid::RawSolidData` still resolves.
pub use render_core::abi::RawSolidData;

impl From<RawSolidData> for SolidColor {
    fn from(value: RawSolidData) -> Self {
        Self(Color::new(value.color))
    }
}
