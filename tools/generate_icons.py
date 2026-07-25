#!/usr/bin/env python3
"""Generate the dependency-free PWA icon set from fixed 火風鼎 geometry."""

from __future__ import annotations

import argparse
import binascii
import struct
import zlib
from pathlib import Path

DESIGN_SIZE = 512
BACKGROUND = (23, 42, 74, 255)
WHITE = (248, 246, 239, 255)
GOLD = (232, 196, 105, 255)

# Display order is top-to-bottom: 上陽、五陰（金）、四陽、三陽、二陽、初陰。
LINES = (
    ("yang", 121, WHITE),
    ("yin", 175, GOLD),
    ("yang", 229, WHITE),
    ("yang", 283, WHITE),
    ("yang", 337, WHITE),
    ("yin", 391, WHITE),
)
LINE_LEFT = 120
LINE_RIGHT = 392
YIN_LEFT_END = 232
YIN_RIGHT_START = 280
LINE_HEIGHT = 22

OUTPUTS = {
    "icon-192.png": 192,
    "icon-512.png": 512,
    "icon-maskable-192.png": 192,
    "icon-maskable-512.png": 512,
    "apple-touch-icon.png": 180,
}


def _inside_capsule(x: float, y: float, left: int, right: int, center: int) -> bool:
    radius = LINE_HEIGHT / 2
    if left + radius <= x <= right - radius and abs(y - center) <= radius:
        return True
    left_distance = (x - (left + radius)) ** 2 + (y - center) ** 2
    right_distance = (x - (right - radius)) ** 2 + (y - center) ** 2
    return left_distance <= radius**2 or right_distance <= radius**2


def _pixel_color(x: float, y: float) -> tuple[int, int, int, int]:
    for kind, center, color in LINES:
        segments = (
            ((LINE_LEFT, LINE_RIGHT),)
            if kind == "yang"
            else ((LINE_LEFT, YIN_LEFT_END), (YIN_RIGHT_START, LINE_RIGHT))
        )
        if any(_inside_capsule(x, y, left, right, center) for left, right in segments):
            return color
    return BACKGROUND


def make_png(size: int) -> bytes:
    rows = []
    for pixel_y in range(size):
        y = (pixel_y + 0.5) * DESIGN_SIZE / size
        row = bytearray([0])
        for pixel_x in range(size):
            x = (pixel_x + 0.5) * DESIGN_SIZE / size
            row.extend(_pixel_color(x, y))
        rows.append(bytes(row))

    def chunk(kind: bytes, data: bytes) -> bytes:
        payload = kind + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", binascii.crc32(payload))

    return b"".join(
        (
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)),
            chunk(b"IDAT", zlib.compress(b"".join(rows), level=9)),
            chunk(b"IEND", b""),
        )
    )


def make_svg() -> str:
    shapes = []
    for kind, center, color in LINES:
        fill = "#e8c469" if color == GOLD else "#f8f6ef"
        y = center - LINE_HEIGHT / 2
        segments = (
            ((LINE_LEFT, LINE_RIGHT),)
            if kind == "yang"
            else ((LINE_LEFT, YIN_LEFT_END), (YIN_RIGHT_START, LINE_RIGHT))
        )
        for left, right in segments:
            shapes.append(
                f'  <rect x="{left}" y="{y:g}" width="{right - left}" '
                f'height="{LINE_HEIGHT}" rx="{LINE_HEIGHT / 2:g}" fill="{fill}"/>'
            )
    return "\n".join(
        (
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">',
            '  <rect width="512" height="512" fill="#172a4a"/>',
            *shapes,
            "</svg>",
            "",
        )
    )


def expected_files() -> dict[str, bytes]:
    files = {name: make_png(size) for name, size in OUTPUTS.items()}
    files["app-icon.svg"] = make_svg().encode("utf-8")
    return files


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if checked-in icons differ from deterministic output",
    )
    args = parser.parse_args()
    icon_directory = Path(__file__).resolve().parents[1] / "icons"
    files = expected_files()

    if args.check:
        mismatches = [
            name
            for name, expected in files.items()
            if not (icon_directory / name).is_file()
            or (icon_directory / name).read_bytes() != expected
        ]
        if mismatches:
            parser.error(f"icon output is missing or stale: {', '.join(mismatches)}")
        print(f"icon outputs are current: {len(files)} files")
        return 0

    icon_directory.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        (icon_directory / name).write_bytes(content)
    print(f"generated {len(files)} icon files in {icon_directory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
