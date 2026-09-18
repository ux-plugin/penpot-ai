"""Detect tile-composite seams objectively.

Tile seams are periodic at exactly TILE_SIZE (512) device px; board borders and shape
edges are not. So: score every column by how much it differs from its left neighbour
(averaged down the column), take the strongest columns, and report their spacings.
A spacing histogram peaking at 512 (or the screenshot's scaled equivalent) is a seam;
scattered spacings are ordinary content.
"""
import sys, zlib, struct
from collections import Counter


def read_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    pos, idat, pal = 8, b'', None
    w = h = bd = ct = None
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        data = d[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bd, ct, _, _, interlace = struct.unpack('>IIBBBBB', data)
            assert interlace == 0, 'interlaced png unsupported'
        elif typ == b'PLTE':
            pal = data
        elif typ == b'IDAT':
            idat += data
        elif typ == b'IEND':
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    assert bd == 8, f'bit depth {bd} unsupported'
    stride = w * ch
    out = bytearray(h * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                c = prev[i - ch] if i >= ch else 0
                b = prev[i]
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, out


def main(path, x0, x1, y0, y1):
    w, h, ch, px = read_png(path)
    x1 = min(x1, w - 1); y1 = min(y1, h - 1)
    print(f'image {w}x{h} ch={ch}; analyzing x[{x0},{x1}] y[{y0},{y1}]')

    def lum(x, y):
        i = (y * w + x) * ch
        return (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) // 1000

    rows = range(y0, y1, 2)
    scores = []
    for x in range(x0 + 1, x1):
        s = sum(abs(lum(x, y) - lum(x - 1, y)) for y in rows)
        scores.append((s / len(list(rows)), x))
    scores.sort(reverse=True)
    top = sorted(x for _, x in scores[:40])
    print('top-40 gradient columns:', top)
    # merge adjacent columns into single edges
    edges, cur = [], [top[0]]
    for x in top[1:]:
        if x - cur[-1] <= 3:
            cur.append(x)
        else:
            edges.append(sum(cur) // len(cur)); cur = [x]
    edges.append(sum(cur) // len(cur))
    print('merged edges:', edges)
    gaps = [b - a for a, b in zip(edges, edges[1:])]
    print('spacings:', gaps)
    print('spacing histogram:', Counter(gaps).most_common(8))


if __name__ == '__main__':
    a = sys.argv
    main(a[1], int(a[2]), int(a[3]), int(a[4]), int(a[5]))
