use crate::shapes::{Color, Gradient};

// Layout in render-core (D17), Skia-facing conversion here. Re-exported so
// `gradient::RawGradientData` still resolves for existing call sites.
pub use render_core::abi::{RawGradientData, RawStopData};

impl From<RawGradientData> for Gradient {
    fn from(raw_gradient: RawGradientData) -> Self {
        // `active_stops` clamps to the array bound, so a malformed `stop_count` off the wire
        // truncates rather than reading past the fixed-size tail.
        let stops = raw_gradient
            .active_stops()
            .iter()
            .map(|stop| (Color::from(stop.color), stop.offset))
            .collect::<Vec<_>>();

        Gradient::new(
            raw_gradient.start(),
            raw_gradient.end(),
            raw_gradient.opacity,
            (raw_gradient.width_x, raw_gradient.width_y),
            &stops,
        )
    }
}
