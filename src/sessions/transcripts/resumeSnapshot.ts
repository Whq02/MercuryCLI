import { constants as bufferLimits } from 'node:buffer'
import { historyHead } from './historyParts.js'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { durableAtomicPublishSync } from '../../platform/substrate/durablePublish.js'
import { flagEnabled } from '../../platform/substrate/flagRegistry.js'
import { jsonParse, jsonStringify } from '../../platform/logs/slowOperations.js'
import { emptyFoldState, type TranscriptFoldState } from './fold.js'
import { createTranscriptRows, transcriptRowOrder } from './rowGraph.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export const SNAPSHOT_SCHEMA = 7
const DIGEST_TAIL_BYTES = 4096
export const SNAPSHOT_MIN_BYTES = 256 * 1024

export function resumeSnapshotEnabled(): boolean {
  return flagEnabled('MERCURY_RESUME_SNAPSHOT')
}

export const snapshotPathFor = (transcriptPath: string): string =>
  `${transcriptPath}.resume-snapshot.json`

function digestPrefixTail(filePath: string, cursor: number): string {
  const start = Math.max(0, cursor - DIGEST_TAIL_BYTES)
  const len = cursor - start
  const buf = Buffer.allocUnsafe(len)
  const fd = openSync(filePath, 'r')
  try {
    let read = 0
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read)
      if (n === 0) break
      read += n
    }
    return createHash('sha256').update(buf.subarray(0, read)).digest('hex')
  } finally {
    closeSync(fd)
  }
}

type SerializedFold = Record<string, unknown>

function serializeFold(st: TranscriptFoldState): SerializedFold {
  const out: SerializedFold = {}
  for (const [k, v] of Object.entries(st)) {
    out[k] = v instanceof Map ? { '«map»': [...v.entries()] } : v
  }
  return out
}

function isSerializedMap(value: unknown): value is { '«map»': [unknown, unknown][] } {
  return value !== null && typeof value === 'object' && '«map»' in value
}

function restoreMap<K, V>(raw: SerializedFold, key: string, fallback: Map<K, V>): Map<K, V> {
  if (!(key in raw)) return fallback
  const v = raw[key]
  return isSerializedMap(v) ? new Map(v['«map»'] as [K, V][]) : (v as Map<K, V>)
}

function deserializeFold(raw: SerializedFold, order: string[]): TranscriptFoldState {
  const st = emptyFoldState()
  return {
    messages: !('messages' in raw)
      ? st.messages
      : isSerializedMap(raw.messages)
        ? createTranscriptRows(
            raw.messages['«map»'] as Parameters<typeof createTranscriptRows>[0],
            order as Parameters<typeof createTranscriptRows>[1],
          )
        : (raw.messages as TranscriptFoldState['messages']),
    summaries: restoreMap(raw, 'summaries', st.summaries),
    customTitles: restoreMap(raw, 'customTitles', st.customTitles),
    tags: restoreMap(raw, 'tags', st.tags),
    agentNames: restoreMap(raw, 'agentNames', st.agentNames),
    agentColors: restoreMap(raw, 'agentColors', st.agentColors),
    agentSettings: restoreMap(raw, 'agentSettings', st.agentSettings),
    sessionBriefs: restoreMap(raw, 'sessionBriefs', st.sessionBriefs),
    sessionBriefAdds: restoreMap(raw, 'sessionBriefAdds', st.sessionBriefAdds),
    prNumbers: restoreMap(raw, 'prNumbers', st.prNumbers),
    prUrls: restoreMap(raw, 'prUrls', st.prUrls),
    prRepositories: restoreMap(raw, 'prRepositories', st.prRepositories),
    modes: restoreMap(raw, 'modes', st.modes),
    advisorSwitches: restoreMap(raw, 'advisorSwitches', st.advisorSwitches),
    swarmSwitches: restoreMap(raw, 'swarmSwitches', st.swarmSwitches),
    sessionModels: restoreMap(raw, 'sessionModels', st.sessionModels),
    worktreeStates: restoreMap(raw, 'worktreeStates', st.worktreeStates),
    fileHistorySnapshots: restoreMap(raw, 'fileHistorySnapshots', st.fileHistorySnapshots),
    attributionSnapshots: restoreMap(raw, 'attributionSnapshots', st.attributionSnapshots),
    contentReplacements: restoreMap(raw, 'contentReplacements', st.contentReplacements),
    agentContentReplacements: restoreMap(raw, 'agentContentReplacements', st.agentContentReplacements),
    contextCollapseCommits: 'contextCollapseCommits' in raw
      ? (raw.contextCollapseCommits as TranscriptFoldState['contextCollapseCommits'])
      : st.contextCollapseCommits,
    contextCollapseSnapshot: 'contextCollapseSnapshot' in raw
      ? (raw.contextCollapseSnapshot as TranscriptFoldState['contextCollapseSnapshot'])
      : st.contextCollapseSnapshot,
    turnEnds: restoreMap(raw, 'turnEnds', st.turnEnds),
    turnsOpen: restoreMap(raw, 'turnsOpen', st.turnsOpen),
    progressBridge: restoreMap(raw, 'progressBridge', st.progressBridge),
  }
}

