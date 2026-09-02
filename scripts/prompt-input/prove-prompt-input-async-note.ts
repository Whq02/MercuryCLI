#!/usr/bin/env bun
// ============================================================================
//  prove-prompt-input-async-note — F1-S2 on the BUILT artifact.
//
//  Reproduced pre-fix: RealmsView's g action ran spawnSync('gh','auth',
//  'status') with a 5s timeout INSIDE the keypress handler — with a 4s gh
//  stub on PATH, esc pressed right after g could not close the view until
//  the probe exited (the whole event loop frozen).
//
//  The law proven here: with the probe-shaped AsyncListNote action, esc
//  closes the view IMMEDIATELY while the probe is still sleeping (the loop
//  stays live), and the probe still ran exactly once (stub fire log).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const home = mkdtempSync(join(tmpdir(), 'kinetic-note-'))
process.env.MERCURY_CONFIG_DIR = home
const stubDir = join(home, 'bin')
mkdirSync(stubDir)
const fireLog = join(home, 'gh-fires.log')
// The stub logs its ARGS: the oracle below counts only the realms probe's
// fingerprint (`gh auth status`). The product also calls `gh pr view` from
// the PR-status footer whenever the capture cwd is a git checkout off its
// default branch (usePrStatus mount + footer remount), so an all-fires
// count is branch-sensitive — green from a main checkout, red from any
// feature-branch worktree.
writeFileSync(join(stubDir, 'gh'), `#!/bin/bash\necho "$(date +%s) $*" >> ${fireLog}\nsleep 4\nexit 1\n`)
chmodSync(join(stubDir, 'gh'), 0o755)

const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')
const cfg = scenario('resume-2turn', 120, 40)

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type Grid = { grid: { c: string }[][]; sendReceipts?: unknown }
const rowsOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))

function capture(tag: string, sends: unknown[], total: number): string[] {
  const out = join(home, `${tag}.json`)
  const cfgPath = join(home, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: cfg.argv, cwd: cfg.cwd, sends, total, cols: 120, rows: 40, out }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(200_000),
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_CONFIG_DIR: home,
    },
  })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${res.stderr?.slice(-500)}`)
  return rowsOf(JSON.parse(readFileSync(out, 'utf8')) as Grid)
}

const ESC = '\u001b'
const sends = [
  // Boot-anchored open (observed-ready): the blind tick-40 type raced slow
  // resume boots.
  { atTick: 40, awaitText: '? for shortcuts', minTick: 5, awaitSettleTicks: 3, data: '/realms\r' },
  // STRICT gate: 'g' must never fire blind into a not-yet-open view — a
  // never-opening view lands in the UNDELIVERED-SENDS refusal (loud),
  // never a wrong-frame pass. total stays 52: the capture ending inside
  // the stub's 4s sleep IS the esc-during-probe oracle.
  { requireAwait: true, awaitText: 'Trusted realms', awaitSettleTicks: 1, data: 'g' },
  { afterPrevTicks: 1, data: ESC },
]

try {
  // Mid-probe (capture ends ~2s into the 4s stub sleep): the view must be
  // GONE — esc processed while the probe slept.
  const mid = capture('mid', sends, 52)
  t('esc closes /realms while the auth probe is still running',
    !mid.some(r => r.includes('Trusted realms')))
  const fires = existsSync(fireLog) ? readFileSync(fireLog, 'utf8').trim().split('\n').filter(Boolean) : []
  const probeFires = fires.filter(l => l.includes('auth status'))
  t('the probe actually ran (gh auth status fired exactly once)', probeFires.length === 1,
    `probe fires=${probeFires.length} of ${fires.length} gh call(s): [${fires.map(l => l.split(' ').slice(1).join(' ')).join(' | ')}]`)
} finally {
  cleanupScenario('resume-2turn')
}

console.log(failures === 0 ? '✅ kinetic async-note law holds' : '❌ kinetic async-note BROKEN')
process.exit(failures)
