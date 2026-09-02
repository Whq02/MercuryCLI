#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HEADER = '✶ SESSION'
SPAN = 60
failures = 0


def check(label, cond, detail=''):
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}{' — ' + detail if detail else ''}")


def render(scenario):
    scratch = tempfile.mkdtemp(prefix='resize-return.')
    grid = os.path.join(scratch, 'grid.json')
    env = {**os.environ, 'MERCURY_LIVE_GLYPHS': '0', 'MERCURY_CRITTER': 'crab'}
    r = subprocess.run(
        [os.path.expanduser('~/.bun/bin/bun'), 'run', 'scripts/ui/render-tui.ts',
         '--scenario', scenario, '--cols', '120', '--rows', '44',
         '--grid', grid, '--out', os.path.join(scratch, 'out.png')],
        cwd=REPO, env=env, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return None, (r.stdout[-300:] + r.stderr[-300:]).replace('\n', ' ')
    return json.load(open(grid)), None


def furniture_rows(g):
    """[(y, x, text, [fg...])] for the SESSION header row and the three
    berth rows under it, clipped to SPAN columns from the header's x."""
    out = []
    for y, row in enumerate(g['grid']):
        text = ''.join(c['c'] for c in row)
        if HEADER in text:
            x = text.index(HEADER)
            for dy in range(4):
                r2 = g['grid'][y + dy]
                t2 = ''.join(c['c'] for c in r2)[x:x + SPAN]
                fgs = [c['fg'] for c in r2[x:x + SPAN]]
                out.append((y + dy, x, t2, fgs))
            break
    return out


print('=' * 60)
print(' resize-return identity — the turns-state furniture')
print('=' * 60)

direct, err = render('resume-2turn')
check('direct 120x44 boot rendered', direct is not None, err or '')
journey, err = render('resize-return')
check('resize-return journey rendered', journey is not None, err or '')

if direct and journey:
    check('final geometry equals the boot geometry',
          journey['cols'] == direct['cols'] and journey['rows'] == direct['rows'],
          f"{journey['cols']}x{journey['rows']}")
    bd = furniture_rows(direct)
    bj = furniture_rows(journey)
    check('R1 form: the SESSION header present in BOTH final frames',
          len(bd) == 4 and len(bj) == 4, f'direct={len(bd)} journey={len(bj)}')
    if len(bd) == 4 and len(bj) == 4:
        check('R1 form: the header at the SAME rows and column',
              [(r[0], r[1]) for r in bd] == [(r[0], r[1]) for r in bj],
              f'{[(r[0], r[1]) for r in bj]} vs {[(r[0], r[1]) for r in bd]}')
        check('R2 art: header + berth rows byte-identical across journeys',
              [r[2] for r in bd] == [r[2] for r in bj],
              next((f'y{bd[i][0]}: {bj[i][2]!r} vs {bd[i][2]!r}'
                    for i in range(4) if bd[i][2] != bj[i][2]), 'rows'))
        check('R3 colour: per-cell fg identical at every furniture x (stable colour coordinates)',
              [r[3] for r in bd] == [r[3] for r in bj],
              next((f'y{bd[i][0]} x{j}: {bj[i][3][j]} vs {bd[i][3][j]}'
                    for i in range(4) for j in range(SPAN)
                    if bd[i][3][j] != bj[i][3][j]), 'all equal'))
    def has_critter(g):
        return any('▟' in ''.join(c['c'] for c in row) or '▙' in ''.join(c['c'] for c in row)
                   for row in g['grid'])
    check('R4 critter: mascot art present in both final frames',
          has_critter(direct) and has_critter(journey))

print()
if failures:
    print(f'❌ {failures} RESIZE-RETURN PROOF(S) FAILED')
    sys.exit(1)
print('✅ ALL RESIZE-RETURN PROOFS PASS')
