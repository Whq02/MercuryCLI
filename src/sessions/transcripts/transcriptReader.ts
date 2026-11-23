import type { UUID } from 'crypto'
import { open } from 'node:fs/promises'
import { decodeTranscriptBuffer } from '../fabric/transcriptDecode.js'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'
import type { Entry, SerializedMessage, TranscriptMessage } from './transcriptEntries.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { logError } from '../../platform/logs/errorLog.js'
import {
  SKIP_PRECOMPACT_THRESHOLD,
} from './sessionStoragePortable.js'
import {
  buildScreenConversation,
  removeExtraFields,
} from './chain.js'
import { applyTranscriptEntry, emptyFoldState, finishTranscriptFold, type TranscriptFoldState } from './fold.js'
import { transcriptRows } from './rowGraph.js'
import { isTranscriptMessage } from './paths.js'
import {
  resumeSnapshotEnabled,
  SNAPSHOT_MIN_BYTES,
  tryLoadResumeSnapshot,
  writeResumeSnapshot,
} from './resumeSnapshot.js'
import { transcriptIo as io, transcriptReaderCensus, transcriptLinesInReverse } from './transcriptBytes.js'
import { historyHead, historyIndex, historyLines, sealedExtents } from './historyParts.js'
import { streamFold } from './streamFold.js'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'

export { nodeTranscriptReaderIo, readTranscriptBytesAfter, setTranscriptReaderIoForTesting, transcriptReaderCensus } from './transcriptBytes.js'

const WINDOW_BYTES = 4096
const RECENT_MAX = 2
const SNAPSHOT_REFRESH_BYTES = 1024 * 1024
const NEWLINE = 0x0a
const EMPTY = Buffer.alloc(0)

function transcriptReaderEnabled(): boolean {
  return flagEnabled('MERCURY_TRANSCRIPT_READER')
}


export type TranscriptLoadDegradation = {
  path: string
  malformed: number
  invalid: number
  totalLines: number
  refusal: string | null
}

let loadDegradation: TranscriptLoadDegradation | null = null
const degradationListeners = new Set<() => void>()

function fanOutLoadDegradation(): void {
  for (const listener of degradationListeners) {
    try {
      listener()
    } catch (error) {
      passedOver(error)
    }
  }
}

function noteLoadDegradation(next: TranscriptLoadDegradation): void {
  loadDegradation = next
  fanOutLoadDegradation()
}

function clearLoadDegradation(path: string): void {
  if (loadDegradation === null || loadDegradation.path !== path) return
  loadDegradation = null
  fanOutLoadDegradation()
}

export function transcriptLoadDegradation(forPath?: string): TranscriptLoadDegradation | null {
  return forPath === undefined || loadDegradation?.path === forPath ? loadDegradation : null
}

export function subscribeTranscriptLoadDegradation(listener: () => void): () => void {
  degradationListeners.add(listener)
  return () => {
    degradationListeners.delete(listener)
  }
}

export function _resetTranscriptLoadDegradationForTesting(): void {
  loadDegradation = null
}


type TranscriptReadPolicy = 'resume' | 'all'

interface TranscriptReadAccounting {
  malformed: number
  invalid: number
  totalLines: number
}

interface TranscriptRead {
  kind: 'cold' | 'growth' | 'none'
  accounting: TranscriptReadAccounting
  refusal: string | null
}

interface TranscriptView {
  path: string
  generation: number
  offset: number
  size: number
  fold: TranscriptFoldState
  read: TranscriptRead
  refusal: string | null
}

const ZERO_ACCOUNTING: TranscriptReadAccounting = Object.freeze({ malformed: 0, invalid: 0, totalLines: 0 })

interface ChainMemo {
  generation: number
  offset: number
  rows: readonly SerializedMessage[]
}

interface ReaderState {
  path: string
  policy: TranscriptReadPolicy
  generation: number
  offset: number
  size: number
  ino: number
  window: Buffer
  fold: TranscriptFoldState
  pruned: boolean
  refusal: string | null
  bytesSinceSnapshot: number
  degradedSinceSnapshot: boolean
  chain: ChainMemo | null
}

const states = new Map<string, ReaderState>()
const retained = new Map<string, number>()
const recent: string[] = []
const inflight = new Map<string, Promise<TranscriptView>>()
let generationSeq = 0

