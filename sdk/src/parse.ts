import { INPUT_ROW_SCHEMAS, INPUT_ROW_TYPES, PARTIAL_ROW_TYPES, ROW_SCHEMAS, ROW_TYPES, ROWS_SCHEMA, type InputRow, type InputRowType, type OutcomeRow, type PartialRowType, type Row, type RowType, type SessionRow, type StepRow, type TurnRow } from './rows.js'
import { validate, type Issue } from './validate.js'

export type UnknownRow = { type: 'unknown_row'; originalType: string; raw: Record<string, unknown>; seq?: number; timestamp?: string; parent_call_id?: string }
export type StreamRow = Row | UnknownRow

export type RowReadFailure = 'not_json' | 'not_an_object' | 'no_type' | 'unknown_type' | 'schema_mismatch' | 'invalid'
export type RowRead = { ok: true; row: StreamRow } | { ok: false; reason: RowReadFailure; type?: string; schema?: unknown; issues: Issue[] }
export type InputRowRead = { ok: true; row: InputRow } | { ok: false; reason: Exclude<RowReadFailure, 'schema_mismatch' | 'not_json'>; type?: string; issues: Issue[] }

const ROW_TYPE_SET: ReadonlySet<string> = new Set<string>([...ROW_TYPES, ...PARTIAL_ROW_TYPES])
const INPUT_TYPE_SET: ReadonlySet<string> = new Set<string>(INPUT_ROW_TYPES)

export const isRowType = (type: string): type is RowType | PartialRowType => ROW_TYPE_SET.has(type)
export const isInputRowType = (type: string): type is InputRowType => INPUT_TYPE_SET.has(type)

export function rowOf(value: unknown): RowRead {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not_an_object', issues: [] }
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return { ok: false, reason: 'no_type', issues: [] }
  const type = record.type
  if (!isRowType(type)) return { ok: true, row: { type: 'unknown_row', originalType: type, raw: record } }
  if ((type === 'session' || type === 'outcome') && record.schema !== ROWS_SCHEMA) return { ok: false, reason: 'schema_mismatch', type, schema: record.schema, issues: [] }
  const issues = validate(ROW_SCHEMAS[type], record)
  if (issues.length > 0) return { ok: false, reason: 'invalid', type, issues }
  return { ok: true, row: record as unknown as Row }
}

export function parseRow(line: string): RowRead {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed[0] !== '{') return { ok: false, reason: 'not_json', issues: [] }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: 'not_json', issues: [] }
  }
  return rowOf(value)
}

export function inputRowOf(value: unknown): InputRowRead {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'not_an_object', issues: [] }
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string') return { ok: false, reason: 'no_type', issues: [] }
  const type = record.type
  if (!isInputRowType(type)) return { ok: false, reason: 'unknown_type', type, issues: [] }
  const issues = validate(INPUT_ROW_SCHEMAS[type], record)
  if (issues.length > 0) return { ok: false, reason: 'invalid', type, issues }
  return { ok: true, row: record as unknown as InputRow }
}

export const isOutcome = (row: StreamRow | null | undefined): row is OutcomeRow => row?.type === 'outcome'
export const isSessionRow = (row: StreamRow | null | undefined): row is SessionRow => row?.type === 'session'
export const turnOpened = (row: StreamRow | null | undefined): row is TurnRow => row?.type === 'turn' && row.state === 'started'
export const turnWaiting = (row: StreamRow | null | undefined): row is TurnRow => row?.type === 'turn' && row.state === 'waiting'
export const mainThreadStep = (row: StreamRow | null | undefined): row is StepRow => row?.type === 'step' && row.parent_call_id === undefined
export const isMainThread = (row: StreamRow): boolean => row.parent_call_id === undefined
export const outcomeFailed = (row: OutcomeRow): boolean => row.status !== 'completed'
export const outcomeErrorText = (row: OutcomeRow): string | undefined => row.error?.message
