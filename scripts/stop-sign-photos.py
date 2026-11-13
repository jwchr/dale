#!/usr/bin/env python3
"""Make the eight stop-sign photos for "See bus stop sign" (owner decision D69, 2026-11-13).

Input: the owner-approved seasonal scenes in src/assets/stop-scenes (kept byte-for-byte).
Output: src/assets/stop-signs/<scene>.webp, cropped to the sign (340 x 860 source pixels).

For each scene this script, in order:
  1. erases the printed route lines (164 / 707 / LIMITED SERVICE / 144) by copying the sign's own
     blank ruled rows over them, following the photo's perspective;
  2. erases the printed stop number (13583) on the mybus plate;
  3. removes overhead power lines from the sky (owner request);
  4. softens the background behind the sign, like a phone's portrait mode, so wires that cross
     trees are not visible either. The sign itself is never blurred or edited beyond steps 1-2.
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
CROP = (395, 85, 735, 945)  # x0, y0, x1, y1 in source pixels; matches SIGN_VIEW in src/domain/stopSign.ts
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


def sign_polygons(off):
    main = np.array([(437, 140), (452, 108), (684, 98), (688, 120), (688, 760), (438, 765)]) - off
    plate = np.array([(439, 752), (690, 752), (690, 936), (439, 936)]) - off
    return main, plate


def wire_pass(reg, off, kernel, sky_min, other_min, thr):
    h, w = reg.shape[:2]
    g = cv2.cvtColor(reg, cv2.COLOR_BGR2GRAY)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel, kernel))
    bh = cv2.morphologyEx(g, cv2.MORPH_BLACKHAT, k)  # thin dark lines
    main, plate = sign_polygons(off)
    face = np.zeros((h, w), np.uint8)
    cv2.fillPoly(face, [main], 255); cv2.fillPoly(face, [plate], 255)
    cv2.rectangle(face, (543 - off[0], 930 - off[1]), (606 - off[0], h), 255, -1)
    core = cv2.erode(face, np.ones((5, 5), np.uint8))
    face = cv2.dilate(face, np.ones((3, 3), np.uint8))
    # Sky: background (wires closed away) that is blue, or bright and gray, connected to the top edge.
    bg = cv2.morphologyEx(reg, cv2.MORPH_CLOSE, k).astype(int)
    hsv = cv2.cvtColor(bg.astype(np.uint8), cv2.COLOR_BGR2HSV).astype(int)
    sky = (bg[..., 0] - bg[..., 2] > 25) | ((hsv[..., 2] > 110) & (hsv[..., 1] < 45))
    _, lab = cv2.connectedComponents(sky.astype(np.uint8), connectivity=4)
    sky = np.isin(lab, np.unique(lab[0][sky[0]])) & sky
    thin = ((bh > thr) & (face == 0)).astype(np.uint8) * 255
    # Wires are long, mostly horizontal straight runs; extend each a little to catch the ends.
    band = np.zeros((h, w), np.uint8)
    for part, minlen, width in [(sky, sky_min, 9)] + ([(~sky, other_min, 7)] if other_min else []):
        t = thin.copy(); t[~part] = 0
        segs = cv2.HoughLinesP(t, 1, np.pi / 720, threshold=50, minLineLength=minlen, maxLineGap=20)
        if segs is None:
            continue
        for x1, y1, x2, y2 in segs.reshape(-1, 4):
            if abs(y2 - y1) > abs(x2 - x1) * 0.9:
                continue
            length = max(1.0, float(np.hypot(x2 - x1, y2 - y1)))
            ux, uy = (x2 - x1) / length, (y2 - y1) / length
            cv2.line(band, (int(x1 - ux * 30), int(y1 - uy * 30)), (int(x2 + ux * 30), int(y2 + uy * 30)), 255, width)
    mask = cv2.bitwise_and(cv2.dilate(thin, np.ones((3, 3), np.uint8)), band)
    mask = cv2.bitwise_and(mask, ((bh > thr + 10) | sky).astype(np.uint8) * 255)
    # Outside the sky keep only thin, wire-shaped pieces (no roof edges or leafy blobs).
    skym = cv2.dilate(sky.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    mask_sky = np.where(skym, mask, 0).astype(np.uint8)
    other = np.where(skym, 0, mask).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(other, connectivity=8)
    keep = np.zeros(n, bool)
    for i in range(1, n):
        x, y, bw, bhh, area = stats[i]
        keep[i] = area / max(1.0, float(np.hypot(bw, bhh))) <= 7.5 and (y + off[1]) < 800
    mask = np.where(keep[lab], 255, 0).astype(np.uint8) | mask_sky
    mask[max(0, 720 - off[1]):, :] = 0  # below the tree line: houses and branches only
    mask = cv2.dilate(mask, np.ones((5, 5), np.uint8))
    mask[core > 0] = 0
    # Inpaint with the sign filled in too, so wire ends next to it draw from sky, not the white sign.
    work = cv2.inpaint(reg, cv2.bitwise_or(mask, cv2.dilate(face, np.ones((3, 3), np.uint8))), 5, cv2.INPAINT_TELEA)
    res = reg.copy(); res[mask > 0] = work[mask > 0]
    return res


def remove_wires(im):
    x0, y0, x1, y1 = 330, 30, 811, 1010
    off = np.array([x0, y0])
    reg = im[y0:y1, x0:x1].copy()
    for kernel, sky_min, other_min, thr in [(17, 60, 140, 16), (31, 60, 0, 14), (17, 45, 0, 12)]:
        reg = wire_pass(reg, off, kernel, sky_min, other_min, thr)
    out = im.copy(); out[y0:y1, x0:x1] = reg
    return out


def sign_mask(ref):
    """Exact outline of both sign plates and the pole, fitted on the clear autumn scene."""
    H, W = ref.shape[:2]
    hsv = cv2.cvtColor(ref, cv2.COLOR_BGR2HSV).astype(int)
    white = (hsv[..., 2] > 105) & (hsv[..., 1] < 70) & (ref[..., 0].astype(int) - ref[..., 2].astype(int) < 40)

    def fit(xs, ys):
        a, c = np.polyfit(xs, ys, 1)
        for _ in range(5):
            res = np.abs(ys - (a * xs + c)); k = res < max(1.5, np.percentile(res, 70))
            a, c = np.polyfit(xs[k], ys[k], 1)
        return a, c

    def side_edges(y0, y1):
        ys, ls, rs = [], [], []
        for y in range(y0, y1):
            run = np.convolve(white[y, 425:705].astype(int), np.ones(4, int), 'valid') >= 4
            idx = np.where(run)[0]
            if len(idx) >= 40:
                ys.append(y); ls.append(425 + idx.min()); rs.append(425 + idx.max() + 3)
        ys = np.array(ys, float)
        return fit(ys, np.array(ls, float)), fit(ys, np.array(rs, float))

    def cap(x0, x1, y0, y1, top):
        xs, ys = [], []
        for x in range(x0, x1):
            col = np.where(white[y0:y1, x])[0]
            if len(col):
                xs.append(x); ys.append(y0 + (col.min() if top else col.max() + 1))
        return fit(np.array(xs, float), np.array(ys, float))

    def plate(yr, top, bottom, radius):
        (la, lc), (ra, rc) = side_edges(*yr)
        ta, tc = cap(*top, True); ba, bc = cap(*bottom, False)

        def corner(ea, ec, ha, hc):  # x = ea*y + ec meets y = ha*x + hc
            y = (ha * ec + hc) / (1 - ha * ea)
            return ea * y + ec, y
        poly = np.round([corner(la, lc, ta, tc), corner(ra, rc, ta, tc), corner(ra, rc, ba, bc), corner(la, lc, ba, bc)]).astype(np.int32)
        m = np.zeros((H, W), np.uint8); cv2.fillPoly(m, [poly], 255)
        return cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius, 2 * radius)))

    face = plate((300, 720), (470, 660, 80, 200), (470, 660, 700, 790), 26) | plate((840, 900), (470, 540, 730, 800), (470, 540, 900, 960), 20)
    cv2.rectangle(face, (546, 925), (603, H), 255, -1)
    return face


def soften_background(im, face, sigma=11.0):
    H, W = im.shape[:2]
    wide = cv2.dilate(face, np.ones((9, 9), np.uint8))
    # Fill the sign with its surroundings before blurring so it does not glow into the background.
    fill = cv2.inpaint(cv2.resize(im, (W // 4, H // 4)), cv2.resize(wide, (W // 4, H // 4)), 5, cv2.INPAINT_TELEA)
    base = np.where(wide[..., None] > 0, cv2.resize(fill, (W, H)), im)
    blur = cv2.GaussianBlur(base, (0, 0), sigma)
    alpha = cv2.GaussianBlur(face.astype(np.float32) / 255, (0, 0), 1.2)[..., None]
    return (im * alpha + blur * (1 - alpha)).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    face = sign_mask(cv2.imread(f'{SRC}/autumn-clear.webp'))
    x0, y0, x1, y1 = CROP
    for scene in SCENES:
        im = cv2.imread(f'{SRC}/{scene}.webp')
        im = soften_background(remove_wires(erase_routes_and_number(im)), face)
        ok, data = cv2.imencode('.webp', im[y0:y1, x0:x1], [cv2.IMWRITE_WEBP_QUALITY, 86])
        assert ok
        with open(f'{OUT}/{scene}.webp', 'wb') as f:
            f.write(data.tobytes())
        print(scene, len(data), 'bytes')


if __name__ == '__main__':
    main()
