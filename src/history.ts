// The global prompt-history store: one JSON-Lines file (history.jsonl) at
// the root of the resolved product home, shared across every project, each
// record carrying the project it was submitted from. Appends are
// fire-and-forget from the submit path; durability comes from the pendingEntries
// buffer + the requeue-on-failure flush (the clear point between lock
// acquisition and append is pinned structurally by the durability prover).

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

/** On-disk record (contract data — other readers depend on these names). */
export type HistoryRecord = {
  display: string
  pastedContents: Record<number, StoredPaste>
  timestamp: number
  project: string
  sessionId?: string
}

/** Every record newest-first, parsed once (loadHistoryCorpus); readers
 *  over it resolve pastes as they yield. */
export type HistoryCorpus = readonly HistoryRecord[]

/** Stored-paste record: inline content or a hash reference into the
 *  external paste store. */
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

// FN-020 row 9c: the file was append-only forever — every prompt ever
// typed, across all projects, with no rotation anywhere. Past
// HISTORY_MAX_BYTES a flush rewrites it to its newest HISTORY_KEEP_BYTES of
// WHOLE lines, atomically, under the flush lock it already holds: every
// read of the file is bounded for good; the oldest prompts leave.
const HISTORY_MAX_BYTES = 8 * 1024 * 1024
const HISTORY_KEEP_BYTES = 4 * 1024 * 1024

/** PROOF CENSUS (operation-shaped, never a wall clock): whole-file reads,
 *  record lines parsed, compactions — read by
 *  scripts/sessionStorage/prove-history-read-economy.ts. */
export const historyIoCensus = { reads: 0, parsedLines: 0, compactions: 0 }

function historyFilePath(): string {
  return join(getMercuryHome(), 'history.jsonl')
}

function historyDisabled(): boolean {
  return isEnvTruthy(process.env.MERCURY_SKIP_PROMPT_HISTORY)
}

// ── pendingEntries buffer + flush machinery ────────────────────────────────────────

let pendingEntries: HistoryRecord[] = []
let lastAppended: HistoryRecord | null = null
/** Timestamps of retracted entries that already reached disk, filtered from
 *  both read paths for records of THIS session. */
const skipTimestamps = new Set<number>()
let cleanupRegistered = false
let inFlightFlush: Promise<void> | null = null
let retryFlushRunning = false
let flushFailureStreak = 0
// Whether ANY flush ran in this process — the health row's honesty gate: a
// one-shot doctor never appends, so zero-counters there mean 'nothing was
// tried', not 'appends healthy' (prove-doctor-truth).
let everFlushed = false
export function historyEverFlushedThisProcess(): boolean {
  return everFlushed
}
let lastFailure: { at: number; message: string } | null = null

/** Create the file if missing (append mode, owner-only permissions) — the
 *  advisory lock needs its target to exist. */
function ensureHistoryFile(): void {
  const fd = openSync(historyFilePath(), 'a', 0o600)
  closeSync(fd)
}

/** ONE flush attempt. The pendingEntries buffer is snapshotted at entry and cleared
 *  BETWEEN lock acquisition and the append call; a failure requeues the
 *  snapshot ahead of newcomers, identity-guarded so a pre-clear failure
 *  cannot duplicate the batch. */
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
    // The pinned clear point: after the lock is held, before the append.
    // (snapshot is the SAME array — arrivals during the lock wait ride it.)
    const jsonLines = snapshot.map(record => JSON.stringify(record))
    pendingEntries = []
    await appendFile(historyFilePath(), jsonLines.join('\n') + '\n', {
      mode: 0o600,
    })
    // Still under the lock — the one place the file may be rewritten.
    // Never throws: a failed compaction must not read as a failed append
    // (the requeue below would duplicate the batch).
    await compactHistoryIfOversized()
    flushFailureStreak = 0
    everFlushed = true
    lastFailure = null
  } catch (error) {
    flushFailureStreak += 1
    lastFailure = { at: Date.now(), message: String(error) }
    // Requeue AHEAD of anything added during the attempt — unless the
    // failure happened before the clear, in which case the buffer still IS
    // the snapshot and concatenating would duplicate the whole batch.
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
        // Releasing a broken lock must not mask the append outcome.
      }
    }
  }
}