function viewOf(state: ReaderState, read: TranscriptRead): TranscriptView {
  return {
    path: state.path,
    generation: state.generation,
    offset: state.offset,
    size: state.size,
    fold: state.fold,
    read,
    refusal: state.refusal,
  }
}

function touch(path: string): void {
  if (retained.has(path)) return
  const at = recent.indexOf(path)
  if (at !== -1) recent.splice(at, 1)
  recent.push(path)
  while (recent.length > RECENT_MAX) {
    const victim = recent.shift()!
    states.delete(victim)
  }
}

export function retainTranscript(path: string): () => void {
  retained.set(path, (retained.get(path) ?? 0) + 1)
  const at = recent.indexOf(path)
  if (at !== -1) recent.splice(at, 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (retained.get(path) ?? 1) - 1
    if (n > 0) {
      retained.set(path, n)
      return
    }
    retained.delete(path)
    if (states.has(path)) touch(path)
  }
}

export async function readTranscript(
  path: string,
  opts?: { policy?: TranscriptReadPolicy; cache?: boolean },
): Promise<TranscriptView> {
  const policy = opts?.policy ?? 'resume'
  if (!transcriptReaderEnabled()) {
    const cold = await coldRead(path, policy)
    return viewOf(cold.state, cold.read)
  }
  const prev = inflight.get(path) ?? Promise.resolve()
  const run = prev.catch(passedOverAs(undefined)).then(async (): Promise<TranscriptView> => {
    const existing = states.get(path)
    const servable = existing !== undefined && existing.offset > 0 && (existing.policy === policy || existing.policy === 'all')
    if (servable) {
      const growth = await growthRead(existing)
      if (growth !== null) {
        touch(path)
        return viewOf(existing, growth)
      }
    }
    const cold = await coldRead(path, policy)
    if (opts?.cache !== false && cold.state.offset > 0) {
      states.set(path, cold.state)
      touch(path)
    } else {
      states.delete(path)
    }
    return viewOf(cold.state, cold.read)
  })
  inflight.set(path, run)
  try {
    return await run
  } finally {
    if (inflight.get(path) === run) inflight.delete(path)
  }
}

function reset(state: ReaderState, why: string): null {
  transcriptReaderCensus.resets++
  logForDebugging(`transcript reader: full read of ${state.path} — ${why}`)
  states.delete(state.path)
  return null
}

function none(state: ReaderState, size: number): TranscriptRead {
  state.size = size
  return { kind: 'none', accounting: ZERO_ACCOUNTING, refusal: state.refusal }
}

function tailWindow(prev: Buffer, added: Buffer): Buffer {
  if (added.length >= WINDOW_BYTES) return Buffer.from(added.subarray(added.length - WINDOW_BYTES))
  const joined = Buffer.concat([prev, added])
  return joined.length > WINDOW_BYTES ? Buffer.from(joined.subarray(joined.length - WINDOW_BYTES)) : joined
}

