import type { UUID } from 'crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { decodeTranscriptBuffer } from '../../fabric/transcriptDecode.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import { flagEnabled } from '../../substrate/flagRegistry.js'
import type { Entry, SerializedMessage, TranscriptMessage } from '../../types/logs.js'
import { logForDebugging } from '../debug.js'
import { parseJSONL } from '../json.js'
import { logError } from '../log.js'
import {
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from '../sessionStoragePortable.js'
import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
  buildConversationChain,
  findLatestMessage,
  removeExtraFields,
} from './chain.js'
import { applyTranscriptEntry, emptyFoldState, type TranscriptFoldState } from './fold.js'
import { isTranscriptMessage } from './paths.js'
import {
  resumeSnapshotEnabled,
  SNAPSHOT_MIN_BYTES,
  tryLoadResumeSnapshot,
  writeResumeSnapshot,
} from './resumeSnapshot.js'

const WINDOW_BYTES = 4096
const RECENT_MAX = 2
const SNAPSHOT_REFRESH_BYTES = 1024 * 1024
const BACKWARD_WINDOW_BYTES = 64 * 1024
const FRAGMENT_SCAN_MAX = 16 * 1024 * 1024
const NEWLINE = 0x0a
const EMPTY = Buffer.alloc(0)

export function transcriptReaderEnabled(): boolean {
  return flagEnabled('MERCURY_TRANSCRIPT_READER')
}


export interface TranscriptReaderIo {
  statSync(path: string): { size: number; ino: number } | null
  readRangeSync(path: string, start: number, end: number): Buffer
}

export const nodeTranscriptReaderIo: TranscriptReaderIo = {
  statSync(path) {
    try {
      const st = statSync(path)
      return { size: st.size, ino: st.ino }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw e
    }
  },
  readRangeSync(path, start, end) {
    const len = Math.max(0, end - start)
    const buf = Buffer.allocUnsafe(len)
    const fd = openSync(path, 'r')
    try {
      let read = 0
      while (read < len) {
        const n = readSync(fd, buf, read, len - read, start + read)
        if (n === 0) break
        read += n
      }
      return buf.subarray(0, read)
    } finally {
      closeSync(fd)
    }
  },
}

let io: TranscriptReaderIo = nodeTranscriptReaderIo