/** The retry-driven flush: backs off 500 ms between attempts, gives up after
 *  six, one runner at a time. */
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

/** Exactly one flush attempt, no retry chain — deliberately bypasses the
 *  re-entrancy guard so failure injection is deterministic. The failure is
 *  absorbed here: the health probe is the reporting channel. */
export async function flushHistoryNow(): Promise<void> {
  await flushOnce().catch(() => {})
}

/** Health probe (field names are contract data — the self-diagnosis command
 *  reads them). */
export function getHistoryFlushHealth(): {
  pending: number
  streak: number
  lastFailure: { at: number; message: string } | null
} {
  return { pending: pendingEntries.length, streak: flushFailureStreak, lastFailure }
}

// ── append / retract ────────────────────────────────────────────────────────

function toStoredPastes(
  pastedContents: Record<number, PastedContent>,
): Record<number, StoredPaste> {
  const stored: Record<number, StoredPaste> = {}
  for (const [key, paste] of Object.entries(pastedContents)) {
    // Image pastes never enter history — they live in the image cache and
    // re-resolve by id.
    if (paste.type === 'image') continue
    if (paste.content.length <= INLINE_PASTE_MAX_CHARS) {
      stored[Number(key)] = { id: paste.id, type: 'text', content: paste.content }
      continue
    }
    const contentHash = hashPastedText(paste.content)
    // The body write is asynchronous and not awaited.
    void storePastedText(contentHash, paste.content).catch(() => {})
    stored[Number(key)] = { id: paste.id, type: 'text', contentHash }
  }
  return stored
}

/**
 * The history entry a DRAINED queued command earns, or null for anything
 * not typed by a human at this keyboard (system, bridge, remote, meta).
 * History is written at actual-send time (sweep #2, round-1
 * deferral 30): a message typed while the session was busy enters
 * history when it is dequeued and sent, never at queue time — a queued
 * message withdrawn before sending leaves no entry, and nothing is
 * recallable that was never sent. Pure; exported for the parity prover.
 */
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

/** One-shot retraction of the most recent append (an interrupt rewound the
 *  conversation before any response, so its record must go too). */
export function removeLastFromHistory(): void {
  const target = lastAppended
  lastAppended = null
  if (!target) return
  const at = pendingEntries.indexOf(target)
  if (at !== -1) {
    pendingEntries.splice(at, 1)
    return
  }
  // The flush already won the race: filter it from the on-disk read paths.
  skipTimestamps.add(target.timestamp)
}

// ── read-back ───────────────────────────────────────────────────────────────

function parseRecordLine(line: string): HistoryRecord | null {
  try {
    return JSON.parse(line) as HistoryRecord
  } catch {
    logForDebugging(`history: skipping malformed line`)
    return null
  }
}

/** Skip-filter for on-disk records: retracted entries of THIS session. */
function isRetracted(record: HistoryRecord): boolean {
  return (
    record.sessionId === getSessionId() && skipTimestamps.has(record.timestamp)
  )
}

/** FN-020 row 9b: the on-disk records newest-first, parsed LAZILY — a
 *  consumer that stops after its window (the 100-row up-arrow window, the
 *  50-command shell corpus) never parses the lines it never reads. `keep`
 *  is a cheap pre-filter over the RAW line (a JSON-encoded substring test)
 *  that skips the parse of lines that cannot match. One whole-file read. */
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

/** FN-020 row 9c: past HISTORY_MAX_BYTES, rewrite the file to its newest
 *  HISTORY_KEEP_BYTES of WHOLE lines (the partial leading line dropped),
 *  atomically through the durable primitive (temp, fsync, rename), keeping
 *  the owner-only mode. Called under the flush lock. Swallows every error:
 *  a compaction that could not run leaves the file as it was and the next
 *  flush tries again — it must never fail the append it follows. */
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
    // Truthiness on purpose: a stored empty string falls through to the
    // hash branch.
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
    // Neither content nor a resolvable hash: dropped; the entry still
    // resolves.
  }
  return { display: record.display, pastedContents }
}

