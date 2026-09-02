#!/usr/bin/env python3
# ============================================================================
# scripts/render-continuity/repro-pr11.py — (D7) reproduction: the boot splash
# vertical composition at compact/ordinary/tall sizes + resize during hold.
#
# Method: run assets/splash/mercury-splash.mjs in a real pty (pty.fork +
# TIOCSWINSZ, the prove-splash.py idiom) against a proof-owned EMPTY home,
# replay the emitted bytes through pyte, and measure where visible content
# sits vertically: rows of blank canvas ABOVE the first content row vs BELOW
# the last content row.
#
# Expected at unfixed HEAD (D7): compose() centres horizontally only and
# frame() lays block[y] from y=0 — all remaining height falls BELOW the
# lockup, so tall terminals show a top-pinned lockup over a large void.
# The receipt records the imbalance per size and after a live resize.
# ============================================================================
import fcntl
import os
import pty
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
RECEIPT = Path(__file__).resolve().parent / 'receipts' / 'pr11-head-6fe78a3d.txt'
EMPTY_HOME = tempfile.mkdtemp(prefix='poise-pr11-home.')

lines_out = []


def log(s):
    lines_out.append(s)
    print(s)


def run_splash(cols, rows, hold_s=2.2, resize=None):
    """Run the splash at cols x rows, optionally resize mid-hold, kill, and
    return the raw byte stream."""
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        # ALL FOUR home spellings (proof-hygiene — the boot-composition
        # gate-env-leak lesson: the gate wrapper exports the live
        # ~/.claude and the splash prefers the CONFIG_DIR spellings).
        env['MERCURY_HOME'] = EMPTY_HOME
        env['MERCURY_HOME'] = EMPTY_HOME
        env['MERCURY_CONFIG_DIR'] = EMPTY_HOME
        env['TERM'] = 'xterm-256color'
        env['COLORTERM'] = 'truecolor'
        env.pop('MERCURY_SPLASH', None)
        env.pop('NO_COLOR', None)
        os.execvpe('node', ['node', SPLASH], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    buf = b''
    deadline = time.time() + hold_s
    resized = False
    while time.time() < deadline:
        if resize and not resized and time.time() > deadline - hold_s + resize[0]:
            _, c2, r2 = resize
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r2, c2, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            resized = True
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
    """Replay through pyte; return (first, last, above, below, display)."""
    screen = pyte.Screen(cols, rows)
    stream = pyte.Stream(screen)
    stream.feed(byts.decode('utf-8', errors='replace'))
    disp = screen.display
    content = [i for i, r in enumerate(disp) if r.strip() != '']
    if not content:
        return None
    first, last = content[0], content[-1]
    return first, last, first, rows - 1 - last, disp


log('── PR-11 (D7) splash vertical-composition receipt ──')
log('method: real pty, empty MERCURY_HOME, truecolor; pyte replay of the hold frame')
log('')

legs = [
    ('80x24  (macOS default)', 80, 24, None),
    ('120x44 (refraction baseline)', 120, 44, None),
    ('120x60 (tall)', 120, 60, None),
    ('100x50 (tall-narrow)', 100, 50, None),
    ('160x70 (very tall+wide)', 160, 70, None),
    ('120x44 -> 120x66 live resize', 120, 44, (1.1, 120, 66)),
]

summary = []
frames = []
for label, cols, rows, resize in legs:
    eff_rows = resize[2] if resize else rows
    eff_cols = resize[1] if resize else cols
    byts = run_splash(cols, rows, hold_s=2.6 if resize else 2.2, resize=resize)
    m = measure(byts, eff_cols, eff_rows)
    if m is None:
        log(f'{label}: NO CONTENT CAPTURED (inconclusive)')
        summary.append((label, None))
        continue
    first, last, above, below, disp = m
    log(
        f'{label}: content rows {first + 1}..{last + 1} of {eff_rows} — '
        f'{above} blank above, {below} blank below (imbalance {below - above:+})'
    )
    summary.append((label, below - above))
    frames.append((label, eff_rows, disp))

log('')
tall_imbalances = [d for label, d in summary if d is not None and ('tall' in label or 'resize' in label)]
reproduced = any(d >= 8 for d in tall_imbalances)
log(
    'D7 REPRODUCED: tall terminals leave the remaining height below the lockup '
    f'(worst imbalance {max(tall_imbalances) if tall_imbalances else "n/a"} rows).'
    if reproduced
    else 'D7 NOT REPRODUCED: vertical distribution is balanced at tall sizes.'
)
log('')
log('source pins (double geometry read at execution):')
log('  compose(cols, rowsAvail) call: assets/splash/mercury-splash.mjs:1649 (module vars :1530-1531)')
log('  frame() re-reads out.rows:     assets/splash/mercury-splash.mjs:1623 (same paintView pass)')
log('  resize handler re-reads both:  assets/splash/mercury-splash.mjs:1792-1793')

for label, eff_rows, disp in frames:
    lines_out.append(f'\n════ {label} — full frame ════')
    for i, row in enumerate(disp):
        lines_out.append(f'{i + 1:3d}│{row.rstrip()}')

RECEIPT.parent.mkdir(exist_ok=True)
RECEIPT.write_text('\n'.join(lines_out))
print(f'receipt: {RECEIPT.relative_to(REPO)}')
sys.exit(0)