async function growthRead(state: ReaderState): Promise<TranscriptRead | null> {
  const st = io.statSync(state.path)
  if (st === null) return reset(state, 'the file is gone')
  if (st.ino !== state.ino) return reset(state, 'the file was replaced')
  if (st.size < state.offset) return reset(state, 'the file was truncated')
  if (st.size === state.offset) return none(state, st.size)
  const W = state.window.length
  if (st.size - state.offset > SKIP_PRECOMPACT_THRESHOLD) {
    const covered = io.readRangeSync(state.path, state.offset - W, state.offset)
    transcriptReaderCensus.bytesRead += covered.length
    if (!covered.equals(state.window)) return reset(state, 'the covered prefix was rewritten')
    if (state.refusal !== null) return reset(state, 'the refused transcript grew')
    let result: Awaited<ReturnType<typeof streamFold>>
    try {
      result = await streamFold(state.path, state.fold, state.offset, st.size, st.ino, false, false, true, entry => !state.pruned || !isTranscriptMessage(entry) || entry.parentUuid === null || state.fold.messages.has(entry.parentUuid) || state.fold.progressBridge.has(entry.parentUuid))
    } catch (error) {
      states.delete(state.path)
      throw error
    }
    if (result.refusal) return reset(state, 'a line outside the record format landed')
    if (result.rejectedParent) return reset(state, 'a row parents onto a pruned branch')
    if (result.offset === state.offset) return none(state, st.size)
    if (io.statSync(state.path)?.ino !== st.ino) return reset(state, 'the file was replaced')
    const { accounting } = result
    if (accounting.malformed || accounting.invalid) {
      logError(new Error(`transcript tail degraded on growth: ${accounting.malformed} malformed, ${accounting.invalid} invalid of ${accounting.totalLines} (${state.path})`))
      noteLoadDegradation({ path: state.path, ...accounting, refusal: null })
      state.degradedSinceSnapshot = true
    }
    finishTranscriptFold(state.fold)
    state.bytesSinceSnapshot += result.offset - state.offset
    state.offset = result.offset
    state.size = st.size
    state.window = io.readRangeSync(state.path, Math.max(0, state.offset - WINDOW_BYTES), state.offset)
    transcriptReaderCensus.bytesRead += state.window.length
    transcriptReaderCensus.growthReads++
    maybeRefreshSnapshot(state)
    return { kind: 'growth', accounting, refusal: null }
  }
  const buf = io.readRangeSync(state.path, state.offset - W, st.size)
  transcriptReaderCensus.bytesRead += buf.length
  if (buf.length < W) return none(state, state.size)
  if (!buf.subarray(0, W).equals(state.window)) return reset(state, 'the covered prefix was rewritten')
  const delta = buf.subarray(W)
  const lastNl = delta.lastIndexOf(NEWLINE)
  if (lastNl === -1) return none(state, st.size)
  const complete = delta.subarray(0, lastNl + 1)
  transcriptReaderCensus.growthReads++
  let accounting: TranscriptReadAccounting = ZERO_ACCOUNTING
  if (state.refusal === null) {
    const decoded = decodeTranscriptBuffer<Entry>(complete)
    if (decoded.refusal) return reset(state, 'a line outside the record format landed')
    const malformed = decoded.malformed.length
    for (const entry of decoded.entries) {
      if (
        state.pruned &&
        isTranscriptMessage(entry) &&
        entry.parentUuid !== null &&
        !state.fold.messages.has(entry.parentUuid) &&
        !state.fold.progressBridge.has(entry.parentUuid)
      ) {
        return reset(state, 'a row parents onto a pruned branch')
      }
      applyTranscriptEntry(state.fold, entry)
    }
    finishTranscriptFold(state.fold)
    accounting = { malformed, invalid: decoded.invalid.length, totalLines: decoded.totalLines }
    if (malformed > 0 || accounting.invalid > 0) {
      logError(
        new Error(
          `transcript tail degraded on growth: ${malformed} malformed, ${accounting.invalid} invalid of ${accounting.totalLines} (${state.path})`,
        ),
      )
      noteLoadDegradation({ path: state.path, malformed, invalid: accounting.invalid, totalLines: accounting.totalLines, refusal: null })
      state.degradedSinceSnapshot = true
    }
  }
  state.offset += complete.length
  state.size = st.size
  state.window = tailWindow(state.window, complete)
  state.bytesSinceSnapshot += complete.length
  maybeRefreshSnapshot(state)
  return { kind: 'growth', accounting, refusal: state.refusal }
}

function maybeRefreshSnapshot(state: ReaderState): void {
  if (state.policy !== 'resume' || state.refusal !== null) return
  if (state.bytesSinceSnapshot < SNAPSHOT_REFRESH_BYTES || state.offset < SNAPSHOT_MIN_BYTES) return
  if (state.degradedSinceSnapshot || !resumeSnapshotEnabled()) return
  writeResumeSnapshot(state.path, state.fold, state.offset)
  state.bytesSinceSnapshot = 0
}

