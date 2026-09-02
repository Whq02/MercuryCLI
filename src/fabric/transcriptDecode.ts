import { parseJSONL } from '../utils/json.js'
import { recordToEntry } from './entryCodec.js'
import { validateRecord } from './validate.js'

export type MalformedLine = { line: number; snippet: string }
export type InvalidShape = { index: number; kind: string; reason: string }

export const TRANSCRIPT_FORMAT_REFUSAL =
  'this session file uses a retired format and cannot be opened'

export type DecodedTranscript<T> = {
  entries: T[]
  malformed: MalformedLine[]
  invalid: InvalidShape[]
  totalLines: number
  refusal?: string
}

const NEWLINE = 0x0a

function countNonEmptyLines(data: string | Buffer): number {
  let count = 0
  if (typeof data === 'string') {
    let sawContent = false
    for (let i = 0; i < data.length; i++) {
      if (data.charCodeAt(i) === NEWLINE) {
        if (sawContent) count++
        sawContent = false
      } else if (!sawContent && data.charCodeAt(i) > 0x20) sawContent = true
    }
    if (sawContent) count++
    return count
  }
  let sawContent = false
  for (let i = 0; i < data.length; i++) {
    if (data[i] === NEWLINE) {
      if (sawContent) count++
      sawContent = false
    } else if (!sawContent && data[i]! > 0x20) sawContent = true
  }
  if (sawContent) count++
  return count
}

function classifyMalformed(data: string | Buffer): MalformedLine[] {
  const text = typeof data === 'string' ? data : data.toString('utf8')
  const out: MalformedLine[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    try {
      JSON.parse(line)
    } catch {
      out.push({ line: i + 1, snippet: line.slice(0, 120) })
    }
  }
  return out
}

function isRecordLine(o: Record<string, unknown>): boolean {
  return (
    typeof o.schemaVersion === 'number' &&
    typeof o.recordId === 'string' &&
    typeof o.payload === 'object' &&
    o.payload !== null &&
    typeof (o.payload as Record<string, unknown>).kind === 'string'
  )
}

function classifyInvalid(values: unknown[]): { valid: unknown[]; invalid: InvalidShape[] } {
  const valid: unknown[] = []
  const invalid: InvalidShape[] = []
  for (let i = 0; i < values.length; i++) {
    let v = values[i]
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      invalid.push({ index: i, kind: 'non-object', reason: 'transcript line is not an object record' })
      continue
    }
    if (!isRecordLine(v as Record<string, unknown>)) {
      invalid.push({ index: i, kind: 'not-a-record', reason: 'line is not a MercuryRecord envelope' })
      continue
    }
    const validated = validateRecord(v)
    if (!validated.ok) {
      invalid.push({
        index: i,
        kind: 'record-invalid',
        reason: `record failed validation: ${validated.issues
          .slice(0, 3)
          .map(x => `${x.path}: ${x.message}`)
          .join('; ')}`,
      })
      continue
    }
    try {
      v = recordToEntry(validated.record)
    } catch (e) {
      invalid.push({
        index: i,
        kind: 'record-unprojectable',
        reason: `record line failed projection: ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }
    const o = v as Record<string, unknown>
    if (typeof o.type !== 'string') {
      invalid.push({ index: i, kind: 'untyped', reason: 'record carries no string `type`' })
      continue
    }
    if (
      (o.type === 'user' || o.type === 'assistant') &&
      (o.message === null || typeof o.message !== 'object')
    ) {
      invalid.push({ index: i, kind: o.type, reason: '`message` is not an object' })
      continue
    }
    valid.push(v)
  }
  return { valid, invalid }
}

function firstParsedIsForeign(values: unknown[]): boolean {
  for (const v of values) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    return !isRecordLine(v as Record<string, unknown>)
  }
  return false
}

export function decodeTranscriptBuffer<T>(data: string | Buffer): DecodedTranscript<T> {
  const values = parseJSONL<unknown>(data)
  const totalLines = countNonEmptyLines(data)
  if (firstParsedIsForeign(values)) {
    return { entries: [], malformed: [], invalid: [], totalLines, refusal: TRANSCRIPT_FORMAT_REFUSAL }
  }
  const malformed = values.length === totalLines ? [] : classifyMalformed(data)
  const { valid, invalid } = classifyInvalid(values)
  return { entries: valid as T[], malformed, invalid, totalLines }
}
