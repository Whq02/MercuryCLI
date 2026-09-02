// ============================================================================
//  sessionStorage/vnext — the transcript FORMAT owner.
//
//  Every transcript file is the Mercury record format:
//    · a NEW file opens with a header record (session-meta, metaKind
//      'mercury-transcript-header') and every line is a versioned
//      MercuryRecord envelope (src/fabric) — serialized at the enqueue
//      seams, so immutable publication, settle-swap, and O(new) append hold;
//    · every line is SELF-DESCRIBING — the read seam (fabric/
//      transcriptDecode) projects record lines to the in-memory entry shape
//      through the codec's proven inverse, so every reader keeps one fold.
//
//  A09 — store-level ordinal allocation: per-file, restart-safe. A resumed
//  file recovers floor(max tail ordinal)+1 from its last parseable records
//  (an interrupted tail line parses back to the previous complete record —
//  C11's interrupted+resumed law); allocation is monotonic within the
//  process for concurrent enqueues.
// ============================================================================
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { getIsNonInteractiveSession, getSessionId } from '../../bootstrap/state.js'
import { entryToRecord, type EncodeContext } from '../../fabric/entryCodec.js'
import { nextOrdinal, asOrdinal, type Ordinal } from '../../fabric/ordinal.js'
import type { MercuryRecord } from '../../fabric/record.js'
import type { SessionId } from '../../types/ids.js'
import { jsonStringify } from '../slowOperations.js'

const TAIL_BYTES = 256 * 1024

type FileState = { nextValue: number; headerPending: boolean; unterminatedTail: boolean }

const fileStates = new Map<string, FileState>()

/** @internal Reset the per-file allocation/header cache (testing). */
export function resetTranscriptFormatCacheForTesting(): void {
  fileStates.clear()
}

/** Max published ordinal recovered from the file tail (restart-safe A09):
 *  walk the last complete lines backwards for the first parseable record.
 *  A window that yields NO parseable record proves nothing while it is
 *  partial — a single record larger than the window tears at the cut, and
 *  reading that tear as "unrecoverable" collapses the floor to 1 and
 *  re-issues published ordinals. Widen until a record parses or the window
 *  is the whole file (a torn fragment can never parse as a record, so a
 *  hit in a wider window is always a real line). */
function recoverTailOrdinalFloor(fd: number, size: number): number {
  for (let len = Math.min(size, TAIL_BYTES); ; len = Math.min(size, len * 4)) {
    const buf = Buffer.allocUnsafe(len)
    const read = readSync(fd, buf, 0, len, size - len)
    const lines = buf.subarray(0, read).toString('utf8').split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        const ord = parsed.updateOrdinal ?? parsed.creationOrdinal
        if (typeof ord === 'string' && ord.length > 0 && Number.isFinite(Number(ord))) {
          return Math.floor(Number(ord))
        }
      } catch {
        // an interrupted tail line — keep walking (C11)
      }
    }
    if (len >= size) return 1 // whole file read: genuinely header-only/unrecoverable
  }
}

/** Resolve (and cache) the per-file allocation state. A fresh/empty file
 *  owes the header; an existing file recovers its ordinal floor from the
 *  tail. */
function stateFor(fullPath: string): FileState {
  const cached = fileStates.get(fullPath)
  if (cached) return cached
  let resolved: FileState
  let fd: number | null = null
  try {
    fd = openSync(fullPath, 'r')
    const { size } = fstatSync(fd)
    if (size === 0) {
      resolved = { nextValue: 1, headerPending: true, unterminatedTail: false }
    } else {
      // The terminator is only ever written as a SUFFIX, so a torn tail (a
      // kill mid-append, a truncated copy) leaves the final record without
      // its newline — and the next append would splice onto it, turning a
      // record that parsed before the resume into one that does not
      // (FC-016). Read the last byte while the fd is open; the first
      // encoded line after resume heals the tear with one leading newline.
      const lastByte = Buffer.alloc(1)
      readSync(fd, lastByte, 0, 1, size - 1)
      resolved = {
        nextValue: recoverTailOrdinalFloor(fd, size) + 1,
        headerPending: false,
        unterminatedTail: lastByte[0] !== 0x0a,
      }
    }
  } catch {
    // Missing file: fresh — the first write lands the header.
    resolved = { nextValue: 1, headerPending: true, unterminatedTail: false }
  } finally {
    if (fd !== null) closeSync(fd)
  }
  fileStates.set(fullPath, resolved)
  return resolved
}

function allocate(state: { nextValue: number }): Ordinal {
  const ord = nextOrdinal(state.nextValue <= 1 ? null : asOrdinal(String(state.nextValue - 1)))
  state.nextValue = Math.floor(Number(ord)) + 1
  return ord
}

function encodeContext(state: { nextValue: number }): EncodeContext {
  return {
    sessionId: getSessionId() as string as SessionId,
    nextOrdinal: () => allocate(state),
    observedAt: new Date().toISOString(),
    source: getIsNonInteractiveSession() ? { channel: 'sdk' } : { channel: 'interactive' },
  }
}

export type EncodedTranscriptLine = {
  /** The serialized line(s) to append — includes the file header on the
   *  first write to a fresh file. */
  line: string
  /** The published record — settlement lineage input. */
  record: MercuryRecord
}

/**
 * Serialize one transcript entry for `fullPath` as a versioned MercuryRecord
 * line (derive-don't-move — the entry spellings ride the record and project
 * back byte-faithfully).
 */
export function encodeTranscriptLine(
  fullPath: string,
  entry: Record<string, unknown>,
  opts?: {
    /** Settlement re-publication: preserve the original creation ordinal
     *  and mark the record as updating its own published identity (C09). */
    settleCreationOrdinal?: string
  },
): EncodedTranscriptLine {
  const state = stateFor(fullPath)
  const ctx = encodeContext(state)
  let prefix = ''
  if (state.unterminatedTail) {
    // One-shot tear heal (FC-016): terminate the torn last record so it
    // parses again and this line starts clean.
    state.unterminatedTail = false
    prefix = '\n'
  }
  if (state.headerPending) {
    state.headerPending = false
    const header = entryToRecord(
      { type: 'mercury-transcript-header', fileVersion: 1, format: 'mercury-records' },
      ctx,
    )
    prefix = jsonStringify(header) + '\n'
  }
  const record = entryToRecord(entry, ctx)
  if (opts?.settleCreationOrdinal) {
    record.creationOrdinal = asOrdinal(opts.settleCreationOrdinal)
    record.updates = record.recordId
  }
  return { line: prefix + jsonStringify(record) + '\n', record }
}
