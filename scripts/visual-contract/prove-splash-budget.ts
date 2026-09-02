#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-contract/prove-splash-budget.ts — the splash joins the render-budget
//  estate (CN-23; the INTERVIEW bands are the law, a
//  regression is a defect, never a re-baseline).
//
//  A real PTY boots the splash asset at 120×40 and the harness timestamps
//  every read:
//    §1 FIRST PAINT — the first byte lands within 2s (generous: the CN-01
//       captures paint in tens of ms; the bound guards against a boot-time
//       regression class, not micro-latency — pool load must not flake it).
//    §2 SETTLE — the paint STOPS: no byte arrives later than 1.5s after the
//       first byte (the INTERVIEW resize-settle window, applied to boot).
//    §3 NO RECURRING ACTIVITY — the lockup at rest is SILENT: at most 2
//       writes in the 2s quiet window after settle (polling reads as ~10+
//       writes/window — the law that caught the class at INTERVIEW).
//
//  The timing harness is the vshot pty.fork pattern with wall-clock stamps;
//  the child gets a scratch home (ambient-state law) and LIVE_GLYPHS=0 like
//  every capture.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'contour-splash-budget-'))
const home = join(scratch, 'home')

const PY = `
import json, os, pty, sys, time, select, fcntl, termios, struct

pid, fd = pty.fork()
if pid == 0:
    os.environ["COLUMNS"], os.environ["LINES"] = "120", "40"
    os.execvp(sys.argv[1], sys.argv[1:])

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
t0 = time.monotonic()
first = None
last = None
writes = 0
# Phase 1 — boot paint: read until a 600ms silent gap after the first byte
# (the settled-phase observable — the two-phase capture law) or the hard cap.
deadline = t0 + 6.0
while time.monotonic() < deadline:
    r, _, _ = select.select([fd], [], [], 0.6)
    if not r:
        if first is not None:
            break            # settled: a full gap with no bytes
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    now = time.monotonic()
    if first is None:
        first = now
    last = now
    writes += 1

# Phase 2 — the quiet window: the child STAYS ALIVE; count writes for 2s.
# (Killing first would count the exit-restore sequence as activity.)
quiet_writes = 0
qdeadline = time.monotonic() + 2.0
while time.monotonic() < qdeadline:
    r, _, _ = select.select([fd], [], [], 0.1)
    if not r:
        continue
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    quiet_writes += 1

os.kill(pid, 15)

print(json.dumps({
    "firstPaintMs": None if first is None else round((first - t0) * 1000),
    "settleMs": None if (first is None or last is None) else round((last - first) * 1000),
    "writes": writes,
    "quietWrites": quiet_writes,
}))
`

writeFileSync(join(scratch, 'timing.py'), PY)
const r = spawnSync(
  '/usr/bin/python3',
  [join(scratch, 'timing.py'), 'node', 'assets/splash/mercury-splash.mjs'],
  {
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_HOME: home,
      MERCURY_HOME: home,
      MERCURY_CONFIG_DIR: home,
      // fullscreen boots auto-run the code trace, so an unpinned
      // "settle" would now contain the whole animation. This budget grades
      // the PAINT — pin the fast-boot lever (frame 0 → immediate handoff);
      // the animation's own bounds are prove-ripple-drain's completion and
      // drain-cap laws.
      MERCURY_LAUNCH_RIPPLE: '0',
    },
    encoding: 'utf8',
    timeout: 30_000,
  },
)

let stats: { firstPaintMs: number | null; settleMs: number | null; writes: number; quietWrites: number } | null = null
try {
  const lastLine = (r.stdout ?? '').trim().split('\n').pop() ?? ''
  stats = JSON.parse(lastLine)
} catch {
  console.log((r.stdout ?? '').slice(-400) + (r.stderr ?? '').slice(-400))
}

t.section('the splash render budget (INTERVIEW bands)')
t.check('the timing harness completed', r.status === 0 && stats !== null, `exit=${r.status}`)
if (stats) {
  t.check(
    '§1 first paint lands within 2s',
    stats.firstPaintMs !== null && stats.firstPaintMs <= 2000,
    `firstPaint=${stats.firstPaintMs}ms`,
  )
  t.check(
    '§2 the boot paint settles within 1.5s of the first byte',
    stats.settleMs !== null && stats.settleMs <= 1500,
    `settle=${stats.settleMs}ms across ${stats.writes} write(s)`,
  )
  t.check(
    '§3 the lockup at rest is SILENT (≤2 writes in the 2s quiet window)',
    stats.quietWrites <= 2,
    `quietWrites=${stats.quietWrites}`,
  )
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-splash-budget')
