#!/usr/bin/env python3
# ============================================================================
# extract-logo.py — extract the Mercury head-logo pixel grids from the
# operator's reference PNG and bake them into
# assets/splash/splash-core.mjs between the HEAD/WORD markers.
#
# The reference is AI-rendered pixel-art: art cells ≈16.5 screen px with soft
# edges, PLUS a thinner sub-grid for the divider rule. This tool:
#   1. sips → BMP (no PIL on the box), manual 24bpp parse;
#   2. fits the art grid (cell size + offset) by maximizing sample crispness
#      (a center sample whose neighborhood is uniform = aligned grid);
#   3. median-samples each cell center, quantizes to {., E cream, R red};
#   4. crops to content, splits the HEAD block and the WORDMARK block on empty
#      bands (the thin divider rule is NOT extracted — the splash draws it
#      with line glyphs, which match its sub-grid weight better);
#   5. rewrites the marker blocks in mercury-splash.mjs.
#
# Usage: python3 scripts/splash/extract-logo.py [reference.png]
#
# The canonical reference is COMMITTED: assets/splash/reference/hermes-head.png
# (the operator's hatched original — briefly lost when its session
# image-cache slot was overwritten by a later paste, re-supplied same night;
# NEVER treat ~/.claude/image-cache/* as a source, commit references first).
# assets/splash/reference/hermes-head-solid-variant.png is a DIFFERENT official
# variant (solid shapes), kept as an alternate — not the default.
# ============================================================================
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from statistics import median

REPO = Path(__file__).resolve().parents[2]
SPLASH = REPO / 'assets' / 'splash' / 'splash-core.mjs'

args = [a for a in sys.argv[1:] if a != '--rebake']
src = Path(args[0]).expanduser() if args else (REPO / 'assets' / 'splash' / 'reference' / 'hermes-head.png')
bmp = Path(tempfile.mkstemp(suffix='.bmp')[1])
subprocess.run(['sips', '-s', 'format', 'bmp', str(src), '--out', str(bmp)],
               check=True, capture_output=True)
