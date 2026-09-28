import { basename, extname } from 'node:path'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { expandPath, hasNulByte } from '../../utils/path.js'
import {
  JEV_EVAL_FILE_KEY,
  JEV_EVAL_FORMAT_BY_EXTENSION,
  JEV_EVAL_ID_COLUMN,
  JEV_EVAL_ID_PATTERN,
  JEV_EVAL_MAX_FILE_BYTES,
  JEV_EVAL_MAX_ID_CHARS,
  JEV_EVAL_MAX_ROWS,
  JEV_EVAL_PARAGRAPH_FACT,
  JEV_EVAL_ROW_POSITION_PREFIX,
  JEV_EVAL_TABLE_KEY,
} from './constants.js'
import type { JevEvalEvidenceItem, JevEvalFileItem, JevEvalFormat, JevEvalRecordItem, JevEvalTableItem } from './jevEvalSchema.js'

export function jevEvalFileOf(item: JevEvalEvidenceItem): JevEvalFileItem[typeof JEV_EVAL_FILE_KEY] | undefined {
  if (typeof item === 'string') return undefined
  const value = (item as Record<string, unknown>)[JEV_EVAL_FILE_KEY]
  return typeof value === 'object' && value !== null ? (value as JevEvalFileItem[typeof JEV_EVAL_FILE_KEY]) : undefined
}

export function jevEvalTableOf(item: JevEvalEvidenceItem): JevEvalTableItem[typeof JEV_EVAL_TABLE_KEY] | undefined {
  if (typeof item === 'string') return undefined
  const value = (item as Record<string, unknown>)[JEV_EVAL_TABLE_KEY]
  return typeof value === 'object' && value !== null ? (value as JevEvalTableItem[typeof JEV_EVAL_TABLE_KEY]) : undefined
}

export interface JevEvalItem {
  label: string
  index: number
  state: Record<string, string>
  origin?: string
}

export interface JevEvalSource {
  title: string
  format: JevEvalFormat | 'table'
  rows: number
  bytes?: number
  idColumn?: string
}

export interface JevEvalWhere {
  index: number
  name: string
  unit: string
}

export interface JevEvalRecord {
  line: number
  facts: Record<string, string>
}

export interface JevEvalRow {
  id?: string
  state: Record<string, string>
  origin: string
}

export type JevEvalRowsResult = { ok: true; rows: JevEvalRow[]; idColumn?: string } | { ok: false; reason: string }
export type JevEvalRecordsResult = { ok: true; records: JevEvalRecord[] } | { ok: false; reason: string }
export type JevEvalTableResult = { ok: true; columns: string[]; rows: string[][]; lines: number[] } | { ok: false; reason: string }
export type JevEvalExpansion = { ok: true; items: JevEvalItem[]; sources: JevEvalSource[] } | { ok: false; reason: string }

export function jevEvalRowLabel(index: number): string {
  return `${JEV_EVAL_ROW_POSITION_PREFIX}${index + 1}`
}

export function jevEvalOrigin(where: JevEvalWhere, line?: number): string {
  return line === undefined ? where.name : `${where.name} ${where.unit} ${line}`
}

export function jevEvalAt(where: JevEvalWhere, line?: number): string {
  return `evidence[${where.index}] (${jevEvalOrigin(where, line)})`
}

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function lines(text: string): string[] {
  return text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

export function jevEvalFormatOf(path: string, explicit?: JevEvalFormat): JevEvalFormat {
  return explicit ?? JEV_EVAL_FORMAT_BY_EXTENSION[extname(path).toLowerCase()] ?? 'text'
}

export function jevEvalTsv(text: string, where: JevEvalWhere): JevEvalTableResult {
  let columns: string[] | undefined
  const rows: string[][] = []
  const rowLines: number[] = []
  lines(text).forEach((line, index) => {
    if (line.trim() === '') return
    if (columns === undefined) {
      columns = line.split('\t')
      return
    }
    rows.push(line.split('\t'))
    rowLines.push(index + 1)
  })
  if (columns === undefined) return refuse(`${jevEvalAt(where)} has no header line`)
  return { ok: true, columns, rows, lines: rowLines }
}

export function jevEvalCsv(text: string, where: JevEvalWhere): JevEvalTableResult {
  const records: Array<{ line: number; cells: string[] }> = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let startLine = 1
  let i = 0
  const closeRecord = (): void => {
    cells.push(cell)
    if (!(cells.length === 1 && cells[0] === '')) records.push({ line: startLine, cells })
    cells = []
    cell = ''
  }
  while (i < text.length) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      if (ch === '\n') line++
      cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === '') {
      quoted = true
      i++
      continue
    }
    if (ch === ',') {
      cells.push(cell)
      cell = ''
      i++
      continue
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      i++
      continue
    }
    if (ch === '\n') {
      closeRecord()
      line++
      startLine = line
      i++
      continue
    }
    cell += ch
    i++
  }
  if (quoted) return refuse(`${jevEvalAt(where, startLine)} opens a quote that never closes`)
  if (cell !== '' || cells.length > 0) closeRecord()
  const [header, ...rest] = records
  if (header === undefined) return refuse(`${jevEvalAt(where)} has no header line`)
  return { ok: true, columns: header.cells, rows: rest.map(record => record.cells), lines: rest.map(record => record.line) }
}

