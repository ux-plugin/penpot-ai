use skia_safe as skia;

use crate::shapes::noise::{NoiseEffect, NoiseType};
use crate::{with_current_shape_mut, STATE};

#[no_mangle]
pub extern "C" fn set_shape_noise(
    raw_noise_type: u8,
    noise_size: f32,
    density: f32,
    raw_color: u32,
    raw_secondary_color: u32,
    hidden: bool,
) {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        let noise_type = NoiseType::from(raw_noise_type);
        let color = skia::Color::new(raw_color);
        let secondary_color = skia::Color::new(raw_secondary_color);
        let noise = NoiseEffect::new(noise_type, noise_size, density, color, secondary_color, hidden);
        shape.set_noise(Some(noise));
    });
}

#[no_mangle]
pub extern "C" fn clear_shape_noise() {
    with_current_shape_mut!(state, |shape: &mut Shape| {
        shape.set_noise(None);
    });
}
