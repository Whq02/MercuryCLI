
import type { UUID } from 'crypto'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd, getSessionProjectDir } from '../../bootstrap/state.js'
import { decodeTranscriptBuffer } from '../../fabric/transcriptDecode.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/featureGates.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  Entry,
  FileHistorySnapshotMessage,
  PersistedWorktreeSession,
  TranscriptMessage,
} from '../../types/logs.js'
import { logForDebugging } from '../debug.js'
import { logError } from '../log.js'
import { isCompactBoundaryMessage } from '../messages.js'
import { parseJSONL } from '../json.js'
import {
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from '../sessionStoragePortable.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import {
  applyPreservedSegmentRelinks,
  applySnipRemovals,
} from './chain.js'
import {
  getProjectDir,
  isPersistedProgressEntry,
  isTranscriptMessage,
} from './paths.js'
import {
  resumeSnapshotEnabled,
  SNAPSHOT_MIN_BYTES,
  tryLoadResumeSnapshot,
  writeResumeSnapshot,
} from './resumeSnapshot.js'

export type TranscriptFoldState = {
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  progressBridge: Map<UUID, UUID | null>
}

type TranscriptLoadResult = Omit<TranscriptFoldState, 'progressBridge'> & {
  leafUuids: Set<UUID>
}

export function emptyFoldState(): TranscriptFoldState {
  return {
    messages: new Map(),
    summaries: new Map(),
    customTitles: new Map(),
    tags: new Map(),
    agentNames: new Map(),
    agentColors: new Map(),
    agentSettings: new Map(),
    prNumbers: new Map(),
    prUrls: new Map(),
    prRepositories: new Map(),
    modes: new Map(),
    worktreeStates: new Map(),
    fileHistorySnapshots: new Map(),
    attributionSnapshots: new Map(),
    contentReplacements: new Map(),
    agentContentReplacements: new Map(),
    contextCollapseCommits: [],
    contextCollapseSnapshot: undefined,
    progressBridge: new Map(),
  }
}