const MARKDOWN_DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function markdownCells(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

export function jevEvalMarkdown(text: string, where: JevEvalWhere): JevEvalTableResult {
  const all = lines(text)
  for (let i = 0; i + 1 < all.length; i++) {
    const header = all[i]!
    const delimiter = all[i + 1]!
    if (!header.includes('|') || !MARKDOWN_DELIMITER_ROW.test(delimiter) || !delimiter.includes('-')) continue
    const columns = markdownCells(header)
    if (markdownCells(delimiter).length !== columns.length) continue
    const rows: string[][] = []
    const rowLines: number[] = []
    for (let j = i + 2; j < all.length; j++) {
      const line = all[j]!
      if (line.trim() === '' || !line.includes('|')) break
      rows.push(markdownCells(line))
      rowLines.push(j + 1)
    }
    return { ok: true, columns, rows, lines: rowLines }
  }
  return refuse(`${jevEvalAt(where)} has no pipe table (a header row, a |---| row, then rows); pass format "text" to send it as one item`)
}

function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `${typeof value === 'object' ? 'an' : 'a'} ${typeof value}`
}

export function jevEvalJsonl(text: string, where: JevEvalWhere): JevEvalRecordsResult {
  const records: JevEvalRecord[] = []
  const all = lines(text)
  for (let index = 0; index < all.length; index++) {
    const line = all[index]!
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return refuse(`${jevEvalAt(where, index + 1)} is not JSON`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refuse(`${jevEvalAt(where, index + 1)} is not a JSON object`)
    const facts: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') facts[key] = value
      else if (typeof value === 'number' || typeof value === 'boolean') facts[key] = String(value)
      else return refuse(`${jevEvalAt(where, index + 1)} key "${key}" holds ${kindOf(value)}; a fact is a string (a number or a boolean is spelled out; nothing else is accepted)`)
    }
    records.push({ line: index + 1, facts })
  }
  return { ok: true, records }
}

export function jevEvalParagraphs(text: string): JevEvalRecord[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map(paragraph => paragraph.trim())
    .filter(paragraph => paragraph !== '')
    .map((paragraph, index) => ({ line: index + 1, facts: { [JEV_EVAL_PARAGRAPH_FACT]: paragraph } }))
}

function validId(value: string): boolean {
  return value.length > 0 && value.length <= JEV_EVAL_MAX_ID_CHARS && JEV_EVAL_ID_PATTERN.test(value)
}

export function jevEvalRecordRows(records: readonly JevEvalRecord[], idColumn: string | undefined, where: JevEvalWhere, seen: Map<string, string>): JevEvalRowsResult {
  const rows: JevEvalRow[] = []
  let usedIdColumn: string | undefined
  for (const record of records) {
    const at = jevEvalAt(where, record.line)
    const key = idColumn ?? (JEV_EVAL_ID_COLUMN in record.facts ? JEV_EVAL_ID_COLUMN : undefined)
    if (idColumn !== undefined && !(idColumn in record.facts)) return refuse(`${at} has no key "${idColumn}"`)
    const state: Record<string, string> = {}
    let id: string | undefined
    for (const [name, value] of Object.entries(record.facts)) {
      if (name === key) id = value
      else state[name] = value
    }
    if (key !== undefined) {
      usedIdColumn = key
      if (id === undefined || !validId(id)) return refuse(`${at} id "${id ?? ''}" is not letters, digits, _ and - of at most ${JEV_EVAL_MAX_ID_CHARS} characters`)
      const first = seen.get(id)
      if (first !== undefined) return refuse(`${at} id "${id}" is already the row key of ${first}; ids are the row keys and must be unique across the whole call`)
      seen.set(id, at)
    }
    if (Object.keys(state).length === 0) return refuse(`${at} needs a fact besides "${key}"`)
    rows.push({ id, state, origin: jevEvalOrigin(where, record.line) })
  }
  return { ok: true, rows, idColumn: usedIdColumn }
}

