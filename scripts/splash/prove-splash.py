#!/usr/bin/env python3
# ============================================================================
# prove-splash.py — the enter-screen byte contract (API-free, PTY-driven).
#
# Runs assets/splash/mercury-splash.mjs in a real pty (the vshot trick:
# pty.fork + TIOCSWINSZ) at three sizes and asserts the contract:
#   · 120×44 STANDARD — the head renders (half-block cells), the (>_) rule and
#     the wordmark present, every visible line fits the width, cursor restored;
#   · 80×24 HEADLESS-CARD — head dropped, launcher card present; the strip is
#     a ladder decision proven from BOTH sides (empty home: tight card + strip
#     fit; populated home: strip sheds first, every action row survives);
#   · 45×12 COMPACT — the one-line brand;
#   · MERCURY_SPLASH=off ⇒ zero output; non-TTY (pipe) ⇒ zero output.
# Hermetic: every leg pins MERCURY_HOME to a proof-owned scratch home — an
# unpinned run inherits the operator's lived-in home and the card population
# (Continue/Projects rows) flips the ladder tier.
#
# the splash has TWO worlds now. FULLSCREEN boots
# are ANIMATION-FIRST (hero frame 0 → the trace auto-runs → handoff; ↵
# skips, ^C cancels, everything else inert; the ORIGINAL card lands on the
# runtime Boot face). The INLINE world (MERCURY_FULLSCREEN=0) keeps the
# whole stop-and-choose deck — card, strip, menu, projects, idle — so every
# deck law below pins MERCURY_FULLSCREEN=0 explicitly; the fullscreen legs
# assert the cinematic contract (sendless auto-run, same needles).
# ============================================================================
import fcntl
import json
import os
import pty
import re
# The ready-line hint: the key '↵ ' then the label 'start' (SGR runs may sit
# between them); the boundary excludes the hold/brand word 'starting' and the
# card's own 'start fresh here' context never carries the key.
HINT_RE = re.compile(r'↵ ?(?:\x1b\[[0-9;]*m)* ?start\b')
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SPLASH = str(REPO / 'assets' / 'splash' / 'mercury-splash.mjs')
# The baked blocks (grids · MENU · RAMP) live in the shared core.
CORE = str(REPO / 'assets' / 'splash' / 'splash-core.mjs')
failures = 0

# HERMETIC HOME: the splash reads
# $MERCURY_HOME for recent projects + boot-env, so an UNPINNED proof inherits
# whatever the invoking shell's home holds — the card population (Continue /
# Projects rows) then flips the 80×24 ladder tier between hlTight (strip kept)
# and hlBare (strip shed), and the same leg passes on a lived-in operator home
# while failing in the gate's scratch home. Every leg now runs against a
# proof-owned empty home by default; the populated-home leg below builds its
# own fixture world. env_extra can still override per-leg.
EMPTY_HOME = tempfile.mkdtemp(prefix='splash-proof-home-empty.')


def make_populated_home():
    """A home with TWO recent projects (live cwds) → the Continue + Projects
    card rows appear, growing the card past what 24 rows can hold WITH the
    strip — the pressure world for the shed-order leg. tmp cwds are honored
    because the home itself is tmp (the scanner's proof-world carve-out)."""
    home = tempfile.mkdtemp(prefix='splash-proof-home-pop.')
    for slug in ('proj-a', 'proj-b'):
        cwd = os.path.join(home, 'fixtures', slug)
        os.makedirs(cwd, exist_ok=True)
        pdir = os.path.join(home, 'projects', slug)
        os.makedirs(pdir, exist_ok=True)
        with open(os.path.join(pdir, 'session.jsonl'), 'w') as f:
            f.write(json.dumps({'cwd': cwd}) + '\n')
    return home


def check(label, cond, detail=''):
    global failures
    if not cond:
        failures += 1
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}{' — ' + detail if detail else ''}")


def run_pty(cols, rows, env_extra=None, send=None, send_after=0.6, oneshot=True,
            resize=None, run_for=None, cwd=None):
    # `send` is bytes (sent once at send_after) or a list of (after_s, bytes)
    # steps — the menu legs drive m → cycle → save as a real key sequence.
    # `resize` is a list of (after_s, cols, rows) TIOCSWINSZ+SIGWINCH steps —
    # the resize-ladder leg shrinks a live splash mid-run. `run_for` bounds a
    # leg whose child never exits on its own (no send): read until the
    # deadline, then kill. `cwd` runs the child from that directory (the
    # border-integrity leg forces a long repo name).
    steps = []
    if isinstance(send, bytes):
        steps = [(send_after, send)]
    elif send:
        steps = list(send)
    resizes = list(resize) if resize else []
    pid, fd = pty.fork()
    if pid == 0:
        if oneshot:
            os.environ['MERCURY_SPLASH_ONESHOT'] = '1'
        os.environ['TERM'] = 'xterm-256color'
        # hermetic default across ALL FOUR home spellings — the splash resolves
        # the explicit-first ladder, so an inherited MERCURY_CONFIG_DIR/
        # MERCURY_CONFIG_DIR (the pooled gate exports them) would outrank a
        # MERCURY_HOME-only pin and route reads/WRITES at the operator's real
        # home (the second-eyes adjudication: pooled runs clobbered
        # ~/.claude/boot-env.json). env_extra overrides; a bare MERCURY_HOME
        # override retargets every spelling.
        home_pin = (env_extra or {}).get('MERCURY_HOME', EMPTY_HOME)
        for spelling in ('MERCURY_HOME', 'MERCURY_CONFIG_DIR'):
            os.environ[spelling] = home_pin
        # Ambient-state pin: an operator-exported MERCURY_FULLSCREEN would
        # outrank the compat pins at the splash's canonical-first pair decode.
        os.environ.pop('MERCURY_FULLSCREEN', None)
        # Hermeticity: TERM_PROGRAM is popped so an ambient value on the
        # dev host can never steer a leg — a per-host arm keyed on it once
        # flipped the generic pins (the round-6 lesson); any future leg that
        # needs a host identity passes it explicitly.
        os.environ.pop('TERM_PROGRAM', None)
        for k, v in (env_extra or {}).items():
            os.environ[k] = v
        if cwd:
            os.chdir(cwd)
        os.execvp('node', ['node', SPLASH])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    out = b''
    t0 = time.time()
    sent = 0
    resized = 0
    while time.time() - t0 < (run_for if run_for else 15):
        if sent < len(steps) and time.time() - t0 >= steps[sent][0]:
            os.write(fd, steps[sent][1])
            sent += 1
        if resized < len(resizes) and time.time() - t0 >= resizes[resized][0]:
            _, rc, rr = resizes[resized]
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rr, rc, 0, 0))
            import signal as _sig
            os.kill(pid, _sig.SIGWINCH)
            resized += 1
        import select as _sel
        r, _, _ = _sel.select([fd], [], [], 0.2)
        if fd not in r:
            if sent >= len(steps):
                # child may have exited; probe
                try:
                    done, status = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    break
                if done:
                    break
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out += data
    if run_for:
        import signal as _sig
        try:
            os.kill(pid, _sig.SIGKILL)
        except ProcessLookupError:
            pass
    os.close(fd)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    return out.decode('utf-8', 'replace')


# CSI (SGR/cursor) + OSC (window title, OSC 11 background — terminated by
# BEL or ST): both are zero-width; counting OSC bytes as visible text made
# every width leg read 13 cols fat the day the oasis OSC 11 ground landed.
STRIP = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\\\)')


def vis_lines(raw):
    return [STRIP.sub('', l) for l in raw.replace('\r', '').split('\n')]


print('=' * 60)
print(' enter-screen splash — byte contract proof')
print('=' * 60)

# ── source contract: the WORD grid's hand-corrected Y ────────────────────────
# The reference PNG extracts a 4-wide, LOPSIDED Y (join at cols 1-2, stem right
# of the arms' axis — the operator-reported defect). The grid in the mjs is
# hand-corrected to the canonical 5-wide symmetric glyph with the 'd' mid-red
# baseline row; a re-bake (extract-logo.py) that clobbers the block goes RED
# here instead of shipping the crooked letter back.
print('\n── SOURCE (WORD grid: the corrected Y survives re-bakes)')
# Ruling-1 split: the WORD grid + RAMP live in the CORE — the source pins
# grep the core+driver pair (round 7: no gradient side remains; the flat
# ground's own source census is prove-ramp-parity §6).
_mjs = open(CORE, encoding='utf-8').read() + '\n' + open(SPLASH, encoding='utf-8').read()
_m = re.search(r"WORD-GRID-START.*?const WORD = \[(.*?)\]", _mjs, re.S)
check('WORD grid block present', bool(_m))
if _m:
    _rows = re.findall(r"'([Rd.]+)'", _m.group(1))
    check('WORD grid is 6 rows × 53 cols', len(_rows) == 6 and all(len(r) == 53 for r in _rows),
          f'rows={len(_rows)} widths={sorted(set(len(r) for r in _rows))}')
    _y = [r[48:53] for r in _rows[:5]]
    check("the Y is the 5-wide symmetric glyph (shaded 'd' baseline)",
          _y == ['R...R', 'R...R', '.RRR.', '..R..', '..d..'], f'got={_y}')
    check("the baseline row speaks the head's ink language (all 'd', no 'R')",
          'R' not in _rows[4] and 'd' in _rows[4])

print('\n── STANDARD @120×44')
raw = run_pty(120, 44)
lines = vis_lines(raw)
check('half-block head cells present', any(c in raw for c in '▀▄█'))
check('the (>_) rule present', '(>_)' in raw and '─' in raw)
check('hint present (↵ start)', HINT_RE.search(raw) is not None)
check('every visible line fits 120 cols', all(len(l) <= 120 for l in lines), f'max={max(len(l) for l in lines)}')
check('head engaged (tall lockup ≥ 20 lines)', sum(1 for l in lines if l.strip()) >= 20)
check('cursor hidden + restored', '\x1b[?25l' in raw and '\x1b[?25h' in raw)
check('truecolor SGRs emitted', '\x1b[38;2;' in raw)

print('\n── HEADLESS-CARD @80×24 (ladder inversion: actions outrank art)')
# The macOS-default window gets the LAUNCHER, never the head art. The strip is
# a LADDER decision, not a fixture. RE-CUT: the
# empty proof home composes SIX action rows now (the kit door L24(5) and the
# Saturn Scheduler row grew the card past the old 4-row premise — the leg was
# red since the kit door landed; a control run showed the same bytes) — the tight
# card + strip genuinely no longer fit 24 rows, so the ladder does its
# ratified job HERE too: the strip sheds FIRST and every action row survives
# (actions outrank the readout). The populated leg below still proves the
# same ORDER under deeper pressure.
# the deck is the INLINE world's surface now — pinned explicitly.
# GLOW: the deck greets with the ~10 s ramp shimmer, so every
# INLINE capture also pins reduced motion — deck legs grade the SETTLED
# composition (the greeting's own fixed point), byte-stable by construction.
# The dedicated GLOW legs below opt back out ('0') to grade the motion.
INLINE = {'MERCURY_FULLSCREEN': '0', 'MERCURY_REDUCED_MOTION': '1'}
raw = run_pty(80, 24, env_extra=dict(INLINE))
lines = vis_lines(raw)
plain80 = STRIP.sub('', raw)
check('rule + hint present', '(>_)' in raw and HINT_RE.search(raw) is not None)
check('launcher card present (New Session row — the bare-↵ path made visible)',
      'New Session' in plain80)
check('head art dropped (no cream head SGR — actions outrank art)', '38;2;240;232;214' not in raw)
check('the six-row card sheds the strip FIRST (no Model row — actions outrank the readout)', 'Model' not in plain80)
# RE-DERIVED: the Logins row joined the run and the Resume
# row became the merged 'Sessions · Projects' door — the survival set is
# the recut card's own.
# RE-DERIVED: the Agents row joined the run under kit.
check('every action row survives the empty-home shed',
      all(s in plain80 for s in ('New Session', 'Boot Menu', 'MCPs & Skills', 'Agents',
                                 'Doctor / Health Check', 'Saturn Scheduler', 'Logins', 'Sessions · Projects')))