export function setTranscriptReaderIoForTesting(next: TranscriptReaderIo | null): void {
  io = next ?? nodeTranscriptReaderIo
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

function noteLoadDegradation(next: TranscriptLoadDegradation): void {
  loadDegradation = next
  for (const listener of degradationListeners) {
    try {
      listener()
    } catch {
    }
  }
}

export function transcriptLoadDegradation(): TranscriptLoadDegradation | null {
  return loadDegradation
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

export const transcriptReaderCensus = {
  coldReads: 0,
  growthReads: 0,
  resets: 0,
  bytesRead: 0,
  chainDerivations: 0,
}


export type TranscriptReadPolicy = 'resume' | 'all'

export interface TranscriptReadAccounting {
  malformed: number
  invalid: number
  totalLines: number
}

export interface TranscriptRead {
  kind: 'cold' | 'growth' | 'none'
  accounting: TranscriptReadAccounting
  refusal: string | null
}

export interface TranscriptView {
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
  tornCounted: boolean
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
  const run = prev.catch(() => undefined).then(async (): Promise<TranscriptView> => {
    const existing = states.get(path)
    const servable = existing !== undefined && existing.offset > 0 && (existing.policy === policy || existing.policy === 'all')
    if (servable) {
      const growth = growthRead(existing)
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

function growthRead(state: ReaderState): TranscriptRead | null {
  const st = io.statSync(state.path)
  if (st === null) return reset(state, 'the file is gone')
  if (st.ino !== state.ino) return reset(state, 'the file was replaced')
  if (st.size < state.offset) return reset(state, 'the file was truncated')
  if (st.size === state.offset) return none(state, st.size)
  const W = state.window.length
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
    let malformed = decoded.malformed.length
    if (state.tornCounted && decoded.malformed.some(m => m.line === 1)) malformed -= 1
    let sawSystem = false
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
      if (entry.type === 'system') sawSystem = true
      applyTranscriptEntry(state.fold, entry)
    }
    if (sawSystem) {
      applyPreservedSegmentRelinks(state.fold.messages)
      applySnipRemovals(state.fold.messages)
    }
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
  state.tornCounted = false
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

function isCompleteJsonLine(line: Buffer): boolean {
  try {
    JSON.parse(line.toString('utf8'))
    return true
  } catch {
    return false
  }
}

function fileFragment(path: string, size: number): Buffer | null {
  if (size === 0) return null
  for (let len = Math.min(size, BACKWARD_WINDOW_BYTES); ; len = Math.min(size, len * 4)) {
    const buf = io.readRangeSync(path, size - len, size)
    transcriptReaderCensus.bytesRead += buf.length
    if (buf.length === 0) return null
    if (buf[buf.length - 1] === NEWLINE) return null
    const nl = buf.lastIndexOf(NEWLINE)
    if (nl !== -1) return Buffer.from(buf.subarray(nl + 1))
    if (len >= size) return Buffer.from(buf)
    if (len >= FRAGMENT_SCAN_MAX) return null
  }
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
    tornCounted: false,
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
  let consumed = 0
  let fragment: Buffer | null = null
  let plainBuf: Buffer | null = null
  let snapshotCovered = false
  let wroteSnapshot = false

  if (policy === 'resume') {
    const hit = await tryLoadResumeSnapshot(path)
    if (hit) {
      const decodedTail = decodeTranscriptBuffer<Entry>(hit.tail)
      if (decodedTail.refusal) {
        logError(new Error(`${decodedTail.refusal}: ${path} (snapshot tail — reloading the file whole)`))
      } else {
        state.fold = hit.fold
        const degraded = decodedTail.malformed.length > 0 || decodedTail.invalid.length > 0
        if (degraded) {
          logError(
            new Error(
              `transcript tail degraded on snapshot resume: ${decodedTail.malformed.length} malformed, ${decodedTail.invalid.length} invalid of ${decodedTail.totalLines}`,
            ),
          )
          noteLoadDegradation({ path, malformed: decodedTail.malformed.length, invalid: decodedTail.invalid.length, totalLines: decodedTail.totalLines, refusal: null })
        }
        for (const entry of decodedTail.entries) applyTranscriptEntry(state.fold, entry)
        accounting = { malformed: decodedTail.malformed.length, invalid: decodedTail.invalid.length, totalLines: decodedTail.totalLines }
        snapshotCovered = true
        consumed = hit.fileSize
        transcriptReaderCensus.bytesRead += hit.tail.length
        const nl = hit.tail.lastIndexOf(NEWLINE)
        fragment = nl === hit.tail.length - 1 ? null : Buffer.from(hit.tail.subarray(nl + 1))
        state.degradedSinceSnapshot = degraded
        state.bytesSinceSnapshot = hit.tail.length
        if (!degraded && hit.tail.length > SNAPSHOT_REFRESH_BYTES) {
          writeResumeSnapshot(path, state.fold, hit.fileSize)
          wroteSnapshot = true
        }
      }
    }
  }

  if (!snapshotCovered) {
    let buf: Buffer | null = null
    let metadataLines: string[] | null = null
    let hasPreservedSegment = false
    if (st.size > SKIP_PRECOMPACT_THRESHOLD) {
      const scan = await readTranscriptForLoad(path, st.size)
      buf = scan.postBoundaryBuf
      hasPreservedSegment = scan.hasPreservedSegment
      transcriptReaderCensus.bytesRead += st.size
      if (scan.boundaryStartOffset > 0) {
        metadataLines = await scanPreBoundaryMetadata(path, scan.boundaryStartOffset)
      }
      consumed = st.size
      fragment = fileFragment(path, st.size)
    }
    if (buf === null) {
      buf = await readFile(path)
      plainBuf = buf
      transcriptReaderCensus.bytesRead += buf.length
      consumed = buf.length
      const nl = buf.lastIndexOf(NEWLINE)
      fragment = buf.length === 0 || nl === buf.length - 1 ? null : buf.subarray(nl + 1)
    }
    if (policy === 'resume' && !hasPreservedSegment && buf.length > SKIP_PRECOMPACT_THRESHOLD) {
      const before = buf
      buf = pruneRecordBranchesBeforeParse(buf)
      state.pruned = buf !== before
    }
    if (metadataLines && metadataLines.length > 0) {
      const metaEntries = parseJSONL<Entry>(Buffer.from(metadataLines.join('\n')))
      for (const entry of metaEntries) {
        if (PRE_BOUNDARY_METADATA_KINDS.has(entry.type)) applyTranscriptEntry(state.fold, entry)
      }
    }
    const decoded = decodeTranscriptBuffer<Entry>(buf)
    if (decoded.refusal) {
      logError(new Error(`${decoded.refusal}: ${path}`))
      noteLoadDegradation({ path, malformed: 0, invalid: 0, totalLines: decoded.totalLines, refusal: decoded.refusal })
      state.refusal = decoded.refusal
      state.fold = emptyFoldState()
      accounting = { malformed: 0, invalid: 0, totalLines: decoded.totalLines }
    } else {
      if (decoded.malformed.length > 0 || decoded.invalid.length > 0) {
        logError(
          new Error(
            `transcript degraded on load: ${decoded.malformed.length} malformed line(s), ` +
              `${decoded.invalid.length} invalid-shape record(s) of ${decoded.totalLines} ` +
              `(first: ${decoded.malformed[0] ? `line ${decoded.malformed[0].line}` : `#${decoded.invalid[0]?.index} ${decoded.invalid[0]?.reason}`})`,
          ),
        )
        noteLoadDegradation({ path, malformed: decoded.malformed.length, invalid: decoded.invalid.length, totalLines: decoded.totalLines, refusal: null })
        state.degradedSinceSnapshot = true
      }
      for (const entry of decoded.entries) applyTranscriptEntry(state.fold, entry)
      accounting = { malformed: decoded.malformed.length, invalid: decoded.invalid.length, totalLines: decoded.totalLines }
    }
  }

  let offset = consumed
  if (fragment !== null && fragment.length > 0 && !isCompleteJsonLine(fragment)) {
    offset = consumed - fragment.length
    state.tornCounted = state.refusal === null
  }
  state.offset = offset
  if (offset > 0) {
    const from = Math.max(0, offset - WINDOW_BYTES)
    if (plainBuf !== null) {
      state.window = Buffer.from(plainBuf.subarray(from, offset))
    } else {
      state.window = io.readRangeSync(path, from, offset)
      transcriptReaderCensus.bytesRead += state.window.length
    }
  }

  if (state.refusal === null) {
    applyPreservedSegmentRelinks(state.fold.messages)
    applySnipRemovals(state.fold.messages)
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
  const messages = fold.messages
  const leaves = computeResumeLeaves(messages)
  const leaf = findLatestMessage(messages.values(), m => leaves.has(m.uuid) && (m.type === 'user' || m.type === 'assistant'))
  const rows = leaf ? buildConversationChain(messages, leaf).map(rowFor) : []
  if (prev !== undefined && prev.length === rows.length && rows.every((r, i) => r === prev[i])) return prev
  return rows
}

export interface TranscriptChainCursor {
  generation: number
  rows: readonly SerializedMessage[]
}

export interface TranscriptChainSince {
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


export interface TranscriptByteCursor {
  offset: number
  carry: string
}

export interface TranscriptBytesAfter {
  text: string
  cursor: TranscriptByteCursor
  rewound: boolean
  size: number
}

export function readTranscriptBytesAfter(path: string, cursor: TranscriptByteCursor): TranscriptBytesAfter {
  const st = io.statSync(path)
  if (st === null) return { text: '', cursor: { offset: 0, carry: '' }, rewound: cursor.offset > 0, size: 0 }
  let from = cursor.offset
  let carry = cursor.carry
  let rewound = false
  if (st.size < cursor.offset) {
    from = 0
    carry = ''
    rewound = true
  }
  if (st.size === from) return { text: '', cursor: { offset: from, carry }, rewound, size: st.size }
  const buf = io.readRangeSync(path, from, st.size)
  transcriptReaderCensus.bytesRead += buf.length
  const combined = carry + buf.toString('utf8')
  const lastNewline = combined.lastIndexOf('\n')
  return {
    text: lastNewline === -1 ? '' : combined.slice(0, lastNewline),
    cursor: { offset: from + buf.length, carry: lastNewline === -1 ? combined : combined.slice(lastNewline + 1) },
    rewound,
    size: st.size,
  }
}

export function scanTranscriptLinesBackward(path: string, visit: (line: string) => boolean | void): void {
  const st = io.statSync(path)
  if (st === null || st.size === 0) return
  const size = st.size
  let visitedFrom = size
  for (let len = Math.min(size, BACKWARD_WINDOW_BYTES); ; len = Math.min(size, len * 4)) {
    const from = size - len
    const buf = io.readRangeSync(path, from, size)
    transcriptReaderCensus.bytesRead += buf.length
    if (buf.length < len) return
    const region = buf.subarray(0, visitedFrom - from)
    const firstNl = from > 0 ? region.indexOf(NEWLINE) : -1
    const whole = from > 0 ? (firstNl === -1 ? EMPTY : region.subarray(firstNl + 1)) : region
    const pieces = whole.toString('utf8').split('\n')
    for (let i = pieces.length - 1; i >= 0; i--) {
      const line = pieces[i]!
      if (line.length === 0) continue
      if (visit(line) === true) return
    }
    visitedFrom = from > 0 && firstNl !== -1 ? from + firstNl + 1 : visitedFrom
    if (from === 0) return
  }
}


export function computeResumeLeaves(messages: Map<UUID, TranscriptMessage>): Set<UUID> {
  const allMessages = [...messages.values()]

  const parentUuids = new Set(
    allMessages.map(msg => msg.parentUuid).filter((uuid): uuid is UUID => uuid !== null),
  )
  const terminalMessages = allMessages.filter(msg => !parentUuids.has(msg.uuid))

  const pruneMidConversation = getFeatureValue_CACHED_MAY_BE_STALE('mercury_pebble_leaf_prune', false)
  const hasUserAssistantChild = new Set<UUID>()
  if (pruneMidConversation) {
    for (const msg of allMessages) {
      if (msg.parentUuid && (msg.type === 'user' || msg.type === 'assistant')) {
        hasUserAssistantChild.add(msg.parentUuid)
      }
    }
  }

  const leafUuids = new Set<UUID>()
  let hasCycle = false
  for (const terminal of terminalMessages) {
    const seen = new Set<UUID>()
    let current: TranscriptMessage | undefined = terminal
    while (current) {
      if (seen.has(current.uuid)) {
        hasCycle = true
        break
      }
      seen.add(current.uuid)
      if (current.type === 'user' || current.type === 'assistant') {
        if (!pruneMidConversation || !hasUserAssistantChild.has(current.uuid)) {
          leafUuids.add(current.uuid)
        }
        break
      }
      current = current.parentUuid ? messages.get(current.parentUuid) : undefined
    }
  }

  if (hasCycle) {
    logForDebugging('cycle detected during resume-leaf computation', { level: 'warn' })
  }

  return leafUuids
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


function resolveMetadataBuf(carry: Buffer | null, chunkBuf: Buffer): Buffer | null {
  if (carry === null || carry.length === 0) return chunkBuf
  if (carry.length < METADATA_PREFIX_BOUND) {
    return Buffer.concat([carry, chunkBuf])
  }
  if (
    carry.compare(
      RECORD_CARRY_PREFIX,
      0,
      RECORD_CARRY_PREFIX.length,
      0,
      Math.min(carry.length, RECORD_CARRY_PREFIX.length),
    ) === 0
  ) {
    return Buffer.concat([carry, chunkBuf])
  }
  const firstNl = chunkBuf.indexOf(NEWLINE)
  return firstNl === -1 ? null : chunkBuf.subarray(firstNl + 1)
}

async function scanPreBoundaryMetadata(filePath: string, endOffset: number): Promise<string[]> {
  const { createReadStream } = await import('fs')

  const stream = createReadStream(filePath, { end: endOffset - 1 })
  const metadataLines: string[] = []
  let carry: Buffer | null = null

  for await (const chunk of stream) {
    const chunkBuf = chunk as Buffer
    const buf = resolveMetadataBuf(carry, chunkBuf)
    if (buf === null) {
      carry = null
      continue
    }

    let hasAnyMarker = false
    for (const m of METADATA_MARKER_BUFS) {
      if (buf.includes(m)) {
        hasAnyMarker = true
        break
      }
    }

    if (hasAnyMarker) {
      let lineStart = 0
      let nl = buf.indexOf(NEWLINE)
      while (nl !== -1) {
        for (const m of METADATA_MARKER_BUFS) {
          const mIdx = buf.indexOf(m, lineStart)
          if (mIdx !== -1 && mIdx < nl) {
            metadataLines.push(buf.toString('utf-8', lineStart, nl))
            break
          }
        }
        lineStart = nl + 1
        nl = buf.indexOf(NEWLINE, lineStart)
      }
      carry = buf.subarray(lineStart)
    } else {
      const lastNl = buf.lastIndexOf(NEWLINE)
      carry = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf
    }

    if (carry.length > 64 * 1024) carry = null
  }

  if (carry !== null && carry.length > 0) {
    for (const m of METADATA_MARKER_BUFS) {
      if (carry.includes(m)) {
        metadataLines.push(carry.toString('utf-8'))
        break
      }
    }
  }

  return metadataLines
}


const RECORD_LINE_PREFIX = Buffer.from('{"schemaVersion":1,"recordId":"')
const PRUNE_KIND_NEEDLE = Buffer.from('"payload":{"kind":"')
const PRUNE_KIND_BOUND = 600
const PRUNE_CHAIN_KINDS = new Set(['input', 'output', 'attachment', 'notice', 'boundary', 'progress'])

export function pruneRecordBranchesBeforeParse(buf: Buffer): Buffer {
  const QUOTE = 0x22
  const PREFIX_LEN = RECORD_LINE_PREFIX.length

  const nodeIdx: number[] = []
  const nodeIds: string[] = []
  const keepRanges: number[] = []
  const idToSlots = new Map<string, number[]>()
  let chainBytes = 0

  let pos = 0
  const len = buf.length
  while (pos < len) {
    const nl = buf.indexOf(NEWLINE, pos)
    const lineEnd = nl === -1 ? len : nl + 1
    let isChainNode = false
    if (
      lineEnd - pos > PREFIX_LEN + 2 &&
      buf.compare(RECORD_LINE_PREFIX, 0, PREFIX_LEN, pos, pos + PREFIX_LEN) === 0
    ) {
      const idStart = pos + PREFIX_LEN
      const idEnd = buf.indexOf(QUOTE, idStart)
      const kindAt = buf.indexOf(PRUNE_KIND_NEEDLE, pos)
      if (
        idEnd > idStart &&
        idEnd - idStart <= 64 &&
        kindAt !== -1 &&
        kindAt < pos + PRUNE_KIND_BOUND &&
        kindAt < lineEnd
      ) {
        const kindStart = kindAt + PRUNE_KIND_NEEDLE.length
        const kindEnd = buf.indexOf(QUOTE, kindStart)
        if (kindEnd > kindStart && PRUNE_CHAIN_KINDS.has(buf.toString('latin1', kindStart, kindEnd))) {
          const id = buf.toString('latin1', idStart, idEnd)
          const slot = nodeIds.length
          nodeIdx.push(pos, lineEnd)
          nodeIds.push(id)
          const slots = idToSlots.get(id)
          if (slots) slots.push(slot)
          else idToSlots.set(id, [slot])
          chainBytes += lineEnd - pos
          isChainNode = true
        }
      }
    }
    if (!isChainNode) keepRanges.push(pos, lineEnd)
    pos = lineEnd
  }
  if (nodeIds.length === 0) return buf

  const decodeSlot = (slot: number): Record<string, unknown> | null => {
    const d = decodeTranscriptBuffer<Record<string, unknown>>(
      buf.subarray(nodeIdx[slot * 2]!, nodeIdx[slot * 2 + 1]!),
    )
    return d.entries.length === 1 ? d.entries[0]! : null
  }

  let leaf: Record<string, unknown> | null = null
  for (let slot = nodeIds.length - 1; slot >= 0; slot--) {
    const e = decodeSlot(slot)
    if (e === null || e.isSidechain === true) continue
    leaf = e
    break
  }
  if (leaf === null) return buf

  const liveIds = new Set<string>()
  let liveBytes = 0
  let cur: Record<string, unknown> | null = leaf
  while (cur) {
    const id = typeof cur.uuid === 'string' ? cur.uuid : null
    if (id === null || liveIds.has(id)) break
    liveIds.add(id)
    for (const slot of idToSlots.get(id) ?? []) {
      liveBytes += nodeIdx[slot * 2 + 1]! - nodeIdx[slot * 2]!
    }
    const parent = typeof cur.parentUuid === 'string' && cur.parentUuid ? cur.parentUuid : null
    if (parent === null) break
    const slots = idToSlots.get(parent)
    if (!slots || slots.length === 0) break
    cur = decodeSlot(slots[slots.length - 1]!)
  }
  if (liveIds.size === 0) return buf

  const deadBytes = chainBytes - liveBytes
  if (deadBytes < len >> 1) return buf

  const parts: Buffer[] = []
  let k = 0
  for (let slot = 0; slot < nodeIds.length; slot++) {
    const start = nodeIdx[slot * 2]!
    while (k < keepRanges.length && keepRanges[k]! < start) {
      parts.push(buf.subarray(keepRanges[k]!, keepRanges[k + 1]!))
      k += 2
    }
    if (liveIds.has(nodeIds[slot]!)) {
      parts.push(buf.subarray(start, nodeIdx[slot * 2 + 1]!))
    }
  }
  while (k < keepRanges.length) {
    parts.push(buf.subarray(keepRanges[k]!, keepRanges[k + 1]!))
    k += 2
  }
  return Buffer.concat(parts)
}

const METADATA_TYPE_MARKERS = [
  '"metaKind":"summary"',
  '"metaKind":"custom-title"',
  '"metaKind":"tag"',
  '"metaKind":"agent-name"',
  '"metaKind":"agent-color"',
  '"metaKind":"agent-setting"',
  '"metaKind":"mode"',
  '"metaKind":"worktree-state"',
  '"metaKind":"pr-link"',
]
const METADATA_MARKER_BUFS = METADATA_TYPE_MARKERS.map(m => Buffer.from(m))
const RECORD_CARRY_PREFIX = Buffer.from('{"schemaVersion":')
const PRE_BOUNDARY_METADATA_KINDS = new Set(
  METADATA_TYPE_MARKERS.map(m => /"metaKind":"([^"]+)"/.exec(m)![1]!),
)
const METADATA_PREFIX_BOUND = 25
