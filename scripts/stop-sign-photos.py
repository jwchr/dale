#!/usr/bin/env python3
"""Make the eight stop-sign photos for "See bus stop sign" (owner decision D69, 2026-11-13).

Input: the owner-approved seasonal scenes in src/assets/stop-scenes (kept byte-for-byte).
Output: src/assets/stop-signs/<scene>.webp, cropped around the sign (530 x 1030 source pixels).

For each scene this script, in order:
  1. erases the printed route lines (164 / 707 / LIMITED SERVICE / 144) by copying the sign's own
     blank ruled rows over them, following the photo's perspective;
  2. erases the printed stop number (13583) on the mybus plate;
and crops around the sign. Nothing else in the photo is changed: the owner chose his sharp, real
picture over a softened background (2026-11-13), and power lines could not be removed cleanly
without blurring, so they stay as photographed.
The NJ Transit sign artwork, logos included, stays as photographed so riders can recognize the
real sign (owner decision D69). Dale writes the rider's real routes and stop number on top at
run time (src/ui/StopSign.tsx); nothing here invents stop data.

Developer tool only, not part of the app build or tests. Needs Python 3 with
numpy and opencv-python-headless. Run from the repository root:
  python3 scripts/stop-sign-photos.py
"""
import os
import cv2
import numpy as np

SCENES = ['spring-clear', 'spring-rain', 'summer-clear', 'summer-storm',
          'autumn-clear', 'autumn-mist', 'winter-clear', 'winter-snow']
SRC, OUT = 'src/assets/stop-scenes', 'src/assets/stop-signs'
CROP = (300, 50, 830, 1080)  # x0, y0, x1, y1 in source pixels; matches SIGN_VIEW in src/domain/stopSign.ts
# The sign sits at the same place in all eight scenes (measured within 1 px).
XL, XR = 450.0, 677.0


def line_y(k, x):
    """Top of ruled line k (0..7) at column x."""
    yl, yr = 597.5 + 20.83 * k, 577.6 + 22.01 * k
    return yl + (yr - yl) * (x - XL) / (XR - XL)


def row_h(x):
    return 20.83 + 1.18 * (x - XL) / (XR - XL)


def erase_routes_and_number(im):
    src = im.astype(np.float32)
    out = src.copy()
    # Rows 0-2 get blank rows 4-6; row 3 gets blank row 6. Per-column shift follows the perspective.
    for x in range(444, 684):
        for k, n in [(0, 4), (1, 4), (2, 4), (3, 3)]:
            y0, y1 = line_y(k, x) - 2.5, line_y(k + 1, x) - 2.5
            shift = n * row_h(x)
            for y in range(int(np.ceil(y0)), int(np.ceil(y1))):
                sy = y + shift
                a = int(np.floor(sy)); f = sy - a
                out[y, x] = src[a, x] * (1 - f) + src[a + 1, x] * f
    out = np.clip(out, 0, 255).astype(np.uint8)
    mask = np.zeros(out.shape[:2], np.uint8)
    mask[823:849, 597:673] = 255  # printed stop number on the white mybus plate
    return cv2.inpaint(out, mask, 6, cv2.INPAINT_TELEA)


def main():
    os.makedirs(OUT, exist_ok=True)
    x0, y0, x1, y1 = CROP
    for scene in SCENES:
        im = cv2.imread(f'{SRC}/{scene}.webp')
        im = erase_routes_and_number(im)
        ok, data = cv2.imencode('.webp', im[y0:y1, x0:x1], [cv2.IMWRITE_WEBP_QUALITY, 86])
        assert ok
        with open(f'{OUT}/{scene}.webp', 'wb') as f:
            f.write(data.tobytes())
        print(scene, len(data), 'bytes')


if __name__ == '__main__':
    main()