export function applyTranscriptEntry(st: TranscriptFoldState, entry: Entry): void {
  const {
    messages, summaries, customTitles, tags, agentNames, agentColors,
    agentSettings, prNumbers, prUrls, prRepositories, modes, worktreeStates,
    fileHistorySnapshots, attributionSnapshots, contentReplacements,
    agentContentReplacements, contextCollapseCommits, progressBridge,
  } = st

  if (isPersistedProgressEntry(entry)) {
    const parent = entry.parentUuid
    progressBridge.set(
      entry.uuid,
      parent && progressBridge.has(parent)
        ? (progressBridge.get(parent) ?? null)
        : parent,
    )
    return
  }
  if (isTranscriptMessage(entry)) {
    if (entry.parentUuid && progressBridge.has(entry.parentUuid)) {
      entry.parentUuid = progressBridge.get(entry.parentUuid) ?? null
    }
    messages.set(entry.uuid, entry)
    if (isCompactBoundaryMessage(entry)) {
      contextCollapseCommits.length = 0
      st.contextCollapseSnapshot = undefined
    }
  } else if (entry.type === 'summary' && entry.leafUuid) {
    summaries.set(entry.leafUuid, entry.summary)
  } else if (entry.type === 'custom-title' && entry.sessionId) {
    customTitles.set(entry.sessionId, entry.customTitle)
  } else if (entry.type === 'tag' && entry.sessionId) {
    tags.set(entry.sessionId, entry.tag)
  } else if (entry.type === 'agent-name' && entry.sessionId) {
    agentNames.set(entry.sessionId, entry.agentName)
  } else if (entry.type === 'agent-color' && entry.sessionId) {
    agentColors.set(entry.sessionId, entry.agentColor)
  } else if (entry.type === 'agent-setting' && entry.sessionId) {
    agentSettings.set(entry.sessionId, entry.agentSetting)
  } else if (entry.type === 'mode' && entry.sessionId) {
    modes.set(entry.sessionId, entry.mode)
  } else if (entry.type === 'worktree-state' && entry.sessionId) {
    worktreeStates.set(entry.sessionId, entry.worktreeSession)
  } else if (entry.type === 'pr-link' && entry.sessionId) {
    prNumbers.set(entry.sessionId, entry.prNumber)
    prUrls.set(entry.sessionId, entry.prUrl)
    prRepositories.set(entry.sessionId, entry.prRepository)
  } else if (entry.type === 'file-history-snapshot') {
    fileHistorySnapshots.set(entry.messageId, entry)
  } else if (entry.type === 'attribution-snapshot') {
    attributionSnapshots.set(entry.messageId, entry)
  } else if (entry.type === 'content-replacement') {
    if (entry.agentId) {
      const existing = agentContentReplacements.get(entry.agentId) ?? []
      agentContentReplacements.set(entry.agentId, existing)
      existing.push(...entry.replacements)
    } else {
      const existing = contentReplacements.get(entry.sessionId) ?? []
      contentReplacements.set(entry.sessionId, existing)
      existing.push(...entry.replacements)
    }
  } else if (entry.type === 'marble-origami-commit') {
    contextCollapseCommits.push(entry)
  } else if (entry.type === 'marble-origami-snapshot') {
    st.contextCollapseSnapshot = entry
  }
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

export async function loadTranscriptFile(
  filePath: string,
  opts?: { keepAllLeaves?: boolean },
): Promise<TranscriptLoadResult> {
  let foldState = emptyFoldState()
  let snapshotCovered = false

  try {
    if (!opts?.keepAllLeaves) {
      const hit = await tryLoadResumeSnapshot(filePath)
      if (hit) {
        const decodedTail = decodeTranscriptBuffer<Entry>(hit.tail)
        if (decodedTail.refusal) {
          logError(new Error(`${decodedTail.refusal}: ${filePath} (snapshot tail — reloading the file whole)`))
          noteLoadDegradation({ path: filePath, malformed: 0, invalid: 0, totalLines: decodedTail.totalLines, refusal: decodedTail.refusal })
        } else {
          foldState = hit.fold
          const degraded = decodedTail.malformed.length > 0 || decodedTail.invalid.length > 0
          if (degraded) {
            logError(
              new Error(
                `transcript tail degraded on snapshot resume: ${decodedTail.malformed.length} malformed, ${decodedTail.invalid.length} invalid of ${decodedTail.totalLines}`,
              ),
            )
            noteLoadDegradation({ path: filePath, malformed: decodedTail.malformed.length, invalid: decodedTail.invalid.length, totalLines: decodedTail.totalLines, refusal: null })
          }
          for (const entry of decodedTail.entries) {
            applyTranscriptEntry(foldState, entry)
          }
          snapshotCovered = true
          if (!degraded && hit.tail.length > 1024 * 1024) {
            writeResumeSnapshot(filePath, foldState, hit.fileSize)
          }
        }
      }
    }

    if (!snapshotCovered) {
      let buf: Buffer | null = null
      let metadataLines: string[] | null = null
      let hasPreservedSegment = false
      let snapshotCursor: number | null = null
      {
        const { size } = await stat(filePath)
        snapshotCursor = size
        if (size > SKIP_PRECOMPACT_THRESHOLD) {
          const scan = await readTranscriptForLoad(filePath, size)
          buf = scan.postBoundaryBuf
          hasPreservedSegment = scan.hasPreservedSegment
          if (scan.boundaryStartOffset > 0) {
            metadataLines = await scanPreBoundaryMetadata(
              filePath,
              scan.boundaryStartOffset,
            )
          }
        }
      }
      if (buf === null) {
        if (snapshotCursor === null) {
          try {
            snapshotCursor = (await stat(filePath)).size
          } catch {
            snapshotCursor = null
          }
        }
        buf = await readFile(filePath)
        if (snapshotCursor !== null && buf.length < snapshotCursor) {
          snapshotCursor = null
        }
      }
      if (
        !opts?.keepAllLeaves &&
        !hasPreservedSegment &&
        buf.length > SKIP_PRECOMPACT_THRESHOLD
      ) {
        buf = pruneRecordBranchesBeforeParse(buf)
      }

      if (metadataLines && metadataLines.length > 0) {
        const metaEntries = parseJSONL<Entry>(
          Buffer.from(metadataLines.join('\n')),
        )
        for (const entry of metaEntries) {
          if (PRE_BOUNDARY_METADATA_KINDS.has(entry.type)) {
            applyTranscriptEntry(foldState, entry)
          }
        }
      }

      const decoded = decodeTranscriptBuffer<Entry>(buf)
      if (decoded.refusal) {
        logError(new Error(`${decoded.refusal}: ${filePath}`))
        noteLoadDegradation({ path: filePath, malformed: 0, invalid: 0, totalLines: decoded.totalLines, refusal: decoded.refusal })
        const { progressBridge: _refused, ...empty } = emptyFoldState()
        return { ...empty, leafUuids: new Set<UUID>() }
      }
      const entries = decoded.entries
      if (decoded.malformed.length > 0 || decoded.invalid.length > 0) {
        logError(
          new Error(
            `transcript degraded on load: ${decoded.malformed.length} malformed line(s), ` +
              `${decoded.invalid.length} invalid-shape record(s) of ${decoded.totalLines} ` +
              `(first: ${decoded.malformed[0] ? `line ${decoded.malformed[0].line}` : `#${decoded.invalid[0]?.index} ${decoded.invalid[0]?.reason}`})`,
          ),
        )
        noteLoadDegradation({ path: filePath, malformed: decoded.malformed.length, invalid: decoded.invalid.length, totalLines: decoded.totalLines, refusal: null })
      }

      for (const entry of entries) {
        applyTranscriptEntry(foldState, entry)
      }

      if (
        !opts?.keepAllLeaves &&
        resumeSnapshotEnabled() &&
        snapshotCursor !== null &&
        snapshotCursor >= SNAPSHOT_MIN_BYTES
      ) {
        writeResumeSnapshot(filePath, foldState, snapshotCursor)
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logError(
        new Error(
          `transcript load failed for ${filePath}; continuing with partial state: ${e}`,
        ),
      )
    }
  }

  const { progressBridge: _internal, ...publicFold } = foldState

  applyPreservedSegmentRelinks(publicFold.messages)
  applySnipRemovals(publicFold.messages)

  return {
    ...publicFold,
    leafUuids: computeResumeLeaves(publicFold.messages),
  }
}

function computeResumeLeaves(
  messages: Map<UUID, TranscriptMessage>,
): Set<UUID> {
  const allMessages = [...messages.values()]

  const parentUuids = new Set(
    allMessages
      .map(msg => msg.parentUuid)
      .filter((uuid): uuid is UUID => uuid !== null),
  )
  const terminalMessages = allMessages.filter(msg => !parentUuids.has(msg.uuid))

  const pruneMidConversation = getFeatureValue_CACHED_MAY_BE_STALE(
    'mercury_pebble_leaf_prune',
    false,
  )
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
      current = current.parentUuid
        ? messages.get(current.parentUuid)
        : undefined
    }
  }

  if (hasCycle) {
    logForDebugging('cycle detected during resume-leaf computation', {
      level: 'warn',
    })
  }

  return leafUuids
}

export async function loadSessionFile(sessionId: UUID): Promise<{
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentSettings: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotMessage>
  attributionSnapshots: Map<UUID, AttributionSnapshotMessage>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
}> {
  const sessionFile = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    `${sessionId}.jsonl`,
  )
  return loadTranscriptFile(sessionFile)
}

function resolveMetadataBuf(
  carry: Buffer | null,
  chunkBuf: Buffer,
): Buffer | null {
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
  const firstNl = chunkBuf.indexOf(0x0a)
  return firstNl === -1 ? null : chunkBuf.subarray(firstNl + 1)
}

async function scanPreBoundaryMetadata(
  filePath: string,
  endOffset: number,
): Promise<string[]> {
  const { createReadStream } = await import('fs')
  const NEWLINE = 0x0a

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
  const NEWLINE = 0x0a
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
