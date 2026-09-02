#!/usr/bin/env bun
// ============================================================================
//  prove-sessiontab-switch — an IDLE session switch actually switches.
//
//  The guarded regression: clicking a SESSIONS-card tab (and
//  the ⌥←→ chord) failing to open the target session. Root cause class: the
//  §SESSION-SWITCH-MID-TURN guard refuses resume() while
//  queryGuard.getSnapshot() is true — but getSnapshot() covers BOTH 'running'
//  (a real model turn — the state the guard exists for) and 'dispatching'
//  (the transient reservation handlePromptSubmit.ts takes for EVERY
//  submission, including the /sessiontab dispatch itself). The switch's own
//  submission tripped the guard: every in-app session switch self-refused,
//  idle or not. The original proof was structural-only (string positions) —
//  it never DROVE an idle switch, so it enforced the bug.
//
//  This leg drives the PRODUCTION path through the REAL binary: boot resumed
//  into fixture A (the 'short' transcript), type the exact command a tab
//  click dispatches (`/sessiontab <id-of-fixture-B>`), and assert fixture B's
//  transcript is on screen. RED on the self-refusing guard, GREEN when
//  resume() refuses only a genuinely RUNNING query.
//
//  (The mid-turn refusal itself stays pinned by prove-resume-mid-turn-guard —
//  this leg is its missing half: idle must PROCEED.)
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cleanupScenario,
  CONFIG_HOME,
  scenario,
  SID_ERRORED,
  writeSyntheticSession,
} from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type GridCell = { c: string }
type Grid = { grid: GridCell[][] }
const text = (g: Grid): string =>
  g.grid.map(row => row.map(c => c.c || ' ').join('')).join('\n')

// Boot resumed into fixture A ('short': "first task"/"second task"); the
// scenario() call also pins the capture env (daemon/teams/boot-env hermeticity).
const cfg = scenario('resume-2turn', 120, 44)
// Fixture B on disk beside it — the flip target (the 'errors' transcript).
writeSyntheticSession('errors', SID_ERRORED)

type Send = {
  atTick: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  afterPrevTicks?: number
}

let lastReceipts: unknown = null

function capture(tag: string, sends: Send[], total: number): Grid {
  const out = `/tmp/sessiontab-switch-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/sessiontab-switch-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, sends, total, cols: 120, rows: 44, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(150_000),
    env: {
      ...process.env,
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) throw new Error(`vshot failed: ${res.stderr?.slice(0, 300)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { sendReceipts?: unknown }
  lastReceipts = payload.sendReceipts ?? null
  return payload
}

try {
  // Baseline: fixture A's transcript is on screen before any input.
  const before = text(capture('before', [], 45))
  t("baseline shows fixture A ('first task')", before.includes('first task'))
  t('baseline does NOT show fixture B', !before.includes('apply the manifest edit'))

  // The switch: type the tab-click command, targeted at fixture B, then ↵.
  // Typed submission rides the SAME dispatcher chain as the SESSIONS-card
  // click (onSubmit → handlePromptSubmit reserve → processUserInput →
  // /sessiontab call → context.resume) — the production condition.
  // Observed-ready: the type send gates on the
  // composer being interactive. NOTE the vshot contract — `atTick` is the
  // HARD DEADLINE that fires regardless; `awaitText` only fires EARLIER.
  // Round 11 set the deadline at 40, so a slow CI boot still ate the keys
  // blind; the deadline now sits late and the await is the normal trigger.
  const after = text(
    capture(
      'after',
      [
        { atTick: 95, data: `/sessiontab ${SID_ERRORED}`, awaitText: '❯', minTick: 8, awaitSettleTicks: 3 },
        { atTick: 100, data: '\r', afterPrevTicks: 3 },
      ],
      130,
    ),
  )
  const switched =
    after.includes('apply the manifest edit') || after.includes('API Error')
  t('after /sessiontab <id>: fixture B transcript is on screen', switched)
  if (!switched) {
    // Loud red: print the actual fire ticks + the final screen so a CI-only
    // failure names its mechanism instead of leaving a bare boolean.
    console.log(`  … sendReceipts: ${JSON.stringify(lastReceipts)}`)
    console.log('  … final grid rows 0-24 (first 80 cols):')
    after
      .split('\n')
      .slice(0, 25)
      .forEach((l, i) => console.log(`  ${String(i).padStart(2)}│${l.slice(0, 80).trimEnd()}`))
  }
  t(
    'the mid-turn refusal notification did NOT fire on an idle switch',
    !after.includes('Run in flight'),
  )
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '✅ sessiontab-switch contract holds' : '❌ sessiontab-switch BROKEN')
process.exit(failures)
