import { appendFile, readFile, stat } from 'fs/promises'
import { closeSync, openSync } from 'fs'
import { join } from 'path'
import { flagEnv } from './substrate/flagRegistry.js'
import { getProjectRoot, getSessionId } from './bootstrap/state.js'
import { durableAtomicPublish } from './substrate/durablePublish.js'
import { registerCleanup } from './utils/cleanupRegistry.js'
import type { HistoryEntry, PastedContent } from './utils/config.js'
import { getMercuryHome, isEnvTruthy } from './utils/envUtils.js'
import { isENOENT } from './utils/errors.js'
import { lock } from './utils/lockfile.js'
import { logForDebugging } from './utils/debug.js'
import {
  hashPastedText,
  retrievePastedText,
  storePastedText,
} from './utils/pasteStore.js'
import { sleep } from './utils/sleep.js'
import { passedOver } from './utils/passedOver.js'


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
  return isEnvTruthy(flagEnv('MERCURY_SKIP_PROMPT_HISTORY'))
}


let pendingEntries: HistoryRecord[] = []
let lastAppended: HistoryRecord | null = null
const retractedRecords: Set<string> = new Set()
let inFlightFlush: Promise<void> | null = null
let cleanupRegistered = false
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

let flushChain: Promise<void> = Promise.resolve()

function flushOnce(): Promise<void> {
  const run = flushChain.then(flushPending, flushPending)
  flushChain = run.catch(passedOver)
  return run
}

async function flushPending(): Promise<void> {
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
      } catch (error) {
        logForDebugging(`history lock release failed: ${String(error)}`, { level: 'error' })
        passedOver(error)
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
        await sleep(FLUSH_RETRY_DELAY_MS)
      } finally {
        inFlightFlush = null
      }
    }
  } finally {
    retryFlushRunning = false
  }
}

export async function flushHistoryNow(): Promise<void> {
  await flushOnce().catch(passedOver)
}

export function getHistoryFlushHealth(): {
  pending: number
  inFlight: boolean
  streak: number
  lastFailure: { at: number; message: string } | null
} {
  return { pending: pendingEntries.length, inFlight: inFlightFlush !== null, streak: flushFailureStreak, lastFailure }
}


function toStoredPastes(
  pastedContents: Record<number, PastedContent>,
): Record<number, StoredPaste> {
  const stored: Record<number, StoredPaste> = {}
  for (const [key, paste] of Object.entries(pastedContents)) {
    if (paste.type === 'image') continue
    if (paste.content === '' && paste.contentHash !== undefined) {
      stored[Number(key)] = { id: paste.id, type: 'text', contentHash: paste.contentHash }
      continue
    }
    if (paste.content.length <= INLINE_PASTE_MAX_CHARS) {
      stored[Number(key)] = { id: paste.id, type: 'text', content: paste.content }
      continue
    }
    const contentHash = paste.contentHash ?? hashPastedText(paste.content)
    void storePastedText(contentHash, paste.content).catch(error => {
      logForDebugging(`history paste store failed: ${String(error)}`)
      passedOver(error)
    })
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
  const display = typeof command === 'string' ? command : command.display
  const pastedContents =
    typeof command === 'string'
      ? {}
      : toStoredPastes(command.pastedContents ?? {})
  const record: HistoryRecord = {
    display,
    pastedContents,
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
        await inFlightFlush.catch(passedOver)
      }
      await flushOnce().catch(passedOver)
    })
  }
  void flushWithRetries()
}

export function removeLastFromHistory(): void {
  const target = lastAppended
  lastAppended = null
  if (!target) return
  const index = pendingEntries.indexOf(target)
  if (index !== -1) {
    pendingEntries.splice(index, 1)
    return
  }
  retractedRecords.add(recordKey(target))
}

function recordKey(record: HistoryRecord): string {
  return `${record.timestamp}\n${record.display}`
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
    record.sessionId === getSessionId() && retractedRecords.has(recordKey(record))
  )
}