d = bmp.read_bytes()
off = struct.unpack('<I', d[10:14])[0]
w, h0 = struct.unpack('<ii', d[18:26])
bpp = struct.unpack('<H', d[28:30])[0]
assert bpp in (24, 32), f'expected 24/32bpp, got {bpp}'
BPP = bpp // 8
topdown = h0 < 0
h = abs(h0)
row_sz = ((w * BPP + 3) // 4) * 4

def px(x, y):
    yy = y if topdown else h - 1 - y
    i = off + yy * row_sz + x * BPP
    return d[i + 2], d[i + 1], d[i]  # r, g, b (BGR(A) order)

def cls(p):
    r, g, b = p
    if r > 110 and g < 95 and b < 95:
        return 'R'
    if r > 165 and g > 145 and b > 115:
        return 'E'
    return '.'

# ── fit the art grid: cell c + offsets, maximize crisp (uniform-neighborhood)
def crispness(c, ox, oy):
    ok = tot = 0
    y = oy + c / 2
    while y < h - 2:
        x = ox + c / 2
        while x < w - 2:
            xi, yi = int(x), int(y)
            c0 = cls(px(xi, yi))
            uni = all(cls(px(xi + dx, yi + dy)) == c0
                      for dx in (-2, 0, 2) for dy in (-2, 0, 2))
            ok += uni
            tot += 1
            x += c
        y += c
    return ok / max(1, tot)

best = (0, 16.5, 0.0, 0.0)
c = 15.5
while c <= 17.6:
    step = c / 4
    for k in range(4):
        s = crispness(c, k * step, k * step)
        if s > best[0]:
            best = (s, c, k * step, k * step)
    c += 0.1
_, CELL, OX, OY = best
# refine offsets fine-grained (the coarse fit only tried 4 diagonal offsets)
bx = (0, OX)
o = 0.0
while o < CELL:
    sc = crispness(CELL, o, OY)
    if sc > bx[0]:
        bx = (sc, o)
    o += 0.5
OX = bx[1]
by = (0, OY)
o = 0.0
while o < CELL:
    sc = crispness(CELL, OX, o)
    if sc > by[0]:
        by = (sc, o)
    o += 0.5
OY = by[1]
print(f'grid fit: cell={CELL:.2f} offset=({OX:.1f},{OY:.1f}) crisp={crispness(CELL, OX, OY):.3f}')

# ── sample a lattice at cell size `c`: majority vote per cell ───────────────
# The reference mixes TWO quanta: the wordmark sits exactly on the ~16.6px art
# grid, but the head carries ~half-cell (8.3px) detail (face contours, feather
# gaps) that a coarse lattice misses. So: sample the whole canvas at BOTH
# scales — the wordmark from the coarse grid (clean 50% vote), the head from
# the FINE grid then an ink-preserving 2×2 downsample (solid forms, reference
# proportions preserved: fine/2 lands back on coarse cell units).
def sample(cell):
    # median of a tight center cross — the crispest read for on-grid content
    cols = int((w - OX) / cell)
    rows = int((h - OY) / cell)
    out = []
    r_ = max(1, int(cell * 0.18))
    for iy in range(rows):
        row = ''
        for ix in range(cols):
            cx = int(OX + ix * cell + cell / 2)
            cy = int(OY + iy * cell + cell / 2)
            rs, gs, bs = [], [], []
            for dx in (-r_, 0, r_):
                for dy in (-r_, 0, r_):
                    x = min(w - 1, max(0, cx + dx))
                    y = min(h - 1, max(0, cy + dy))
                    r, g, b = px(x, y)
                    rs.append(r); gs.append(g); bs.append(b)
            row += cls((median(rs), median(gs), median(bs)))
        out.append(row)
    return out

grid = sample(CELL)        # coarse: block split + the wordmark
fine = sample(CELL / 2)    # fine: the head detail source

# ── crop to content bbox ────────────────────────────────────────────────────
def nonempty(r):
    return bool(re.search(r'[^.]', r))
top = 0
while top < len(grid) and not nonempty(grid[top]):
    top += 1
bot = len(grid) - 1
while bot > top and not nonempty(grid[bot]):
    bot -= 1
row_off = top
grid = grid[top:bot + 1]
lefts = [min((i for i, ch in enumerate(r) if ch != '.'), default=10**9) for r in grid]
rights = [max((i for i, ch in enumerate(r) if ch != '.'), default=-1) for r in grid]
L, Rt = min(lefts), max(rights)
col_off = L
grid = [r[L:Rt + 1] for r in grid]
print(f'content: {len(grid[0])} cols × {len(grid)} rows')

# ── split blocks on empty bands: head · (divider band skipped) · wordmark ───
bands = []
band_tops = []
cur = []
for i, r in enumerate(grid):
    if nonempty(r):
        if not cur:
            band_tops.append(i)
        cur.append(r)
    elif cur:
        bands.append(cur)
        cur = []
if cur:
    bands.append(cur)
print('blocks:', [f'{len(b[0])}x{len(b)}' for b in bands])
# head = the tallest block; wordmark = the last block; the thin divider (and
# its dots/sigil) may appear as a 1-row band between them — dropped here, the
# splash draws that rule with glyphs at matching weight.
hi = max(range(len(bands)), key=lambda i: len(bands[i]))
head = bands[hi]
head_band_top = band_tops[hi]
word = bands[-1]
assert head is not word, 'unexpected: single block'

# THE HEAD: tone grids, PHASE-LOCKED to the source quantum (operator round 2:
# fractional resampling beat against the 8.3px fine grid and rendered moiré
# stripes; integer ratios kill the aliasing).
#   LG  — the fine lattice 1:1, but 3-TONE per fine cell (average → posterize:
#         full cream E / mid-cream e / void; red R / deep-red r), so the
#         source's soft edges become deliberate shading instead of ragged
#         binary edges (the old "hero" failure).
#   STD — an exact 2×2 tone-weighted downsample of LG (no fractional phase).
# Ramp: cream #F0E8D6 · mid #B3AC9C (SECOND) · red #DD4444 (TERRA) · deep
# #7B3232 (CLAW) — the brand family.
head_top = head_band_top
FC = CELL / 2
# Round 5 — the winning combination:
#   · sample 3 TONES at the FINE lattice (its OWN offsets, fitted below — the
#     sub-grid does not sit at half-coarse phase);
#   · CLOSE the source's 1-px scanline texture (a void row cell with ink
#     directly above AND below is texture, not structure — feather/contour
#     gaps are ≥2 px and survive);
#   · despeckle; LG = the healed fine grid 1:1 (~66×31 cells);
#   · STD = tone-weighted exact 2×2 downsample (~33×16 cells).
OX2, OY2 = OX, OY
_b = (0.0, OX2)
_o = 0.0
while _o < FC:
    _sc = crispness(FC, _o, OY2)
    if _sc > _b[0]:
        _b = (_sc, _o)
    _o += 0.25
OX2 = _b[1]
_b = (0.0, OY2)
_o = 0.0
while _o < FC:
    _sc = crispness(FC, OX2, _o)
    if _sc > _b[0]:
        _b = (_sc, _o)
    _o += 0.25
OY2 = _b[1]
print(f'fine lattice: pitch={FC:.2f} offset=({OX2:.2f},{OY2:.2f}) crisp={crispness(FC, OX2, OY2):.3f}')


def fine_cls(cx, cy):
    # median-center read at the fine cell — binary ink classes
    rs, gs, bs = [], [], []
    r_ = max(1, int(FC * 0.18))
    for dx in (-r_, 0, r_):
        for dy in (-r_, 0, r_):
            x = min(w - 1, max(0, int(cx + dx)))
            y = min(h - 1, max(0, int(cy + dy)))
            r, g, b = px(x, y)
            rs.append(r); gs.append(g); bs.append(b)
    return cls((median(rs), median(gs), median(bs)))


# the head band's pixel range → the refined fine lattice, binary
py0 = OY + (head_top + row_off) * CELL
py1 = py0 + len(head) * CELL
px0 = OX + col_off * CELL
px1 = px0 + len(grid[0]) * CELL
fy0 = max(0, int((py0 - OY2) / FC))
fy1 = int((py1 - OY2) / FC) + 1
fx0 = max(0, int((px0 - OX2) / FC))
fx1 = int((px1 - OX2) / FC) + 1
fineg = []
for fy in range(fy0, fy1):
    row = ''
    for fx in range(fx0, fx1):
        row += fine_cls(OX2 + fx * FC + FC / 2, OY2 + fy * FC + FC / 2)
    fineg.append(row)


def crop_rows(g):
    # rows only — X offsets are LOAD-BEARING: the shared 52-col frame carries
    # the reference's own head↔wordmark alignment (operator round 4).
    keep = [i for i, r in enumerate(g) if r.strip('.')]
    return g[keep[0]:keep[-1] + 1] if keep else g


# ROUND 7 — the committed AA version's structure was right; its failure was
# CONTINUOUS grey mixes (flat grey slabs at real font sizes). Same 2×2-fine-px
# half-cell integration, POSTERIZED: solid clusters → cream, the source's
# ~50% hatch → ONE warm mid tone (deliberate shading), sparse → void.
def posterize2x2(g):
    if len(g) % 2:
        g = g + ['.' * len(g[0])]
    if len(g[0]) % 2:
        g = [r + '.' for r in g]
    out = []
    for y in range(0, len(g), 2):
        row = ''
        for x in range(0, len(g[0]), 2):
            quad = [g[y][x], g[y][x + 1], g[y + 1][x], g[y + 1][x + 1]]
            nR = sum(1 for c in quad if c == 'R')
            nE = sum(1 for c in quad if c == 'E')
            if nR >= 2:
                row += 'R'
            elif nR == 1 and nE <= 1:
                row += 'r'
            elif nE + nR >= 3:
                row += 'E'
            elif nE == 2:
                row += 'e'
            else:
                row += '.'
        out.append(row)
    return out


def tidy(g):
    # drop dangling mid-tone caps (e with ≤1 ink neighbor) + lone specks
    out = [list(r) for r in g]
    H, W = len(g), len(g[0])
    for y in range(H):
        for x in range(W):
            ch = g[y][x]
            if ch == '.':
                continue
            nInk = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    yy, xx = y + dy, x + dx
                    if 0 <= yy < H and 0 <= xx < W and g[yy][xx] != '.':
                        nInk += 1
            if ch == 'e' and nInk <= 1:
                out[y][x] = '.'
            elif nInk == 0:
                out[y][x] = '.'
    return [''.join(r) for r in out]


def consolidate_runs(g):
    # the art is horizontal STROKES: make each ink run one uniform tone
    # (majority within the run) — kills per-cell E/e flicker, keeps the style.
    out = []
    for r in g:
        row = list(r)
        x = 0
        W = len(row)
        while x < W:
            if row[x] == '.':
                x += 1
                continue
            x2 = x
            while x2 < W and row[x2] != '.':
                x2 += 1
            run = row[x:x2]
            nR = sum(1 for c in run if c in 'Rr')
            nC = len(run) - nR
            if nR > nC:
                t = 'R' if sum(1 for c in run if c == 'R') >= nR / 2 else 'r'
            else:
                t = 'E' if sum(1 for c in run if c == 'E') >= nC / 2 else 'e'
            # a mixed run keeps its red segment red: only unify within families
            for i in range(x, x2):
                row[i] = t if (row[i] in 'Ee') == (t in 'Ee') else row[i]
            x = x2
        out.append(''.join(row))
    return out


def finish(g):
    # REGION-AWARE finish (round 8): the wing + dome are SOLID cream strokes in
    # the source — unify their mid-tones up to full cream; the face keeps its
    # v12 tonal mix (that variation IS the face's form — flattening it was the
    # v13 barcode failure). The face zone ≈ x ≥ 13 AND y ≥ 12 (below the band).
    out = [list(r) for r in g]
    H, W = len(g), len(g[0])
    headL = min(min((i for i, ch in enumerate(r) if ch != '.'), default=10**9)
                for r in g if r.strip('.'))
    for y in range(H):
        for x in range(W):
            if out[y][x] == 'e' and not (x >= headL + 13 and y >= 12):
                out[y][x] = 'E'
    return [''.join(r) for r in out]


def band_continuity(g):
    # a lone cream cell horizontally sandwiched inside the red band run reads
    # as a hole in the band — snap it red.
    out = []
    for r in g:
        r = re.sub(r'(?<=[Rr])E(?=[Rr])', 'R', r)
        r = re.sub(r'(?<=[Rr])e(?=[Rr])', 'r', r)
        out.append(r)
    return out


head_std = band_continuity(tidy(finish(posterize2x2(crop_rows(fineg)))))
if len(head_std) % 2:
    head_std.append('.' * len(head_std[0]))
# ONE scale ships (round 9 verdict): a 2× pixel-double amplified the stroke
# gaps into bars; the 33×16 STD is the look.
# Letterform correction: the extraction picks up a stray
# bottom-right FOOT on the C (AA bleed at the C/U boundary) that closes it into
# a G — "MERGURY". The reference C is open: clear any ink in the C's mouth rows
# on its rightmost column (the C spans cols 24-28 of the 52-col wordmark;
# rows 1-3 are its open mouth).
word = [r if i not in (1, 2, 3) else (r[:28] + '.' + r[29:] if len(r) > 28 else r)
        for i, r in enumerate(word)]

if len(word) % 2:
    word.append('.' * len(word[0]))

def bake(name, rows_):
    body = f'// {name}-GRID-START (baked by scripts/splash/extract-logo.py — from the reference PNG)\n'
    body += f'const {name} = [\n' + '\n'.join(f"  '{r}'," for r in rows_) + '\n]\n'
    body += f'// {name}-GRID-END'
    return body

s = SPLASH.read_text()
for name, rows_ in (('HEADSTD', head_std), ('WORD', word)):
    pat = re.compile(rf'// {name}-GRID-START[\s\S]*?// {name}-GRID-END')
    if not pat.search(s):
        print(f'!! marker block for {name} missing in splash-core.mjs')
        sys.exit(1)
    s = pat.sub(bake(name, rows_), s)
SPLASH.write_text(s)
print(f'baked HEADSTD {len(head_std[0])}×{len(head_std)} + WORD {len(word[0])}×{len(word)} → {SPLASH.relative_to(REPO)}')
