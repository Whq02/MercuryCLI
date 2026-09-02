#!/usr/bin/env python3
# ============================================================================
# scripts/motion/splash-reel.py — the splash MOTION capture substrate.
#
# The frame-by-frame PTY recorder for the launcher splash
# (assets/splash/mercury-splash.mjs): capture records the RAW byte stream
# with millisecond arrival timestamps plus scripted resize/key events;
# render replays it offline through pyte into per-paint-unit frame
# snapshots (text + vshot-format grid JSON for gridToPng); report computes
# the measured motion facts (frame cadence, blank frames, coverage per
# frame) the splash motion laws pin.
#
# A PAINT UNIT is what a terminal would apply as one visual step: bytes up
# to each DEC-2026 synchronized-output close (?2026l) coalesce into one
# unit even when the PTY split them across reads; bytes arriving OUTSIDE
# an open 2026 bracket snapshot at their read boundary. Unit time = the
# arrival time of the chunk carrying the unit's final byte.
#
# Hermetic like scripts/splash/prove-splash.py: every home spelling pins to
# a scratch home (an unpinned run inherits the operator's lived-in home and
# flips the card ladder), TERM_PROGRAM/MERCURY_FULLSCREEN are popped, and
# NO_COLOR must not leak in (it silently disables the animation — the
# ripple-probe audit gotcha).
#
# usage:
#   splash-reel.py capture --cols 120 --rows 38 --out reel.jsonl \
#       [--resize MS:COLSxROWS ...] [--send MS:enter|ctrlc ...] \
#       [--env K=V ...] [--deadline S] [--home DIR] [--argv CMD ...]
#   splash-reel.py render --reel reel.jsonl --outdir DIR \
#       [--grids all|N,M,...] [--no-text]
#   splash-reel.py report --reel reel.jsonl [--json OUT]
# ============================================================================
import argparse
import base64
import fcntl
import json
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

REPO = Path(__file__).resolve().parents[2]
SPLASH = str(REPO / 'assets' / 'splash' / 'mercury-splash.mjs')


# ── capture ─────────────────────────────────────────────────────────────────
def cmd_capture(a):
    home = a.home or tempfile.mkdtemp(prefix='splash-reel-home.')
    argv = a.argv or ['node', SPLASH]
    resizes = []
    for spec in a.resize or []:
        ms, _, geo = spec.partition(':')
        c, _, r = geo.partition('x')
        resizes.append((int(ms), int(c), int(r)))
    resizes.sort()
    sends = []
    KEYS = {'enter': b'\r', 'ctrlc': b'\x03', 'esc': b'\x1b', 'm': b'm'}
    for spec in a.send or []:
        ms, _, key = spec.partition(':')
        sends.append((int(ms), key, KEYS[key]))
    sends.sort()

    pid, fd = pty.fork()
    if pid == 0:  # child — become the splash
        for spelling in ('MERCURY_HOME', 'MERCURY_CONFIG_DIR'):
            os.environ[spelling] = home
        os.environ['TERM'] = 'xterm-256color'
        for k in ('TERM_PROGRAM', 'MERCURY_FULLSCREEN', 'NO_COLOR',
                  'MERCURY_SPLASH_ONESHOT', 'MERCURY_SPLASH_VIEW'):
            os.environ.pop(k, None)
        for kv in a.env or []:
            k, _, v = kv.partition('=')
            os.environ[k] = v
        os.execvp(argv[0], argv)

    cols, rows = a.cols, a.rows
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    out = open(a.out, 'w')
    t0 = time.monotonic()
    now_ms = lambda: int((time.monotonic() - t0) * 1000)
    out.write(json.dumps({
        'v': 1, 'cols': cols, 'rows': rows, 'argv': argv, 'home': home,
        'resizes': [[m, c, r] for m, c, r in resizes],
        'sends': [[m, k] for m, k, _ in sends],
    }) + '\n')
    ri = si = 0
    exit_rec = None
    deadline = a.deadline * 1000
    while True:
        t = now_ms()
        if t >= deadline:
            out.write(json.dumps({'t': t, 'ev': 'deadline'}) + '\n')
            os.kill(pid, signal.SIGKILL)
            break
        while ri < len(resizes) and t >= resizes[ri][0]:
            _, c, r = resizes[ri]
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
            out.write(json.dumps({'t': now_ms(), 'ev': 'resize', 'cols': c, 'rows': r}) + '\n')
            ri += 1
        while si < len(sends) and t >= sends[si][0]:
            os.write(fd, sends[si][2])
            out.write(json.dumps({'t': now_ms(), 'ev': 'send', 'key': sends[si][1]}) + '\n')
            si += 1
        nxt = deadline
        if ri < len(resizes):
            nxt = min(nxt, resizes[ri][0])
        if si < len(sends):
            nxt = min(nxt, sends[si][0])
        wait = max(0.001, min(0.05, (nxt - now_ms()) / 1000))
        r, _, _ = select.select([fd], [], [], wait)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if not data:
                out.write(json.dumps({'t': now_ms(), 'ev': 'eof'}) + '\n')
                break
            out.write(json.dumps({'t': now_ms(),
                                  'b': base64.b64encode(data).decode()}) + '\n')
    done, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status):
        exit_rec = {'code': os.WEXITSTATUS(status)}
    elif os.WIFSIGNALED(status):
        exit_rec = {'signal': os.WTERMSIG(status)}
    out.write(json.dumps({'t': now_ms(), 'ev': 'exit', **(exit_rec or {})}) + '\n')
    out.close()
    print(json.dumps({'reel': a.out, 'exit': exit_rec, 'wall_ms': now_ms()}))


