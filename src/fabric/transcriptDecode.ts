// ============================================================================
//  fabric/transcriptDecode — the validating transcript read seam (
//  IDM-6, ER-4). The durable read path yields a TOTAL ACCOUNTING: every
//  input line is either a decoded entry, a classified malformed line, or a
//  classified invalid-shape record — nothing silently vanishes and no
//  compile-time cast reaches a consumer unexamined.
//
//  The durable format is the versioned MercuryRecord envelope, and it is the
//  ONLY format this seam opens. A file whose lines are not records is
//  refused whole with one honest verdict (`refusal`) — never translated,
//  never a crash: every consumer surfaces TRANSCRIPT_FORMAT_REFUSAL and
//  degrades to an empty read.
//
//  Hot-path design: the happy path stays at parseJSONL speed — a fast
//  newline count proves totality (values == non-empty lines); only when the
//  counts disagree (corruption present, rare) does a line-by-line rescan
//  run to classify WHICH lines were malformed. Shape classification is a
//  cheap O(entries) structural pass over the decoded values.
// ============================================================================
import { parseJSONL } from '../utils/json.js'
import { recordToEntry } from './entryCodec.js'
import { validateRecord } from './validate.js'

export type MalformedLine = { line: number; snippet: string }
export type InvalidShape = { index: number; kind: string; reason: string }

/** The one honest line every reader speaks when a file is not in the
 *  Mercury record format. */
export const TRANSCRIPT_FORMAT_REFUSAL =
  'this session file uses a retired format and cannot be opened'

export type DecodedTranscript<T> = {
  /** Structurally-plausible entries (the tolerant reader's working set). */
  entries: T[]
  /** Unparseable lines, classified by position — retained visibly. */
  malformed: MalformedLine[]
  /** Parsed values whose shape violates the record contract. */
  invalid: InvalidShape[]
  /** Non-empty input lines (the accounting total). */
  totalLines: number
  /** Set when the FILE is refused whole: its first parseable line is not a
   *  MercuryRecord envelope, so the file is not in Mercury's format.
   *  Entries are empty; the value is TRANSCRIPT_FORMAT_REFUSAL. */
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

/** Classify which lines fail to parse (the rare rescue path). */
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

/** A record line: the versioned MercuryRecord envelope (every line is
 *  self-describing). */
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
      // A stray non-record object inside a record file (file-level format
      // refusal already ran on the FIRST parseable line) — classified, never
      // folded.
      invalid.push({ index: i, kind: 'not-a-record', reason: 'line is not a MercuryRecord envelope' })
      continue
    }
    // The IDM-1 validation boundary: the record either VALIDATES (a newer
    // schema's unknown payload kind is retained per the law) or is
    // classified invalid with its issue paths — no compile-time cast
    // reaches the projection.
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
    // Project the record to the in-memory entry shape (the codec's proven
    // inverse) so every reader keeps ONE fold.
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
    // Structural entry-shape floor on the projected entry: a message-kind
    // entry must carry an object `message`; every entry a string `type`.
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

/** The file-format verdict: the first PARSEABLE object line decides. A file
 *  whose first parseable line is an object that is not a MercuryRecord
 *  envelope is not in Mercury's format — refused whole. Unparseable lines
 *  (a torn head) don't decide; the malformed accounting covers them. */
function firstParsedIsForeign(values: unknown[]): boolean {
  for (const v of values) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
    return !isRecordLine(v as Record<string, unknown>)
  }
  return false
}

/**
 * Decode a transcript buffer with total line accounting:
 * entries + malformed + invalid together cover every non-empty input line —
 * or one whole-file `refusal` when the file is not in Mercury's format.
 */
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
