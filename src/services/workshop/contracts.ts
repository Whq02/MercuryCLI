// ============================================================================
//  workshop/contracts — the persistent code-cell runtime's types + gate
//
//
//  A Workshop runtime is OWNER-SCOPED (one per conversation owner ×
//  language × generation): cells share state across calls; a timeout/cancel
//  terminates the worker and bumps the generation (state loss is REPORTED,
//  never silent); reset is explicit; owner disposal reaps everything.
// ============================================================================

import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export type WorkshopLanguage = 'js' | 'ts' | 'py'

export interface WorkshopCellInput {
  language: WorkshopLanguage
  title?: string
  code: string
  timeoutMs?: number
  reset?: boolean
}

export type WorkshopCellState =
  | 'succeeded'
  | 'failed'
  | 'timed-out'
  | 'cancelled'

export interface WorkshopDisplayItem {
  kind: 'text' | 'json' | 'markdown' | 'table' | 'ref'
  value: string
}

export interface WorkshopCellResult {
  cellId: string
  title?: string
  language: WorkshopLanguage
  state: WorkshopCellState
  /** The runtime generation the cell ran in (bumps on kill/reset). */
  generation: number
  /** True when THIS cell's failure killed the runtime (state lost). */
  runtimeKilled: boolean
  durationMs: number
  /** The cell's completion value, bounded-rendered ('' when undefined). */
  valuePreview: string
  /** Captured console/stdout lines (bounded tail; full via artifactRef). */
  outputTail: string[]
  /** mercury.display() items emitted during the cell. */
  displays: WorkshopDisplayItem[]
  /** Set when the output overflowed the tail and spilled to an artifact. */
  artifactRef?: string
  /** Error message for failed cells. */
  error?: string
  /** Nested tool/agent calls the cell made through the bridge. */
  nestedCalls: number
  /** Which TypeScript handled a ts cell ('workspace typescript@x.y.z'). */
  compiler?: string
}

/** Default per-cell wall ceiling; nested tool/agent waits PAUSE the idle
 *  budget but the overall ceiling always stands. */
export const DEFAULT_CELL_TIMEOUT_MS = 30_000
export const MAX_CELL_TIMEOUT_MS = 600_000
export const OVERALL_CELL_CEILING_MS = 600_000
/** Output tail retention per cell (full stream spills to an artifact). */
export const OUTPUT_TAIL_LINES = 60
export const OUTPUT_SPILL_THRESHOLD_LINES = 200

export function workshopEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_WORKSHOP'))
}