async function* diskRecordsReversed(keep?: (line: string) => boolean): AsyncGenerator<HistoryRecord> {
  let raw: string
  try {
    historyIoCensus.reads++
    raw = await readFile(historyFilePath(), 'utf8')
  } catch (error) {
    if (isENOENT(error)) return
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
  for (const [key, paste] of Object.entries(record.pastedContents ?? {})) {
    const id = Number(key)
    if (paste.content) {
      pastedContents[id] = {
        id: paste.id,
        type: paste.type,
        content: paste.content,
        ...(paste.mediaType !== undefined ? { mediaType: paste.mediaType } : {}),
        ...(paste.filename !== undefined ? { filename: paste.filename } : {}),
      }
      continue
    }
    if (paste.contentHash) {
      const content = await retrievePastedText(paste.contentHash)
      if (content === null) continue
      pastedContents[id] = {
        id: paste.id,
        type: paste.type,
        content,
        contentHash: paste.contentHash,
        ...(paste.mediaType !== undefined ? { mediaType: paste.mediaType } : {}),
        ...(paste.filename !== undefined ? { filename: paste.filename } : {}),
      }
    }
  }
  return { display: record.display, pastedContents }
}

export async function loadHistoryCorpus(): Promise<HistoryCorpus> {
  const records: HistoryRecord[] = []
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    records.push(pendingEntries[i]!)
  }
  for await (const record of diskRecordsReversed()) {
    if (isRetracted(record)) continue
    records.push(record)
  }
  return records
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
  const matches = text.match(/\r\n|\r|\n/g)
  return matches ? matches.length : 0
}

export function formatPastedTextRef(id: number, numLines: number): string {
  return numLines > 0
    ? `[Pasted text #${id} +${numLines} lines]`
    : `[Pasted text #${id}]`
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`
}

export function parseReferences(
  input: string,
): Array<{ id: number; match: string; index: number }> {
  const results: Array<{ id: number; match: string; index: number }> = []
  const pattern =
    /\[(?:\.\.\.)?(?:Pasted text|Image|Truncated text) #(\d+)(?: \+\d+ lines)?\.*\]/g
  for (const m of input.matchAll(pattern)) {
    const id = Number(m[1])
    if (id > 0) {
      results.push({ id, match: m[0], index: m.index })
    }
  }
  return results
}

export function danglingReferences(
  input: string,
  pastedContents: Record<number, PastedContent>,
): Array<{ id: number; match: string; index: number }> {
  const dangling: Array<{ id: number; match: string; index: number }> = []
  for (const ref of parseReferences(input)) {
    const paste = pastedContents[ref.id]
    const expectedType = ref.match.startsWith('[Image') ? 'image' : 'text'
    if (!paste || paste.type !== expectedType) {
      dangling.push(ref)
    }
  }
  return dangling
}

export function pasteUnavailableLine(reference: string): string {
  return `${reference} is no longer available — remove the reference or paste the content again`
}

export async function resolvePastedContents(
  input: string,
  pastedContents: Record<number, PastedContent>,
): Promise<{ pastedContents: Record<number, PastedContent>; missing: string[] }> {
  const resolved: Record<number, PastedContent> = { ...pastedContents }
  const missing: string[] = []
  for (const reference of parseReferences(input)) {
    const paste = resolved[reference.id]
    if (!paste || paste.type !== 'text' || paste.content !== '' || paste.contentHash === undefined) continue
    const body = await retrievePastedText(paste.contentHash)
    if (body === null) {
      if (!missing.includes(reference.match)) missing.push(reference.match)
      continue
    }
    resolved[reference.id] = { ...paste, content: body }
  }
  return { pastedContents: resolved, missing }
}

export async function historyPasteHashes(): Promise<Set<string>> {
  const hashes = new Set<string>()
  const corpus = await loadHistoryCorpus()
  for (const record of corpus) {
    for (const stored of Object.values(record.pastedContents ?? {})) {
      if (typeof stored.contentHash === 'string' && stored.contentHash !== '') hashes.add(stored.contentHash)
    }
  }
  return hashes
}

export function expandPastedTextRefs(
  input: string,
  pastedContents: Record<number, PastedContent>,
): string {
  const refs = parseReferences(input)
  if (refs.length === 0) return input
  let out = ''
  let cursor = 0
  for (const ref of refs) {
    out += input.slice(cursor, ref.index)
    cursor = ref.index + ref.match.length
    if (ref.match.startsWith('[Image')) {
      out += ref.match
      continue
    }
    const paste = pastedContents[ref.id]
    if (
      !paste ||
      paste.type !== 'text' ||
      (paste.content === '' && paste.contentHash !== undefined)
    ) {
      out += ref.match
      continue
    }
    out += paste.content
  }
  out += input.slice(cursor)
  return out
}