# ── the paint-unit splitter (shared by render + report) ─────────────────────
SYNC_OPEN = b'\x1b[?2026h'
SYNC_CLOSE = b'\x1b[?2026l'


def load_reel(path):
    header, chunks, events = None, [], []
    for line in open(path):
        rec = json.loads(line)
        if header is None and 'v' in rec:
            header = rec
        elif 'b' in rec:
            chunks.append((rec['t'], base64.b64decode(rec['b'])))
        else:
            events.append(rec)
    return header, chunks, events


def paint_units(chunks):
    """[(t_ms, bytes, synced)] — one entry per visual step (see header)."""
    units = []
    buf = b''
    for t, data in chunks:
        buf += data
        # Close a unit at every complete ?2026l; hold back an open bracket.
        while True:
            close = buf.find(SYNC_CLOSE)
            if close == -1:
                break
            end = close + len(SYNC_CLOSE)
            units.append((t, buf[:end], True))
            buf = buf[end:]
        if buf and buf.find(SYNC_OPEN) == -1:
            units.append((t, buf, False))
            buf = b''
    if buf:
        units.append((chunks[-1][0] if chunks else 0, buf, False))
    return units


def make_screen(cols, rows):
    import pyte
    screen = pyte.Screen(cols, rows)
    stream = pyte.ByteStream(screen)
    return screen, stream


def snap_grid(screen, cols, rows):
    return [[{'c': screen.buffer[y][x].data,
              'fg': screen.buffer[y][x].fg,
              'bg': screen.buffer[y][x].bg,
              'bold': bool(screen.buffer[y][x].bold),
              'rev': bool(screen.buffer[y][x].reverse)}
             for x in range(cols)] for y in range(rows)]


def frame_walk(header, chunks, events):
    """Yield (idx, t, synced, screen, cols, rows) after each paint unit,
    applying recorded resizes to the emulator at their capture times."""
    cols, rows = header['cols'], header['rows']
    screen, stream = make_screen(cols, rows)
    resize_events = sorted([e for e in events if e.get('ev') == 'resize'],
                           key=lambda e: e['t'])
    ri = 0
    for idx, (t, data, synced) in enumerate(paint_units(chunks)):
        while ri < len(resize_events) and resize_events[ri]['t'] <= t:
            cols, rows = resize_events[ri]['cols'], resize_events[ri]['rows']
            screen.resize(rows, cols)
            ri += 1
        stream.feed(data)
        yield idx, t, synced, screen, cols, rows


def frame_text(screen, cols, rows):
    return [''.join(screen.buffer[y][x].data for x in range(cols)).rstrip()
            for y in range(rows)]


