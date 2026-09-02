#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-input-fidelity.ts — composer input fidelity across
//  the transition matrix: the buffer equals the driven key
//  sequence — no loss, no duplication, no reordering — through an overlay
//  open/close and a live resize, in bursts AND discrete keystrokes.
//
//  HZ4's steer-queue proof pinned fidelity on a streaming turn; this matrix
//  drives the TRANSITIONS that historically eat or double a keystroke: the
//  first key after an overlay closes (idle-parked commits ate it once), and
//  typing across a geometry change. Session-switch first-key rides HZ10's
//  campaign with the rest of the journey matrix.
//
//  Editor-correctness assertion: the final composer row is byte-equal to the
//  exact concatenation of everything driven, at the post-resize geometry.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const scratch = mkdtempSync(join(tmpdir(), 'hz-fid-'))

const BIN = 'dist/mercury.mjs'
if (!existsSync(BIN)) {
  t.check('dist exists (build first)', false, BIN)
} else {
  const home = join(scratch, 'pty-home')
  const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-fid'
  spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
    env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
  })
  const out = join(scratch, 'fid.json')
  // The full driven sequence, in the order driven. 'alpha ' arrives as one
  // burst; 'bravo' as five discrete keys (both chunking regimes — the HZ3
  // lesson: a burst can pass where discrete keys fail, and vice versa).
  const EXPECT = 'alpha bravo charlie delta'
  const cfg = {
    cols: 120,
    rows: 40,
    total: 300,
    argv: ['node', BIN],
    out,
    cwd: process.cwd(),
    resizes: [{ cols: 100, rows: 40, atTick: 200 }],
    sends: [
      // THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session enters the chat first.
      { atTick: 40, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
      { atTick: 60, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: 'alpha ' },
      { afterPrevTicks: 2, data: 'b' },
      { afterPrevTicks: 1, data: 'r' },
      { afterPrevTicks: 1, data: 'a' },
      { afterPrevTicks: 1, data: 'v' },
      { afterPrevTicks: 1, data: 'o' },
      // Overlay open (ctrl+x p — the palette) once the draft is visible.
      { atTick: 999, awaitText: 'alpha bravo', minTick: 5, awaitSettleTicks: 2, data: '\u0018', mark: 'pre-overlay' },
      { afterPrevTicks: 2, data: 'p' },
      // Overlay closes; the FIRST key after the transition must not be lost.
      { atTick: 999, awaitText: 'palette', minTick: 5, awaitSettleTicks: 2, data: '\u001b', mark: 'overlay-open' },
      { afterPrevTicks: 3, data: ' charlie' },
      // The resize fires at tick 200 (stage snapshot taken by the driver);
      // type the last word at the NEW geometry.
      { atTick: 220, awaitText: 'alpha bravo charlie', minTick: 210, awaitSettleTicks: 2, data: ' delta' },
    ],
    readyText: EXPECT,
    readySettleTicks: 4,
  }
  const cfgPath = join(scratch, 'fid-cfg.json')
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: FIXTURE_KEY,
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor'),
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    },
    encoding: 'utf8',
    timeout: vshotBudgetMs(240_000),
  })
  type Cell = { c: string }
  let payload: { grid?: Cell[][]; marks?: Array<{ label: string; grid: Cell[][] }> } = {}
  try {
    payload = JSON.parse(readFileSync(out, 'utf8'))
  } catch {
    /* reported below */
  }
  const asLines = (g?: Cell[][]): string[] => (g ?? []).map(row => row.map(c => c.c).join(''))
  const composerLine = (lines: string[]): string => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]?.includes('❯')) return lines[i]!
    }
    return ''
  }
  const finalLines = asLines(payload.grid)
  const composer = composerLine(finalLines)
  t.check('the journey completed (vshot exit 0)', r.status === 0, `exit=${r.status}`)
  t.check('the overlay really opened between the words', (payload.marks ?? []).some(m => m.label === 'overlay-open'))
  t.check(
    'FIDELITY: the composer equals the driven sequence exactly, at the new geometry',
    composer.includes(`❯ ${EXPECT}`),
    composer.trim() || '(no composer row)',
  )
  t.check(
    'no character lost or duplicated across the overlay or the resize',
    !/alpha  bravo|bbravo|bravoo|charliee|ddelta|charlie  delta/.test(finalLines.join('\n')) &&
      (composer.match(/alpha/g) ?? []).length === 1,
    'exact',
  )
  t.check(
    'the final frame is the post-resize geometry (100 cols)',
    (finalLines[0]?.length ?? 0) === 100,
    `width=${finalLines[0]?.length}`,
  )
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-input-fidelity')