check('fits the 24-row window', sum(1 for l in lines if l.strip()) <= 23,
      f"lines={sum(1 for l in lines if l.strip())}")
check('every visible line fits 80 cols', all(len(l) <= 80 for l in lines), f'max={max(len(l) for l in lines)}')

print('\n── HEADLESS-CARD @80×24 under PRESSURE (populated home: strip sheds before the card)')
# Two recent projects grow the card (+Continue +Projects → 6 rows): tight card
# + strip no longer fit 24 rows. The shed ORDER is the contract — the strip
# goes first, every action row survives.
pop_home = make_populated_home()
raw = run_pty(80, 24, env_extra={'MERCURY_HOME': pop_home, **INLINE})
lines = vis_lines(raw)
plain80 = STRIP.sub('', raw)
check('card grew (Continue Last Session row present)', 'Continue Last Session' in plain80)
# RE-DERIVED: the standalone Projects row folded into the
# merged door — the squeeze list names the recut rows exactly.
check('every action row survives the squeeze (New/Menu/Doctor/Logins/Sessions · Projects)',
      all(s in plain80 for s in ('New Session', 'Boot Menu', 'Doctor', 'Logins', 'Sessions · Projects')))
check('strip shed FIRST (no Model row under pressure)', 'Model' not in plain80)
check('fits the 24-row window', sum(1 for l in lines if l.strip()) <= 23,
      f"lines={sum(1 for l in lines if l.strip())}")
check('every visible line fits 80 cols', all(len(l) <= 80 for l in lines), f'max={max(len(l) for l in lines)}')

print('\n── COMPACT @45×12 (one-line brand)')
raw = run_pty(45, 12)
lines = [l for l in vis_lines(raw) if l.strip()]
check('exactly one visible line', len(lines) == 1, f'got {len(lines)}')
check('brand + hint on it', lines and 'MERCURY' in lines[0] and HINT_RE.search(lines[0]) is not None)
check('fits 45 cols', lines and len(lines[0]) <= 45, f'len={len(lines[0]) if lines else 0}')

print('\n── RESIZE: the waiting deck recomposes the ladder (alt-screen lifetime)')
# The waiting world is inline now; the fullscreen resize-mid-animation law
# (abort to the exit path) is prove-ripple-drain's resize leg.
raw = run_pty(220, 50, env_extra=dict(INLINE), oneshot=False, resize=[(0.8, 80, 24)], run_for=2.2)
check('alt screen entered exactly once', raw.count('\x1b[?1049h') == 1, f"count={raw.count(chr(27)+'[?1049h')}")
check('resize repainted from a clean slate (≥2 clears)', raw.count('\x1b[2J') >= 2, f"clears={raw.count(chr(27)+'[2J')}")
post = raw.split('\x1b[2J')[-1]
check('post-resize keeps rule + hint (headless-card tier)', '(>_)' in post and HINT_RE.search(post) is not None)
check('post-resize dropped the head (no cream head SGR)', '38;2;240;232;214' not in post)
lines_post = [l for l in vis_lines(post) if l.strip()]
check('post-resize fits 80 cols', all(len(l) <= 80 for l in lines_post),
      f"max={max((len(l) for l in lines_post), default=0)}")

print('\n── the AUTO trace: fullscreen boots animate UNPROMPTED → brand line')
raw = run_pty(100, 34, oneshot=False)
# The launch animation is the CODE-TRACE since (operator redesign
# — flowing code glyphs tracing to the corners replaced the ember ripple);
# since it runs on its own tick — no ↵, no waiting state.
check('code-trace ran (code glyphs in the wave)', any(g in raw for g in ('{', '};', '=>', '();')))
check('screen cleared and settled to the brand line', 'starting' in raw and '\x1b[2J' in raw)
raw = run_pty(100, 34, env_extra={'MERCURY_REDUCED_MOTION': '1'}, oneshot=False)
# The no-motion needle is the CODE-TRACE signature (mirrors the motion leg
# above), NOT the ✶ family — the launcher card's static New-Session icon IS
# a ✶ since the ladder inversion put the card on this geometry.
check('reduced motion ⇒ NO code-trace, straight collapse to the brand line',
      'starting' in raw and not any(g in raw for g in ('{', '};', '=>', '();')))

print('\n── the handoff hold (the lock-break fix): exit re-enters alt, arms 1007')
# The exit byte contract: ?1049l → brand line (real scrollback) → ?1049h +
# ?1007h + holding line, ONE write — the main screen exists for zero
# interactive instants, so a wheel tick during the dist boot can never scroll
# Apple Terminal into saved lines (the "lock is not persistent" class).
leave = raw[raw.rindex('\x1b[?1049l'):]
check('exit leaves alt exactly once, then RE-ENTERS (handoff hold)',
      leave.count('\x1b[?1049h') == 1, f"re-enters={leave.count(chr(27)+'[?1049h')}")
check('brand line lands on the MAIN screen (between leave and re-enter)',
      'MERCURY' in leave[:leave.index('\x1b[?1049h')])
check('alternate-scroll (1007) armed for the boot window',
      '\x1b[?1007h' in leave[leave.index('\x1b[?1049h'):])
check('holding line painted in the held alt screen',
      'starting' in leave[leave.index('\x1b[?1049h'):])
# The retired foreign spelling, composed so this prover never matches a
# vocabulary sweep: its falsy value is IGNORED — the handoff hold stands.
_cc_flicker = '_'.join(['CLAUDE', 'CODE']) + '_NO_FLICKER'
raw_foreign = run_pty(100, 34, env_extra={'MERCURY_REDUCED_MOTION': '1', _cc_flicker: '0'},
                     send=b'\r', oneshot=False)
tail_foreign = raw_foreign[raw_foreign.rindex('\x1b[?1049l'):]
check('the retired foreign inline spelling is IGNORED (handoff hold stands)',
      '\x1b[?1049h' in tail_foreign)

print('\n── code-trace coverage (task #6: fill to edges) + frame atomicity')
# A 120×40 AUTO run (the trace runs unprompted; a ↵ would SKIP
# and truncate the fleet): cursor-address every trace write; the fleet +
# spawn spread + edge-riding must reach every EDGE of the window (row/col
# mins and maxes), and the etched residue (permanent '·' wake) must
# accumulate. Frames are DEC-2026 bracketed, balanced h/l.
import re as _re
raw_cov = run_pty(120, 40, oneshot=False)
check('handoff hold reached (starting)', 'starting' in raw_cov)
# The trace is the ONLY DEC-2026-bracketed writer, so its first ?2026h is the
# honest left boundary (review: an `x and 0` slice silently started
# at byte 0, letting pre-↵ view paints satisfy the edge legs vacuously).
trace_seg = raw_cov[raw_cov.index('\x1b[?2026h'):raw_cov.rindex('\x1b[?1049l')]
addrs = [(int(r), int(c)) for r, c in _re.findall(r'\x1b\[(\d+);(\d+)H', trace_seg)]
if addrs:
    rows_seen = [a[0] for a in addrs]
    cols_seen = [a[1] for a in addrs]
    check('trace reaches the TOP edge (min row ≤ 2)', min(rows_seen) <= 2, f'min={min(rows_seen)}')
    check('trace reaches the BOTTOM edge (max row ≥ 39)', max(rows_seen) >= 39, f'max={max(rows_seen)}')
    check('trace reaches the LEFT edge (min col ≤ 2)', min(cols_seen) <= 2, f'min={min(cols_seen)}')
    check('trace reaches the RIGHT edge (max col ≥ 119)', max(cols_seen) >= 119, f'max={max(cols_seen)}')
else:
    check('trace emitted cursor-addressed writes', False)
check('etched residue accumulates (·-wake writes present)', trace_seg.count('·') > 40,
      f'count={trace_seg.count(chr(0xB7))}')
check('sync-output brackets balanced (?2026h == ?2026l)',
      raw_cov.count('\x1b[?2026h') == raw_cov.count('\x1b[?2026l') and raw_cov.count('\x1b[?2026h') > 0,
      f"h={raw_cov.count(chr(27)+'[?2026h')} l={raw_cov.count(chr(27)+'[?2026l')}")

print('\n── ONE-SCENE: the brand never re-parks, never jumps')
# The A6 class — the wordmark jumping rows at the most-watched moment of the
# boot — is structurally retired by the one-scene rework: the cinematic run paints the composed hero ONCE at arrival,
# the trace routes AROUND it (the one-line ' (>_) MERCURY ' re-park no
# longer exists in this world), and the handoff hold repaints the SAME
# composition at the live size. Contract: zero brand re-parks in the whole
# cinematic run, and the divider row (the composition's spine) sits on the
# SAME absolute row in the arrival frame and in the hold repaint.
_brand_rows = set()
for mm in _re.finditer(r'\x1b\[(\d+);\d+H(?:\x1b\[[0-9;]*m)* \(>_\) ', raw_cov):
    _brand_rows.add(int(mm.group(1)))
check('the one-line brand re-park is retired (zero parks in the cinematic run)',
      len(_brand_rows) == 0, f'rows={sorted(_brand_rows)}')
_sgr_re = _re.compile(r'\x1b\[[0-9;]*m')
_arrival_row = None
_arr_body = raw_cov[raw_cov.index('\x1b[2J\x1b[H') + len('\x1b[2J\x1b[H'):].split('\x1b[?2026l')[0]
for _i, _ln in enumerate(_arr_body.split('\n')):
    if '··· (>_) ···' in _sgr_re.sub('', _ln):
        _arrival_row = _i + 1  # 1-based terminal row (H homed the paint)
        break
_hold_row = None
_hold_parts = _re.split(r'\x1b\[(\d+);1H', raw_cov[raw_cov.rindex('\x1b[2J'):])
for _j in range(1, len(_hold_parts) - 1, 2):
    if '··· (>_) ···' in _sgr_re.sub('', _hold_parts[_j + 1]):
        _hold_row = int(_hold_parts[_j])
        break
check('the hold repaints the divider on the arrival row (no jump into the hold)',
      _arrival_row is not None and _hold_row == _arrival_row,
      f'arrival={_arrival_row} hold={_hold_row}')

print("\n── echo-guard (task #6: the leaked-'p' flash): the hold screen parks the ink")
hold_seg = raw_cov[raw_cov.rindex('starting'):]
check('hold screen ends with the cursor HIDDEN (no ?25h after the hold line)',
      '\x1b[?25h' not in hold_seg and '\x1b[?25l' in hold_seg)
# The park ink rides the adopted family ground: this run has no stored
# theme, so the default appearance (True Black) parks black-on-black.
check('hold screen parks the SGR ink in the default ground (echoed keys land invisible)',
      '\x1b[38;2;0;0;0m\x1b[48;2;0;0;0m' in hold_seg or '\x1b[8m' in hold_seg)
check('the escape-hatch hint stays readable (written BEFORE the park)',
      'stuck? type: reset' in raw_cov)

