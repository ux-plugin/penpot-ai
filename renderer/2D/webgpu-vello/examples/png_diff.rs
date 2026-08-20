//! Pixel-difference heat map between two PNGs — where two renders disagree, not just how much.
//!
//! Writes a false-colour map (black = identical, blue → green → yellow → red as the maximum channel
//! delta grows) and prints the differing pixels' bounding box plus a coarse grid histogram, which is
//! what actually localises an artifact: a seam reads as one row or column of cells, a wrong surface
//! as one dense block.
//!
//! Run: `cargo run --release --example png_diff -- a.png b.png out.png`.

use std::fs::File;
use std::io::{BufReader, BufWriter};

fn load(path: &str) -> (Vec<u8>, u32, u32) {
    let decoder = png::Decoder::new(BufReader::new(File::open(path).unwrap_or_else(|e| panic!("open {path}: {e}"))));
    let mut reader = decoder.read_info().expect("png info");
    let mut buf = vec![0; reader.output_buffer_size().expect("buffer size")];
    let info = reader.next_frame(&mut buf).expect("png frame");
    let px = (info.width * info.height) as usize;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..px * 4].to_vec(),
        png::ColorType::Rgb => {
            let mut v = Vec::with_capacity(px * 4);
            for c in buf[..px * 3].chunks_exact(3) {
                v.extend_from_slice(&[c[0], c[1], c[2], 255]);
            }
            v
        }
        other => panic!("unsupported colour type {other:?}"),
    };
    (rgba, info.width, info.height)
}

/// Black → blue → cyan → green → yellow → red as `d` goes 0 → 255, so a one-step difference is still
/// visible against the background but reads clearly apart from a saturated one.
fn heat(d: u8) -> [u8; 3] {
    let t = f32::from(d) / 255.0;
    let (r, g, b) = if t < 0.25 {
        (0.0, t * 4.0 * 0.6, 0.4 + t * 4.0 * 0.6)
    } else if t < 0.5 {
        (0.0, 0.6 + (t - 0.25) * 4.0 * 0.4, 1.0 - (t - 0.25) * 4.0)
    } else if t < 0.75 {
        ((t - 0.5) * 4.0, 1.0, 0.0)
    } else {
        (1.0, 1.0 - (t - 0.75) * 4.0, 0.0)
    };
    [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let (a_path, b_path) = (args.get(1).expect("usage: png_diff A B [OUT]"), args.get(2).expect("need B"));
    let out_path = args.get(3).map_or("diff.png", |s| s.as_str());

    let (a, w, h) = load(a_path);
    let (b, bw, bh) = load(b_path);
    assert!(w == bw && h == bh, "size mismatch: {w}x{h} vs {bw}x{bh}");

    let mut out = vec![0u8; (w * h * 3) as usize];
    let mut differing = 0u32;
    let mut max_delta = 0u8;
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    const GRID: u32 = 8;
    let mut grid = vec![0u32; (GRID * GRID) as usize];

    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            let d = (0..4).map(|c| a[i + c].abs_diff(b[i + c])).max().unwrap_or(0);
            let o = ((y * w + x) * 3) as usize;
            out[o..o + 3].copy_from_slice(&heat(d));
            if d > 0 {
                differing += 1;
                max_delta = max_delta.max(d);
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
                grid[((y * GRID / h) * GRID + (x * GRID / w)) as usize] += 1;
            }
        }
    }

    let total = w * h;
    println!("{a_path}\n  vs {b_path}");
    println!("{differing}/{total} px differ ({:.4}%), max channel delta {max_delta}", 100.0 * f64::from(differing) / f64::from(total));
    if differing > 0 {
        println!("bounding box: x {x0}..={x1}  y {y0}..={y1}  ({}x{})", x1 - x0 + 1, y1 - y0 + 1);
        println!("grid ({GRID}x{GRID} blocks, differing px per block):");
        for gy in 0..GRID {
            let row: Vec<String> = (0..GRID)
                .map(|gx| {
                    let n = grid[(gy * GRID + gx) as usize];
                    if n == 0 { "     .".to_string() } else { format!("{n:6}") }
                })
                .collect();
            println!("  {}", row.join(""));
        }
    }

    write_rgb(out_path, &out, w, h);
    println!("wrote {out_path}");

    // A stark white-on-black mask beside the heat map: any non-zero difference reads at full
    // brightness, so a one-step delta is as visible as a saturated one. Scaled up `ZOOM`× with
    // nearest sampling, because a two-pixel seam in a 1192×242 proof is invisible at 1:1.
    const ZOOM: u32 = 3;
    let (zw, zh) = (w * ZOOM, h * ZOOM);
    let mut mask = vec![0u8; (zw * zh * 3) as usize];
    for y in 0..zh {
        for x in 0..zw {
            let i = (((y / ZOOM) * w + (x / ZOOM)) * 4) as usize;
            let d = (0..4).map(|c| a[i + c].abs_diff(b[i + c])).max().unwrap_or(0);
            let v = if d > 0 { 255 } else { 0 };
            let o = ((y * zw + x) * 3) as usize;
            mask[o..o + 3].copy_from_slice(&[v, v, v]);
        }
    }
    let mask_path = out_path.replace(".png", "-mask.png");
    write_rgb(&mask_path, &mask, zw, zh);
    println!("wrote {mask_path} ({ZOOM}x)");
}

fn write_rgb(path: &str, data: &[u8], w: u32, h: u32) {
    let file = File::create(path).unwrap_or_else(|e| panic!("create {path}: {e}"));
    let mut encoder = png::Encoder::new(BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().expect("header").write_image_data(data).expect("write");
}
