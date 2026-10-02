import { INPUT_ROW_TYPES, PARTIAL_ROW_TYPES, ROW_TYPES, type OutcomeRow, type Row, type RowType, type StepRow, type TurnRow } from './vocabulary.js'

export type LooseRow = { type: string; seq?: number; session_id?: string; turn?: number; parent_call_id?: string; [key: string]: unknown }

const CONTROL_TYPES = new Set(['control_request', 'control_response', 'control_cancel_request'])
const ROW_TYPE_SET: ReadonlySet<string> = new Set([...ROW_TYPES, ...PARTIAL_ROW_TYPES])
const INPUT_TYPE_SET: ReadonlySet<string> = new Set(INPUT_ROW_TYPES)

export function parseRow(line: string): LooseRow | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed[0] !== '{') return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  return rowOf(value)
}

export function rowOf(value: unknown): LooseRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.jsonrpc === '2.0') {
    if (record.method !== 'row') return null
    return rowOf(record.params)
  }
  if (typeof record.type !== 'string' || CONTROL_TYPES.has(record.type)) return null
  return record as LooseRow
}

export const isRowType = (type: string): type is RowType => ROW_TYPE_SET.has(type)
export const isInputRowType = (type: string): boolean => INPUT_TYPE_SET.has(type)

export const isOutcome = (row: LooseRow | null | undefined): row is OutcomeRow & LooseRow => row?.type === 'outcome'
export const isSessionRow = (row: LooseRow | null | undefined): boolean => row?.type === 'session'
export const turnOpened = (row: LooseRow | null | undefined): row is TurnRow & LooseRow => row?.type === 'turn' && row.state === 'started'
export const turnWaiting = (row: LooseRow | null | undefined): row is TurnRow & LooseRow => row?.type === 'turn' && row.state === 'waiting'
export const mainThread = (row: LooseRow | null | undefined): boolean => row !== null && row !== undefined && row.parent_call_id === undefined
export const mainThreadStep = (row: LooseRow | null | undefined): row is StepRow & LooseRow => row?.type === 'step' && row.parent_call_id === undefined

export function outcomeErrorText(row: OutcomeRow | LooseRow): string | undefined {
  const error = (row as { error?: { message?: unknown } }).error
  if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
  return undefined
}

export function outcomeFailed(row: OutcomeRow | LooseRow): boolean {
  return (row as { status?: unknown }).status !== 'completed'
}

export function rowSchemaOf(row: LooseRow): number | undefined {
  return typeof row.schema === 'number' ? row.schema : undefined
}

export { ROWS_SCHEMA } from './vocabulary.js'
export type { Row }