/** Every entry newest-first across all projects, pastes resolved. */
export async function* makeHistoryReader(): AsyncGenerator<HistoryEntry> {
  for (let i = pendingEntries.length - 1; i >= 0; i--) {
    yield resolveRecord(pendingEntries[i]!)
  }
  for await (const record of diskRecordsReversed()) {
    if (isRetracted(record)) continue
    yield await resolveRecord(record)
  }
}

/** FN-020 row 9a: every record newest-first (the pending buffer first,
 *  then the disk), retractions filtered, parsed ONCE — the reverse search
 *  loads it when the search opens and matches every keystroke against it
 *  in memory (each typed character used to re-read and re-parse the whole
 *  file). Pastes stay unresolved until a reader yields the entry. */
export async function loadHistoryCorpus(): Promise<HistoryCorpus> {
  const corpus: HistoryRecord[] = []
  for (let i = pendingEntries.length - 1; i >= 0; i--) corpus.push(pendingEntries[i]!)
  for await (const record of diskRecordsReversed()) {
    if (isRetracted(record)) continue
    corpus.push(record)
  }
  return corpus
}

/** A reader over an already-loaded corpus: no disk read, no parse. */
export async function* makeHistoryReaderOver(corpus: HistoryCorpus): AsyncGenerator<HistoryEntry> {
  for (const record of corpus) {
    if (isRetracted(record)) continue
    yield await resolveRecord(record)
  }
}

/** Up-arrow history: current-project entries, current session first (each
 *  newest-first), capped at 100 — a rearrangement INSIDE the window, not an
 *  extension of it. */
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
    // The raw-line pre-filter: a line whose JSON-encoded project field is
    // not this project's cannot enter the window, so its parse is skipped
    // (the same encoder wrote the field; the real compare still follows).
    const projectNeedle = JSON.stringify(project)
    for await (const record of diskRecordsReversed(line => line.includes(projectNeedle))) {
      if (typeof record.project !== 'string' || record.project !== project) continue
      if (isRetracted(record)) continue
      window.push(record)
      // Break AFTER the push: a check at the top of the loop would pull
      // (and parse) one record past the window before seeing it full.
      if (window.length >= READ_WINDOW) break
    }
  }
  const current = window.filter(record => record.sessionId === session)
  const other = window.filter(record => record.sessionId !== session)
  for (const record of [...current, ...other]) {
    yield await resolveRecord(record)
  }
}

// ── paste-reference placeholders (contract data) ───────────────────────────

/** Count of line BREAKS (\r\n, \r or \n) — three lines report +2. */
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

// The recognised shapes derive from the ONE chip-pattern definition
// (utils/inputRange.ts); the parser additionally accepts the optional
// `+N lines` middle on all three kinds and a trailing run of dots.
const REFERENCE_RE =
  /\[(?:\.\.\.)?(?:Pasted text|Image|Truncated text) #(\d+)(?: \+\d+ lines)?\.*\]/g

// Lockstep guard (compile-time only): the chip pattern module must keep
// covering the shapes this store mints.
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

/** References in `input` that cannot resolve against `pastedContents`: an
 *  Image reference without an image entry, any other reference without a
 *  text entry (a type-mismatched entry counts as dangling — it must never
 *  attach the wrong data). Sources: an aged-out history paste
 *  (resolveRecord drops unrecoverable hash bodies), an image recalled from
 *  history (images never enter it), a hand-typed placeholder. The composer
 *  refuses these at submit rather than letting expandPastedTextRefs ship a
 *  bare placeholder. */
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

/** Replace TEXT placeholders with their bodies in place. Image placeholders
 *  stay (they become separate content blocks downstream), as does any
 *  placeholder without a paste entry. The splice runs from the LAST match
 *  backwards so placeholder-looking strings inside pasted bodies are never
 *  re-interpreted and earlier offsets stay valid. */
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
