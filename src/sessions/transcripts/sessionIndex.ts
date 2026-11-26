import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { stripGroundNote, GROUND_NOTE_MARK } from './isolationNote.js'
import { sliceHeadAtGrapheme } from '../../platform/text/textSegments.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  scanTailForEndedOnError,
  validateUuid,
} from './sessionStoragePortable.js'
import { readTranscriptTailSync, scanTranscriptLinesBackward } from './transcriptReader.js'
import { historyHead } from './historyParts.js'
import { isRecord } from '../../platform/primitives/isRecord.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { passedOver } from '../../platform/errors/passedOver.js'

function isAbsenceError(error: unknown): boolean {
  const code = getErrnoCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export type IndexedSession = {
  sessionId: string
  path: string
  mtime: number
  ctime: number
  size: number
}

export async function sessionFiles(
  projectDir: string,
  options: { stat?: boolean; concurrency?: number; failed?: (path: string, error?: unknown) => void } = {},
): Promise<IndexedSession[]> {
  let entries
  try {
    entries = await readdir(projectDir, { withFileTypes: true })
  } catch (error) {
    passedOver(error)
    if (!isAbsenceError(error)) options.failed?.(projectDir, error)
    return []
  }
  const candidates = entries.flatMap(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return []
    const sessionId = validateUuid(entry.name.slice(0, -6))
    return sessionId ? [{ sessionId, path: join(projectDir, entry.name), mtime: 0, ctime: 0, size: 0 }] : []
  })
  if (options.stat === false) return candidates
  const rows: Array<IndexedSession | null> = new Array(candidates.length)
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(candidates.length, options.concurrency ?? 32) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++
      const row = candidates[index]!
      try {
        const info = await stat(row.path)
        rows[index] = { ...row, mtime: info.mtimeMs, ctime: info.birthtimeMs, size: info.size }
      } catch (error) {
        passedOver(error)
        if (!isAbsenceError(error)) options.failed?.(row.path, error)
        rows[index] = null
      }
    }
  }))
  return rows.filter((row): row is IndexedSession => row !== null)
}

function flatPrompt(text: string): string {
  return text.replace(/\n/g, ' ').trim()
}

function clippedPrompt(flat: string): string {
  return flat.length > 200 ? sliceHeadAtGrapheme(flat, 200).trim() + '…' : flat
}

export function promptLabel(text: string): string {
  return clippedPrompt(flatPrompt(text))
}

