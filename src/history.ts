
import { appendFile, readFile, stat } from 'fs/promises'
import { closeSync, openSync } from 'fs'
import { join } from 'path'
import { getProjectRoot, getSessionId } from './bootstrap/state.js'
import { durableAtomicPublish } from './substrate/durablePublish.js'
import { CHIP_PATTERN } from './utils/inputRange.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import type { HistoryEntry, PastedContent } from './utils/config.js'
import { getMercuryHome, isEnvTruthy } from './utils/envUtils.js'
import { lock } from './utils/lockfile.js'
import { logError } from './utils/log.js'
import { logForDebugging } from './utils/debug.js'
import {
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from './utils/pasteStore.js'

export type { HistoryEntry }

export type HistoryRecord = {
  display: string
  pastedContents: Record<number, StoredPaste>
  timestamp: number
  project: string
  sessionId?: string
}

export type HistoryCorpus = readonly HistoryRecord[]

type StoredPaste = {
  id: number
  type: 'text' | 'image'
  content?: string
  contentHash?: string
  mediaType?: string
  filename?: string
}

const INLINE_PASTE_MAX_CHARS = 1024
const READ_WINDOW = 100
const FLUSH_RETRY_DELAY_MS = 500
const HISTORY_FLUSH_ESCALATION_STREAK = 3
const FLUSH_MAX_RETRIES = 5

const HISTORY_MAX_BYTES = 8 * 1024 * 1024
const HISTORY_KEEP_BYTES = 4 * 1024 * 1024

export const historyIoCensus = { reads: 0, parsedLines: 0, compactions: 0 }

function historyFilePath(): string {
  return join(getMercuryHome(), 'history.jsonl')
}

function historyDisabled(): boolean {
  return isEnvTruthy(process.env.MERCURY_SKIP_PROMPT_HISTORY)
}


let pendingEntries: HistoryRecord[] = []
let lastAppended: HistoryRecord | null = null
const skipTimestamps = new Set<number>()
let cleanupRegistered = false
let inFlightFlush: Promise<void> | null = null
let retryFlushRunning = false
let flushFailureStreak = 0
let everFlushed = false
export function historyEverFlushedThisProcess(): boolean {
  return everFlushed
}
let lastFailure: { at: number; message: string } | null = null

function ensureHistoryFile(): void {
  const fd = openSync(historyFilePath(), 'a', 0o600)
  closeSync(fd)
}

async function flushOnce(): Promise<void> {
  if (pendingEntries.length === 0) return
  const snapshot = pendingEntries
  let release: (() => Promise<void>) | null = null
  try {
    ensureHistoryFile()
    release = await lock(historyFilePath(), {
      stale: 10_000,
      retries: { retries: 3, minTimeout: 50 },
    })
    const jsonLines = snapshot.map(record => JSON.stringify(record))
    pendingEntries = []
    await appendFile(historyFilePath(), jsonLines.join('\n') + '\n', {
      mode: 0o600,
    })
    await compactHistoryIfOversized()
    flushFailureStreak = 0
    everFlushed = true
    lastFailure = null
  } catch (error) {
    flushFailureStreak += 1
    lastFailure = { at: Date.now(), message: String(error) }
    if (pendingEntries !== snapshot) {
      pendingEntries = snapshot.concat(pendingEntries)
    }
    logForDebugging(
      `history flush failed (streak ${flushFailureStreak}): ${String(error)}`,
      flushFailureStreak >= HISTORY_FLUSH_ESCALATION_STREAK
        ? { level: 'error' }
        : undefined,
    )
    throw error
  } finally {
    if (release) {
      try {
        await release()
      } catch {
      }
    }
  }
}

async function flushWithRetries(): Promise<void> {
  if (retryFlushRunning) return
  retryFlushRunning = true
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const run = flushOnce()
        inFlightFlush = run
        await run
        return
      } catch {
        if (attempt >= FLUSH_MAX_RETRIES) return
        await new Promise(resolve => setTimeout(resolve, FLUSH_RETRY_DELAY_MS))
      } finally {
        inFlightFlush = null
      }
    }
  } finally {
    retryFlushRunning = false
  }
}

export async function flushHistoryNow(): Promise<void> {
  await flushOnce().catch(() => {})
}

export function getHistoryFlushHealth(): {
  pending: number
  streak: number
  lastFailure: { at: number; message: string } | null
} {
  return { pending: pendingEntries.length, streak: flushFailureStreak, lastFailure }
}


