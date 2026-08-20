"""Compose a labelled effect review sheet from a rendered parity frame.

The tiled scheduler is no longer ahead of the whole-viewport one, so a cross-implementation diff
measures tiled's staleness rather than our correctness. Effects have to be judged by eye instead —
this lays the effect-bearing cells out large, labelled, so an artifact is visible without hunting.

Usage: python3 tools/effect_sheet.py <frame.png> <zoom> <out.png>
"""
import sys
from PIL import Image, ImageDraw, ImageFont

COLS, CELL, MARGIN = 6, 190.0, 26.0

# The cells worth eyeballing: everything with an effect on it, plus the two shape-gap cases.
CELLS = [
    (18, "drop shadow"), (19, "inner shadow"), (20, "layer blur"), (21, "filter graph [dead]"),
    (22, "backdrop blur"), (23, "glass"), (31, "scoped bg-blur"), (32, "scoped glass"),
    (33, "glass on path [bbox]"), (34, "bg-blur on path"), (35, "text + bg-blur"), (36, "vector + shadow"),
]
PER_ROW, LABEL_H, PAD = 4, 26, 10


def main(src_path: str, zoom: float, out_path: str) -> None:
    src = Image.open(src_path).convert("RGBA")
    size = int(CELL * zoom)
    rows = (len(CELLS) + PER_ROW - 1) // PER_ROW
    sheet = Image.new("RGBA", (PER_ROW * (size + PAD) + PAD,
                               rows * (size + LABEL_H + PAD) + PAD), (250, 250, 250, 255))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/SFNSMono.ttf", 15)
    except OSError:
        font = ImageFont.load_default()

    for i, (cell, label) in enumerate(CELLS):
        row, col = cell // COLS, cell % COLS
        x0 = int((MARGIN + col * CELL) * zoom)
        y0 = int((MARGIN + row * CELL) * zoom)
        tile = src.crop((x0, y0, x0 + size, y0 + size))
        px = PAD + (i % PER_ROW) * (size + PAD)
        py = PAD + (i // PER_ROW) * (size + LABEL_H + PAD)
        sheet.paste(tile, (px, py))
        draw.rectangle([px, py, px + size - 1, py + size - 1], outline=(200, 200, 200, 255))
        draw.text((px + 2, py + size + 5), label, fill=(40, 40, 40, 255), font=font)
    sheet.convert("RGB").save(out_path)
    print(f"wrote {out_path} ({sheet.width}x{sheet.height}), {len(CELLS)} effects at {zoom}x")


if __name__ == "__main__":
    main(sys.argv[1], float(sys.argv[2]), sys.argv[3])
