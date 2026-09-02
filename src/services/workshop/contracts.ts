
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
  generation: number
  runtimeKilled: boolean
  durationMs: number
  valuePreview: string
  outputTail: string[]
  displays: WorkshopDisplayItem[]
  artifactRef?: string
  error?: string
  nestedCalls: number
  compiler?: string
}

export const DEFAULT_CELL_TIMEOUT_MS = 30_000
export const MAX_CELL_TIMEOUT_MS = 600_000
export const OVERALL_CELL_CEILING_MS = 600_000
export const OUTPUT_TAIL_LINES = 60
export const OUTPUT_SPILL_THRESHOLD_LINES = 200

export function workshopEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_WORKSHOP'))
}
