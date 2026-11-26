import type { UUID } from 'node:crypto'
import { decodeTranscriptBuffer } from '../fabric/transcriptDecode.js'
import { pointOf, type Point } from './conversationEnd.js'
import { isPersistedProgressEntry, isTranscriptMessage } from './paths.js'
import type { Entry, TranscriptMessage } from './transcriptEntries.js'

export type RecordFact =
  | { kind: 'voter'; point: Point; sidechain: boolean; assistant: boolean; note: boolean; holdsResult: boolean | undefined }
  | { kind: 'bridge'; parent: string | null }

const QUOTE = 34
const BRACE_CLOSE = 125
const NEWLINE = 10
const HEAD_BYTES = 700
const ID_CAP = 64
const STAMP_KEY = '"occurredAt":"'
const MAIN_THREAD = '"threadId":"main"'
const KIND_KEY = '"payload":{"kind":"'
const OPENING = /^(?:input","content":(\[\{"kind":"tool-result"|\[|")|output"|attachment"|progress"|notice"|boundary","boundaryKind":"(compact|microcompact|fork|rewind)")/
const ANNOTATIONS = ',"annotations":{'
const PARENT_ID = ',"parentId":"'
const MESSAGE_ID = '"providerMessageId":"'
const RESULT_MARK = '"toolUseResult":'

function parentBefore(line: Buffer, at: number, from: number): string | null | undefined {
  if (line[at - 1] === BRACE_CLOSE) return null
  const key = line.lastIndexOf(PARENT_ID, at)
  if (line[at - 1] !== QUOTE || key < from) return undefined
  const parent = line.toString('latin1', key + PARENT_ID.length, at - 1)
  return parent === '' || parent.length > ID_CAP || parent.includes('"') || parent.includes('\\') ? undefined : parent
}

function messageIdBefore(line: Buffer, at: number, from: number): string | undefined {
  const key = line.lastIndexOf(MESSAGE_ID, at)
  if (key < from || line.indexOf(MESSAGE_ID, from) !== key) return undefined
  const close = line.indexOf(QUOTE, key + MESSAGE_ID.length)
  const id = line.toString('utf8', key + MESSAGE_ID.length, close)
  const after = line.toString('latin1', close + 1, close + 10)
  return id === '' || id.includes('\\') || !(after.startsWith('}') || after.startsWith(',"meta":{')) ? undefined : id
}

function writtenFact(id: string, line: Buffer, position: number): RecordFact | undefined {
  const head = line.toString('latin1', 0, HEAD_BYTES)
  const stampAt = head.indexOf(STAMP_KEY)
  const kindAt = head.indexOf(KIND_KEY)
  if (stampAt < 0 || kindAt < stampAt || !head.slice(0, kindAt).includes(MAIN_THREAD)) return undefined
  const stamp = head.slice(stampAt + STAMP_KEY.length, head.indexOf('"', stampAt + STAMP_KEY.length))
  const opening = OPENING.exec(head.slice(kindAt + KIND_KEY.length))
  if (opening === null || stamp.includes('\\')) return undefined
  const [shape, content, boundary] = opening
  if (boundary === 'compact') return undefined
  let linked = (line.at(-1) === NEWLINE ? line.length - 1 : line.length) - 1
  if (shape !== 'notice"' && boundary === undefined) {
    linked = line.indexOf(ANNOTATIONS, kindAt)
    if (linked < 0 || linked !== line.lastIndexOf(ANNOTATIONS)) return undefined
  } else if (line[linked] !== BRACE_CLOSE) return undefined
  const parent = parentBefore(line, linked, kindAt)
  if (parent === undefined) return undefined
  if (shape === 'progress"') return { kind: 'bridge', parent }
  const row = { id: id as UUID, parent: parent as UUID | null, stamp, position, group: id, kept: undefined }
  const fact = { kind: 'voter' as const, sidechain: false, assistant: false, note: false, holdsResult: false as boolean | undefined }
  if (shape === 'output"') {
    const group = messageIdBefore(line, linked, kindAt)
    return group === undefined ? undefined : { ...fact, assistant: true, point: { ...row, role: 'turn', group } }
  }
  if (content !== undefined) {
    if (content.length > 1) return { ...fact, holdsResult: true, point: { ...row, role: 'result' } }
    if (line.indexOf(RESULT_MARK, linked) >= 0) return undefined
    return { ...fact, holdsResult: content === '"' ? false : undefined, point: { ...row, role: 'turn' } }
  }
  return { ...fact, note: boundary !== 'microcompact', point: { ...row, role: 'quiet' } }
}

function decodedRow(id: string, line: Buffer): TranscriptMessage | { type: 'progress'; parentUuid: UUID | null } | undefined {
  const decoded = decodeTranscriptBuffer<Entry>(line)
  const entry = decoded.entries.length === 1 ? decoded.entries[0] : undefined
  const loose: unknown = entry
  if (isPersistedProgressEntry(loose)) return loose.uuid === id ? loose : undefined
  return entry !== undefined && isTranscriptMessage(entry) && entry.uuid === id ? entry : undefined
}

const holdsToolResult = (row: TranscriptMessage): boolean =>
  row.type === 'user' && Array.isArray(row.message.content) && row.message.content.some(block => block.type === 'tool_result')

export function recordHoldsToolResult(id: string, line: Buffer): boolean {
  const row = decodedRow(id, line)
  return row !== undefined && row.type !== 'progress' && holdsToolResult(row)
}

export function readRecordFact(id: string, line: Buffer, position: number): RecordFact | undefined {
  const written = writtenFact(id, line, position)
  if (written !== undefined) return written
  const row = decodedRow(id, line)
  if (row === undefined) return undefined
  if (row.type === 'progress') return { kind: 'bridge', parent: row.parentUuid }
  return {
    kind: 'voter',
    point: pointOf(row, position),
    sidechain: Boolean(row.isSidechain),
    assistant: row.type === 'assistant',
    note: row.type === 'attachment' || (row.type === 'system' && row.subtype !== 'compact_boundary' && row.subtype !== 'microcompact_boundary'),
    holdsResult: holdsToolResult(row),
  }
}