function toStoredPastes(
  pastedContents: Record<number, PastedContent>,
): Record<number, StoredPaste> {
  const stored: Record<number, StoredPaste> = {}
  for (const [key, paste] of Object.entries(pastedContents)) {
    if (paste.type === 'image') continue
    if (paste.content.length <= INLINE_PASTE_MAX_CHARS) {
      stored[Number(key)] = { id: paste.id, type: 'text', content: paste.content }
      continue
    }
    const contentHash = hashPastedText(paste.content)
    void storePastedText(contentHash, paste.content).catch(() => {})
    stored[Number(key)] = { id: paste.id, type: 'text', contentHash }
  }
  return stored
}

export function queuedCommandHistoryEntry(command: {
  value: unknown
  preExpansionValue?: string
  mode: string
  pastedContents?: Record<number, PastedContent>
  isMeta?: boolean
  origin?: unknown
  bridgeOrigin?: boolean
  skipSlashCommands?: boolean
}): HistoryEntry | null {
  if (command.isMeta || command.origin !== undefined || command.bridgeOrigin || command.skipSlashCommands) return null
  if (command.mode !== 'prompt' && command.mode !== 'bash') return null
  const typed = command.preExpansionValue ?? (typeof command.value === 'string' ? command.value : null)
  if (typed === null || typed.trim() === '') return null
  return { display: `${command.mode === 'bash' ? '!' : ''}${typed}`, pastedContents: command.pastedContents ?? {} }
}

export function addToHistory(command: HistoryEntry | string): void {
  if (historyDisabled()) return
  const entry: HistoryEntry =
    typeof command === 'string'
      ? { display: command, pastedContents: {} }
      : command
  const record: HistoryRecord = {
    display: entry.display,
    pastedContents: toStoredPastes(entry.pastedContents ?? {}),
    timestamp: Date.now(),
    project: getProjectRoot(),
    sessionId: getSessionId(),
  }
  pendingEntries.push(record)
  lastAppended = record
  if (!cleanupRegistered) {
    cleanupRegistered = true
    registerCleanup(async () => {
      if (inFlightFlush) {
        await inFlightFlush.catch(() => {})
      }
      if (pendingEntries.length > 0) {
        await flushOnce().catch(() => {})
      }
    })
  }
  void flushWithRetries()
}

export function removeLastFromHistory(): void {
  const target = lastAppended
  lastAppended = null
  if (!target) return
  const at = pendingEntries.indexOf(target)
  if (at !== -1) {
    pendingEntries.splice(at, 1)
    return
  }
  skipTimestamps.add(target.timestamp)
}


function parseRecordLine(line: string): HistoryRecord | null {
  try {
    return JSON.parse(line) as HistoryRecord
  } catch {
    logForDebugging(`history: skipping malformed line`)
    return null
  }
}

function isRetracted(record: HistoryRecord): boolean {
  return (
    record.sessionId === getSessionId() && skipTimestamps.has(record.timestamp)
  )
}

async function* diskRecordsReversed(keep?: (line: string) => boolean): AsyncGenerator<HistoryRecord> {
  let raw: string
  try {
    historyIoCensus.reads++
    raw = await readFile(historyFilePath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let end = raw.length
  while (end > 0) {
    const nl = raw.lastIndexOf('\n', end - 1)
    const line = raw.slice(nl + 1, end).trim()
    end = nl < 0 ? 0 : nl
    if (line === '') continue
    if (keep !== undefined && !keep(line)) continue
    historyIoCensus.parsedLines++
    const record = parseRecordLine(line)
    if (record) yield record
  }
}

async function compactHistoryIfOversized(): Promise<void> {
  try {
    const path = historyFilePath()
    const st = await stat(path)
    if (st.size <= HISTORY_MAX_BYTES) return
    const buf = await readFile(path)
    let slice = buf.subarray(buf.length - HISTORY_KEEP_BYTES)
    const nl = slice.indexOf(0x0a)
    if (nl >= 0 && nl + 1 < slice.length) slice = slice.subarray(nl + 1)
    await durableAtomicPublish(path, slice, { mode: 0o600 })
    historyIoCensus.compactions++
  } catch (error) {
    logForDebugging(`history compaction skipped: ${String(error)}`)
  }
}

async function resolveRecord(record: HistoryRecord): Promise<HistoryEntry> {
  const pastedContents: Record<number, PastedContent> = {}
  for (const [key, stored] of Object.entries(record.pastedContents ?? {})) {
    if (stored.content) {
      pastedContents[Number(key)] = {
        id: stored.id,
        type: stored.type,
        content: stored.content,
        ...(stored.mediaType !== undefined && { mediaType: stored.mediaType }),
        ...(stored.filename !== undefined && { filename: stored.filename }),
      }
      continue
    }
    if (stored.contentHash) {
      const body = await retrievePastedText(stored.contentHash)
      if (body !== null) {
        pastedContents[Number(key)] = {
          id: stored.id,
          type: stored.type,
          content: body,
          ...(stored.mediaType !== undefined && { mediaType: stored.mediaType }),
          ...(stored.filename !== undefined && { filename: stored.filename }),
        }
      }
    }
  }
  return { display: record.display, pastedContents }
}

export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    yield resolveRecord(pendingEntries[i]!)
  }
  for await (const record of diskRecordsReversed()) {
    if (isRetracted(record)) continue
    yield await resolveRecord(record)
  }
}

