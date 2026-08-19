//! Blur geometry, backend-neutral.
//!
//! Penpot sends a blur as a **radius**; both Skia and Vello's Gaussian blur take a **sigma**
//! (standard deviation). The conversion is Skia's `SkBlurMask::ConvertRadiusToSigma`, and it has
//! to be identical on both sides or the same document blurs by different amounts — so it lives
//! here, once, and render-vello routes through it (render-wasm keeps its own copy for its Skia
//! path, pinned equal by a test).

/// Skia's `kBLUR_SIGMA_SCALE` (1/√3 ≈ 0.577350). Mirrors `render-wasm/src/shapes/blurs.rs`.
const BLUR_SIGMA_SCALE: f32 = 0.577_350_27;

/// Convert a blur radius to a Gaussian sigma. Zero (and negative) radii mean no blur.
#[inline]
pub fn radius_to_sigma(radius: f32) -> f32 {
    if radius > 0.0 {
        BLUR_SIGMA_SCALE * radius + 0.5
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_zero_or_negative_radius_is_no_blur() {
        assert_eq!(radius_to_sigma(0.0), 0.0);
        assert_eq!(radius_to_sigma(-4.0), 0.0);
    }

    #[test]
    fn a_positive_radius_follows_skias_formula() {
        assert!((radius_to_sigma(10.0) - (BLUR_SIGMA_SCALE * 10.0 + 0.5)).abs() < 1e-6);
        assert!(radius_to_sigma(20.0) > radius_to_sigma(10.0));
    }
}