print('\n── boot menu (Slice D): view, saved-state preload, env pin, save file')
import json
import shutil
import tempfile
home = tempfile.mkdtemp(prefix='splash-menu-home-')
try:
    raw = run_pty(100, 34, {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home})
    # SGR codes split ramp-crossing needles: body cells composite the canvas
    # per cell, so text on the side-ease
    # ramps carries a bg run per cell — match rendered text, not raw bytes.
    plain = STRIP.sub('', raw)
    check('menu one-shot renders the boot menu', 'boot menu' in plain and 'Run discipline (THEMIS)' in plain)
    check('menu footer contract present', 'change (saved)' in raw and 's launch' in raw and 'esc back' in raw)
    lines = vis_lines(raw)
    check('menu fits 100 cols', all(len(l) <= 100 for l in lines), f'max={max(len(l) for l in lines)}')
    check('deck hint offers the menu at full size (inline waiting world)',
          'm menu' in run_pty(120, 44, {'MERCURY_HOME': home, **INLINE}))
    check('compact never offers the menu (too small)', 'm menu' not in run_pty(45, 12, {'MERCURY_HOME': home, **INLINE}))
    # the CINEMATIC frame never advertises m — the key is dead
    # during the animation (the runtime Boot face owns the menu key now).
    check('cinematic frame never advertises m (fullscreen: the animation owns the frame)',
          'm menu' not in run_pty(120, 44, {'MERCURY_HOME': home}))

    # saved choices initialize the menu (preload enforce, expect it shown)
    with open(os.path.join(home, 'boot-env.json'), 'w') as f:
        json.dump({'version': 1, 'savedAt': 'x', 'env': {'MERCURY_THEMIS': 'enforce'}}, f)
    raw = run_pty(100, 34, {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home})
    check('saved boot-env preloads the selection (enforce shown)', 'enforce' in raw)
    os.unlink(os.path.join(home, 'boot-env.json'))

    # explicit real env is surfaced as the winner on the row
    raw = run_pty(100, 34, {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home, 'MERCURY_THEMIS': 'warn'})
    check('env-pinned row says the real env wins', 'env=warn wins' in raw)

    # the REAL contract: cycling a row SAVES it —
    # the visible menu state is the saved state. The old only-`s`-saves grammar
    # silently discarded a row that still read as changed (the operator's
    # "toggled on but session reads UNSET" report — the dishonest-cue class).
    raw = run_pty(100, 34, {'MERCURY_HOME': home, 'MERCURY_REDUCED_MOTION': '1', **INLINE},
                  send=[(0.6, b'm'), (1.2, b'\r'), (1.8, b's')], oneshot=False)
    saved_path = os.path.join(home, 'boot-env.json')
    check('m → cycle → s launches (brand line)', 'starting' in raw)
    saved = None
    if os.path.exists(saved_path):
        with open(saved_path) as f:
            saved = json.load(f)
    # declutter: the cockpit-combo rows left the menu, so the
    # first row (and this journey's cycle target) is Content-rule wards.
    check('cycle wrote boot-env.json {version:1, env:{MERCURY_WARDS: 0}} (canonical key — the first row is Content-rule wards)',
          bool(saved) and saved.get('version') == 1 and saved.get('env', {}).get('MERCURY_WARDS') == '0',
          json.dumps(saved.get('env')) if saved else 'no file')
    os.unlink(saved_path)

    # the reported-bug repro: cycle → esc → ↵ launch — the cycled value MUST survive
    raw = run_pty(100, 34, {'MERCURY_HOME': home, 'MERCURY_REDUCED_MOTION': '1', **INLINE},
                  send=[(0.6, b'm'), (1.2, b'\r'), (1.8, b'\x1b'), (2.4, b'\r')], oneshot=False)
    saved = None
    if os.path.exists(saved_path):
        with open(saved_path) as f:
            saved = json.load(f)
    check('m → cycle → esc → ↵: the cycled choice SURVIVED (write-through)',
          'starting' in raw and bool(saved) and saved.get('env', {}).get('MERCURY_WARDS') == '0',
          json.dumps(saved.get('env')) if saved else 'no file')
    os.unlink(saved_path)

    # browsing alone stays a no-op: m → esc → ↵ with NO cycle writes nothing
    raw = run_pty(100, 34, {'MERCURY_HOME': home, 'MERCURY_REDUCED_MOTION': '1', **INLINE},
                  send=[(0.6, b'm'), (1.2, b'\x1b'), (1.8, b'\r')], oneshot=False)
    check('m → esc → ↵ without cycling writes nothing', 'starting' in raw and not os.path.exists(saved_path))

    # ── the small-terminal tier + the geometry-aware detail ─────
    print('\n── windowed menu (small terminals) + detail un-clip (tall windows)')
    # a 20-row window still gets the menu, WINDOWED behind a scroll indicator
    raw = run_pty(80, 20, {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home})
    plain = STRIP.sub('', raw)  # SGR codes split ramp-crossing needles
    check('short window still offers the menu (windowed)',
          'boot menu' in plain and 'Content-rule wards' in plain)
    check('scroll indicator marks the hidden tail', 'more' in plain)
    # a 24-row inline deck now advertises m (the menu is reachable there)
    raw = run_pty(80, 24, {'MERCURY_HOME': home, **INLINE})
    check('24-row deck advertises m menu', 'm menu' in raw)
    # cycling inside the WINDOWED menu still write-through saves
    raw = run_pty(80, 18, {'MERCURY_HOME': home, 'MERCURY_REDUCED_MOTION': '1', **INLINE},
                  send=[(0.6, b'm'), (1.2, b'\r'), (1.8, b's')], oneshot=False)
    saved3 = None
    if os.path.exists(saved_path):
        with open(saved_path) as f:
            saved3 = json.load(f)
    check('windowed menu cycle still write-through saves',
          bool(saved3) and saved3.get('env', {}).get('MERCURY_WARDS') == '0',
          json.dumps(saved3.get('env')) if saved3 else 'no file')
    if os.path.exists(saved_path):
        os.unlink(saved_path)
    # a TALL window renders the longest detail un-clipped (the head yields
    # to the detail when both can't fit — the operator report)
    # Since the THEMIS default-on move, ↓×2 lands Run discipline
    # (THEMIS) — now the longest detail in the navigated cluster (its authored
    # copy is budgeted to the pane; the old ↓×4 Autopilot landing shifted when
    # THEMIS joined the trust combo). 70 rows keeps the un-clip invariant
    # tested against the genuinely longest navigated detail, with margin for
    # authored-copy drift.
    raw = run_pty(150, 70, {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home, 'MERCURY_REDUCED_MOTION': '1'},
                  send=[(0.7, b'j'), (0.9, b'j'), (2.2, b'\x03')], oneshot=False)
    # AMENDED tail (the byte, not the law): the default
    # clamp hint stopped naming a repo doc — the negative needle follows
    # the new spelling so a clipped frame can never pass unseen.
    check('tall window renders the longest navigated detail UN-clipped (THEMIS)',
          'Run discipline' in STRIP.sub('', raw) and 'When off' in raw and 'clipped' not in raw and 'the trail continues' not in raw)

finally:
    shutil.rmtree(home, ignore_errors=True)

print('\n── launcher card + status strip (the enter-screen redesign)')
home2 = tempfile.mkdtemp(prefix='splash-card-home-')
projdir = tempfile.mkdtemp(prefix='splash-card-proj-')
try:
    enc = projdir.replace('/', '-')
    os.makedirs(os.path.join(home2, 'projects', enc), exist_ok=True)
    with open(os.path.join(home2, 'projects', enc, 'aaaa.jsonl'), 'w') as f:
        f.write(json.dumps({'cwd': projdir, 'sessionId': 'aaaa', 'type': 'user'}) + '\n')
    env2 = {'MERCURY_HOME': home2, 'MERCURY_REDUCED_MOTION': '1', **INLINE}
    raw = run_pty(120, 50, env2)
    plain = STRIP.sub('', raw)  # SGR codes split multi-color needles
    # RE-PINNED: the Resume row is the merged door and the
    # Logins row joined the tier.
    # RE-PINNED: the Agents row joined the tier under kit.
    check('card renders at the standard tier (continue · menu · agents · doctor · logins · sessions)',
          'Continue Last Session' in plain and 'Boot Menu' in plain and 'Doctor / Health Check' in plain
          and 'Agents' in plain and 'Logins' in plain and 'Sessions · Projects' in plain)
    check('status strip present (Model · Theme · Dir)',
          'Model' in plain and 'Theme' in plain and 'Dir' in plain)
    check('ready line advertises the card (↑↓ choose) only when shown', '↑↓ choose' in plain)
    lines = vis_lines(raw)
    check('card tier fits 120 cols', all(len(l) <= 120 for l in lines),
          f'max={max(len(l) for l in lines)}')
    raw = run_pty(100, 34, env2)
    plain = STRIP.sub('', raw)
    check('card PRESENT at 100×34 (ladder inversion: the head art drops, the actions stay)',
          'Continue Last Session' in plain and '↑↓ choose' in plain)
    # ↓×5 (continue → menu → kit → agents → doctor) then ↵ ⇒ the action
    # file + launch. RE-DERIVED: the Agents row joined the
    # card directly under MCPs & Skills (the ruled under-kit position), so
    # the Doctor stretch grew one step.
    raw = run_pty(120, 50, env2,
                  send=[(0.6, b'\x1b[B'), (0.9, b'\x1b[B'), (1.2, b'\x1b[B'), (1.5, b'\x1b[B'), (1.8, b'\x1b[B'), (2.2, b'\r')],
                  oneshot=False)
    act_path = os.path.join(home2, 'splash-action.json')
    act = None
    if os.path.exists(act_path):
        with open(act_path) as f:
            act = json.load(f)
    check('↓×5 ↵ activates Doctor: splash-action.json {action: doctor} + launch',
          'starting' in raw and bool(act) and act.get('version') == 1 and act.get('action') == 'doctor',
          json.dumps(act) if act else 'no file')
    # the plain-text twin is RETIRED at the writer — the
    # launchers consume the EXIT CODE, the RUNTIME consumes the JSON; the
    # 1.5.4 cmd `set /p` reader aborted its whole batch parsing the twin.
    # The twin's ABSENCE is the class ratchet now.
    txt_path = os.path.join(home2, 'splash-action.txt')
    check('NO plain-text twin is written (BM-30 — the txt protocol is retired)',
          not os.path.exists(txt_path))
    # ↓×4 ↵ ⇒ the Agents row (new → continue → menu → kit →
    # agents) — the studio layer is RUNTIME-ONLY, so the launcher hands
    # over with the `agents` receipt action (the kit door's law).
    raw = run_pty(120, 50, env2,
                  send=[(0.6, b'\x1b[B'), (0.9, b'\x1b[B'), (1.2, b'\x1b[B'), (1.5, b'\x1b[B'), (1.9, b'\r')],
                  oneshot=False)
    act = None
    if os.path.exists(act_path):
        with open(act_path) as f:
            act = json.load(f)
    check('↓×4 ↵ activates Agents: splash-action.json {action: agents}',
          bool(act) and act.get('version') == 1 and act.get('action') == 'agents',
          json.dumps(act) if act else 'no file')
    # ↑ ↵ ⇒ the merged 'Sessions · Projects' door (the LAST row — one ↑
    # wraps to it, row-count- and timing-tolerant): the WIRE WORD stays
    # {action: resume} BY DESIGN (an older runtime opens
    # its resume screen honestly; this one opens the merged screen).
    raw = run_pty(120, 50, env2,
                  send=[(0.6, b'\x1b[A'), (1.2, b'\r')],
                  oneshot=False)
    act = None
    if os.path.exists(act_path):
        with open(act_path) as f:
            act = json.load(f)
    check('the merged sessions row activates: splash-action.json {action: resume}',
          bool(act) and act.get('action') == 'resume', json.dumps(act) if act else 'no file')
    # ↓×8 ↵ ⇒ Session Concourse (new → continue → menu → kit → agents →
    # doctor → saturn → logins → concourse) — the one-shot 'Open Concourse
    # once' receipt. RE-PINNED: kit + Saturn joined the
    # stretch. RE-DERIVED: Logins joined — ↓×7.
    # RE-DERIVED: the Agents row joined under kit — ↓×8 now.
    raw = run_pty(120, 50, env2,
                  send=[(0.6, b'\x1b[B'), (0.9, b'\x1b[B'), (1.2, b'\x1b[B'), (1.5, b'\x1b[B'),
                        (1.8, b'\x1b[B'), (2.1, b'\x1b[B'), (2.4, b'\x1b[B'), (2.7, b'\x1b[B'), (3.1, b'\r')],
                  oneshot=False)
    act = None
    if os.path.exists(act_path):
        with open(act_path) as f:
            act = json.load(f)
    check('↓×8 ↵ activates Session Concourse: splash-action.json {action: concourse}',
          bool(act) and act.get('version') == 1 and act.get('action') == 'concourse',
          json.dumps(act) if act else 'no file')
    # ↓ ↵ ⇒ Continue, carrying the session's dir for the launcher cd
    raw = run_pty(120, 50, env2, send=[(0.6, b'\x1b[B'), (1.2, b'\r')], oneshot=False)
    act = None
    if os.path.exists(act_path):
        with open(act_path) as f:
            act = json.load(f)
    check('↓ ↵ activates Continue: action carries the session dir',
          bool(act) and act.get('action') == 'continue' and act.get('dir') == projdir,
          json.dumps(act) if act else 'no file')
    txt_lines = []
    check('still no plain-text twin beside the continue action (BM-30)',
          not os.path.exists(txt_path))
    os.unlink(act_path)
    # plain ↵ (nothing selected) boots straight. 3.6.2 via: the
    # SETTLED screen receipt writes on EVERY interactive settle — a plain
    # boot leaves a RECEIPT-ONLY JSON (no action key, screen fact present)
    # for the RUNTIME consumer; the startup stale-clean removed
    # the previous leg's leftover BEFORE this run, so what exists after
    # settle is THIS run's receipt. The handoff also stamps the
    # boot-completion beacon (REC-4: the attempt half).
    raw = run_pty(120, 50, env2, send=b'\r', oneshot=False)
    receipt = None
    try:
        with open(act_path) as f: receipt = json.load(f)
    except OSError:
        pass
    check('plain ↵ boots with a RECEIPT-ONLY JSON (no action key — zero added friction)',
          'starting' in raw and bool(receipt) and 'action' not in receipt,
          json.dumps(receipt) if receipt else 'no file')
    check('startup stale-clean replaced the leftover with THIS run\'s receipt (screen fact present, stale action gone)',
          bool(receipt) and receipt.get('screen') in ('held', 'restored'),
          json.dumps(receipt) if receipt else 'no file')
    check('a handoff stamps the boot-attempt beacon (BM-30/REC-4)',
          os.path.exists(os.path.join(home2, 'boot-attempts.json')))
    # the launcher-minted launch id crosses env-down and lands in the
    # receipt — the runtime applies only its own launch's receipt.
    raw = run_pty(120, 50, {**env2, 'MERCURY_LAUNCH_ID': 'drill-lh01'}, send=b'\r', oneshot=False)
    receipt = None
    try:
        with open(act_path) as f: receipt = json.load(f)
    except OSError:
        pass
    check('the receipt embeds the launcher-minted launch id (LH-01)',
          bool(receipt) and receipt.get('launchId') == 'drill-lh01',
          json.dumps(receipt) if receipt else 'no file')
