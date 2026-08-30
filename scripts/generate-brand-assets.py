#!/usr/bin/env python
"""Generate local Hermes Browser brand assets with Python stdlib only."""
from __future__ import annotations

import math
import random
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "extension" / "assets"
ICONS = ASSETS / "icons"
IMG = ASSETS / "img"

BLUE = "#0000f2"
WHITE = "#f5f5f5"
ACCENT = "#edff45"


def png_chunks(data: bytes):
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    i = 8
    while i < len(data):
        length = struct.unpack(">I", data[i:i+4])[0]
        ctype = data[i+4:i+8]
        payload = data[i+8:i+8+length]
        yield ctype, payload
        i += 12 + length


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def read_rgba_png(path: Path):
    width = height = None
    bit_depth = color_type = None
    compressed = bytearray()
    for ctype, payload in png_chunks(path.read_bytes()):
        if ctype == b"IHDR":
            width, height, bit_depth, color_type, _compression, _filter, interlace = struct.unpack(">IIBBBBB", payload)
            if bit_depth != 8 or color_type != 6 or interlace != 0:
                raise ValueError(f"expected 8-bit non-interlaced RGBA PNG, got bit={bit_depth} color={color_type} interlace={interlace}")
        elif ctype == b"IDAT":
            compressed.extend(payload)
    if width is None or height is None:
        raise ValueError("missing IHDR")

    raw = zlib.decompress(bytes(compressed))
    bpp = 4
    stride = width * bpp
    rows = []
    prev = bytearray(stride)
    offset = 0
    for _y in range(height):
        ftype = raw[offset]
        offset += 1
        scan = bytearray(raw[offset:offset+stride])
        offset += stride
        out = bytearray(stride)
        for x in range(stride):
            left = out[x - bpp] if x >= bpp else 0
            up = prev[x]
            upper_left = prev[x - bpp] if x >= bpp else 0
            val = scan[x]
            if ftype == 0:
                out[x] = val
            elif ftype == 1:
                out[x] = (val + left) & 255
            elif ftype == 2:
                out[x] = (val + up) & 255
            elif ftype == 3:
                out[x] = (val + ((left + up) // 2)) & 255
            elif ftype == 4:
                out[x] = (val + paeth(left, up, upper_left)) & 255
            else:
                raise ValueError(f"unsupported PNG filter {ftype}")
        rows.append(out)
        prev = out
    return width, height, rows


def write_rgba_png(path: Path, width: int, height: int, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw.extend(row)
    compressed = zlib.compress(bytes(raw), level=9)

    def chunk(ctype: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + ctype + payload + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b""))


def resize_nearest(rows, src_w: int, src_h: int, dst: int):
    out = []
    for y in range(dst):
        sy = min(src_h - 1, int(y * src_h / dst))
        row = bytearray(dst * 4)
        for x in range(dst):
            sx = min(src_w - 1, int(x * src_w / dst))
            row[x*4:x*4+4] = rows[sy][sx*4:sx*4+4]
        out.append(row)
    return out


def generate_png_icons():
    source = ICONS / "icon-source.png"
    if not source.exists():
        return
    w, h, rows = read_rgba_png(source)
    for size in (16, 32, 48, 128):
        resized = resize_nearest(rows, w, h, size)
        write_rgba_png(ICONS / f"icon-{size}.png", size, size, resized)


def generate_ray_field():
    random.seed(42)
    width, height = 720, 360
    cx, cy = 500, 150
    lines = []
    for i in range(54):
        angle = math.radians(198 + i * 2.9)
        r1 = 34 + (i % 5) * 2
        r2 = 260 + (i % 9) * 11
        x1 = cx + math.cos(angle) * r1
        y1 = cy + math.sin(angle) * r1
        x2 = cx + math.cos(angle) * r2
        y2 = cy + math.sin(angle) * r2
        opacity = 0.22 + (i % 7) * 0.045
        lines.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{WHITE}" stroke-width="1.4" opacity="{opacity:.2f}"/>')
    dots = []
    for _ in range(180):
        x = random.randrange(0, width)
        y = random.randrange(0, height)
        opacity = random.uniform(0.08, 0.32)
        dots.append(f'<circle cx="{x}" cy="{y}" r="0.8" fill="{WHITE}" opacity="{opacity:.2f}"/>')
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-label="Hermes radial browser field">
  <rect width="{width}" height="{height}" fill="{BLUE}"/>
  <g opacity="0.96">{''.join(lines)}</g>
  <g>{''.join(dots)}</g>
  <circle cx="{cx}" cy="{cy}" r="26" fill="none" stroke="{WHITE}" stroke-width="1.2" opacity="0.42"/>
  <circle cx="{cx}" cy="{cy}" r="54" fill="none" stroke="{WHITE}" stroke-width="0.9" opacity="0.20"/>
  <path d="M82 300 C170 246 259 268 326 213 C381 168 422 157 500 150" fill="none" stroke="{WHITE}" stroke-width="1.2" opacity="0.24"/>
  <text x="36" y="64" fill="{WHITE}" opacity="0.16" font-size="68" font-family="Georgia,serif" letter-spacing="4">HERMES</text>
</svg>'''
    (IMG / "ray-field.svg").write_text(svg, encoding="utf-8")


def generate_mark_svg():
    rays = []
    cx, cy = 128, 128
    for i in range(40):
        a = math.radians(i * 9)
        rays.append(f'<line x1="{cx + math.cos(a)*34:.1f}" y1="{cy + math.sin(a)*34:.1f}" x2="{cx + math.cos(a)*108:.1f}" y2="{cy + math.sin(a)*108:.1f}"/>')
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="Hermes Browser mark">
  <rect width="256" height="256" fill="{BLUE}"/>
  <g stroke="{WHITE}" stroke-width="2" opacity="0.62">{''.join(rays)}</g>
  <rect x="36" y="36" width="184" height="184" fill="none" stroke="{WHITE}" stroke-width="4"/>
  <text x="128" y="148" fill="{WHITE}" text-anchor="middle" font-size="104" font-family="Georgia,serif" font-weight="400">H</text>
  <text x="128" y="184" fill="{WHITE}" text-anchor="middle" font-size="20" font-family="Courier New,monospace" letter-spacing="4">BROWSER</text>
</svg>'''
    (IMG / "hermes-browser-mark.svg").write_text(svg, encoding="utf-8")


def main():
    ICONS.mkdir(parents=True, exist_ok=True)
    IMG.mkdir(parents=True, exist_ok=True)
    generate_png_icons()
    generate_ray_field()
    generate_mark_svg()
    print("Generated Hermes Browser assets")


if __name__ == "__main__":
    main()
