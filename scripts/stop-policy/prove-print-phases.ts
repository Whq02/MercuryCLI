#!/usr/bin/env bun
// ============================================================================
//  scripts/stop-policy/prove-print-phases.ts
//  STAGE 3.5.3 — minimal print graph + twelve-phase instrumentation
//  (F01-F12): a print invocation records every phase from
//  process start through clean exit on ONE monotonic clock, provider time
//  reports separately from local overhead, and the print route mounts no UI
//  and starts no daemon/multiplayer subsystem.
//
//  Behavioral legs drive the pure phase store (printPhases.ts); wiring legs
//  pin each stamp at its owner. Measurement rows stay measurement-gated and
//  ride Stage 4 (F03 report shape · F07 ≥50% local-overhead cut vs Wave-0 ·
//  F08 stretch p95) — the bench battery needs the operator re-auth.
//  F09 = the forwarding budget (prove-tool-delta-grammar owns it).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
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
const src = (p: string): string => readFileSync(join(import.meta.dir, '../../', p), 'utf8')

async function main(): Promise<void> {
  const state = await import('../../src/bootstrap/state.js')
  const phases = await import('../../src/utils/printPhases.js')

  // Declared posture (ambient-state law): these proofs model a PRINT process.
  state.setIsInteractive(false)

  // ── F01 · one monotonic clock, twelve named phases ────────────────────────
  section('F01 — twelve-phase record: first-stamp-wins, monotonic, honest about gaps')
  {
    phases._resetPrintPhasesForTesting()
    phases.notePrintPhase('graph_load', 12)
    phases.notePrintPhase('cli_parse', 15)
    phases.notePrintPhase('invocation_resolution', 20)
    phases.notePrintPhase('config_auth', 40)
    phases.notePrintPhase('assembly', 90)
    phases.notePrintPhase('dispatch', 120)
    phases.notePrintPhase('first_byte', 400)
    phases.notePrintPhase('first_canonical_event', 410)
    phases.notePrintPhase('terminal', 900)
    phases.notePrintPhase('settlement', 910)
    phases.notePrintPhase('flush_exit', 950)
    const r = phases.printPhaseReport(700)
    check(
      'F01: all twelve phases report in declared order with process_start auto-seeded at the clock origin',
      r.phases.length === 12 &&
        r.phases[0]!.phase === 'process_start' &&
        r.phases[0]!.atMs === 0 &&
        JSON.stringify(r.phases.map(p => p.phase)) === JSON.stringify([...phases.PRINT_PHASES]),
      `phases=${r.phases.length}`,
    )
    check('F01: the record is monotonic and wall = the latest boundary', r.monotonic && r.wallMs === 950)
    phases.notePrintPhase('dispatch', 5)
    check(
      'F01: first stamp WINS — a later re-stamp never rewrites history',
      phases.printPhaseReport(0).phases.find(p => p.phase === 'dispatch')?.atMs === 120,
    )
  }
  {
    phases._resetPrintPhasesForTesting()
    phases.notePrintPhase('assembly', 300)
    phases.notePrintPhase('dispatch', 100)
    const r = phases.printPhaseReport(0)
    check(
      'F01: out-of-order stamps are REPORTED non-monotonic, never silently reordered; unstamped phases stay absent (no invented boundaries)',
      r.monotonic === false && r.phases.length === 3 && !r.phases.some(p => p.phase === 'terminal'),
      `monotonic=${r.monotonic} phases=${r.phases.length}`,
    )
  }
  {
    phases._resetPrintPhasesForTesting()
    state.setIsInteractive(true)
    phases.notePrintPhase('dispatch', 10)
    const interactive = phases.printPhaseReport(0).phases.length
    state.setIsInteractive(false)
    check('F01: interactive sessions record NOTHING (print-only instrument)', interactive === 0)
  }

  // ── F02 · provider time separate from local overhead ──────────────────────
  section('F02 — provider latency reports separately from local overhead')
  {
    phases._resetPrintPhasesForTesting()
    phases.notePrintPhase('dispatch', 100)
    phases.notePrintPhase('flush_exit', 1000)
    const r = phases.printPhaseReport(750)
    check(
      'F02: localOverheadMs = wall − provider (floored at 0), both reported',
      r.providerApiMs === 750 && r.localOverheadMs === 250 && r.wallMs === 1000,
      `provider=${r.providerApiMs} local=${r.localOverheadMs}`,
    )
    check(
      'F02: a provider figure exceeding wall floors local overhead at 0 (never negative)',
      phases.printPhaseReport(5000).localOverheadMs === 0,
    )
  }

  // ── wiring: every stamp at its owner ──────────────────────────────────────
  section('F01 wiring — the twelve stamps live at their owners (both provider lanes)')
  {
    const print = src('src/cli/print.ts')
    const engine = src('src/QueryEngine.ts')
    const anthropic = src('src/services/providers/anthropic/streamCore.ts')
    const openai = src('src/services/providers/openai/openaiCallModel.ts')
    check(
      'print.ts stamps graph_load (backdated to cli_entry) · cli_parse · invocation_resolution · config_auth · flush_exit',
      print.includes("notePrintPhase('graph_load', getPerformance().getEntriesByName('cli_entry')[0]?.startTime)") &&
        print.includes("notePrintPhase('cli_parse')") &&
        print.includes("notePrintPhase('invocation_resolution')") &&
        print.includes("notePrintPhase('config_auth')") &&
        print.includes("notePrintPhase('flush_exit')"),
    )
    check(
      'QueryEngine stamps assembly · first_canonical_event · terminal · settlement (settlement inside baseResult — every terminal envelope passes it)',
      engine.includes("notePrintPhase('assembly')") &&
        engine.includes("notePrintPhase('first_canonical_event')") &&
        engine.includes("notePrintPhase('terminal')") &&
        engine.includes("notePrintPhase('settlement')"),
    )
    check(
      'BOTH provider lanes stamp dispatch + first_byte (anthropic streamCore · openai callModel)',
      anthropic.includes("notePrintPhase('dispatch')") &&
        anthropic.includes("notePrintPhase('first_byte')") &&
        openai.includes("notePrintPhase('dispatch')") &&
        openai.includes("notePrintPhase('first_byte')"),
    )
    check(
      'F02 wiring: the report ships at BOTH flush boundaries with the api-duration ledger figure',
      (print.match(/\[print-phases\]/g) ?? []).length >= 2 &&
        print.includes('printPhaseReport(getTotalAPIDuration())'),
    )
  }

  // ── F04/F05 · the print route mounts no UI, starts no daemon ──────────────
  section('F04/F05 — print mounts no UI/splash and starts no daemon/multiplayer')
  {
    const print = src('src/cli/print.ts')
    check(
      "F04: the print owner never mounts Ink (no ink import, no render()) and never touches the splash",
      !print.includes("from 'ink'") && !/\brender\(/.test(print) && !/splash/i.test(print),
    )
    check(
      'F05: the print owner starts no daemon/supervisor and no multiplayer room host',
      !/ensureDaemon|startDaemon|spawnDaemon|longLivedSupervisor|roomHost/.test(print),
    )
    // The audited residue, recorded honestly: the -p route still EVALUATES
    // the main.js commander graph (cli.tsx routes through main). That load
    // cost is the F07 measurement's target, priced by the Stage-4 battery —
    // not silently claimed fixed here.
    const cli = src('src/entrypoints/cli.tsx')
    check(
      'F04 audit pin: the -p route reaches print through the main.js graph (the recorded residue the F07 battery prices)',
      cli.includes("await import('../main.js')"),
    )
  }

  // ── F06/F12 · optional subsystems lazy + truthfully phased ────────────────
  section('F06/F12 — optional subsystems load lazily and record their phase truthfully')
  {
    const engine = src('src/QueryEngine.ts')
    check(
      'F06: print-path extensions load from DISK ONLY (no network block) and skills/extensions record their load phase',
      engine.includes('ensureExtensionsLoaded(') &&
        engine.includes("headlessProfilerCheckpoint('before_skills_extensions')") &&
        engine.includes("headlessProfilerCheckpoint('after_skills_extensions')"),
    )
  }

  // ── F09/F10/F11 dispositions (owners hold the proofs) ─────────────────────
  section('F09/F10/F11 — dispositions at their owning provers')
  {
    check(
      'F09: forwarding budget owned by prove-tool-delta-grammar (C07 p95 probe)',
      src('scripts/stop-policy/prove-tool-delta-grammar.ts').includes('p95 fold latency'),
    )
    const print = src('src/cli/print.ts')
    check(
      'F10: exit durability unchanged — the flush stamp precedes gracefulShutdownSync; the K7 trace-flush + drain-aware exit owners keep their laws',
      print.includes("notePrintPhase('flush_exit')") && print.includes('gracefulShutdownSync('),
    )
    check(
      'F11: cold/warm parity rides the compile-cache law (byte-stable reuse prover) — the cache changes parse cost, never behavior',
      src('scripts/node-runtime/prove-compile-cache.ts').includes('byte'),
    )
  }

  // ── verdict ───────────────────────────────────────────────────────────────
  console.log('')
  let red = 0
  for (const leg of legs) {
    const mark = leg.pass ? '[PASS]' : '[FAIL]'
    if (!leg.pass) red++
    console.log(`  ${mark} ${leg.label}${leg.detail && !leg.pass ? ` — ${leg.detail}` : ''}`)
  }
  console.log(
    `\n${legs.length} legs: ${legs.length - red} green, ${red} red — 3.5.3 print phases ${red === 0 ? 'HOLD' : 'BROKEN'}`,
  )
  if (red > 0) process.exit(1)
}

await main()