export async function loadHistoryCorpus(): Promise<HistoryCorpus> {
  const corpus: HistoryRecord[] = []
  for (let i = pendingEntries.length - 1; i >= 0; i--) corpus.push(pendingEntries[i]!)
  for await (const record of diskRecordsReversed()) {
    if (isRetracted(record)) continue
    corpus.push(record)
  }
  return corpus
}

export async function* makeHistoryReaderOver(corpus: HistoryCorpus): AsyncGenerator<HistoryEntry> {
  for (const record of corpus) {
    if (isRetracted(record)) continue
    yield await resolveRecord(record)
  }
}

export async function* getHistory(): AsyncGenerator<HistoryEntry> {
  const project = getProjectRoot()
  const session = getSessionId()
  const window: HistoryRecord[] = []
  for (let i = pendingEntries.length - 1; i >= 0 && window.length < READ_WINDOW; i--) {
    const record = pendingEntries[i]!
    if (typeof record.project !== 'string' || record.project !== project) continue
    window.push(record)
  }
  if (window.length < READ_WINDOW) {
    const projectNeedle = JSON.stringify(project)
    for await (const record of diskRecordsReversed(line => line.includes(projectNeedle))) {
      if (typeof record.project !== 'string' || record.project !== project) continue
      if (isRetracted(record)) continue
      window.push(record)
      if (window.length >= READ_WINDOW) break
    }
  }
  const current = window.filter(record => record.sessionId === session)
  const other = window.filter(record => record.sessionId !== session)
  for (const record of [...current, ...other]) {
    yield await resolveRecord(record)
  }
}


export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length
}

export function formatPastedTextRef(id: number, numLines: number): string {
  return numLines > 0
    ? `[Pasted text #${id} +${numLines} lines]`
    : `[Pasted text #${id}]`
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`
}

const REFERENCE_RE =
  /\[(?:\.\.\.)?(?:Pasted text|Image|Truncated text) #(\d+)(?: \+\d+ lines)?\.*\]/g

void CHIP_PATTERN

export function parseReferences(
  input: string,
): Array<{ id: number; match: string; index: number }> {
  const out: Array<{ id: number; match: string; index: number }> = []
  for (const match of input.matchAll(REFERENCE_RE)) {
    const id = Number(match[1])
    if (!(id > 0)) continue
    out.push({ id, match: match[0], index: match.index ?? 0 })
  }
  return out
}

export function danglingReferences(
  input: string,
  pastedContents: Record<number, PastedContent>,
): Array<{ id: number; match: string; index: number }> {
  return parseReferences(input).filter(reference => {
    const entry = pastedContents[reference.id]
    if (reference.match.startsWith('[Image')) return entry?.type !== 'image'
    return entry === undefined || entry.type !== 'text'
  })
}

export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
  const references = parseReferences(input)
  let out = input
  for (let i = references.length - 1; i >= 0; i--) {
    const reference = references[i]!
    if (reference.match.startsWith('[Image')) continue
    const paste = pastedContents[reference.id]
    if (!paste || paste.type !== 'text') continue
    out =
      out.slice(0, reference.index) +
      paste.content +
      out.slice(reference.index + reference.match.length)
  }
  return out
}
