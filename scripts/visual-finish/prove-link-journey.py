#!/usr/bin/env python3
# ============================================================================
# prove-link-journey.py — FRAME-WRITER-LINK-FIDELITY, the full visible
# journey (the FRAME-WRITER-LINK-
# FIDELITY). The ledger's own measurement recipe, made a standing proof:
# boot the REAL binary in a real PTY on a hyperlink-capable profile
# (TERM_PROGRAM=iTerm.app), resume a synthetic session whose transcript
# carries a markdown link (the 'link' corpus / cockpit-link scenarios), and
# hold the RAW TEE (VSHOT_TEE length-prefixed frames) to the OSC 8 laws
# across the writer's paint arms:
#
#   · cockpit-link           — the initial full paint;
#   · cockpit-link-resize    — a relayout AND a round-trip second relayout,
#                              so the link row repaints through the PER-CELL
#                              dirty arm (the ledger's measured path).
#
# Laws per leg:
#   L1 BALANCE   — never a closer at depth 0 (the measured defect WAS a
#                  dangling closer); the stream ends at depth 0.
#   L2 IDENTITY  — >=1 opener carrying the corpus URI; the link TEXT appears
#                  inside an open span (opener precedes it, closer follows).
#   L3 BUDGET    — the leg's total tee bytes stay under a loose 4x ceiling
#                  of the recorded baselines (27KB / 73KB): a
#                  writer regression that re-emits whole frames per tick
#                  would blow it; colour-only drift cannot.
#
# Adjudication context: the
# measured drop does NOT reproduce by this recipe —
# the native-core T1/T2 writer models hyperlink identity per cell (the
# ledger row's prescribed fix shape). This leg is the standing gate; a field
# recurrence has its harness here.
# ============================================================================
import os
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
URI = b'https://example.com/mercury/frame-writer#contract'
LINK_TEXT = b'the build notes'
failures = 0


def check(label, cond, detail=''):
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}{' — ' + detail if detail else ''}")


def tee_bytes(scenario, cols, rows):
    scratch = tempfile.mkdtemp(prefix='link-journey.')
    tee = os.path.join(scratch, 'raw.tee')
    env = {**os.environ, 'VSHOT_TEE': tee, 'TERM_PROGRAM': 'iTerm.app',
           'MERCURY_LIVE_GLYPHS': '0'}
    r = subprocess.run(
        [os.path.expanduser('~/.bun/bin/bun'), 'run', 'scripts/ui/render-tui.ts',
         '--scenario', scenario, '--cols', str(cols), '--rows', str(rows),
         '--grid', os.path.join(scratch, 'grid.json'),
         '--out', os.path.join(scratch, 'out.png')],
        cwd=REPO, env=env, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return None, (r.stdout[-300:] + r.stderr[-300:]).replace('\n', ' ')
    raw = b''
    data = open(tee, 'rb').read()
    i = 0
    while i + 8 <= len(data):
        _tick, ln = struct.unpack('>II', data[i:i + 8])
        raw += data[i + 8:i + 8 + ln]
        i += 8 + ln
    return raw, None


OSC8 = re.compile(rb'\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)')
STRIP = re.compile(rb'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)')

print('=' * 60)
print(' frame-writer link fidelity — the full visible journey')
print('=' * 60)

for scenario, cols, rows, ceiling in (
    ('cockpit-link', 120, 44, 4 * 27_347),
    ('cockpit-link-resize', 120, 44, 4 * 72_709),
):
    print(f'\n── {scenario} @{cols}x{rows}')
    raw, err = tee_bytes(scenario, cols, rows)
    check('capture ran', raw is not None, err or '')
    if raw is None:
        continue
    events = [(m.start(), m.end(), m.group(1)) for m in OSC8.finditer(raw)]
    depth = 0
    dangling = 0
    for _s, _e, uri in events:
        if uri:
            depth = 1
        else:
            if depth == 0:
                dangling += 1
            depth = 0
    openers = sum(1 for _s, _e, u in events if u)
    check('L1 balance: no dangling closer, stream ends closed',
          dangling == 0 and depth == 0,
          f'openers={openers} closers={len(events) - openers} dangling={dangling} depth={depth}')
    check('L2 identity: >=1 opener carries the corpus URI',
          any(u == URI for _s, _e, u in events), f'{openers} openers')
    in_span = False
    for i2, (s, e, u) in enumerate(events):
        if not u:
            continue
        end = events[i2 + 1][0] if i2 + 1 < len(events) else len(raw)
        if LINK_TEXT in STRIP.sub(b'', raw[e:end]):
            in_span = True
            break
    check('L2 identity: the link text is painted INSIDE an open span', in_span)
    check('L3 budget: tee bytes under the recorded 4x ceiling',
          len(raw) <= ceiling, f'{len(raw)} <= {ceiling}')

print()
if failures:
    print(f'❌ {failures} LINK-JOURNEY PROOF(S) FAILED')
    sys.exit(1)
print('✅ ALL LINK-JOURNEY PROOFS PASS')