async function coldRead(path: string, policy: TranscriptReadPolicy): Promise<{ state: ReaderState; read: TranscriptRead }> {
  transcriptReaderCensus.coldReads++
  const state: ReaderState = {
    path,
    policy,
    generation: ++generationSeq,
    offset: 0,
    size: 0,
    ino: 0,
    window: EMPTY,
    fold: emptyFoldState(),
    pruned: false,
    refusal: null,
    bytesSinceSnapshot: 0,
    degradedSinceSnapshot: false,
    chain: null,
  }
  const absent: TranscriptRead = { kind: 'none', accounting: ZERO_ACCOUNTING, refusal: null }
  const st = io.statSync(path)
  if (st === null) return { state, read: absent }
  state.ino = st.ino
  state.size = st.size

  let accounting: TranscriptReadAccounting = ZERO_ACCOUNTING
  let offset = 0
  let snapshotCovered = false
  let wroteSnapshot = false
  if (policy === 'resume') {
    const hit = await tryLoadResumeSnapshot(path, true)
    if (hit && hit.fileSize <= st.size) {
      const tail = await streamFold(path, hit.fold, hit.byteCursor, st.size, st.ino, false, false)
      if (!tail.refusal) {
        state.fold = hit.fold
        accounting = tail.accounting
        offset = tail.offset
        snapshotCovered = true
        state.bytesSinceSnapshot = offset - hit.byteCursor
        if (accounting.malformed || accounting.invalid) {
          logError(new Error(`transcript tail degraded on snapshot resume: ${accounting.malformed} malformed, ${accounting.invalid} invalid of ${accounting.totalLines}`))
          noteLoadDegradation({ path, ...accounting, refusal: null })
          state.degradedSinceSnapshot = true
        } else if (offset === st.size && state.bytesSinceSnapshot > SNAPSHOT_REFRESH_BYTES) {
          writeResumeSnapshot(path, state.fold, offset)
          state.bytesSinceSnapshot = 0
          wroteSnapshot = true
        }
      } else logError(new Error(`${tail.refusal}: ${path} (snapshot tail — reloading the file whole)`))
    }
  }
  if (!snapshotCovered) {
    const result = await streamFold(path, state.fold, 0, st.size, st.ino, st.size > SKIP_PRECOMPACT_THRESHOLD, policy === 'resume')
    accounting = result.accounting
    offset = result.offset
    state.pruned = result.pruned
    if (result.refusal) {
      state.refusal = result.refusal
      state.fold = emptyFoldState()
      logError(new Error(`${result.refusal}: ${path}`))
      noteLoadDegradation({ path, ...accounting, refusal: result.refusal })
    } else if (accounting.malformed || accounting.invalid) {
      logError(new Error(`transcript degraded on load: ${accounting.malformed} malformed line(s), ${accounting.invalid} invalid-shape record(s) of ${accounting.totalLines} (first: ${result.firstIssue})`))
      noteLoadDegradation({ path, ...accounting, refusal: null })
      state.degradedSinceSnapshot = true
    }
  }
  if (io.statSync(path)?.ino !== st.ino) throw new Error(`History changed during the read: ${path}`)
  state.offset = offset
  if (offset > 0) {
    const from = Math.max(0, offset - WINDOW_BYTES)
    state.window = io.readRangeSync(path, from, offset)
    transcriptReaderCensus.bytesRead += state.window.length
  }

  if (state.refusal === null) {
    finishTranscriptFold(state.fold)
    if (!state.degradedSinceSnapshot) clearLoadDegradation(path)
    if (!snapshotCovered && policy === 'resume' && resumeSnapshotEnabled() && offset >= SNAPSHOT_MIN_BYTES) {
      writeResumeSnapshot(path, state.fold, offset)
      wroteSnapshot = true
    }
  }
  if (wroteSnapshot) state.bytesSinceSnapshot = 0
  else if (!snapshotCovered) state.bytesSinceSnapshot = offset

  return { state, read: { kind: 'cold', accounting, refusal: state.refusal } }
}


const rowOfSource = new WeakMap<TranscriptMessage, SerializedMessage>()
const rowTokens = new WeakMap<object, string>()
let rowSeq = 0

function rowFor(source: TranscriptMessage): SerializedMessage {
  let row = rowOfSource.get(source)
  if (row === undefined) {
    row = removeExtraFields([source])[0]!
    rowOfSource.set(source, row)
    rowTokens.set(row, `row:${++rowSeq}`)
  }
  return row
}

export function chainRowSigner(): (row: unknown) => string {
  if (!transcriptReaderEnabled()) return row => JSON.stringify(row)
  return row => {
    const token = typeof row === 'object' && row !== null ? rowTokens.get(row) : undefined
    return token ?? JSON.stringify(row)
  }
}

function deriveChainRows(fold: TranscriptFoldState, prev: readonly SerializedMessage[] | undefined): readonly SerializedMessage[] {
  transcriptReaderCensus.chainDerivations++
  const rows = buildScreenConversation(fold.messages).map(rowFor)
  if (prev !== undefined && prev.length === rows.length && rows.every((r, i) => r === prev[i])) return prev
  return rows
}

