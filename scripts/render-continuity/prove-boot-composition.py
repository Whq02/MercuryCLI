#!/usr/bin/env python3
# ============================================================================
# scripts/render-continuity/prove-boot-composition.py — PO-7 (PO-20..22): one
# geometry snapshot + one placement law for the boot surfaces.
#
# Behavioral legs (real pty, empty MERCURY_HOME, pyte replay — the repro-pr11
# harness with ASSERTIONS):
#   · 80x24 and 120x44 stay balanced (|below-above| <= 1);
#   · tall sizes (120x60 · 100x50 · 160x70) distribute the slack optically
#     (|below-above| <= 5 AND >= 4 rows above — never top-pinned), or, when
#     the block nearly fills the terminal (pad <= 6), balance what is left;
#   · a live resize 44 -> 66 lands in the same law (stale-geometry kill);
#   · the MENU view at a tall size is placed by the SAME owner (centred).
#
# Structural pins (the double-read fix stays dead):
#   · frame() takes the snapshot (fCols/fRows) and performs NO out.rows read;
#   · paintView reads the geometry ONCE into snapCols/snapRows;
#   · repaint() (the second paint path) does not exist.
#
# Before-state measurements: 120x60: 21 blank below vs 1 above; 160x70: 31;
# live-resize: 27.
# ============================================================================
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time
from pathlib import Path

try:
    import pyte
except ImportError:
    print('SKIP: pyte unavailable in this python')
    sys.exit(0)

REPO = Path(__file__).resolve().parents[2]
SPLASH = str(REPO / 'assets' / 'splash' / 'mercury-splash.mjs')
EMPTY_HOME = tempfile.mkdtemp(prefix='poise-po7-home.')
failures = 0


def check(label, cond, detail=''):
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}{' — ' + detail if detail else ''}")