finally:
    shutil.rmtree(home2, ignore_errors=True)
    shutil.rmtree(projdir, ignore_errors=True)

print("\n── status strip MODEL truth (the stale 'Opus 4.8' family regex)")
# The strip's Model value resolves through the BAKED owner table
# (MERCURY-MODEL-NAMES — bake-menu.mjs, from src/utils/model owners), never a
# hand family regex: the operator's claude-opus-5 settings pin rendered as
# 'Opus 4.8' (the STALE-COPY class prove-model-truth.ts hunts, out of its
# reach in this standalone asset). Each leg pins a scratch home carrying the
# settings under proof and reads the rendered strip.


def strip_with_model(model_value):
    home = tempfile.mkdtemp(prefix='splash-model-home-')
    try:
        with open(os.path.join(home, 'settings.json'), 'w') as f:
            json.dump({'model': model_value}, f)
        return STRIP.sub('', run_pty(120, 50, {'MERCURY_HOME': home, 'MERCURY_REDUCED_MOTION': '1', **INLINE}))
    finally:
        shutil.rmtree(home, ignore_errors=True)


plain = strip_with_model('claude-opus-5')
check("settings claude-opus-5 renders 'Opus 5' (the live catalogue name)",
      'Opus 5' in plain and 'Opus 4.8' not in plain)
plain = strip_with_model('claude-opus-5[1m]')
check("the [1m] pin renders 'Opus 5 (1M)'", 'Opus 5 (1M)' in plain)
plain = strip_with_model('opus')
check("the opus ALIAS renders what it boots (Opus 5 — D-02a), never a frozen family",
      'Opus 5' in plain and 'Opus 4.8' not in plain)
plain = strip_with_model('acme-turbo-9')
check('an unknown id renders RAW (never a guessed family name)', 'acme-turbo-9' in plain)

print('\n── the PROJECTS picker RETIRED into the merged door')
home4 = tempfile.mkdtemp(prefix='splash-projects-home-')
projA = tempfile.mkdtemp(prefix='splash-repo-alpha-')
projB = tempfile.mkdtemp(prefix='splash-repo-beta-')
try:
    for i, (p, sid) in enumerate([(projA, 'aaaa'), (projB, 'bbbb')]):
        enc = p.replace('/', '-')
        d = os.path.join(home4, 'projects', enc)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, sid + '.jsonl'), 'w') as f:
            f.write(json.dumps({'cwd': p, 'sessionId': sid, 'type': 'user'}) + '\n')
        t = time.time() - (i + 1) * 3600
        os.utime(os.path.join(d, sid + '.jsonl'), (t, t))
    env4 = {'MERCURY_HOME': home4, 'MERCURY_REDUCED_MOTION': '1', **INLINE}
    # RE-CUT (the operator's merge): the in-splash repo
    # picker died with its card row — the RUNTIME's merged screen hosts the
    # repos as its second container now. The legs assert the retirement:
    # the capture env falls to the lockup, the card wears the merged door
    # with the STANDING words (host truth is runtime-only — no counts on
    # this host), and the last row hands over with the UNCHANGED wire word.
    raw = run_pty(120, 50, dict(env4, MERCURY_SPLASH_VIEW='projects'))
    plain = STRIP.sub('', raw)
    check('the projects capture env falls to the lockup (the view is gone)',
          '◆ Projects' not in plain and '↑↓ pick' not in plain and 'Sessions · Projects' in plain)
    # The card consolidates BOTH old doors into the merged one, standing ctx.
    raw = run_pty(120, 50, env4)
    plain = STRIP.sub('', raw)
    check("the card wears the merged door and neither retired row",
          'Sessions · Projects' in plain and 'pick a session or a repo' in plain
          and 'Recent Project' not in plain and '2 repos' not in plain and 'Resume Session' not in plain)
    # ↑ ↵ wraps to the merged door (the LAST row): the wire word is
    # 'resume' BY DESIGN, and it NEVER carries a dir (the runtime screen
    # owns the repo landing now).
    raw = run_pty(120, 50, env4,
                  send=[(0.6, b'\x1b[A'), (1.2, b'\r')],
                  oneshot=False)
    act_path4 = os.path.join(home4, 'splash-action.json')
    act = None
    if os.path.exists(act_path4):
        with open(act_path4) as f:
            act = json.load(f)
    check('the merged door hands over {action: resume} with NO dir',
          bool(act) and act.get('action') == 'resume' and 'dir' not in act,
          json.dumps(act) if act else 'no file')
    check('the merged flow still launches (starting)', 'starting' in raw)
    # The retirement, structurally: this launcher can no longer WRITE the
    # 'project' action (the word stays consumed runtime-side for stale
    # deployed splashes — the degradation law).
    with open(os.path.join(REPO, 'assets', 'splash', 'mercury-splash.mjs')) as f:
        launcher_src = f.read()
    check("the launcher no longer writes the 'project' action",
          "writeSplashAction('project'" not in launcher_src)
finally:
    shutil.rmtree(home4, ignore_errors=True)
    shutil.rmtree(projA, ignore_errors=True)
    shutil.rmtree(projB, ignore_errors=True)

print('\n── boot menu: the WIDE three-panel layout (image-3 redesign)')
home3 = tempfile.mkdtemp(prefix='splash-widemenu-home-')
try:
    env3 = {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home3}
    raw = run_pty(150, 60, env3)
    for needle in ('CONTROL PLANE', 'SETTING DETAIL', 'LAUNCH SUMMARY', 'ENVIRONMENT',
                   'What it controls', 'System ready', 'MEMORY & MISSIONS'):
        check(f'wide menu carries {needle!r}', needle in raw)
    lines = vis_lines(raw)
    check('wide menu fits 150 cols', all(len(l) <= 150 for l in lines),
          f'max={max(len(l) for l in lines)}')
    raw = run_pty(100, 34, env3)
    check('classic single-column at 100 cols (no panels)',
          'SETTING DETAIL' not in raw and 'boot menu' in raw)
    # write-through through the WIDE path: m → ↵ cycle → esc → ↵ keeps the save
    raw = run_pty(150, 60, {'MERCURY_HOME': home3, 'MERCURY_REDUCED_MOTION': '1', **INLINE},
                  send=[(0.6, b'm'), (1.2, b'\r'), (1.8, b'\x1b'), (2.4, b'\r')], oneshot=False)
    saved3 = None
    p3 = os.path.join(home3, 'boot-env.json')
    if os.path.exists(p3):
        with open(p3) as f:
            saved3 = json.load(f)
    check('WIDE menu write-through: cycle → esc → ↵ keeps the save',
          bool(saved3) and saved3.get('env', {}).get('MERCURY_WARDS') == '0',
          json.dumps(saved3.get('env')) if saved3 else 'no file')
    # LAYOUT-TIER INVARIANT (operator screenshot, "regresses on
    # autopilot"): the wide↔classic choice is a function of TERMINAL SIZE
    # only. Selecting the Autopilot row (the longest detail text) used to
    # grow SETTING DETAIL past rowsAvail and DEMOTE the whole menu to the
    # classic column mid-navigation. The detail panel is now height-budgeted
    # against the fixed left panel (ellipsis row when clipped), so navigating
    # to Autopilot at a wide-eligible size must KEEP the panels.
    # Row index comes from the LIVE registry order (menu edits must not
    # silently retarget this leg — the 'Session companion' insert
    # moved Autopilot from ↓×9 to ↓×10).
    sys.path = sys.path  # (no import needed — count from the baked MENU block)
    with open(CORE) as f:
        baked = f.read()
    autopilot_idx = None
    for i, m in enumerate(re.finditer(r'"label":"([^"]+)"', baked[baked.index('MERCURY-MENU-START'):baked.index('MERCURY-MENU-END')])):
        if m.group(1) == 'Autopilot tier mode':
            autopilot_idx = i
            break
    check('Autopilot row found in the baked menu', autopilot_idx is not None)
    downs = autopilot_idx or 0
    raw = run_pty(150, 46, {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home3,
                            'MERCURY_REDUCED_MOTION': '1'},
                  send=[(0.6 + 0.25 * i, b'\x1b[B') for i in range(downs)],
                  oneshot=False, run_for=0.6 + 0.25 * downs + 1.6)
    last_frame = STRIP.sub('', raw).split('boot menu')[-1]
    check('wide menu SURVIVES selecting Autopilot (tier = size, not selection)',
          'SETTING DETAIL' in last_frame and '❯ Autopilot tier mode' in last_frame,
          'final frame lost the panels' if 'SETTING DETAIL' not in last_frame else 'selection missed')
    # AMENDED tail (the byte, not the law): the clamp row's
    # default spelling is the honest trail sentence now.
    check('over-budget detail clamps with the honest ellipsis row',
          'the trail continues' in last_frame or 'When off' in last_frame)
    # BORDER INTEGRITY: the ENVIRONMENT Dir
    # row would otherwise run THROUGH the panel border when repo name + git tail
    # exceeded the panel width. panelLines now clips every content row
    # (clipVis) and the Dir row sheds its git tail first — so every panel
    # content line must still END on its │ border. Run from a deep long-named
    # cwd to force the old overflow.
    longproj = tempfile.mkdtemp(prefix='splash-a-very-long-repository-directory-name-')
    try:
        raw = run_pty(150, 60, {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home3},
                      cwd=longproj)
        plain_lines = [STRIP.sub('', l) for l in vis_lines(raw)]
        dir_lines = [l for l in plain_lines if ' Dir ' in l or l.strip().startswith('Dir')]
        check('ENVIRONMENT Dir row stays inside its border (clipVis backstop)',
              len(dir_lines) > 0 and all(l.rstrip().endswith('│') for l in dir_lines),
              dir_lines[0] if dir_lines else 'no Dir row found')
    finally:
        shutil.rmtree(longproj, ignore_errors=True)