export function sessionPromptFromWindow(chunk: string, builtIn: (name: string) => boolean = () => true): string {
  let commandFallback = ''
  for (const line of chunk.split('\n')) {
    if (!/"kind":\s*"input"/.test(line) || line.includes('"tool_result"') || /"isMeta":\s*true/.test(line)) continue
    try {
      const record = JSON.parse(line)
      const payload = record.payload
      if (payload?.kind !== 'input') continue
      const meta = payload.meta ?? {}
      if (meta.hiddenFromTranscript === true || meta.isVirtual === true || meta.isCompactSummary === true || meta.toolUseResult !== undefined) continue
      const texts = typeof payload.content === 'string' ? [stripGroundNote(payload.content)] : Array.isArray(payload.content)
        ? payload.content.flatMap((block: { kind?: string; text?: string }) => block.kind === 'text' && typeof block.text === 'string' && !block.text.startsWith(GROUND_NOTE_MARK) ? [block.text] : []) : []
      for (const text of texts) {
        if (!text) continue
        const flat = flatPrompt(text)
        const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(flat)?.[1]
        if (command) {
          if (builtIn(command.replace(/^\//, ''))) continue
          commandFallback ||= command
          const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(flat)?.[1]?.trim()
          if (!args) continue
          return `${command} ${args}`
        }
        const shell = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(flat)?.[1]
        if (shell) return `! ${shell}`
        if (/^(?:\s*<[a-z][\w-]*[\s>]|\[Request (?:interrupted by user|cut off)[^\]]*\])/.test(flat)) continue
        return clippedPrompt(flat)
      }
    } catch (error) { passedOver(error) }
  }
  return commandFallback
}

function firstField(head: string, field: string): unknown {
  for (const line of head.split('\n').slice(0, 80)) {
    if (!line.includes(`"${field}"`)) continue
    try {
      const record = JSON.parse(line)
      if (record && typeof record === 'object' && field in record) return record[field]
    } catch (error) { passedOver(error) }
  }
  return undefined
}

const FUTURE_SKEW_GRACE_MS = 5_000
export const RECENCY_CLOCK_SLACK_MS = FUTURE_SKEW_GRACE_MS
const BACKWARD_SCAN_BYTE_BUDGET = 2 * 1024 * 1024

type ActivityLineResult =
  | { kind: 'match'; ms: number; recheckAtMs?: number }
  | { kind: 'future'; validAtMs: number }
  | { kind: 'skip' }

type ActivityScanResult = {
  lastUsedMs: number | null
  recheckAtMs?: number
}

function earlierAt(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return Math.min(a, b)
}

function hasAnyFlag(obj: unknown, keys: readonly string[]): boolean {
  if (!isRecord(obj)) return false
  for (const key of keys) {
    if (obj[key] === true) return true
  }
  return false
}

function isConversationActivityRecord(record: Record<string, unknown>): boolean {
  const payload = record.payload
  if (!isRecord(payload)) return false
  const kind = payload.kind
  if (kind === 'output') {
    return !hasAnyFlag(record.annotations, ['isVirtual', 'isApiErrorMessage']) && !hasAnyFlag(payload.meta, ['isVirtual'])
  }
  if (kind === 'session-meta') return payload.metaKind === 'turn-end'
  if (kind !== 'input') return false
  const skipKeys = ['isMeta', 'hiddenFromTranscript', 'isVirtual', 'isCompactSummary', 'isVisibleInTranscriptOnly']
  return !hasAnyFlag(record.annotations, skipKeys) && !hasAnyFlag(payload.meta, skipKeys)
}

function parseConversationActivityLine(raw: string, nowMs: number): ActivityLineResult {
  const line = raw.trim()
  if (!line || line.charCodeAt(0) !== 123) return { kind: 'skip' }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    passedOver(error)
    return { kind: 'skip' }
  }
  if (!isRecord(parsed)) return { kind: 'skip' }
  if (!isConversationActivityRecord(parsed)) return { kind: 'skip' }
  if (typeof parsed.occurredAt !== 'string') return { kind: 'skip' }
  const ms = Date.parse(parsed.occurredAt)
  if (!Number.isFinite(ms)) return { kind: 'skip' }
  if (ms > nowMs + FUTURE_SKEW_GRACE_MS) return { kind: 'future', validAtMs: ms - FUTURE_SKEW_GRACE_MS }
  return ms > nowMs ? { kind: 'match', ms: nowMs, recheckAtMs: ms } : { kind: 'match', ms }
}

function scanTailActivity(tail: string, nowMs: number): ActivityScanResult {
  if (!tail) return { lastUsedMs: null }
  const lines = tail.split('\n')
  let earliestFuture: number | undefined
  for (let i = lines.length - 1; i >= 0; i--) {
    const res = parseConversationActivityLine(lines[i]!, nowMs)
    if (res.kind === 'future') {
      earliestFuture = earlierAt(earliestFuture, res.validAtMs)
      continue
    }
    if (res.kind === 'match') {
      const recheckAtMs = earlierAt(earliestFuture, res.recheckAtMs)
      return recheckAtMs !== undefined ? { lastUsedMs: res.ms, recheckAtMs } : { lastUsedMs: res.ms }
    }
  }
  return earliestFuture !== undefined ? { lastUsedMs: null, recheckAtMs: earliestFuture } : { lastUsedMs: null }
}

export function lastConversationActivityMs(tail: string, nowMs: number = Date.now()): number | null {
  return scanTailActivity(tail, nowMs).lastUsedMs
}

function scanBackwardActivitySync(filePath: string, nowMs: number = Date.now()): ActivityScanResult {
  let found: number | null = null
  let recheckAtMs: number | undefined
  let bytes = 0
  try {
    scanTranscriptLinesBackward(filePath, line => {
      bytes += line.length + 1
      const res = parseConversationActivityLine(line, nowMs)
      if (res.kind === 'future') {
        recheckAtMs = earlierAt(recheckAtMs, res.validAtMs)
      } else if (res.kind === 'match') {
        found = res.ms
        recheckAtMs = earlierAt(recheckAtMs, res.recheckAtMs)
        return true
      }
      return bytes >= BACKWARD_SCAN_BYTE_BUDGET
    })
  } catch (error) {
    passedOver(error)
  }
  return recheckAtMs !== undefined ? { lastUsedMs: found, recheckAtMs } : { lastUsedMs: found }
}

export function scanLastConversationActivityMsSync(filePath: string, nowMs: number = Date.now()): number | null {
  return scanBackwardActivitySync(filePath, nowMs).lastUsedMs
}

const lastUsedCache = new Map<string, { mtimeMs: number; size: number; lastUsedMs: number | null; recheckAtMs?: number }>()
const LAST_USED_CACHE_CAP = 2048

function readSessionLastUsedSync(filePath: string, fileSize?: number, nowMs: number = Date.now()): ActivityScanResult {
  const fromTail = scanTailActivity(readTranscriptTailSync(filePath, LITE_READ_BUF_SIZE), nowMs)
  if (fromTail.lastUsedMs !== null) return fromTail
  if ((fileSize !== undefined && fileSize > LITE_READ_BUF_SIZE) || historyHead(filePath).before > 0) {
    const back = scanBackwardActivitySync(filePath, nowMs)
    const recheckAtMs = earlierAt(fromTail.recheckAtMs, back.recheckAtMs)
    return recheckAtMs !== undefined ? { lastUsedMs: back.lastUsedMs, recheckAtMs } : back
  }
  return fromTail
}

export function readSessionLastUsedMsCachedSync(
  filePath: string,
  mtimeMs: number,
  fileSize: number,
  preReadText?: string,
  nowMs: number = Date.now(),
): number | null {
  const held = lastUsedCache.get(filePath)
  if (
    held !== undefined &&
    held.mtimeMs === mtimeMs &&
    held.size === fileSize &&
    (held.recheckAtMs === undefined || nowMs < held.recheckAtMs) &&
    (held.lastUsedMs === null || held.lastUsedMs <= nowMs)
  ) {
    return held.lastUsedMs
  }
  const result =
    preReadText !== undefined
      ? scanTailActivity(preReadText, nowMs)
      : readSessionLastUsedSync(filePath, fileSize, nowMs)
  if (lastUsedCache.size >= LAST_USED_CACHE_CAP) lastUsedCache.clear()
  lastUsedCache.set(filePath, {
    mtimeMs,
    size: fileSize,
    lastUsedMs: result.lastUsedMs,
    ...(result.recheckAtMs !== undefined ? { recheckAtMs: result.recheckAtMs } : {}),
  })
  return result.lastUsedMs
}

export function compareSessionRecency(
  a: { lastUsedMs: number | null; mtimeMs: number; createdMs?: number; sessionId?: string },
  b: { lastUsedMs: number | null; mtimeMs: number; createdMs?: number; sessionId?: string },
): number {
  const aHas = a.lastUsedMs !== null && Number.isFinite(a.lastUsedMs)
  const bHas = b.lastUsedMs !== null && Number.isFinite(b.lastUsedMs)
  if (aHas !== bHas) return aHas ? -1 : 1
  if (aHas && bHas && b.lastUsedMs !== a.lastUsedMs) return b.lastUsedMs! - a.lastUsedMs!
  const ma = Number.isFinite(a.mtimeMs) ? Math.floor(a.mtimeMs) : 0
  const mb = Number.isFinite(b.mtimeMs) ? Math.floor(b.mtimeMs) : 0
  if (mb !== ma) return mb - ma
  const ca = a.createdMs !== undefined && Number.isFinite(a.createdMs) ? Math.floor(a.createdMs) : 0
  const cb = b.createdMs !== undefined && Number.isFinite(b.createdMs) ? Math.floor(b.createdMs) : 0
  if (cb !== ca) return cb - ca
  return (a.sessionId ?? '').localeCompare(b.sessionId ?? '')
}

function sessionLabelFacts(head: string, tail: string, builtIn: (name: string) => boolean) {
  const first = (field: string) => extractJsonStringField(head, field)
  const last = (field: string) => extractLastJsonStringField(tail, field)
  const cwd = firstField(head, 'cwd')
  let prNumber = parseInt(last('prNumber') ?? '', 10) || undefined
  if (!prNumber) {
    const index = tail.lastIndexOf('"prNumber":')
    if (index >= 0) {
      const numeric = parseInt(tail.slice(index + 11, index + 25).trim(), 10)
      if (numeric > 0) prNumber = numeric
    }
  }
  return {
    firstPrompt: sessionPromptFromWindow(head, builtIn) || last('lastPrompt') || '',
    gitBranch: last('gitBranch') ?? first('gitBranch'),
    isSidechain: firstField(head, 'isSidechain') === true,
    projectPath: typeof cwd === 'string' && cwd ? cwd : first('cwd'),
    customTitle: last('customTitle') ?? extractLastJsonStringField(head, 'customTitle') ?? last('aiTitle') ?? extractLastJsonStringField(head, 'aiTitle'),
    summary: last('summary'),
    tag: last('tag'),
    agentSetting: first('agentSetting'),
    prNumber,
    prUrl: last('prUrl'),
    prRepository: last('prRepository'),
    endedOnError: scanTailForEndedOnError(tail),
    lastTimestamp: last('timestamp') ?? first('timestamp'),
    lastUsedAt: lastConversationActivityMs(tail) ?? undefined,
  }
}

export async function readSessionLabelFacts(
  filePath: string,
  fileSize: number,
  buffer: Buffer,
  builtIn: (name: string) => boolean,
  onReadError?: (path: string, error: unknown) => void,
) {
  const { head, tail } = await readHeadAndTail(filePath, fileSize, buffer, onReadError)
  if (!head) return { firstPrompt: '', isSidechain: false }
  const facts = sessionLabelFacts(head, tail, builtIn)
  const lastUsedAt =
    facts.lastUsedAt ??
    (fileSize > LITE_READ_BUF_SIZE || historyHead(filePath).before > 0
      ? scanLastConversationActivityMsSync(filePath) ?? undefined
      : undefined)
  return { ...facts, lastUsedAt }
}
