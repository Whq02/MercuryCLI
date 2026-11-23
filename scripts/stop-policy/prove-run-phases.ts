#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'speedster-phases-home-'))

type Leg = { label: string; pass: boolean; detail: string }
const legs: Leg[] = []
function check(label: string, cond: boolean, detail = ''): void {
  legs.push({ label, pass: cond, detail })
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const state = await import('../../src/boot/process-state/processState.js')
  const phases = await import('../../src/platform/logs/runPhases.js')

  state.setIsInteractive(false)

  section('F01 — twelve-phase record: first-stamp-wins, monotonic, honest about gaps')
  {
    phases._resetRunPhasesForTesting()
    phases.noteRunPhase('graph_load', 12)
    phases.noteRunPhase('cli_parse', 15)
    phases.noteRunPhase('invocation_resolution', 20)
    phases.noteRunPhase('config_auth', 40)
    phases.noteRunPhase('assembly', 90)
    phases.noteRunPhase('dispatch', 120)
    phases.noteRunPhase('first_byte', 400)
    phases.noteRunPhase('first_canonical_event', 410)
    phases.noteRunPhase('terminal', 900)
    phases.noteRunPhase('settlement', 910)
    phases.noteRunPhase('flush_exit', 950)
    const r = phases.runPhaseReport(700)
    check(
      'F01: all twelve phases report in declared order with process_start auto-seeded at the clock origin',
      r.phases.length === 12 &&
        r.phases[0]!.phase === 'process_start' &&
        r.phases[0]!.atMs === 0 &&
        JSON.stringify(r.phases.map(p => p.phase)) === JSON.stringify([...phases.RUN_PHASES]),
      `phases=${r.phases.length}`,
    )
    check('F01: the record is monotonic and wall = the latest boundary', r.monotonic && r.wallMs === 950)
    phases.noteRunPhase('dispatch', 5)
    check(
      'F01: first stamp WINS — a later re-stamp never rewrites history',
      phases.runPhaseReport(0).phases.find(p => p.phase === 'dispatch')?.atMs === 120,
    )
  }
  {
    phases._resetRunPhasesForTesting()
    phases.noteRunPhase('assembly', 300)
    phases.noteRunPhase('dispatch', 100)
    const r = phases.runPhaseReport(0)
    check(
      'F01: out-of-order stamps are REPORTED non-monotonic, never silently reordered; unstamped phases stay absent (no invented boundaries)',
      r.monotonic === false && r.phases.length === 3 && !r.phases.some(p => p.phase === 'terminal'),
      `monotonic=${r.monotonic} phases=${r.phases.length}`,
    )
  }
  {
    phases._resetRunPhasesForTesting()
    state.setIsInteractive(true)
    phases.noteRunPhase('dispatch', 10)
    const interactive = phases.runPhaseReport(0).phases.length
    state.setIsInteractive(false)
    check('F01: interactive sessions record NOTHING (headless instrument)', interactive === 0)
  }

  section('F02 — provider latency reports separately from local overhead')
  {
    phases._resetRunPhasesForTesting()
    phases.noteRunPhase('dispatch', 100)
    phases.noteRunPhase('flush_exit', 1000)
    const r = phases.runPhaseReport(750)
    check(
      'F02: localOverheadMs = wall − provider (floored at 0), both reported',
      r.providerApiMs === 750 && r.localOverheadMs === 250 && r.wallMs === 1000,
      `provider=${r.providerApiMs} local=${r.localOverheadMs}`,
    )
    check(
      'F02: a provider figure exceeding wall floors local overhead at 0 (never negative)',
      phases.runPhaseReport(5000).localOverheadMs === 0,
    )
  }


  console.log('')
  let red = 0
  for (const leg of legs) {
    const mark = leg.pass ? '[PASS]' : '[FAIL]'
    if (!leg.pass) red++
    console.log(`  ${mark} ${leg.label}${!leg.pass ? ` — change noteRunPhase or runPhaseReport in src/platform/logs/runPhases.ts${leg.detail ? `: ${leg.detail}` : ''}` : ''}`)
  }
  console.log(
    `\n${legs.length} legs: ${legs.length - red} green, ${red} red — 3.5.3 print phases ${red === 0 ? 'HOLD' : 'BROKEN'}`,
  )
  if (red > 0) process.exit(1)
}

await main()