finally:
    shutil.rmtree(home3, ignore_errors=True)

print('\n── LAUNCH SUMMARY reflects the SAVED choices; env pins agree across layouts')
# The HERMES→MERCURY rename left the wide layout's summary querying retired
# keys no MENU row carries (val() matched row.env only), so the summary
# rendered CONSTANTS — party·helm·console always on, fable never, Integrity
# always off — whatever the operator saved. val() now resolves canonical OR
# legacy, the call sites use canonical keys, and the wide layout's env-pin
# detection adopts the classic layout's canonical-then-legacy precedence.
# Assertions are LINE-scoped (panels share terminal lines — a raw-text slice
# would cross into the CONTROL PLANE column, where 'Router party' etc. live).
home4 = tempfile.mkdtemp(prefix='splash-summary-home-')
try:
    # declutter: helm home/console have NO menu row (default-ON;
    # env is their only off-switch) — the saved file carries party+THEMIS,
    # the run env kills both helm layers, and the chip must reflect all
    # three offs.
    with open(os.path.join(home4, 'boot-env.json'), 'w') as f:
        json.dump({'version': 1, 'env': {
            'MERCURY_PARTY': '0',
            'MERCURY_THEMIS': 'enforce'}}, f)

    def panel_tail(lines, key):
        for l in lines:
            if key in l:
                return l[l.index(key) + len(key):]
        return None

    raw = run_pty(150, 60, {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home4,
                            'MERCURY_HELM_HOME': '0', 'MERCURY_HELM_CONSOLE': '0'})
    plain_lines = [STRIP.sub('', l) for l in vis_lines(raw)]
    harness_tail = panel_tail(plain_lines, 'Harness')
    integrity_tail = panel_tail(plain_lines, 'Integrity')
    check('Harness row reflects the saved offs (was: constants)',
          harness_tail is not None
          and 'party' not in harness_tail and 'helm' not in harness_tail
          and 'console' not in harness_tail,
          repr(harness_tail))
    check('Integrity row reflects the saved THEMIS choice (enforce)',
          integrity_tail is not None and 'enforce' in integrity_tail,
          repr(integrity_tail))
    # A LEGACY env pin must read "env=… wins" in BOTH layouts (the wide
    # layout would otherwise check the canonical spelling only).
    envpin = {'MERCURY_SPLASH_VIEW': 'menu', 'MERCURY_HOME': home4, 'MERCURY_AUTOPILOT': '1'}
    wide = STRIP.sub('', run_pty(150, 60, envpin))
    classic = STRIP.sub('', run_pty(100, 34, envpin))
    check('wide layout shows a legacy env pin (env=1 wins)', 'env=1 wins' in wide)
    check('classic layout agrees on the same pin', 'env=1 wins' in classic)
    # The compat state facet RETIRED with the compat era — its menu row
    # must stay gone (a returning row would mean a compat rung crept back).
    check('the retired state-facet row stays out of the menu', 'state facet' not in wide)
finally:
    shutil.rmtree(home4, ignore_errors=True)

print('\n── the ACTIVATION-INTENT corpus')
# The lockup would otherwise fall through to launch() for EVERY unmatched byte — the
# WILDCARD-ACTIVATION class (the visible hint promises only ↵/m, yet q, Tab,
# Space, digits, F-keys, unmatched CSI, and the first byte of any paste all
# booted the deck). The fix gates activation on a bare CR/LF/CRLF arriving as
# its OWN data event; everything unmatched returns inert. Every corpus item
# declares its EXPECTED outcome and the proof discriminates STRUCTURALLY —
# child-still-alive (waitpid poll), zero post-send paint bytes (an inert key
# writes NOTHING, which subsumes hint-line/selection grid compares), the
# splash-action file, and the exit code — never substring absence alone.


