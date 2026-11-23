import { transcriptLinesInReverse } from './transcriptBytes.js'
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { getIsNonInteractiveSession, getSessionId } from '../../boot/process-state/processState.js'
import { entryToRecord, type EncodeContext } from '../fabric/entryCodec.js'
import { nextOrdinal, asOrdinal, type Ordinal } from '../fabric/ordinal.js'
import type { MercuryRecord } from '../fabric/record.js'
import type { SessionId } from './ids.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage, getErrnoCode } from '../../platform/errors/errors.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { setStoreHealth, transcriptStoreHealth } from './writer/storeHealth.js'


type FileState = { nextValue: number; headerPending: boolean; unterminatedTail: boolean }

const fileStates = new Map<string, FileState>()
const reportedReadFailures = new Set<string>()

export function resetTranscriptFormatCacheForTesting(): void {
  fileStates.clear()
  reportedReadFailures.clear()
}

function recoverTailOrdinalFloor(fd: number, size: number): number {
  for (const bytes of transcriptLinesInReverse('', 0, size, fd)) {
    const line = bytes.toString('utf8').trim()
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const ord = parsed.updateOrdinal ?? parsed.creationOrdinal
      if (typeof ord === 'string' && ord.length > 0 && Number.isFinite(Number(ord))) return Math.floor(Number(ord))
    } catch (error) { passedOver(error) }
  }
  return 1
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
  } catch (error) {
    const code = getErrnoCode(error)
    resolved = { nextValue: 1, headerPending: true, unterminatedTail: false }
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logForDebugging(`transcript state read failed for ${fullPath} (${code ?? 'unknown'})`, { level: 'error' })
      if (!reportedReadFailures.has(fullPath)) {
        reportedReadFailures.add(fullPath)
        if (!transcriptStoreHealth().failing) {
          setStoreHealth({
            failing: true,
            sentence: `Session transcript at ${fullPath} could not be read (${errorMessage(error)}), so new messages may be saved out of order — restore read permission on the file.`,
          })
        }
      }
      return resolved
    }
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

type EncodedTranscriptLine = {
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