def coverage(screen, cols, rows):
    """Glyph coverage: overall fraction + a 3x3 region density map."""
    filled = 0
    regions = [[0] * 3 for _ in range(3)]
    counts = [[0] * 3 for _ in range(3)]
    for y in range(rows):
        for x in range(cols):
            gy, gx = min(2, y * 3 // max(1, rows)), min(2, x * 3 // max(1, cols))
            counts[gy][gx] += 1
            if screen.buffer[y][x].data.strip():
                filled += 1
                regions[gy][gx] += 1
    total = max(1, cols * rows)
    return {
        'fill': round(filled / total, 4),
        'regions': [[round(regions[gy][gx] / max(1, counts[gy][gx]), 3)
                     for gx in range(3)] for gy in range(3)],
    }


def cmd_render(a):
    header, chunks, events = load_reel(a.reel)
    outdir = Path(a.outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    want_grids = a.grids
    grid_set = None
    if want_grids and want_grids != 'all':
        grid_set = {int(x) for x in want_grids.split(',')}
    index = []
    for idx, t, synced, screen, cols, rows in frame_walk(header, chunks, events):
        name = f'frame-{idx:04d}'
        if not a.no_text:
            (outdir / f'{name}.txt').write_text(
                '\n'.join(frame_text(screen, cols, rows)) + '\n')
        if want_grids and (grid_set is None or idx in grid_set):
            (outdir / f'{name}.grid.json').write_text(json.dumps({
                'grid': snap_grid(screen, cols, rows), 'cols': cols, 'rows': rows,
            }))
        index.append({'i': idx, 't': t, 'synced': synced,
                      'cols': cols, 'rows': rows})
    (outdir / 'frames.json').write_text(json.dumps(
        {'reel': a.reel, 'header': header, 'frames': index}, indent=1))
    print(json.dumps({'outdir': str(outdir), 'frames': len(index)}))


def cmd_report(a):
    header, chunks, events = load_reel(a.reel)
    frames = []
    for idx, t, synced, screen, cols, rows in frame_walk(header, chunks, events):
        cov = coverage(screen, cols, rows)
        frames.append({'i': idx, 't': t, 'synced': synced, 'cols': cols,
                       'rows': rows, **cov})
    deltas = [b['t'] - a2['t'] for a2, b in zip(frames, frames[1:])]
    synced_ts = [f['t'] for f in frames if f['synced']]
    sdeltas = [b - a2 for a2, b in zip(synced_ts, synced_ts[1:])]
    blank = [f['i'] for f in frames if f['fill'] == 0.0]
    rep = {
        'reel': a.reel,
        'frames': len(frames),
        'events': [e for e in events if e.get('ev') != None],
        'blank_frames': blank,
        'cadence_all_ms': _stats(deltas),
        'cadence_synced_ms': _stats(sdeltas),
        'per_frame': frames,
    }
    text = json.dumps(rep, indent=1)
    if a.json:
        Path(a.json).write_text(text)
        print(json.dumps({k: rep[k] for k in
                          ('frames', 'blank_frames', 'cadence_synced_ms')}))
    else:
        print(text)


def _stats(xs):
    if not xs:
        return None
    s = sorted(xs)
    return {'n': len(xs), 'min': s[0], 'max': s[-1],
            'mean': round(sum(xs) / len(xs), 1),
            'p50': s[len(s) // 2], 'p95': s[int(len(s) * 0.95)]}


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('capture')
    c.add_argument('--cols', type=int, required=True)
    c.add_argument('--rows', type=int, required=True)
    c.add_argument('--out', required=True)
    c.add_argument('--resize', action='append')
    c.add_argument('--send', action='append')
    c.add_argument('--env', action='append')
    c.add_argument('--deadline', type=float, default=30)
    c.add_argument('--home')
    c.add_argument('--argv', nargs=argparse.REMAINDER)
    r = sub.add_parser('render')
    r.add_argument('--reel', required=True)
    r.add_argument('--outdir', required=True)
    r.add_argument('--grids')
    r.add_argument('--no-text', action='store_true')
    q = sub.add_parser('report')
    q.add_argument('--reel', required=True)
    q.add_argument('--json')
    a = p.parse_args()
    {'capture': cmd_capture, 'render': cmd_render, 'report': cmd_report}[a.cmd](a)


if __name__ == '__main__':
    main()