export interface TranscriptChainCursor {
  generation: number
  rows: readonly SerializedMessage[]
}

interface TranscriptChainSince {
  rows: readonly SerializedMessage[]
  since: number
  appended: readonly SerializedMessage[]
  rewound: boolean
  cursor: TranscriptChainCursor
  view: TranscriptView
}

export async function readTranscriptChainSince(
  path: string,
  cursor: TranscriptChainCursor | null,
  opts?: { policy?: TranscriptReadPolicy },
): Promise<TranscriptChainSince> {
  const view = await readTranscript(path, opts)
  const state = states.get(path)
  let rows: readonly SerializedMessage[]
  if (state !== undefined && state.generation === view.generation) {
    const memo = state.chain
    if (memo !== null && memo.offset === state.offset) rows = memo.rows
    else {
      rows = deriveChainRows(state.fold, memo?.rows ?? cursor?.rows)
      state.chain = { generation: state.generation, offset: state.offset, rows }
    }
  } else {
    rows = deriveChainRows(view.fold, cursor?.rows)
  }
  let since = 0
  if (cursor !== null && cursor.generation === view.generation) {
    const n = Math.min(cursor.rows.length, rows.length)
    while (since < n && cursor.rows[since] === rows[since]) since++
  }
  const rewound = cursor !== null && since < cursor.rows.length
  return {
    rows,
    since,
    appended: since === 0 ? rows : rows.slice(since),
    rewound,
    cursor: { generation: view.generation, rows },
    view,
  }
}

interface RecordIdScan {
  ino: number
  offset: number
  window: Buffer
  parts: Buffer[]
  ids: Set<string>
}

const recordIdScans = new Map<string, RecordIdScan>()
const recordIdScanRuns = new Map<string, Promise<Set<string>>>()
const RECORD_ID_SCAN_CHUNK = 1024 * 1024
const RECORD_ID_HEAD = /^\{"schemaVersion":\d+,"recordId":"([^"]+)"/
const RECORD_ID_HEAD_BYTES = 256

function recordIdOfLine(line: Buffer): string | null {
  const head = RECORD_ID_HEAD.exec(line.subarray(0, RECORD_ID_HEAD_BYTES).toString('latin1'))
  if (head !== null) return head[1]!
  try {
    const parsed = JSON.parse(line.toString('utf8')) as { recordId?: unknown; uuid?: unknown; annotations?: { uuid?: unknown } }
    if (typeof parsed.recordId === 'string') return parsed.recordId
    if (typeof parsed.annotations?.uuid === 'string') return parsed.annotations.uuid
    if (typeof parsed.uuid === 'string') return parsed.uuid
  } catch (error) {
    passedOver(error)
    return null
  }
  return null
}

function takeRecordIds(scan: RecordIdScan, bytes: Buffer): void {
  let start = 0
  for (let newline = bytes.indexOf(NEWLINE); newline !== -1; newline = bytes.indexOf(NEWLINE, start)) {
    const piece = bytes.subarray(start, newline)
    const line = scan.parts.length === 0 ? piece : Buffer.concat([...scan.parts, piece])
    scan.parts = []
    if (line.length > 0) {
      const id = recordIdOfLine(line)
      if (id !== null) scan.ids.add(id)
    }
    start = newline + 1
  }
  if (start < bytes.length) scan.parts.push(Buffer.from(bytes.subarray(start)))
}

function scanStillCovers(path: string, scan: RecordIdScan, st: { size: number; ino: number }): boolean {
  if (scan.ino !== st.ino || st.size < scan.offset) return false
  if (scan.window.length === 0) return true
  const window = io.readRangeSync(path, scan.offset - scan.window.length, scan.offset)
  transcriptReaderCensus.bytesRead += window.length
  return window.equals(scan.window)
}