export function jevEvalTableRows(columns: readonly string[], rows: readonly (readonly string[])[], idColumn: string | undefined, where: JevEvalWhere, seen: Map<string, string>, lines?: readonly number[]): JevEvalRowsResult {
  const names = columns.map(column => column.trim())
  const empty = names.findIndex(name => name === '')
  if (empty !== -1) return refuse(`${jevEvalAt(where)} header column ${empty + 1} is empty`)
  const twice = names.find((name, index) => names.indexOf(name) !== index)
  if (twice !== undefined) return refuse(`${jevEvalAt(where)} header names "${twice}" twice`)
  const key = idColumn ?? (names.includes(JEV_EVAL_ID_COLUMN) ? JEV_EVAL_ID_COLUMN : undefined)
  if (key !== undefined && !names.includes(key)) return refuse(`${jevEvalAt(where)} has no column "${key}"`)
  if (key !== undefined && names.length === 1) return refuse(`${jevEvalAt(where)} needs a fact column besides "${key}"`)
  if (rows.length === 0) return refuse(`${jevEvalAt(where)} has a header and no rows`)
  const records: JevEvalRecord[] = []
  for (let index = 0; index < rows.length; index++) {
    const cells = rows[index]!
    const line = lines?.[index] ?? index + 1
    if (cells.length !== names.length) return refuse(`${jevEvalAt(where, line)} has ${count(cells.length, 'cell')} where the header has ${names.length}; a row is never padded or cut`)
    records.push({ line, facts: Object.fromEntries(names.map((name, column) => [name, cells[column]!])) })
  }
  return jevEvalRecordRows(records, key, where, seen)
}

type FileRead = { ok: true; path: string; text: string; bytes: number } | { ok: false; reason: string }

function readEvidenceFile(index: number, given: string): FileRead {
  if (hasNulByte(given)) return refuse(`evidence[${index}].file.path contains a NUL byte; nothing was read and nothing was sent`)
  const path = expandPath(given)
  const fs = getFsImplementation()
  let size: number
  try {
    const stat = fs.statSync(path)
    if (stat.isDirectory()) return refuse(`evidence[${index}].file.path ${path} is a directory, not a file; nothing was sent`)
    if (!stat.isFile()) return refuse(`evidence[${index}].file.path ${path} is not a regular file; nothing was sent`)
    size = stat.size
  } catch {
    return refuse(`evidence[${index}].file.path ${path} does not exist; nothing was sent`)
  }
  if (size > JEV_EVAL_MAX_FILE_BYTES) return refuse(`evidence[${index}].file.path ${path} is ${size} bytes; a file of evidence is at most ${JEV_EVAL_MAX_FILE_BYTES} bytes (measured before reading); nothing was read and nothing was sent`)
  let text: string
  try {
    text = fs.readFileSync(path, { encoding: 'utf8' })
  } catch (error) {
    return refuse(`evidence[${index}].file.path ${path} could not be read (${error instanceof Error ? error.message : String(error)}); nothing was sent`)
  }
  const where = { index, name: basename(path), unit: 'line' }
  if (text.includes('\0')) return refuse(`${jevEvalAt(where)} holds a NUL byte; a file of evidence is text; nothing was sent`)
  if (text.trim() === '') return refuse(`${jevEvalAt(where)} is empty; nothing was sent`)
  return { ok: true, path, text, bytes: size }
}