export function writeResumeSnapshot(
  transcriptPath: string,
  fold: TranscriptFoldState,
  byteCursor: number,
): void {
  try {
    const payload = jsonStringify({
      schemaVersion: SNAPSHOT_SCHEMA,
      byteCursor,
      historyPart: historyHead(transcriptPath).boundary,
      prefixDigest: digestPrefixTail(transcriptPath, byteCursor),
      fold: serializeFold(fold),
      order: transcriptRowOrder(fold.messages),
    })
    durableAtomicPublishSync(snapshotPathFor(transcriptPath), payload)
  } catch (error) {
    passedOver(error)
  }
}

type SnapshotHit = {
  fold: TranscriptFoldState
  tail: Buffer
  byteCursor: number
  fileSize: number
}

export async function tryLoadResumeSnapshot(transcriptPath: string, streamTail = false): Promise<SnapshotHit | null> {
  if (!resumeSnapshotEnabled()) return null
  const snapPath = snapshotPathFor(transcriptPath)
  if (!existsSync(snapPath)) return null
  try {
    if (statSync(snapPath).size > bufferLimits.MAX_STRING_LENGTH) return null
    const raw = jsonParse(await readFile(snapPath, 'utf8')) as {
      schemaVersion?: number
      byteCursor?: number
      historyPart?: string
      prefixDigest?: string
      fold?: SerializedFold
      order?: unknown
    } | null
    if (!raw || raw.schemaVersion !== SNAPSHOT_SCHEMA) return null
    const cursor = raw.byteCursor
    if (typeof cursor !== 'number' || cursor <= 0 || !raw.fold || !raw.prefixDigest) return null
    if (!Array.isArray(raw.order) || !raw.order.every(id => typeof id === 'string')) return null
    const order = raw.order as string[]
    if (raw.historyPart !== historyHead(transcriptPath).boundary) return null
    const { size } = statSync(transcriptPath)
    if (size < cursor) return null
    if (digestPrefixTail(transcriptPath, cursor) !== raw.prefixDigest) return null
    const tailLen = size - cursor
    if (streamTail) return { fold: deserializeFold(raw.fold, order), tail: Buffer.alloc(0), byteCursor: cursor, fileSize: size }
    if (tailLen > 5 * 1024 * 1024) return null
    const tail = Buffer.allocUnsafe(tailLen)
    const fd = openSync(transcriptPath, 'r')
    let read = 0
    try {
      while (read < tailLen) {
        const n = readSync(fd, tail, read, tailLen - read, cursor + read)
        if (n === 0) break
        read += n
      }
    } finally {
      closeSync(fd)
    }
    if (read < tailLen) return null
    return {
      fold: deserializeFold(raw.fold, order),
      tail,
      byteCursor: cursor,
      fileSize: size,
    }
  } catch (error) {
    passedOver(error)
    return null
  }
}