async function scanRecordIds(path: string): Promise<Set<string>> {
  const st = io.statSync(path)
  if (st === null) {
    recordIdScans.delete(path)
    return new Set()
  }
  let scan = recordIdScans.get(path)
  if (scan === undefined || !scanStillCovers(path, scan, st)) {
    scan = { ino: st.ino, offset: 0, window: EMPTY, parts: [], ids: new Set() }
    for (const part of sealedExtents(historyHead(path))) for (const [id] of historyIndex(part)) if (id) scan.ids.add(id)
    recordIdScans.set(path, scan)
  }
  if (st.size > scan.offset) {
    const handle = await open(path, 'r')
    try {
      const chunk = Buffer.allocUnsafe(RECORD_ID_SCAN_CHUNK)
      let position = scan.offset
      while (position < st.size) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(RECORD_ID_SCAN_CHUNK, st.size - position), position)
        if (bytesRead === 0) break
        position += bytesRead
        transcriptReaderCensus.bytesRead += bytesRead
        const bytes = chunk.subarray(0, bytesRead)
        takeRecordIds(scan, bytes)
        scan.window = tailWindow(scan.window, bytes)
      }
      scan.offset = position
    } finally {
      await handle.close()
    }
  }
  return new Set(scan.ids)
}

export async function readTranscriptRecordIds(path: string): Promise<Set<string>> {
  const prev = recordIdScanRuns.get(path) ?? Promise.resolve(new Set<string>())
  const run = prev.catch(passedOverAs(undefined)).then(() => scanRecordIds(path))
  recordIdScanRuns.set(path, run)
  try {
    return await run
  } finally {
    if (recordIdScanRuns.get(path) === run) recordIdScanRuns.delete(path)
  }
}

export function _resetTranscriptRecordIdScansForTesting(): void {
  recordIdScans.clear()
  recordIdScanRuns.clear()
}

export function readTranscriptTailSync(path: string, bytes: number): string {
  try {
    const stat = io.statSync(path)
    if (!stat) return ''
    const buffer = io.readRangeSync(path, Math.max(0, stat.size - bytes), stat.size)
    transcriptReaderCensus.bytesRead += buffer.length
    return buffer.toString('utf8')
  } catch (error) {
    passedOver(error)
    return ''
  }
}

export function scanTranscriptLinesBackward(path: string, visit: (line: string) => boolean | void): void {
  const st = io.statSync(path)
  if (st === null || st.size === 0) return
  const walk = (path: string, start: number, end: number): boolean => {
    for (const bytes of transcriptLinesInReverse(path, start, end)) {
      const line = bytes.toString('utf8').replace(/\n$/, '')
      if (line && visit(line) === true) return true
    }
    return false
  }
  const head = historyHead(path)
  if (walk(path, 0, st.size)) return
  for (const part of sealedExtents(head).reverse()) if (walk(part.path, part.start, part.end)) return
}

export function scanTranscriptEntriesForward(path: string, visit: (entry: Entry) => void): TranscriptRead {
  const st = io.statSync(path)
  if (st === null) return { kind: 'none', accounting: ZERO_ACCOUNTING, refusal: null }
  const accounting: TranscriptReadAccounting = { malformed: 0, invalid: 0, totalLines: 0 }
  let first = true
  for (const line of historyLines(path)) {
    const decoded = decodeTranscriptBuffer<Entry>(line)
    accounting.totalLines += decoded.totalLines
    if (decoded.refusal && first) return { kind: 'cold', accounting, refusal: decoded.refusal }
    if (decoded.refusal || decoded.entries.length || decoded.invalid.length) first = false
    accounting.malformed += decoded.malformed.length
    accounting.invalid += decoded.invalid.length + Number(Boolean(decoded.refusal))
    for (const entry of decoded.entries) visit(entry)
  }
  return { kind: 'cold', accounting, refusal: null }
}

export function computeResumeLeaves(messages: Map<UUID, TranscriptMessage>): Set<UUID> {
  return transcriptRows(messages).resumeLeaves()
}

export function _resetTranscriptReaderForTesting(): void {
  states.clear()
  retained.clear()
  recent.length = 0
  inflight.clear()
  transcriptReaderCensus.coldReads = 0
  transcriptReaderCensus.growthReads = 0
  transcriptReaderCensus.resets = 0
  transcriptReaderCensus.bytesRead = 0
  transcriptReaderCensus.chainDerivations = 0
}

export function _transcriptReaderRetentionForTesting(): { states: string[]; retained: string[]; recent: string[] } {
  return { states: [...states.keys()], retained: [...retained.keys()], recent: [...recent] }
}


export { pruneRecordBranchesBeforeParse } from './branchSelection.js'