function fileRows(index: number, text: string, path: string, format: JevEvalFormat, idColumn: string | undefined, seen: Map<string, string>): JevEvalRowsResult {
  const where = { index, name: basename(path), unit: format === 'paragraphs' ? 'paragraph' : 'line' }
  if (format === 'text' || format === 'paragraphs') {
    if (idColumn !== undefined) return refuse(`${jevEvalAt(where)} format ${format} has no columns; drop id_column`)
    const records = format === 'text' ? [{ line: 1, facts: { [JEV_EVAL_PARAGRAPH_FACT]: text } }] : jevEvalParagraphs(text)
    return jevEvalRecordRows(records, undefined, where, seen)
  }
  if (format === 'jsonl') {
    const parsed = jevEvalJsonl(text, where)
    return parsed.ok ? jevEvalRecordRows(parsed.records, idColumn, where, seen) : parsed
  }
  const parsed = format === 'tsv' ? jevEvalTsv(text, where) : format === 'csv' ? jevEvalCsv(text, where) : jevEvalMarkdown(text, where)
  return parsed.ok ? jevEvalTableRows(parsed.columns, parsed.rows, idColumn, where, seen, parsed.lines) : parsed
}

export function expandJevEvalEvidence(evidence: readonly JevEvalEvidenceItem[]): JevEvalExpansion {
  const items: JevEvalItem[] = []
  const sources: JevEvalSource[] = []
  const seen = new Map<string, string>()
  const breakdown: string[] = []
  let rowTotal = 0
  const admit = (index: number, rows: JevEvalRow[], title: string): string | undefined => {
    rowTotal += rows.length
    breakdown.push(`${title} ${rows.length}`)
    if (rowTotal > JEV_EVAL_MAX_ROWS) return `the files and tables expand to ${rowTotal} rows (${breakdown.join(', ')}); a call takes at most ${JEV_EVAL_MAX_ROWS} rows from files and tables; nothing was read further and nothing was sent`
    for (const row of rows) items.push({ label: row.id ?? jevEvalRowLabel(items.length), index, state: row.state, origin: row.origin })
    return undefined
  }
  for (let index = 0; index < evidence.length; index++) {
    const item = evidence[index]!
    if (typeof item === 'string') {
      items.push({ label: jevEvalRowLabel(items.length), index, state: { [JEV_EVAL_PARAGRAPH_FACT]: item } })
      continue
    }
    const file = jevEvalFileOf(item)
    if (file !== undefined) {
      const read = readEvidenceFile(index, file.path)
      if (!read.ok) return read
      const format = jevEvalFormatOf(read.path, file.format)
      const rows = fileRows(index, read.text, read.path, format, file.id_column, seen)
      if (!rows.ok) return rows
      const over = admit(index, rows.rows, basename(read.path))
      if (over !== undefined) return refuse(over)
      sources.push({ title: read.path, format, rows: rows.rows.length, bytes: read.bytes, idColumn: rows.idColumn })
      continue
    }
    const table = jevEvalTableOf(item)
    if (table !== undefined) {
      const title = `the inline table at evidence[${index}]`
      const rows = jevEvalTableRows(table.columns, table.rows, table.id_column, { index, name: 'table', unit: 'row' }, seen)
      if (!rows.ok) return rows
      const over = admit(index, rows.rows, title)
      if (over !== undefined) return refuse(over)
      sources.push({ title, format: 'table', rows: rows.rows.length, idColumn: rows.idColumn })
      continue
    }
    const { id, ...facts } = item as JevEvalRecordItem
    if (id !== undefined) {
      const first = seen.get(id)
      if (first !== undefined) return refuse(`evidence[${index}] id "${id}" is already the row key of ${first}; ids are the row keys and must be unique across the whole call`)
      seen.set(id, `evidence[${index}]`)
    }
    items.push({ label: id ?? jevEvalRowLabel(items.length), index, state: facts })
  }
  return { ok: true, items, sources }
}

export function jevEvalSourceLine(source: JevEvalSource): string {
  const ids = source.idColumn !== undefined ? `ids from column ${source.idColumn}` : ''
  if (source.format === 'table') return `from ${source.title}${ids ? ` (${ids})` : ''}: ${count(source.rows, 'row')}`
  return `from ${source.title} (${source.format}${ids ? `, ${ids}` : ''}): ${count(source.rows, 'row')}, ${source.bytes} bytes`
}