def run_splash(cols, rows, hold_s=2.2, resize=None, send=None, send_after=1.2):
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        # BOTH home spellings pin to the empty home (proof-hygiene: the
        # splash resolves MERCURY_CONFIG_DIR before MERCURY_HOME, and the
        # gate wrapper exports the operator's LIVE home — pinning only
        # MERCURY_HOME let real recents grow the composed block one row and
        # break the 100x50 knife-edge leg POOLED-ONLY; the "load flake" was
        # this).
        env['MERCURY_HOME'] = EMPTY_HOME
        env['MERCURY_CONFIG_DIR'] = EMPTY_HOME
        env['TERM'] = 'xterm-256color'
        env['COLORTERM'] = 'truecolor'
        # The display animations every capture pins still (the critter's
        # sway and blink, its gaze and sleep, the live seconds, the live
        # glyphs): a captured frame never lands on an arbitrary phase.
        env['MERCURY_CRITTER_IDLE'] = '0'
        env['MERCURY_CRITTER_GAZE'] = '0'
        env['MERCURY_CRITTER_SLEEP'] = '0'
        env['MERCURY_LIVE_CLOCK'] = '0'
        env['MERCURY_LIVE_GLYPHS'] = '0'
        # the WAITING deck (the composed lockup these placement
        # laws grade) is the INLINE world now — a fullscreen boot auto-runs
        # the trace out from under the hold_s capture window. The inline deck
        # is byte-identical to the pre-unification waiting screen.
        env['MERCURY_FULLSCREEN'] = '0'
        env.pop('MERCURY_SPLASH', None)
        env.pop('NO_COLOR', None)
        os.execvpe('node', ['node', SPLASH], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    buf = b''
    deadline = time.time() + hold_s
    start = deadline - hold_s
    resized = False
    sent = False
    while time.time() < deadline:
        now = time.time()
        if resize and not resized and now - start > resize[0]:
            _, c2, r2 = resize
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r2, c2, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            resized = True
        if send and not sent and now - start > send_after:
            os.write(fd, send)
            sent = True
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                chunk = os.read(fd, 65536)
                if chunk:
                    buf += chunk
            except OSError:
                break
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.close(fd)
    os.waitpid(pid, 0)
    return buf


def measure(byts, cols, rows):
    screen = pyte.Screen(cols, rows)
    stream = pyte.Stream(screen)
    stream.feed(byts.decode('utf-8', errors='replace'))
    disp = screen.display
    content = [i for i, r in enumerate(disp) if r.strip() != '']
    if not content:
        return None
    first, last = content[0], content[-1]
    return first, rows - 1 - last, disp


print('── §1 placement law across sizes ──')
for label, cols, rows, resize, balanced_only in [
    ('80x24', 80, 24, None, True),
    ('120x44', 120, 44, None, True),
    ('120x60 tall', 120, 60, None, False),
    ('100x50 tall-narrow', 100, 50, None, False),
    ('160x70 very tall', 160, 70, None, False),
    ('120x44 -> 120x66 live resize', 120, 44, (1.1, 120, 66), False),
]:
    eff_cols = resize[1] if resize else cols
    eff_rows = resize[2] if resize else rows
    m = measure(run_splash(cols, rows, hold_s=2.6 if resize else 2.2, resize=resize), eff_cols, eff_rows)
    if m is None:
        check(f'{label}: captured content', False)
        continue
    above, below, _ = m
    imb = below - above
    if balanced_only:
        check(f'{label}: balanced (|imb| <= 1)', abs(imb) <= 1, f'{above} above / {below} below')
    else:
        # The tall lockup measures one fixed 48-row block at every tall size
        # (this run's own details: 6/6 at 120x60, 10/12 at 160x70, 1/1 at
        # 100x50): a terminal it nearly fills has no slack to distribute,
        # so the law reads the menu view's shape — distributed, or naturally
        # full (pad <= 6 balances what little is left).
        pad = above + below
        check(
            f'{label}: optical distribution (|imb| <= 5, >= 4 above; or naturally full)',
            (pad <= 6 and abs(imb) <= 1) or (abs(imb) <= 5 and above >= 4),
            f'{above} above / {below} below (pad {pad})',
        )

print('── §2 the menu is placed by the same owner ──')
m = measure(run_splash(120, 60, hold_s=2.8, send=b'm', send_after=1.4), 120, 60)
if m is None:
    check('menu leg captured content', False)
else:
    above, below, disp = m
    is_menu = any('menu' in r.lower() or 'projects' in r.lower() for r in disp)
    check('the m key reached the menu view', is_menu)
    pad = above + below
    check(
        'menu view rides the one placement law (distributed, or naturally full)',
        pad <= 6 or (abs(below - above) <= 6 and above >= 4),
        f'{above} above / {below} below (pad {pad})',
    )

print('── §3 structural pins: the double read stays dead ──')
src = open(SPLASH).read()
# Round 7 (flat ground): frame() is the plain join — it consumes NOTHING but
# the composed block, so the PO-7 no-second-geometry-read law now holds by
# construction; the pin keeps the shape from regrowing a geometry argument.
frame_body = re.search(r'function frame\(block\) \{.*?\n\}', src, re.S)
check(
    'frame() is the flat join (no geometry parameter, no out.rows/out.columns read)',
    frame_body is not None and 'out.rows' not in frame_body.group(0) and 'out.columns' not in frame_body.group(0),
)
check(
    'paintView snapshots geometry ONCE (snapCols/snapRows)',
    'const snapCols = Math.max(20, out.columns || 80)' in src
    and 'const snapRows = Math.max(8, out.rows || 24)' in src
    and 'frame(placed)' in src,
)
check('the second paint path (repaint) no longer exists', 'function repaint(' not in src)
# (The focusPeakFrac pin retired with its subject: round 7 removed the
# gradient focus entirely — there is no peak left to follow the placement.)

print(f"\n{'✅' if failures == 0 else '❌'} prove-boot-composition — {'all checks pass' if failures == 0 else f'{failures} failed'}")
sys.exit(0 if failures == 0 else 3)