def run_corpus(cols, rows, env_extra=None, steps=None, settle=1.4, resize=None):
    """Boot the splash live (not oneshot), fire timed steps, and observe the
    structure: bytes before/after the LAST send, child liveness after the
    settle window, and the exit code when the child left on its own.
    The corpus laws bind the WAITING deck, which is the inline
    world now — the default pin; a leg may override to the cinematic world."""
    steps = list(steps or [])
    resizes = list(resize or [])
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.environ['MERCURY_REDUCED_MOTION'] = '1'
        os.environ['MERCURY_FULLSCREEN'] = '0'
        home_pin = (env_extra or {}).get('MERCURY_HOME', EMPTY_HOME)
        for spelling in ('MERCURY_HOME', 'MERCURY_CONFIG_DIR'):
            os.environ[spelling] = home_pin
        for k, v in (env_extra or {}).items():
            os.environ[k] = v
        os.execvp('node', ['node', SPLASH])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    import select as _sel
    import signal as _sig
    pre = b''
    post = b''
    last_send_at = max([t for t, _ in steps], default=0.0)
    last_resize_at = max([t for t, _, _ in resizes], default=0.0)
    deadline = max(last_send_at, last_resize_at) + settle
    t0 = time.time()
    sent = 0
    resized = 0
    exit_code = None
    while time.time() - t0 < deadline:
        now = time.time() - t0
        if sent < len(steps) and now >= steps[sent][0]:
            try:
                os.write(fd, steps[sent][1])
            except OSError:
                pass  # child already gone — the structural checks still grade
            sent += 1
        if resized < len(resizes) and now >= resizes[resized][0]:
            _, rc, rr = resizes[resized]
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rr, rc, 0, 0))
            os.kill(pid, _sig.SIGWINCH)
            resized += 1
        r, _, _ = _sel.select([fd], [], [], 0.05)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if data:
                if sent >= len(steps):
                    post += data
                else:
                    pre += data
    alive = True
    try:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            alive = False
            if os.WIFEXITED(status):
                exit_code = os.WEXITSTATUS(status)
    except ChildProcessError:
        alive = False
    if alive:
        try:
            os.kill(pid, _sig.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
    os.close(fd)
    return {'pre': pre, 'post': post, 'alive': alive, 'exit': exit_code}


# Inert corpus on the PLAIN lockup (empty home — no card, so even arrows must
# write nothing). Each entry: (label, the exact bytes of ONE data event).
INERT_PLAIN = [
    ('lower letter x', b'x'),
    ('upper letter Q', b'Q'),
    ("the old any-key favourite 'q'", b'q'),
    ('digit 5', b'5'),
    ("punctuation '.'", b'.'),
    ('Space', b' '),
    ('Tab', b'\t'),
    ('left arrow (unhandled on the lockup)', b'\x1b[D'),
    ('right arrow (unhandled on the lockup)', b'\x1b[C'),
]
# ↑ with NO card on screen: only the COMPACT tier is genuinely card-less
# (even the empty proof home shows the 4-row launcher card at 80×24, where
# ↑/↓ legitimately navigate — the held-repeat leg below owns that world).
r = run_corpus(45, 12, steps=[(0.9, b'\x1b[A')])
check('inert: up arrow on the card-less COMPACT tier — alive, zero post-send paint',
      r['alive'] and r['post'] == b'', f"alive={r['alive']} post={r['post'][:60]!r}")
INERT_PLAIN += [
    ('F1 old-style CSI', b'\x1b[11~'),
    ('F1 SS3 variant', b'\x1bOP'),
    ('F5', b'\x1b[15~'),
    ('unsupported CSI (PageDown)', b'\x1b[6~'),
    ('kitty CSI-u sequence', b'\x1b[=5;1u'),
    ('SGR mouse press outside a live target', b'\x1b[<0;10;5M'),
    ('paste class: printable+CR in ONE write', b'x\r'),
    ('paste class: "x\\r\\n" in ONE write', b'x\r\n'),
    ('paste class: multi-line paste in ONE write', b'line one\rline two\r'),
]
for label, byts in INERT_PLAIN:
    r = run_corpus(80, 24, steps=[(0.9, byts)])
    check(f'inert: {label} — child alive, ZERO post-send paint',
          r['alive'] and r['post'] == b'',
          f"alive={r['alive']} post={r['post'][:60]!r}")

# The deliberate press semantics: a printable then ↵ as SEPARATE events — the
# ↵ is still a press and launches. The inline deck's handoff is the RESTORED
# screen: exit 20.
r = run_corpus(80, 24, steps=[(0.9, b'x'), (1.7, b'\r')], settle=3.0)
check('press: printable then ↵ as SEPARATE events still launches (exit 20, inline restored)',
      not r['alive'] and r['exit'] == 20 and b'starting' in r['pre'] + r['post'],
      f"alive={r['alive']} exit={r['exit']}")
# A bare CRLF arriving as ONE event is a single press (Windows-shaped Enter).
r = run_corpus(80, 24, steps=[(0.9, b'\r\n')], settle=3.0)
check('press: bare CRLF as its own event launches (exit 20, inline restored)',
      not r['alive'] and r['exit'] == 20 and b'starting' in r['pre'] + r['post'],
      f"alive={r['alive']} exit={r['exit']}")
# the cinematic input law: during the animation every byte except
# ^C is inert and can never cause a SECOND launch — a paste's stray printable
# + CR still settles ONE exit-0 handoff (the raw-owner ratchet pins the
# single-launch structure; this is its behavioral witness). The corpus's
# reduced-motion default is lifted so a real animation window exists for the
# mid-flight paste.
r = run_corpus(80, 24, env_extra={'MERCURY_FULLSCREEN': '1', 'MERCURY_REDUCED_MOTION': '0'},
               steps=[(0.3, b'x\r')], settle=4.0)
check('cinematic: a mid-animation paste settles ONE exit-0 handoff',
      not r['alive'] and r['exit'] == 0 and b'starting' in r['pre'] + r['post'],
      f"alive={r['alive']} exit={r['exit']}")

# Esc then an unrelated key: both inert on the plain lockup.
r = run_corpus(80, 24, steps=[(0.9, b'\x1b'), (1.7, b'z')])
check('inert: Esc then an unrelated key — alive, zero post-send paint',
      r['alive'] and r['post'] == b'', f"alive={r['alive']} post={r['post'][:60]!r}")

# Resize (winch) then an unrelated key: the repaint belongs to the resize;
# the key after it must add NOTHING.
r = run_corpus(100, 30, steps=[(1.6, b'z')], resize=[(0.8, 80, 24)])
check('inert: winch repaints, but the unrelated key AFTER it adds nothing',
      r['alive'] and r['post'] == b'', f"alive={r['alive']} post={r['post'][:60]!r}")

# Ctrl-C CANCELS the boot: the splash
# swallows ^C in raw mode (no console signal ⇒ no cmd.exe "Terminate batch
# job" prompt), exits 130 — the EXIT CODE is the one cancel channel the
# launchers consume (they stand down on the number; no shell ever parses the
# receipt) — and restores the MAIN screen: no held alternate buffer, no
# "starting" promise it will not keep. The JSON receipt still records
# action=cancel for diagnostics.
cancel_home = tempfile.mkdtemp(prefix='splash-cancel-home-')
r = run_corpus(80, 24, env_extra={'MERCURY_HOME': cancel_home}, steps=[(0.9, b'\x03')], settle=2.5)
check('Ctrl-C exits 130 (BM-30: the exit code IS the cancel channel)',
      not r['alive'] and r['exit'] == 130, f"alive={r['alive']} exit={r['exit']}")
cancel_raw = (r['pre'] + r['post']).decode('utf-8', 'replace')
check('Ctrl-C never promises the deck (launch cancelled line instead)',
      'starting' not in cancel_raw and 'launch cancelled' in cancel_raw)
if '\x1b[?1049l' in cancel_raw:
    cancel_tail = cancel_raw[cancel_raw.rindex('\x1b[?1049l'):]
    check('Ctrl-C restores the MAIN screen (no held alt re-entry)',
          '\x1b[?1049h' not in cancel_tail)
else:
    check('Ctrl-C left the alternate screen', False)
cancel_act = None
try:
    with open(os.path.join(cancel_home, 'splash-action.json')) as f:
        cancel_act = json.load(f)
except OSError:
    pass
check('Ctrl-C wrote {action: cancel} for the launcher',
      bool(cancel_act) and cancel_act.get('version') == 1 and cancel_act.get('action') == 'cancel',
      json.dumps(cancel_act) if cancel_act else 'no file')
check('Ctrl-C writes NO plain-text twin (BM-30 — the txt protocol is retired)',
      not os.path.exists(os.path.join(cancel_home, 'splash-action.txt')))
check('Ctrl-C stamps NO boot attempt (a cancel is not a handoff — REC-4)',
      not os.path.exists(os.path.join(cancel_home, 'boot-attempts.json')))
_shutil_cancel = __import__('shutil')
_shutil_cancel.rmtree(cancel_home, ignore_errors=True)

# The idle timeout EXITS without launching: collapse(0) here
# would otherwise be the LAUNCH path — half an hour idle booted a full session with
# nobody watching. MERCURY_SPLASH_IDLE_MS is the proof override (≥500ms).
idle_home = tempfile.mkdtemp(prefix='splash-idle-home-')
r = run_corpus(80, 24, env_extra={'MERCURY_HOME': idle_home, 'MERCURY_SPLASH_IDLE_MS': '700'},
               steps=[], settle=3.0)
idle_raw = (r['pre'] + r['post']).decode('utf-8', 'replace')
check('idle timeout exits 130 WITHOUT launching (a cancel, not a handoff — BM-30)',
      not r['alive'] and r['exit'] == 130 and 'starting' not in idle_raw,
      f"alive={r['alive']} exit={r['exit']}")
idle_act = None
try:
    with open(os.path.join(idle_home, 'splash-action.json')) as f:
        idle_act = json.load(f)
except OSError:
    pass
check('idle timeout signals cancel through the action channel',
      bool(idle_act) and idle_act.get('action') == 'cancel',
      json.dumps(idle_act) if idle_act else 'no file')
_shutil_cancel.rmtree(idle_home, ignore_errors=True)

# The split-escape law (best-effort behavioral: the DETERMINISTIC
# state machine is prove-splash-units.ts): a bare ESC still resolves as Escape
# after the coalesce window — sent alone, well past any partial-sequence wait.
r = run_corpus(80, 24, steps=[(0.9, b'\x1b'), (1.7, b'z')])
check('coalescer: bare ESC still resolves (esc semantics kept, z inert after)',
      r['alive'] and r['post'] == b'', f"alive={r['alive']} post={r['post'][:60]!r}")

# ── the CARD world (populated home): navigation stays navigation ────────────
corpus_home = make_populated_home()
corpus_act = os.path.join(corpus_home, 'splash-action.json')

# Held-repeat arrows: a burst of ↓ repeats NAVIGATES (paints selection moves)
# but never activates — child alive, no action file, no launch signature.
r = run_corpus(120, 50, env_extra={'MERCURY_HOME': corpus_home},
               steps=[(0.9 + 0.08 * i, b'\x1b[B') for i in range(6)], settle=1.6)
check('held-repeat ↓ on the card: navigation paints, NO activation',
      r['alive'] and r['post'] != b'' and b'starting' not in r['pre'] + r['post']
      and not os.path.exists(corpus_act),
      f"alive={r['alive']} post_bytes={len(r['post'])}")

# A paste hitting a SELECTED card row must not activate it: ↓ selects, then
# a one-write printable+CR paste stays fully inert (no action file, alive).
r = run_corpus(120, 50, env_extra={'MERCURY_HOME': corpus_home},
               steps=[(0.9, b'\x1b[B'), (1.7, b'y\r')], settle=1.6)
check('paste onto a SELECTED card row: inert (no action file, still alive)',
      r['alive'] and not os.path.exists(corpus_act)
      and b'starting' not in r['pre'] + r['post'],
      f"alive={r['alive']} act={os.path.exists(corpus_act)}")

# Unknown bytes with the card on screen: still zero post-send paint (the
# selection marker cannot have moved if nothing painted).
for label, byts in (('letter x', b'x'), ('Tab', b'\t'), ('F5', b'\x1b[15~')):
    r = run_corpus(120, 50, env_extra={'MERCURY_HOME': corpus_home},
                   steps=[(0.9, byts)])
    check(f'inert with card: {label} — alive, zero post-send paint',
          r['alive'] and r['post'] == b'' and not os.path.exists(corpus_act),
          f"alive={r['alive']} post={r['post'][:60]!r}")

import shutil as _shutil
_shutil.rmtree(corpus_home, ignore_errors=True)

print('\n── refraction RF-3: the continuous word + one capability law')
# The rendered word must walk the LAW the baked RAMP-LAW block pins:
# face(x) = piecewise-lerp(RAMP, x/(W-1)) and deep(x) = round-mix(DEEPRED,
# face(x), 0.5) (depth inherits locality; the left edge IS the
# authored MIDRED). The WORD grid renders as three terminal rows: (0,1) and
# (2,3) full-ink face, (4,5) the 'd' baseline over void.
_ramp_m = re.search(r'const RAMP = (\[\[.*?\]\])', _mjs)
check('baked RAMP block present', bool(_ramp_m))
RAMP_RGB = json.loads(_ramp_m.group(1)) if _ramp_m else []
DEEPRED_RGB = (123, 50, 50)
W53 = 53


def js_round(v):
    # JS Math.round is HALF-UP; python round() is banker's — the .5 halves
    # the mix law produces would silently diverge under round().
    import math
    return math.floor(v + 0.5)


def ramp_sample(u):
    s = min(1.0, max(0.0, u)) * (len(RAMP_RGB) - 1)
    i = min(len(RAMP_RGB) - 2, int(s))
    frac = s - i
    a, b = RAMP_RGB[i], RAMP_RGB[i + 1]
    return tuple(js_round(a[c] + (b[c] - a[c]) * frac) for c in range(3))


def mix_half(a, b):
    return tuple(js_round(a[c] + (b[c] - a[c]) * 0.5) for c in range(3))


def cell_fgs(line):
    """Per-visible-cell fg (r,g,b) tuples for one raw line — escapes update
    the tracked fg; every plain char appends the current one."""
    fgs, fg = [], None
    for m in re.finditer(r'(\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\\\))|(.)', line):
        esc, ch = m.group(1), m.group(2)
        if esc:
            mm = re.match(r'\x1b\[([0-9;]*)m$', esc)
            if mm:
                seq = mm.group(1)
                if seq in ('', '0'):
                    fg = None
                else:
                    m2 = re.match(r'^38;2;(\d+);(\d+);(\d+)$', seq)
                    if m2:
                        fg = tuple(int(x) for x in m2.groups())
        elif ch:
            fgs.append(fg)
    return fgs


# GLOW: the accent is critter-derived now — this section's
# oracle pins the CRAB family's authored anchors (MIDRED, CLAW depth), so the
# leg pins MERCURY_CRITTER=crab explicitly; the FAMILY section below grades
# the unpinned default (jellyfish) and two pinned families against the baked
# family ramps.
raw_rf = run_pty(120, 44, {'MERCURY_CRITTER': 'crab'})
raw_rf_lines = raw_rf.replace('\r', '').split('\n')
word_rows_txt = []
if _m:
    def raster_txt(top, bot):
        s = ''
        for a, b in zip(top, bot):
            ta, tb = a != '.', b != '.'
            s += '█' if ta and tb else '▀' if ta else '▄' if tb else ' '
        return s
    word_rows_txt = [raster_txt(_rows[0], _rows[1]), raster_txt(_rows[2], _rows[3]),
                     raster_txt(_rows[4], _rows[5])]

found = []
for wtxt in word_rows_txt:
    wt = wtxt.rstrip()
    hit = None
    for li, l in enumerate(raw_rf_lines):
        idx = STRIP.sub('', l).find(wt)
        if idx >= 0:
            hit = (li, idx)
            break
    found.append(hit)
check('all three word rows located in the frame', len(found) == 3 and all(found), f'{found}')

# THE SOLID-CELL GLYPH LAW. The guarded class: swapping
# solid art cells to bg-painted SPACES and retuning the
# templates above to match keeps this prover passing while, live, the wordmark
# renders MANGLED (broken, unevenly spaced strokes).
# The fg-█ grammar is the law, and these INVERSE legs refuse the
# excuse shape — a proof that tolerates both renderings is not a pin:
# the two face cell-rows of the authored wordmark must HAVE solid cells, the
# frame must carry them as █ glyphs, and the per-column oracle walk below
# reads their ink as FG — bg-painted spaces fail all three.
check('face word-row templates carry solid █ cells (glyph law is non-vacuous)',
      len(word_rows_txt) == 3 and all('█' in w for w in word_rows_txt[:2]))
check('truecolor frame renders solid art cells as fg █ glyphs (a ZERO-█ frame is the regression)',
      '█' in raw_rf)

if len(found) == 3 and all(found) and RAMP_RGB:
    (li0, off0), (li1, off1), (li2, off2) = found
    fgs0, fgs1, fgs2 = (cell_fgs(raw_rf_lines[li]) for li in (li0, li1, li2))
    ok_face = ok_shared = ok_deep = ok_void = True
    for x in range(W53):
        want = ramp_sample(x / (W53 - 1))
        if _rows[0][x] != '.' or _rows[1][x] != '.':
            if (fgs0[off0 + x] if off0 + x < len(fgs0) else None) != want:
                ok_face = False
        else:
            if (fgs0[off0 + x] if off0 + x < len(fgs0) else None) is not None:
                ok_void = False
        if _rows[2][x] != '.' or _rows[3][x] != '.':
            if (fgs1[off1 + x] if off1 + x < len(fgs1) else None) != want:
                ok_shared = False
        if _rows[4][x] == 'd':
            if (fgs2[off2 + x] if off2 + x < len(fgs2) else None) != mix_half(DEEPRED_RGB, want):
                ok_deep = False
    check('face row samples the continuous law per column (oracle-exact)', ok_face)
    check('same-x rows share the base sample (second face row == oracle at same x)', ok_shared)
    check("the 'd' baseline equals mix(CLAW, sample(x), 0.5) per column — the dark stripe is gone", ok_deep)
    d0 = fgs2[off2] if off2 < len(fgs2) else None
    check('the left edge deep ink IS the authored MIDRED (172,59,59)', d0 == (172, 59, 59), f'{d0}')
    check('void cells carry no colour', ok_void)
    painted = [fgs0[off0 + x] for x in range(W53)
               if (_rows[0][x] != '.' or _rows[1][x] != '.') and off0 + x < len(fgs0)]
    dirs = [1 if RAMP_RGB[-1][c] >= RAMP_RGB[0][c] else -1 for c in range(3)]
    mono = all(
        (painted[i + 1][c] - painted[i][c]) * dirs[c] >= 0
        for i in range(len(painted) - 1) for c in range(3)
        if painted[i] and painted[i + 1]
    )
    check('face walk is per-channel monotone L→R at W=53', mono)

# The selected-label ramp walks the DECK's card — an inline capture (the
# cinematic frame carries no card; the runtime face re-proves the same law
# through the journey oracle).
raw_lab = run_pty(120, 44, dict(INLINE))
raw_lab_lines = raw_lab.replace('\r', '').split('\n')
lab_line = next((l for l in raw_lab_lines if 'New Session in' in STRIP.sub('', l)), None)
check('selected launcher label line present', lab_line is not None)
if lab_line:
    distinct = set(re.findall(r'38;2;\d+;\d+;\d+', lab_line))
    check('the selected label walks CONTINUOUSLY (≥5 distinct colours; the bucket law gave ≤3)',
          len(distinct) >= 5, f'{len(distinct)} distinct')

print('\n── GLOW: the critter-derived accent family (the red unpinned)')
# The boot accent follows the critter: env pin → the persisted /critter
# default (the config-precedence legs below prove that read) → the BAKED
# default (jellyfish since — the same DEFAULT_CRITTER_KEY the session
# resolves, so a fresh home's splash and its booted session agree). The
# family owns the word ramp, the accent chrome (carets, rule, hint keys)
# and the strip's Theme chip; prove-ramp-parity §7 holds the baked family
# table to the canonical derivations.
JELLY_MAIN = '38;2;111;199;232'
CLAM_MAIN = '38;2;22;216;176'
CRAB_MAIN = '38;2;221;68;68'
raw_fam = run_pty(120, 44)
check('hermetic default wears JELLYFISH cyan (the baked default family)', JELLY_MAIN in raw_fam)
check('…and no crab red survives anywhere in the frame (the unpin is total)', CRAB_MAIN not in raw_fam)
# The strip lives on the INLINE deck (the cinematic hero paints no card).
fam_txt = STRIP.sub('', run_pty(120, 44, dict(INLINE)))
check("…and the deck's Theme chip says Jellyfish (strip truth == family truth)", 'Jellyfish' in fam_txt)
raw_fam = run_pty(120, 44, {'MERCURY_CRITTER': 'clam'})
check('MERCURY_CRITTER=clam pins the clam teal family', CLAM_MAIN in raw_fam and CRAB_MAIN not in raw_fam)
raw_fam = run_pty(120, 44, {'MERCURY_CRITTER': 'mantis shrimp'})
check("a retired spelling resolves to its successor's family ('mantis shrimp' → clam)", CLAM_MAIN in raw_fam)
raw_fam = run_pty(120, 44, {'MERCURY_CRITTER': 'dragon'})
check('a retired key resolves to the pool default (the sessionAccent poolKeyOr law)', JELLY_MAIN in raw_fam)
raw_fam = run_pty(120, 44, {'MERCURY_CRITTER': 'crab'})
check('the crab family byte-anchors the authored red (pre-GLOW parity)', CRAB_MAIN in raw_fam)

print('\n── GLOW: the greeting shimmer (a greeting, not a loop — the settle law)')
# The live inline deck greets: the ramp's bright band sweeps the word + the
# selected row for ~10 s, then settles into the exact static composition and
# the frame writer STOPS. run_corpus pins reduced motion by default (every
# structural leg grades the settled deck); these legs opt out to grade the
# motion itself.
r = run_corpus(120, 50, env_extra={'MERCURY_REDUCED_MOTION': '0'}, steps=[], settle=2.4)
glow_raw = r['pre'] + r['post']
check('greeting ALIVE: the deck keeps painting bracketed glow frames after the first paint',
      r['alive'] and glow_raw.count(b'\x1b[?2026h') >= 3,
      f"brackets={glow_raw.count(b'?2026h')}")
check('glow frames are cursor-addressed line rewrites (incremental, never a 2J storm)',
      glow_raw.count(b'\x1b[2J') == 1, f"clears={glow_raw.count(b'[2J')}")
r = run_corpus(120, 50, steps=[], settle=2.4)
still_raw = r['pre'] + r['post']
check('reduced motion ⇒ ONE paint, then byte-silence (no greeting frames at all)',
      r['alive'] and still_raw.count(b'\x1b[?2026h') == 1,
      f"brackets={still_raw.count(b'?2026h')}")
# Re-selection re-greets: a ↓ under live motion is followed by MORE frames
# than the single navigation repaint (the fresh greeting on the new row).
r = run_corpus(120, 50, env_extra={'MERCURY_REDUCED_MOTION': '0'},
               steps=[(0.9, b'\x1b[B')], settle=1.8)
check('re-selecting a row starts a fresh greeting (frames continue after the nav repaint)',
      r['alive'] and r['post'].count(b'\x1b[?2026h') >= 3,
      f"post_brackets={r['post'].count(b'?2026h')}")
# THE SETTLE LAW, live: past the greeting window the deck is byte-silent
# again — an inert key after 11.8 s sees ZERO post-send paint, exactly the
# corpus's own inertness idiom (and the pre-window frames prove the greeting
# actually ran, so the leg can never pass vacuously).
r = run_corpus(120, 50, env_extra={'MERCURY_REDUCED_MOTION': '0'},
               steps=[(11.8, b'x')], settle=1.4)
check('the greeting SETTLES: after the window an inert key sees zero post-send paint',
      r['alive'] and r['pre'].count(b'\x1b[?2026h') >= 3 and r['post'] == b'',
      f"pre_brackets={r['pre'].count(b'?2026h')} post={r['post'][:40]!r}")

# ── the capability truth table, rendered (R4/D9) ─────────────────────────────
plainraw = run_pty(120, 44, {'NO_COLOR': '1'})
check('NO_COLOR ⇒ ZERO SGR bytes (the plain path)', not re.search(r'\x1b\[[0-9;]*m', plainraw))
check('NO_COLOR keeps the word (layout intact, colour-only law)',
      bool(word_rows_txt) and word_rows_txt[0].rstrip() in plainraw.replace('\r', ''))
forceraw = run_pty(120, 44, {'NO_COLOR': '1', 'FORCE_COLOR': '1'})
check('FORCE_COLOR overrides NO_COLOR (spec precedence — truecolor back)', '\x1b[38;2;' in forceraw)
raw256 = run_pty(120, 44, {'MERCURY_TRUECOLOR': '0'})
check('MERCURY_TRUECOLOR=0 ⇒ the 256 fallback (no truecolor SGR)',
      '\x1b[38;2;' not in raw256 and '\x1b[38;5;' in raw256)
raw256b = run_pty(120, 44, {'MERCURY_TRUECOLOR': '0'})
check('legacy MERCURY_TRUECOLOR=0 honored identically',
      '\x1b[38;2;' not in raw256b and '\x1b[38;5;' in raw256b)
_base_txt = [l.rstrip() for l in vis_lines(raw_rf) if l.strip()]
for _label, _rawx in (('NO_COLOR', plainraw), ('256-fallback', raw256)):
    _txt = [l.rstrip() for l in vis_lines(_rawx) if l.strip()]
    check(f'{_label}: stripped frame text identical to truecolor (colour-only across tiers)',
          _txt == _base_txt, f'{len(_txt)} vs {len(_base_txt)} lines')

print('\n── ROUND 7: the flat-ground law (no field background; OSC 11 = the shared family ground)')
# Six rounds of vignette work (the OASIS canvas, full-grid paint, the
# round-6 per-host SGR-49 arm) all managed one structural liability: a
# painted field and the OSC-11 ground are separate channels that can drift
# and did (forensics: the vignette's #070D12 edge cells under
# the runtime's OSC-11 re-assert to NIGHT #0D181B at handoff — two of our
# own constants fighting; the operator's banded boxes / bottom band /
# corner artifacts). The splash now paints NOTHING behind the composition
# — the main REPL's own model: ONE OSC-11 ground (the resolved appearance's
# family ground — #000000 on the True Black default, NIGHT on the oasis
# appearance — the same value oasisBg.ts sets at runtime boot) with glyphs
# on it. Explicit CONTENT backgrounds (half-block art cells, the PLATE_TONE
# box plate, the held brand's maroon backing) still ride inside composed
# lines.
raw_ground = run_pty(172, 42)
raw_expl = run_pty(172, 42, {'MERCURY_OASIS_BG': '0'})
check('ground run (no stored theme): OSC 11 sets the True Black default ground (#000000 — the oasisBg pair value of the default appearance)',
      '\x1b]11;#000000' in raw_ground and '\x1b]11;#0D181B' not in raw_ground)
check('ground run: the retired wash never paints (no vignette edge/band bg, no SGR 49)',
      '48;2;7;13;18' not in raw_ground and '48;2;22;48;60' not in raw_ground
      and '\x1b[49m' not in raw_ground)


# THE PER-CELL FLAT-GRID CHECK (the round-7 inversion of the pyte
# pass): the emulated final grid must ride the terminal DEFAULT background
# outside content — all four edges 100%% default-bg (any reintroduced field
# paint lands exactly here), and bg-painted cells bounded to content
# (mixed half-block art cells; < 10%% of the grid). pyte rides the house
# interpreter; an unavailable pyte FAILS loudly, never skips.
def _percell_flat_census(raw, cols, rows):
    start = raw.index('\x1b[?1049h')
    end = raw.find('\x1b[?1049l', start)
    span = raw[start:end] if end != -1 else raw[start:]
    code = (
        "import sys, pyte\n"
        "raw = sys.stdin.buffer.read().decode('utf-8', 'replace')\n"
        f"s = pyte.Screen({cols}, {rows})\n"
        "st = pyte.Stream(s)\n"
        "st.feed(raw)\n"
        f"painted = [(x, y) for y in range({rows}) for x in range({cols}) if s.buffer[y][x].bg != 'default']\n"
        f"edge_bad = [(x, y) for (x, y) in painted if x in (0, {cols} - 1) or y in (0, {rows} - 1)]\n"
        "print(len(painted))\n"
        "print(len(edge_bad))\n"
        "for x, y in edge_bad[:8]:\n"
        "    print(f'{x},{y}')\n"
    )
    r = subprocess.run(['/usr/bin/python3', '-c', code], input=span.encode(),
                       capture_output=True, timeout=60)
    lines = r.stdout.decode().strip().split('\n') if r.stdout else []
    painted = int(lines[0]) if lines and lines[0].isdigit() else -1
    edge_bad = int(lines[1]) if len(lines) > 1 and lines[1].isdigit() else -1
    return r.returncode, painted, edge_bad, lines[2:]


_rc, _painted, _edge_bad, _samples = _percell_flat_census(raw_ground, 172, 42)
check(f'ground run PER-CELL: all four grid edges ride the DEFAULT background (edge painted cells: {_edge_bad}; samples: {_samples})',
      _rc == 0 and _edge_bad == 0)
check(f'ground run PER-CELL: bg paint is bounded to content (painted {_painted} of {172 * 42} cells)',
      _rc == 0 and 0 <= _painted < 172 * 42 * 0.10)
check('opt-out run (MERCURY_OASIS_BG=0): the ONE delta is the OSC-11 write itself',
      '\x1b]11;' not in raw_expl)
_g_txt = [l.rstrip() for l in vis_lines(raw_ground) if l.strip()]
_e_txt = [l.rstrip() for l in vis_lines(raw_expl) if l.strip()]
check('ground vs opt-out: stripped frame text identical (the opt-out costs no layout)',
      _g_txt == _e_txt, f'{len(_g_txt)} vs {len(_e_txt)} lines')
# (Round 6's Apple_Terminal ground-reference legs retired WITH their subject:
# with no field paint there is no per-host edge handling left to prove — the
# flat law is host-invariant by construction.)

print('\n── THE APPEARANCE FAMILY: the launcher estate follows the persisted theme')
# The persisted appearance re-anchors the ONE ground reference (VOID ===
# GROUND === PLATE_TONE, adoptGroundFamily) before any paint: with True
# Black persisted, the WHOLE estate grounds at #000000 — the OSC-11 write,
# every plate fill, the launch hold's park ink — and no oasis-family ground
# byte exists anywhere between launcher start and handoff. The oasis ladder
# is the un-adopted module; the selection ladder mirrors the runtime
# (initialThemeSetting): MERCURY_THEME_PIN > stored global-config theme >
# the True Black default (the driver's DEFAULT_THEME_FAMILY, pinned to the
# runtime's owner by prove-ramp-parity); a corrupt/absent config keeps the
# default silently (the cosmetic-read K3 stance — a ground color must never
# stall a boot). Every other leg in this file runs on a home with no stored
# theme, so it rides the default family.
tb_home = tempfile.mkdtemp(prefix='splash-proof-home-tb.')
with open(os.path.join(tb_home, '.mercury.json'), 'w') as f:
    json.dump({'theme': 'true-black'}, f)
raw_tb = run_pty(172, 42, {'MERCURY_HOME': tb_home})
check('true-black home: OSC 11 sets the pure-black ground (#000000)',
      '\x1b]11;#000000' in raw_tb)
check('true-black home: no oasis ground byte anywhere (no #0D181B OSC, no 13;24;27 SGR)',
      '\x1b]11;#0D181B' not in raw_tb and '38;2;13;24;27' not in raw_tb
      and '48;2;13;24;27' not in raw_tb)
oasis_home = tempfile.mkdtemp(prefix='splash-proof-home-oasis.')
with open(os.path.join(oasis_home, '.mercury.json'), 'w') as f:
    json.dump({'theme': 'dark'}, f)
raw_oasis = run_pty(172, 42, {'MERCURY_HOME': oasis_home})
check('oasis home (a saved dark choice): OSC 11 sets the oasis NIGHT ground (#0D181B) — the saved choice outranks the default',
      '\x1b]11;#0D181B' in raw_oasis and '\x1b]11;#000000' not in raw_oasis)
raw_pin = run_pty(172, 42, {'MERCURY_THEME_PIN': 'dark'})
check('MERCURY_THEME_PIN=dark selects the oasis family with no stored theme (the pin rung outranks the default)',
      '\x1b]11;#0D181B' in raw_pin and '\x1b]11;#000000' not in raw_pin)
raw_tb_bad = run_pty(172, 42, {'MERCURY_HOME': tb_home, 'MERCURY_THEME_PIN': 'dark'})
check('the pin outranks the stored theme (dark pin over a true-black home)',
      '\x1b]11;#0D181B' in raw_tb_bad and '\x1b]11;#000000' not in raw_tb_bad)
# The CINEMATIC launch on a true-black home: the trace runs and the hold
# parks its ink IN the family ground — black-on-black, never oasis-on-black
# (the visible-plate class the operator's second eyeball caught).
raw_tb_cine = run_pty(120, 40, {'MERCURY_HOME': tb_home, 'MERCURY_FULLSCREEN': '1'},
                      oneshot=False, run_for=7.0)
check('true-black cinematic: the hold parks black-on-black (fg==bg==#000000)',
      '38;2;0;0;0m\x1b[48;2;0;0;0m' in raw_tb_cine)
check('true-black cinematic: no oasis ground byte across trace + hold',
      '\x1b]11;#0D181B' not in raw_tb_cine and '48;2;13;24;27' not in raw_tb_cine
      and '38;2;13;24;27m\x1b[48;2;13;24;27m' not in raw_tb_cine)

# ── K1/K2/K3: seeded config homes · chip CONTENT · cwd-scoped
# continue/resume DIR handovers — the field-defect classes (the
# splash-resume-drift report). Three home states: native-only, legacy-only,
# adopted-BOTH-divergent (the frozen-stale case: the strip must serve the
# NATIVE facts, never the leftover .claude.json's).
print('\n── K1/K3: seeded homes × chip content (resolveConfigFile is .mercury-first)')


def seeded_home(native=None, legacy=None):
    home = tempfile.mkdtemp(prefix='splash-proof-home-cfg.')
    if native is not None:
        with open(os.path.join(home, '.mercury.json'), 'w') as f:
            json.dump(native, f)
    if legacy is not None:
        with open(os.path.join(home, '.claude.json'), 'w') as f:
            json.dump(legacy, f)
    return home


home_native = seeded_home(native={'defaultCritter': 'crab',
                                  'oauthAccount': {'emailAddress': 'native@mercury.test'}})
raw = run_pty(120, 44, {'MERCURY_HOME': home_native, **INLINE})
plain = STRIP.sub('', raw)
check('native home: theme chip serves .mercury.json (Crab)', 'Crab' in plain)
check('native home: account chip serves .mercury.json', 'native@mercury.test' in plain)
# GLOW: the persisted critter drives the ACCENT FAMILY too — a crab-seeded
# home wears the authored red, not the jellyfish default (the whole-frame
# hue rides the same CRITTER_KEY the chip label rides).
check('native home: the persisted critter drives the accent family (crab red, no default cyan)',
      CRAB_MAIN in raw and JELLY_MAIN not in raw)

home_legacy = seeded_home(legacy={'defaultCritter': 'crab',
                                  'oauthAccount': {'emailAddress': 'legacy@compat.test'}})
raw = run_pty(120, 44, {'MERCURY_HOME': home_legacy, **INLINE})
plain = STRIP.sub('', raw)
check('external-file-only home: the retired .claude.json is NEVER read',
      'legacy@compat.test' not in plain and 'Crab' not in plain)

home_both = seeded_home(
    native={'defaultCritter': 'crab', 'oauthAccount': {'emailAddress': 'native@mercury.test'}},
    legacy={'defaultCritter': 'octopus', 'oauthAccount': {'emailAddress': 'stale@old.test'}})
raw = run_pty(120, 44, {'MERCURY_HOME': home_both, **INLINE})
plain = STRIP.sub('', raw)
check('adopted-BOTH home: the NATIVE file wins (the frozen-stale class)',
      'native@mercury.test' in plain and 'Crab' in plain)
check('adopted-BOTH home: the stale legacy facts never render',
      'stale@old.test' not in plain and 'Octopus' not in plain)

print('\n── K1: health chip reads the ADOPTIVE project path (.mercury first)')
cert_cwd = tempfile.mkdtemp(prefix='splash-proof-certcwd.')
os.makedirs(os.path.join(cert_cwd, '.mercury', 'doctor'), exist_ok=True)
with open(os.path.join(cert_cwd, '.mercury', 'doctor', 'last-cert.json'), 'w') as f:
    json.dump({'verdict': 'certified', 'ranAt': '2026-08-07T12:00:00Z'}, f)
raw = run_pty(120, 44, {'MERCURY_HOME': home_native, **INLINE}, cwd=cert_cwd)
plain = STRIP.sub('', raw)
check('health chip renders from <cwd>/.mercury/doctor',
      'Health' in plain and 'certified' in plain)
cert_cwd2 = tempfile.mkdtemp(prefix='splash-proof-certcwd2.')
os.makedirs(os.path.join(cert_cwd2, '.claude', 'doctor'), exist_ok=True)
with open(os.path.join(cert_cwd2, '.claude', 'doctor', 'last-cert.json'), 'w') as f:
    json.dump({'verdict': 'caution', 'ranAt': '2026-08-07T12:00:00Z'}, f)
raw = run_pty(120, 44, {'MERCURY_HOME': home_native, **INLINE}, cwd=cert_cwd2)
plain = STRIP.sub('', raw)
check('health chip never reads the external <cwd>/.claude/doctor', 'caution' not in plain)

print('\n── K2: the launched cwd WINS (two-repo continue/resume dir law)')


def two_repo_home():
    """cwdfix (OLDER session) + other-proj (NEWER) — global recency points
    AWAY from cwd, exactly the drift-report shape."""
    # realpath: the runtime records realpath'd cwds in session files and the
    # splash compares against its own process.cwd() (also real) — a fixture
    # written with the /var→/private/var symlink spelling would never match.
    home = os.path.realpath(tempfile.mkdtemp(prefix='splash-proof-home-k2.'))
    dirs = {}
    for slug, age_s in (('cwdfix', 3600), ('other-proj', 60)):
        cwd = os.path.join(home, 'fixtures', slug)
        os.makedirs(cwd, exist_ok=True)
        pdir = os.path.join(home, 'projects', slug)
        os.makedirs(pdir, exist_ok=True)
        sess = os.path.join(pdir, 'session.jsonl')
        with open(sess, 'w') as f:
            f.write(json.dumps({'cwd': cwd}) + '\n')
        t = time.time() - age_s
        os.utime(sess, (t, t))
        dirs[slug] = cwd
    return home, dirs


k2_home, k2_dirs = two_repo_home()
k2_act = os.path.join(k2_home, 'splash-action.json')
k2_txt = os.path.join(k2_home, 'splash-action.txt')

# cwd HAS history → Continue is cwd-scoped: ctx names cwdfix, action carries
# NO dir (the launcher stays put).
raw = run_pty(120, 50, {'MERCURY_HOME': k2_home, **INLINE}, cwd=k2_dirs['cwdfix'],
              send=[(0.6, b'\x1b[B'), (1.2, b'\r')], oneshot=False)
plain = STRIP.sub('', raw)
act = None
if os.path.exists(k2_act):
    with open(k2_act) as f:
        act = json.load(f)
check('cwd-with-history: Continue ctx never claims a crossing',
      'in other-proj' not in plain)
check('cwd-with-history: continue action carries NO dir (launcher stays put)',
      bool(act) and act.get('action') == 'continue' and 'dir' not in act,
      json.dumps(act) if act else 'no file')
check('cwd-with-history: no plain twin beside the action (BM-30 — retired)',
      not os.path.exists(k2_txt))

# Resume NEVER hands a dir — the runtime picker opens cwd-scoped with its own
# explicit cross-project toggle.
raw = run_pty(120, 50, {'MERCURY_HOME': k2_home, **INLINE}, cwd=k2_dirs['cwdfix'],
              send=[(0.6, b'\x1b[A'), (1.2, b'\r')], oneshot=False)
act = None
if os.path.exists(k2_act):
    with open(k2_act) as f:
        act = json.load(f)
check('resume action NEVER carries a dir (picker opens cwd-scoped)',
      bool(act) and act.get('action') == 'resume' and 'dir' not in act,
      json.dumps(act) if act else 'no file')

# cwd WITHOUT history → the labeled cross-repo fallback: ctx says "in <base>"
# and the action carries the global-newest dir (the ONLY continue arm that
# still crosses — and it says so).
fresh_cwd = tempfile.mkdtemp(prefix='splash-proof-freshcwd.')
raw = run_pty(120, 50, {'MERCURY_HOME': k2_home, **INLINE}, cwd=fresh_cwd,
              send=[(0.6, b'\x1b[B'), (1.2, b'\r')], oneshot=False)
plain = STRIP.sub('', raw)
act = None
if os.path.exists(k2_act):
    with open(k2_act) as f:
        act = json.load(f)
check('history-less cwd: Continue ctx NAMES the crossing (in other-proj)',
      'in other-proj' in plain)
check('history-less cwd: continue action carries the cross-repo dir',
      bool(act) and act.get('action') == 'continue' and act.get('dir') == k2_dirs['other-proj'],
      json.dumps(act) if act else 'no file')

print('\n── gates')
raw = run_pty(120, 44, {'MERCURY_SPLASH': 'off'})
check('MERCURY_SPLASH=off ⇒ zero output', raw.strip() == '')
piped = subprocess.run(['node', SPLASH], capture_output=True, text=True,
                       env={**os.environ, 'MERCURY_SPLASH_ONESHOT': '1'})
check('non-TTY (pipe) ⇒ zero output, exit 0', piped.stdout == '' and piped.returncode == 0)

print()
if failures:
    print(f'❌ {failures} SPLASH PROOF(S) FAILED')
    sys.exit(1)
print('✅ ALL SPLASH PROOFS PASS')
