#!/usr/bin/env bun
// prove-redraw-repair.ts — the ctrl+l (app:redraw) HEAL contract, live-binary.
//
// The long-standing "hiding the text" root cause (task #20): forceRedraw's
// alt-screen branch reset the frame buffers WITHOUT prevFrameContaminated, so
// the next render blitted clean nodes from the blanked buffer — ctrl+l ERASED
// swaths of UI and clean diffs preserved the damage. This proof drives the
// real binary, fires ctrl+l mid-session, and asserts the screen stays at
// content parity with an untouched baseline (the repaint must be invisible on
// a healthy screen). RED on the pre-fix build (ready/model rows vanished).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

const run = (sends: Array<{ atTick: number; data: string }>, out: string) => {
  const cfg = scenario('resume-2turn', 120, 44)
  // total=60 (~12s): the renderScenarios settle guidance — 30 ticks left the
  // post-ctrl+l repaint mid-flight under full-suite PTY contention (healed
  // row-count under-read → a flaky parity FAIL, standalone always green); 45
  // re-flaked (−2 rows, twice) after the accent unify added a fable
  // store subscription to every useSessionAccent consumer — the repaint is a
  // touch slower under load, so both captures (symmetric) settle longer. The
  // parity assertion stays strict (±1).
  const mine = { argv: cfg.argv, sends, total: 60, cols: 120, rows: 44, out }
  const cfgPath = `/tmp/redraw-proof-${process.pid}-${sends.length}.json`
  writeFileSync(cfgPath, JSON.stringify(mine))
  execFileSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    timeout: vshotBudgetMs(120_000),
    // MERCURY_AWAY_SUMMARY=0: the resume-recap CARD (trust-cockpit W2c) lands
    // ASYNC after boot (post fetchGitDiff), so its 3 rows race the two
    // captures and break row-parity nondeterministically. This proof tests
    // the ctrl+l repaint, not the recap — pin it off; the recap has its own
    // render scenario.
    env: {
      ...process.env,
    // Split-home guard: bun-side writers and the stamp-defaulted dist must
    // resolve ONE home even outside the gate unit's pin (pinned home).
    MERCURY_CONFIG_DIR: CONFIG_HOME,
      MERCURY_AWAY_SUMMARY: '0',
    },
    stdio: 'ignore',
  })
  const g = JSON.parse(readFileSync(out, 'utf8')) as { grid: Array<Array<{ c: string }>> }
  const text = g.grid.map(r => r.map(c => c.c).join('')).join('\n')
  const rows = g.grid.map(r => r.map(c => c.c).join('').trimEnd()).filter(Boolean).length
  return { text, rows }
}

try {
  const base = run([], `/tmp/redraw-base-${process.pid}.json`)
  const healed = run([{ atTick: 20, data: String.fromCharCode(12) }], `/tmp/redraw-healed-${process.pid}.json`)
  // A RESUMED session opens on the turns-state furniture + the turns (the
  // landing block lives on EMPTY sessions only). That furniture is the
  // SESSION header over the critter berth (the block wordmark belongs to the
  // empty landing), so this ctrl+l repaint proof pins the header, both turns,
  // and the session berth rail.
  t('baseline transcript paints (session header + turns)', base.rows >= 8 && base.text.includes('✶ SESSION') && base.text.includes('first task') && base.text.includes('second task'))
  t('ctrl+l keeps row parity', Math.abs(healed.rows - base.rows) <= 1, `healed=${healed.rows} base=${base.rows}`)
  for (const [name, marker] of [['session header', '✶ SESSION'], ['first task', 'first task'], ['second task', 'second task'], ['this session', 'this session']] as const) {
    t(`ctrl+l keeps '${name}'`, healed.text.includes(marker) === base.text.includes(marker))
  }
} finally {
  cleanupScenario('resume-2turn')
}

console.log(fail ? '❌ REDRAW-REPAIR RED' : '✅ REDRAW-REPAIR GREEN')
process.exit(fail)
