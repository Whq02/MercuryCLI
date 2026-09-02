#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-bash-flicker.ts — #184 ("messages disappear then
//  reappear during Bash").
//
//  The three-layer verdict from the byte-oracle investigation:
//    · COMPOSE layer: stable — no composed frame ever loses transcript rows
//      across a Bash turn (leg A pins this as the regression net for the
//      INLINE/STALE-PAINT class).
//    · DIFF/WRITE layer: minimal diffs, zero transcript erases, loss-proof
//      fd delivery; BSU/ESU wraps alt frames where DEC 2026 holds.
//    · The residual visible flicker class is NON-ATOMIC APPLICATION on
//      terminals without DEC 2026 (Apple Terminal). Mercury now LIVE-PROBES
//      mode 2026 at boot (DECRQM in the existing DA1-bounded round-trip) and
//      upgrades sniff-missed terminals to atomic frames (legs B/C).
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_HOME, cleanupScenario, scenario } from './renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const ROOT = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' bash-turn render stability + the DEC 2026 live probe (#184)')
console.log('============================================================')

console.log('\n── A. compose stability: no frame loses the transcript ─────')
{
  const TEE = `/tmp/bash-flicker-tee-${process.pid}.jsonl`
  rmSync(TEE, { force: true })
  const cfg = scenario('resume-2turn', 100, 36)
  // The bang gates on the raw-mode arm (the observed-ready discipline the
  // retired seat-board captures taught: observed-ready over fixed ticks): a blind tick-40 send
  // raced a starved boot in the bare-worktree gate rehearsal (21 composed
  // frames in the window instead of ~45; the keys never reached the
  // composer, so the LAST frame carried no bang turn). `atTick` stays the
  // hard deadline; the Enter keeps its relative gap.
  cfg.sends = [
    { atTick: 40, minTick: 10, awaitRaw: '\u001b[?2004h', data: '!echo flicker-probe-ran' },
    { afterPrevTicks: 8, data: '\r' },
  ]
  cfg.total = 90
  const cfgPath = `/tmp/bash-flicker-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: `/tmp/bash-flicker-grid-${process.pid}.json` }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, 'vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(180_000),
    env: {
      ...process.env,
      INK_COMPOSED_TEE: TEE,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  cleanupScenario('resume-2turn')
  check('PTY capture ran', res.status === 0, res.stderr?.slice(0, 200) ?? '')
  const frames: Array<{ f: number; rows: string[] }> = []
  try {
    for (const line of readFileSync(TEE, 'utf8').trim().split('\n')) {
      try {
        const f = JSON.parse(line)
        if (Array.isArray(f.rows)) frames.push(f)
      } catch {
        /* torn tail line at process kill — tolerated */
      }
    }
  } catch {
    /* missing tee handled below */
  }
  rmSync(TEE, { force: true })
  check('composed frames captured', frames.length > 20, `got ${frames.length}`)
  let appeared = false
  const gaps: number[] = []
  for (const f of frames) {
    const has = f.rows.some(r => r.includes('first task'))
    if (has) appeared = true
    else if (appeared) gaps.push(f.f)
  }
  check('the transcript anchor appeared', appeared)
  check('NO composed frame lost it during the Bash turn', gaps.length === 0, `gaps=${gaps.slice(0, 8).join(',')}`)
  const last = frames[frames.length - 1]
  check('the bang output landed', last !== undefined && last.rows.some(r => r.includes('flicker-probe-ran')))
}

console.log('\n── B. the DEC 2026 LIVE probe is wired (source locks) ──────')
{
  const app = readFileSync(join(ROOT, 'src/ink/components/App.tsx'), 'utf8')
  check('boot round-trip probes DECRQM 2026', app.includes('decrqm(2026)'))
  check('a set/reset answer upgrades sync support', app.includes('upgradeSyncOutputSupport()'))
  const ink = readFileSync(join(ROOT, 'src/ink/ink.tsx'), 'utf8')
  check('frame flushes LIVE-read sync support (never a boot-frozen const)', !ink.includes('SYNC_OUTPUT_SUPPORTED') && ink.includes('syncOutputSupportedNow()'))
}

console.log('\n── C. the upgrade seam behaves ─────────────────────────────')
{
  // The sync-output capability seam moved to session/capabilities.ts when
  // the native-core T5 cut deleted terminal.ts.
  const { syncOutputSupportedNow, upgradeSyncOutputSupport } = await import('../../src/ink/session/capabilities.ts')
  const before = syncOutputSupportedNow()
  upgradeSyncOutputSupport()
  check('upgrade flips the live read to true', syncOutputSupportedNow() === true, `before=${before}`)
}

console.log()
if (failures > 0) {
  console.log(`❌ BASH-FLICKER PROOF RED (${failures})`)
  process.exit(1)
}
console.log('✅ BASH-FLICKER PROOF PASS')
