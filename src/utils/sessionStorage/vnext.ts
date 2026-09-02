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

export function resetTranscriptFormatCacheForTesting(): void {
  fileStates.clear()
}

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
      }
    }
    if (len >= size) return 1
  }
}

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
      const lastByte = Buffer.alloc(1)
      readSync(fd, lastByte, 0, 1, size - 1)
      resolved = {
        nextValue: recoverTailOrdinalFloor(fd, size) + 1,
        headerPending: false,
        unterminatedTail: lastByte[0] !== 0x0a,
      }
    }
  } catch {
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
  line: string
  record: MercuryRecord
}

export function encodeTranscriptLine(
  fullPath: string,
  entry: Record<string, unknown>,
  opts?: {
    settleCreationOrdinal?: string
  },
): EncodedTranscriptLine {
  const state = stateFor(fullPath)
  const ctx = encodeContext(state)
  let prefix = ''
  if (state.unterminatedTail) {
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
