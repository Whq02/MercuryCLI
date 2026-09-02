// ============================================================================
//  printPhases —.5.3 (F01/F02): the twelve-phase monotonic record
//  of a print (-p/SDK) invocation, process start → clean exit, on the ONE
//  monotonic clock (perf hooks — origin IS process start).
//
//  Always-on in non-interactive sessions: twelve first-stamp-wins map sets,
//  no sampling — unlike the legacy mark layer (headlessProfiler.ts), which
//  stays for fine-grained per-turn checkpoints. A multi-turn SDK process
//  records its FIRST full cycle (the boot truth); per-turn latency remains
//  the legacy layer's job. Early-terminal paths (max-turns, budget,
//  structured-output retries) settle without a 'terminal' stamp — the report
//  lists exactly what stamped, never an invented boundary.
//
//  The twelve phases and their owners:
//    process_start          the clock origin (stamped 0 by definition)
//    graph_load             runHeadless entry, backdated to the startup
//                           profiler's cli_entry mark when it exists
//    cli_parse              runHeadless entry (args parsed, print routed)
//    invocation_resolution  output/input contract resolved (print.ts)
//    config_auth            model + config resolution done (print.ts)
//    assembly               system prompt/tools/skills assembled (QueryEngine)
//    dispatch               provider request sent (both lanes)
//    first_byte             first provider stream chunk (both lanes)
//    first_canonical_event  first canonical run event consumed (QueryEngine)
//    terminal               the query loop settled (QueryEngine)
//    settlement             the terminal result envelope minted (baseResult)
//    flush_exit             output flushed, exit imminent (print.ts)
//
//  F02: provider latency reports separately from local overhead — the caller
//  passes the api-duration ledger's figure at report time, keeping this
//  module pure (no service imports, no cycles).
// ============================================================================

import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getPerformance } from './profilerBase.js'

export const PRINT_PHASES = [
  'process_start',
  'graph_load',
  'cli_parse',
  'invocation_resolution',
  'config_auth',
  'assembly',
  'dispatch',
  'first_byte',
  'first_canonical_event',
  'terminal',
  'settlement',
  'flush_exit',
] as const

export type PrintPhase = (typeof PRINT_PHASES)[number]

const stamps = new Map<PrintPhase, number>()

/**
 * Stamp a phase boundary. First stamp wins; later calls are no-ops (a
 * multi-turn process keeps its first cycle). `atMs` backdates to an already
 * recorded monotonic time (e.g. a perf mark's startTime) — clamped at 0.
 * Interactive sessions record nothing.
 */
export function notePrintPhase(phase: PrintPhase, atMs?: number): void {
  if (!getIsNonInteractiveSession()) return
  if (stamps.size === 0 && phase !== 'process_start') {
    stamps.set('process_start', 0)
  }
  if (stamps.has(phase)) return
  const at = atMs !== undefined ? Math.max(0, atMs) : getPerformance().now()
  stamps.set(phase, at)
}

export interface PrintPhaseReport {
  /** Stamped phases in DECLARED order (the twelve-phase vocabulary). */
  phases: Array<{ phase: PrintPhase; atMs: number }>
  /** True when every stamped phase is non-decreasing in declared order. */
  monotonic: boolean
  /** Wall time through the latest stamped boundary. */
  wallMs: number
  /** Provider time as the api-duration ledger reported it (F02). */
  providerApiMs: number
  /** wall − provider, floored at 0 — the local-overhead figure (F02). */
  localOverheadMs: number
}

/** Build the report. Pure fold over the stamps — call at the flush boundary
 *  with the api-duration ledger's current figure. */
export function printPhaseReport(providerApiMs: number): PrintPhaseReport {
  const phases: Array<{ phase: PrintPhase; atMs: number }> = []
  for (const phase of PRINT_PHASES) {
    const at = stamps.get(phase)
    if (at !== undefined) phases.push({ phase, atMs: Math.round(at * 1000) / 1000 })
  }
  let monotonic = true
  for (let i = 1; i < phases.length; i++) {
    if (phases[i]!.atMs < phases[i - 1]!.atMs) monotonic = false
  }
  const wallMs = phases.reduce((max, p) => Math.max(max, p.atMs), 0)
  const provider = Math.max(0, providerApiMs)
  return {
    phases,
    monotonic,
    wallMs,
    providerApiMs: provider,
    localOverheadMs: Math.max(0, Math.round((wallMs - provider) * 1000) / 1000),
  }
}

/** Prover seam — phases are process-lifetime state. */
export function _resetPrintPhasesForTesting(): void {
  stamps.clear()
}
