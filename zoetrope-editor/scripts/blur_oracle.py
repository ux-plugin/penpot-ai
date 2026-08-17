"""Score a rendered background-blur against a ground-truth linear-light Gaussian.

Usage: blur_oracle.py <with-lenses.png> <no-lenses.png> <canvasW> <canvasH> <lenses> <radius> [dpr]

`no-lenses.png` is the *true* backdrop (the identical scene with the lens shapes omitted), so the
reference needs no guesswork about what was underneath. Each lens is blurred from that backdrop with
a separable Gaussian in **linear light** (sRGB-decode → blur → re-encode), which is what the vello
effects graph now does, and compared against the rendered pixels inside the lens — inset by the blur
reach so the comparison never straddles the lens edge or the kernel's boundary fringe.

Reports mean/p99/max absolute channel error in 0-255. Inline (correct) scores ~1; a mismapped
backdrop scores tens.
"""
import math
import sys

import numpy as np
from PIL import Image


def srgb_to_linear(a):
    a = a / 255.0
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(a):
    a = np.clip(a, 0.0, 1.0)
    return np.where(a <= 0.0031308, a * 12.92, 1.055 * (a ** (1 / 2.4)) - 0.055) * 255.0


def gaussian_1d(sigma):
    r = max(1, int(math.ceil(3.0 * sigma)))
    x = np.arange(-r, r + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2.0 * sigma * sigma))
    return k / k.sum()


def blur_linear(img, sigma):
    """Separable Gaussian in linear light, edges clamped (same as a clamp-to-edge sampler)."""
    lin = srgb_to_linear(img.astype(np.float64))
    k = gaussian_1d(sigma)
    r = len(k) // 2
    pad = np.pad(lin, ((0, 0), (r, r), (0, 0)), mode="edge")
    out = np.zeros_like(lin)
    for i, w in enumerate(k):
        out += w * pad[:, i:i + lin.shape[1], :]
    pad = np.pad(out, ((r, r), (0, 0), (0, 0)), mode="edge")
    res = np.zeros_like(lin)
    for i, w in enumerate(k):
        res += w * pad[i:i + lin.shape[0], :, :]
    return linear_to_srgb(res)


def lens_rects(w, h, lenses):
    """Mirror bench.html's lens grid exactly."""
    lc = math.ceil(math.sqrt(lenses))
    cw, ch = w / lc, h / lc
    half = min(cw, ch) * 0.28
    out = []
    for s in range(lenses):
        gx = (s % lc + 0.5) * cw
        gy = (s // lc + 0.5) * ch
        out.append((gx - half, gy - half, gx + half, gy + half))
    return out


def main():
    a_path, b_path, w, h, lenses, radius = sys.argv[1:7]
    w, h, lenses, radius = int(w), int(h), int(lenses), float(radius)
    a = np.asarray(Image.open(a_path).convert("RGB")).astype(np.float64)
    b = np.asarray(Image.open(b_path).convert("RGB")).astype(np.float64)
    # The screenshots are viewport captures at some dpr; crop both to the canvas and rescale to 1:1.
    scale = a.shape[1] / w
    print(f"shot {a.shape[1]}x{a.shape[0]} for canvas {w}x{h} -> scale {scale:.3f}")
    assert a.shape == b.shape, f"{a.shape} != {b.shape}"

    # render-wasm's blur radius maps to sigma = radius/2 (the value the effects graph builds with).
    sigma = radius / 2.0 * scale
    ref = blur_linear(b, sigma)

    reach = 3.0 * sigma
    errs = []
    for (x0, y0, x1, y1) in lens_rects(w, h, lenses):
        # Inset by the reach so neither the lens silhouette edge nor the kernel fringe is sampled.
        ix0 = int(x0 * scale + reach) + 2
        iy0 = int(y0 * scale + reach) + 2
        ix1 = int(x1 * scale - reach) - 2
        iy1 = int(y1 * scale - reach) - 2
        if ix1 - ix0 < 4 or iy1 - iy0 < 4:
            continue
        d = np.abs(a[iy0:iy1, ix0:ix1] - ref[iy0:iy1, ix0:ix1])
        errs.append(d.ravel())
    if not errs:
        print("no lens interior survived the inset — raise the radius or the lens size")
        return
    d = np.concatenate(errs)
    print(f"lenses scored: {len(errs)}  samples: {d.size}")
    print(f"mean {d.mean():.2f}/255   p99 {np.percentile(d, 99):.2f}   max {d.max():.2f}")


main()
