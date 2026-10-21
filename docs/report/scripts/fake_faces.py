"""
Draws simple illustrated faces (flat shapes — not a photo of any real person) and writes
each as a short Y4M video for Chromium's fake camera (--use-file-for-fake-video-capture).
The report's screenshot script gives each guest a different face, so the live photo at the
gate matches that guest's profile photo, as it would in real use.

The head moves a few pixels from frame to frame, like a person in front of a camera. That
matters: two photos taken a second apart must not be byte-identical, or the API refuses
the second as a re-used photo (PHOTO_REUSED, SDD §9.4).

Usage:  python docs/report/scripts/fake_faces.py <out_dir>
Writes face-a.y4m, face-b.y4m, face-c.y4m (+ .png previews) into <out_dir>.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

W, H = 400, 300  # video size; frames are drawn at 640 x 480 and scaled down
FRAMES = 80  # 8 s at 10 fps: photos a few seconds apart never land on the same frame

FACES = {
    # background, shirt, skin, hair, hair style
    "a": ((214, 232, 240), (46, 110, 140), (224, 172, 128), (40, 28, 22), "long"),
    "b": ((236, 226, 214), (150, 60, 80), (196, 140, 100), (25, 20, 18), "bun"),
    "c": ((222, 236, 220), (70, 120, 70), (236, 190, 150), (90, 55, 30), "bob"),
}


def draw(bg, shirt, skin, hair, style, shift: int = 0, index: int = 0) -> Image.Image:
    im = Image.new("RGB", (640, 480), bg)
    d = ImageDraw.Draw(im)
    cx = 320 + shift
    # shoulders and neck
    d.ellipse((cx - 210, 380, cx + 210, 640), fill=shirt)
    d.rectangle((cx - 38, 300, cx + 38, 400), fill=skin)
    # A 7-dot code of the frame number on the shirt, inside the centred square the app
    # keeps: no two frames are equal, even after cropping, resizing and JPEG.
    dots = tuple(max(0, c - 45) for c in shirt)
    for bit in range(7):
        if index >> bit & 1:
            d.ellipse((cx - 42 + bit * 12, 430, cx - 34 + bit * 12, 438), fill=dots)
    # hair behind the head
    if style == "long":
        d.rounded_rectangle((cx - 125, 90, cx + 125, 390), radius=110, fill=hair)
    elif style == "bob":
        d.rounded_rectangle((cx - 122, 90, cx + 122, 320), radius=100, fill=hair)
    else:  # bun
        d.ellipse((cx - 55, 40, cx + 55, 130), fill=hair)
    # head, hair on top, ears
    d.ellipse((cx - 100, 110, cx + 100, 350), fill=skin)
    d.chord((cx - 108, 96, cx + 108, 300), start=180, end=360, fill=hair)
    d.ellipse((cx - 115, 215, cx - 90, 265), fill=skin)
    d.ellipse((cx + 90, 215, cx + 115, 265), fill=skin)
    # eyes and eyebrows
    for dx in (-42, 42):
        d.ellipse((cx + dx - 18, 220, cx + dx + 18, 244), fill=(255, 255, 255))
        d.ellipse((cx + dx - 8, 224, cx + dx + 8, 240), fill=(50, 35, 30))
        d.line((cx + dx - 20, 206, cx + dx + 20, 202), fill=hair, width=6)
    # nose, mouth, cheeks
    d.line((cx, 245, cx - 8, 280, cx + 4, 282), fill=(170, 110, 80), width=3)
    d.arc((cx - 34, 280, cx + 34, 318), start=20, end=160, fill=(150, 60, 60), width=5)
    for dx in (-60, 60):
        d.ellipse((cx + dx - 16, 272, cx + dx + 16, 290), fill=tuple(min(255, c + 12) for c in skin))
    return im.resize((W, H), Image.LANCZOS)


def write_y4m(frames: list[Image.Image], path: Path) -> None:
    with path.open("wb") as f:
        f.write(f"YUV4MPEG2 W{W} H{H} F10:1 Ip A1:1 C420jpeg\n".encode())
        for im in frames:
            y, cb, cr = im.convert("YCbCr").split()
            cb = cb.resize((W // 2, H // 2), Image.BILINEAR)
            cr = cr.resize((W // 2, H // 2), Image.BILINEAR)
            f.write(b"FRAME\n" + y.tobytes() + cb.tobytes() + cr.tobytes())


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    for name, spec in FACES.items():
        frames = [
            draw(*spec, shift=(i % 20) - 10, index=i) for i in range(FRAMES)
        ]
        frames[0].save(out / f"face-{name}.png")
        write_y4m(frames, out / f"face-{name}.y4m")
    print(f"faces written to {out}")


if __name__ == "__main__":
    main()
