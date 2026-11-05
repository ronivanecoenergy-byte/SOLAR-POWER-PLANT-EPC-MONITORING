#!/usr/bin/env python3
"""Register an orthomosaic against the CAD tables, measure per-table evidence, and build map tiles.

Usage: python3 -I pipeline/drone.py <drone.png> <capture-date YYYY-MM-DD> [--tiles]

Steps
 1. Coarse search (scale + offset) of the CAD table mask against a detected-module mask at 1/8 scale.
 2. ECC affine refinement at 1/4 and 1/2 scale.  The CAD geometry is never modified; only the image
    is positioned.  The result is reported as scale / rotation / shear so a bad fit is obvious.
 3. Per-table evidence: share of module-coloured pixels inside each table (inner 70 %).
 4. Tiles: the image is resampled once into CAD space (north-up, metres) as 512 px WebP tiles.
"""
import json, os, sys, math, time
import numpy as np, cv2
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'data', 'build')
src_path, capture_date = sys.argv[1], sys.argv[2]
make_tiles = '--tiles' in sys.argv
reg = json.load(open(os.path.join(BUILD, 'registry.json')))
R = np.array([[t['x0'], t['y0'], t['x1'], t['y1']] for t in reg])
t0 = time.time()

full = Image.open(src_path); full.load()
W, H = full.size
pyr = {1: full}
for f in (2, 4, 8):
    pyr[f] = pyr[f // 2].reduce(2) if f > 2 else full.reduce(2)
print('loaded + pyramid', round(time.time() - t0, 1), 's', full.size, flush=True)


def module_mask(img):
    a = np.asarray(img).astype(np.int32)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    m = ((b - r) > 6) & ((b - g) > -4) & (al > 0) & ((b + g + r) < 540)
    return m.astype(np.float32)


def render(A, shape):
    t = np.zeros(shape, np.float32)
    for x0, y0, x1, y1 in R:
        pts = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
        px = (A[:, :2] @ pts.T).T + A[:, 2]
        cv2.fillConvexPoly(t, np.round(px * 16).astype(np.int32), 1.0, lineType=cv2.LINE_AA, shift=4)
    return t


# ---- 1. coarse search at 1/8
m8 = cv2.GaussianBlur(module_mask(pyr[8]), (0, 0), 1.0)
X0, Y0, X1, Y1 = R[:, 0].min(), R[:, 1].min(), R[:, 2].max(), R[:, 3].max()
PAD = 300
img8 = cv2.copyMakeBorder(m8, PAD, PAD, PAD, PAD, cv2.BORDER_CONSTANT, 0)
best = None
for s in np.arange(0.70, 1.40, 0.005):
    A = np.array([[s, 0, -X0 * s], [0, -s, Y1 * s]])
    hh, ww = int((Y1 - Y0) * s) + 4, int((X1 - X0) * s) + 4
    if hh >= img8.shape[0] or ww >= img8.shape[1]:
        continue
    tpl = cv2.GaussianBlur(render(A, (hh, ww)), (0, 0), 1.0)
    res = cv2.matchTemplate(img8, tpl, cv2.TM_CCORR_NORMED)
    _, mx, _, loc = cv2.minMaxLoc(res)
    if best is None or mx > best[0]:
        best = (mx, s, loc)
mx, s, loc = best
A = np.array([[s, 0, -X0 * s + loc[0] - PAD], [0, -s, Y1 * s + loc[1] - PAD]])
print('coarse scale %.3f px/m @1/8, score %.3f' % (s, mx), flush=True)

# ---- 2. ECC refinement
eccs = []
for f in (4, 2):
    A = A * 2
    m = module_mask(pyr[f]); mb = cv2.GaussianBlur(m, (0, 0), 1.5)
    tpl = cv2.GaussianBlur(render(A, m.shape), (0, 0), 1.5)
    Wm = np.eye(2, 3, dtype=np.float32)
    cc, Wm = cv2.findTransformECC(tpl, mb, Wm, cv2.MOTION_AFFINE, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-7), None, 5)
    A = (np.vstack([Wm, [0, 0, 1]]) @ np.vstack([A, [0, 0, 1]]))[:2]
    eccs.append(round(float(cc), 4))
    print('ECC @1/%d = %.4f' % (f, cc), flush=True)
m2 = m
A_full = A * 2
M = A_full[:, :2]
sx, sy = math.hypot(M[0, 0], M[1, 0]), math.hypot(M[0, 1], M[1, 1])
fit = dict(cad_to_pixel=A_full.tolist(), scale_x_px_per_m=sx, scale_y_px_per_m=sy, gsd_m=1 / ((sx + sy) / 2),
           rotation_deg=math.degrees(math.atan2(M[1, 0], M[0, 0])),
           shear=float((M[0, 0] * M[0, 1] + M[1, 0] * M[1, 1]) / (sx * sy)), ecc=eccs)
