
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
  phases: Array<{ phase: PrintPhase; atMs: number }>
  monotonic: boolean
  wallMs: number
  providerApiMs: number
  localOverheadMs: number
}

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

export function _resetPrintPhasesForTesting(): void {
  stamps.clear()
}