print(json.dumps(fit, indent=1), flush=True)

# ---- 3. per-table evidence at 1/2
A2 = A_full / 2
cov = []
for x0, y0, x1, y1 in R:
    pts = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]); px = (A2[:, :2] @ pts.T).T + A2[:, 2]
    c0, r0 = np.floor(px.min(0)).astype(int); c1, r1 = np.ceil(px.max(0)).astype(int)
    w, h = c1 - c0, r1 - r0
    sub = m2[max(0, r0 + int(h * 0.15)):max(0, r1 - int(h * 0.15)), max(0, c0 + int(w * 0.08)):max(0, c1 - int(w * 0.08))]
    cov.append(round(float(sub.mean()), 3) if sub.size else 0.0)
evidence = {t['key']: c for t, c in zip(reg, cov)}
covs = np.array(cov)
fit['evidence'] = dict(threshold=0.6, tables_with_modules_visible=int((covs > 0.6).sum()), partial=int(((covs > 0.3) & (covs <= 0.6)).sum()),
                       none=int((covs <= 0.3).sum()))
pv_appr = np.array([t['pv_approved'] for t in reg])
fit['evidence']['pv_approved_with_modules_visible'] = int((pv_appr & (covs > 0.6)).sum())
fit['evidence']['pv_approved_total'] = int(pv_appr.sum())
fit['evidence']['modules_visible_not_pv_approved'] = int((~pv_appr & (covs > 0.6)).sum())
print(json.dumps(fit['evidence']), flush=True)
json.dump(evidence, open(os.path.join(BUILD, 'drone_evidence.json'), 'w'))

# ---- 4. tiles in CAD space
Ainv = cv2.invertAffineTransform(A_full.astype(np.float64))
corners = np.array([[0, 0], [W, 0], [W, H], [0, H]], float)
cad = (Ainv[:, :2] @ corners.T).T + Ainv[:, 2]
TILE = 512
RESOLUTIONS = [8, 4, 2, 1, 0.5, 0.25, 0.125]
ex0, ey0 = math.floor(cad[:, 0].min() / 64) * 64, math.floor(cad[:, 1].min() / 64) * 64
ex1, ey1 = math.ceil(cad[:, 0].max() / 64) * 64, math.ceil(cad[:, 1].max() / 64) * 64
meta = dict(capture_date=capture_date, source=os.path.basename(src_path), source_size=[W, H], extent=[ex0, ey0, ex1, ey1], origin=[ex0, ey1],
            tile_size=TILE, resolutions=RESOLUTIONS, format='webp', crs='CAD metres (MMS_APPROVED_2.0 baseline)', fit=fit)
out_dir = os.path.join(BUILD, 'tiles')
if make_tiles:
    arrays = {f: np.asarray(pyr[f]) for f in (1, 2, 4, 8)}
    count = 0; skipped = 0; size = 0
    for z, res in enumerate(RESOLUTIONS):
        f = max([k for k in (1, 2, 4, 8) if (1 / ((sx + sy) / 2)) * k <= res * 1.01] or [1])
        src = arrays[f]
        As = A_full / f
        nx = math.ceil((ex1 - ex0) / (res * TILE)); ny = math.ceil((ey1 - ey0) / (res * TILE))
        for ty in range(ny):
            for tx in range(nx):
                # tile pixel (u,v) -> CAD: x = ex0 + (tx*T+u)*res ; y = ey1 - (ty*T+v)*res
                T = np.array([[res, 0, ex0 + tx * TILE * res], [0, -res, ey1 - ty * TILE * res]])
                Mtx = (np.vstack([As, [0, 0, 1]]) @ np.vstack([T, [0, 0, 1]]))[:2]
                tile = cv2.warpAffine(src, Mtx, (TILE, TILE), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                                      borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
                if tile[..., 3].max() == 0:
                    skipped += 1; continue
                p = os.path.join(out_dir, str(z), str(tx)); os.makedirs(p, exist_ok=True)
                fn = os.path.join(p, '%d.webp' % ty)
                Image.fromarray(tile, 'RGBA').save(fn, 'WEBP', quality=78, method=4)
                count += 1; size += os.path.getsize(fn)
        print('zoom', z, 'res', res, 'grid', nx, ny, 'src 1/%d' % f, 'tiles so far', count, flush=True)
    meta['tiles'] = dict(count=count, empty_skipped=skipped, bytes=size)
    print('tiles', count, 'skipped', skipped, 'MB', round(size / 1e6, 1), flush=True)
json.dump(meta, open(os.path.join(BUILD, 'drone_meta.json'), 'w'), indent=1)
print('done', round(time.time() - t0, 1), 's')
