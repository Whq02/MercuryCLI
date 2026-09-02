// sessionStorage/loading — the resume read path. One entry fold
// (applyTranscriptEntry) serves both the full parse and the
// snapshot-plus-tail fast path; around it sit the byte-level big-file
// strategies (pre-boundary truncation, metadata recovery scan, dead-branch
// pruning) that keep multi-hundred-MB sessions loadable in tens of ms.
// Mercury-owned.

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

/** Everything the per-entry fold accumulates BEFORE the post-passes
 *  (relinks, snip replay, leaf computation) run. The resume snapshot
 * serializes exactly this shape, so the next load
 *  folds only the appended tail. */
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

/** The fold state minus its internal bridge map, plus the computed leaves —
 *  what loadTranscriptFile hands back. */
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

/** Fold one JSONL entry into the state — the shared body of the full parse
 *  and the snapshot tail-merge, so the two paths cannot diverge. */
export function applyTranscriptEntry(st: TranscriptFoldState, entry: Entry): void {
  const {
    messages, summaries, customTitles, tags, agentNames, agentColors,
    agentSettings, prNumbers, prUrls, prRepositories, modes, worktreeStates,
    fileHistorySnapshots, attributionSnapshots, contentReplacements,
    agentContentReplacements, contextCollapseCommits, progressBridge,
  } = st

  // Persisted progress must be tested FIRST: it is outside the Entry
  // union, so once TypeScript narrows `entry` through the typed branches
  // below, the check would intersect to never.
  if (isPersistedProgressEntry(entry)) {
    // Bridge chains ACROSS progress runs, resolving transitively as lines
    // arrive so a message pointing at the end of a long progress run heals
    // in a single map lookup.
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
    // A compact boundary retires every context-collapse commit before it:
    // those commits reference messages the post-boundary chain no longer
    // holds. The >5MB scan path never reads pre-boundary bytes so the
    // discard is implicit there; the small-file path reads everything and
    // must discard here — otherwise /context's collapsedSpans overcounts
    // from commits that render nothing.
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
    // Two keyspaces on purpose: agentId for sidechain resume, sessionId
    // for /resume of the main thread.
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

// ── the load-degradation fact (FN-013 CRASH-05a) ────────────────────────────
// Malformed and shape-invalid records were classified and the fold
// proceeded on the valid set — but the fact reached logError alone, which
// the operator never sees, and a whole-file refusal returned an EMPTY fold
// silently: a session could resume as if it had no history and nobody was
// told. The classification now ALSO latches this small subscribable fact
// (the writer's store-health pattern); the chat's boot effect paints it as
// one sticky notification. Latched, not consumed: the surface reads the
// current fact at mount and subscribes for later loads. The repair half
// (quarantine + rewrite) is the split's deferred sibling — nothing here
// touches bytes.

export type TranscriptLoadDegradation = {
  path: string
  malformed: number
  invalid: number
  totalLines: number
  /** The whole-file refusal sentence when the load resumed EMPTY; null for
   *  a partial degradation (the valid records loaded). */
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
      /* a listener must never break a load */
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

/** TEST-ONLY: reset the latch (proof harnesses). */
export function _resetTranscriptLoadDegradationForTesting(): void {
  loadDegradation = null
}

/**
 * Read one transcript file into a fold state plus computed resume leaves.
 * The absent-file case resolves to an empty result by design (a fresh
 * session has no file yet); any OTHER failure still resolves — resume must
 * degrade, not crash — but is logged with its cause first.
 *
 * Strategy ladder, fastest first:
 *   1. snapshot + tail — deserialize the persisted
 *      fold, parse only bytes appended since; any invalidation (truncation,
 *      prefix rewrite, corruption, schema drift, kill switch) falls through;
 *   2. big files: fd-level pre-boundary truncation + a byte scan that
 *      recovers pre-boundary session metadata, then (when no preserved
 *      segment forbids it) dead-branch pruning before the JSON parse;
 *   3. plain full read.
 */
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
          // The tail's FIRST line is not a record line, so the decoder
          // refused the whole tail — but the tail is a mid-file slice, and
          // record lines past that first line are still the user's
          // history (the plain road classifies per line and folds them).
          // Keeping the covered fold and skipping the tail here — and
          // worse, refreshing the snapshot over it — left that stretch
          // permanently unread on every later resume while the bytes sat
          // intact on disk (release-hardening audit rank 51). Say so, and
          // fall through to the plain roads.
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
          // A materially grown tail earns a refreshed snapshot behind the
          // load, keeping the NEXT resume O(new tail) rather than
          // O(everything since the last snapshot) — only when the tail
          // folded CLEAN: a cursor published over degraded lines would
          // bake their loss into every later resume.
          if (!degraded && hit.tail.length > 1024 * 1024) {
            writeResumeSnapshot(filePath, foldState, hit.fileSize)
          }
        }
      }
    }

    if (!snapshotCovered) {
      // Large sessions must not materialize their stale majority. The
      // chunked fd read skips attribution-snapshot lines before they ever
      // reach a buffer and truncates at the last compact boundary
      // in-stream, so peak allocation tracks the OUTPUT, not the file
      // (measured: a 151 MB file that is 84% stale attr-snaps peaks ~32 MB
      // here vs ~316 MB RSS on the old read-then-strip path — the
      // allocator never returns those pages even after GC frees them).
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
          // boundaryStartOffset > 0 means bytes were truncated away and
          // the session-scoped metadata that lived there (mode, pr-link,
          // agent-*) must be recovered by the cheap byte scan. A
          // preservedSegment boundary does not truncate — preserved
          // messages sit physically before it — so the offset stays 0
          // unless an EARLIER plain boundary truncated, in which case the
          // preserved lines were post-that-boundary and survived anyway.
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
          // Shrunk between stat and read (a tombstone rewrite) — the
          // cursor no longer describes a stable prefix; don't cover it.
          snapshotCursor = null
        }
      }
      // Dead-branch pruning earns its keep only on big buffers (the
      // readTranscriptForLoad output; small files fall through). Skipped
      // when the caller wants every leaf (/insights picks branches by
      // message count, not recency) and when a preserved segment exists —
      // preserved lines carry pre-compact parentUuids on disk and only
      // applyPreservedSegmentRelinks (post-parse) makes them reachable, so
      // a pre-parse walk would prune them as dead.
      if (
        !opts?.keepAllLeaves &&
        !hasPreservedSegment &&
        buf.length > SKIP_PRECOMPACT_THRESHOLD
      ) {
        buf = pruneRecordBranchesBeforeParse(buf)
      }

      // Recovered pre-boundary metadata folds first; the post-boundary
      // buffer may re-state some of it, and later values winning is the
      // correct outcome for session-scoped maps.
      if (metadataLines && metadataLines.length > 0) {
        const metaEntries = parseJSONL<Entry>(
          Buffer.from(metadataLines.join('\n')),
        )
        for (const entry of metaEntries) {
          // Metadata kinds ONLY. The byte scanner can false-positive on a
          // marker string INSIDE message content — such a line must stay
          // inert here; a pre-boundary message resurrecting through the
          // metadata pass would corrupt the chain.
          if (PRE_BOUNDARY_METADATA_KINDS.has(entry.type)) {
            applyTranscriptEntry(foldState, entry)
          }
        }
      }

      // The validating read seam: every line is accounted
      // for — malformed and shape-invalid records are CLASSIFIED, the fold
      // proceeds on the valid set, and the degradation surfaces exactly
      // once per load. A file that is not in the record format is refused
      // whole: one honest line, an empty fold, never a crash.
      const decoded = decodeTranscriptBuffer<Entry>(buf)
      if (decoded.refusal) {
        logError(new Error(`${decoded.refusal}: ${filePath}`))
        // The refusal is STATED in-session (CRASH-05a): the session is
        // about to resume EMPTY of its prior records, and silence here was
        // the defect.
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

      // Write-behind: pay the serialization now so the NEXT
      // resume is O(tail). The cursor is the size captured BEFORE reading —
      // an append racing this load lands past it and folds in as tail.
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
    // Missing file = a session that has not written yet: quiet, empty
    // result. Anything else still degrades to whatever folded so far —
    // resume must not crash — but says why first.
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

/**
 * Resume anchors, computed once per load. Only user/assistant messages may
 * anchor a resume — system/attachment entries are bookkeeping — so from
 * every terminal message (no children) the walk backs up to the nearest
 * user/assistant ancestor.
 *
 * Behind the pebble-prune gate, an ancestor that already has a
 * user/assistant CHILD is skipped: the conversation demonstrably continued
 * through it (e.g. a tool_use assistant whose progress child is terminal
 * but whose tool_result child carries on), so it is a mid-chain node, not
 * a leaf.
 */
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
    // The walk guarded itself; say so once — a cyclic chain means a writer
    // bug upstream and silent tolerance would bury it.
    logForDebugging('cycle detected during resume-leaf computation', {
      level: 'warn',
    })
  }

  return leafUuids
}

/** Resolve a sessionId to its transcript in the current project tree and
 *  load it. */
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

// Carry-resolution for the metadata scanner: null carry = the previous
// chunk ended mid-line inside content we already know is not metadata.
// A short carry might still grow into the record-envelope prefix, so it
// concatenates; a long carry concatenates only when it opens with the
// envelope key (metaKind sits deeper in the line).
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

/**
 * Byte-level forward scan of [0, endOffset) that collects ONLY
 * metadata-entry lines. No readline, no string decode for the ~99% of
 * bytes that are message content: a chunk containing zero marker bytes is
 * skipped whole, and line splitting happens only around actual matches.
 */
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
        // Marker check bounded to this line's bytes.
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
      // Nothing here — keep only the unterminated trailing line.
      const lastNl = buf.lastIndexOf(NEWLINE)
      carry = lastNl >= 0 ? buf.subarray(lastNl + 1) : buf
    }

    // A newline-free multi-MB tool-output line would otherwise grow the
    // carry quadratically. Real metadata entries stay under 1 KB, so a
    // 64 KB carry is provably mid-content — drop it.
    if (carry.length > 64 * 1024) carry = null
  }

  // The final line may end at endOffset without a newline.
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

// ── dead-branch pruning (byte level, before any full parse) ─────────────────

// Every record line opens with the envelope's first two keys in compact
// serialization; recordId (== the entry uuid, the identity law) sits at a
// FIXED offset. A raw double-quote cannot occur inside a JSON string value,
// and content newlines serialize escaped, so this prefix at line start is
// structural — content can never forge it.
const RECORD_LINE_PREFIX = Buffer.from('{"schemaVersion":1,"recordId":"')
const PRUNE_KIND_NEEDLE = Buffer.from('"payload":{"kind":"')
/** The envelope's payload key sits after the fixed-shape envelope fields;
 *  a record EMBEDDED inside another record's fields sits past its host's
 *  envelope, beyond this bound. */
const PRUNE_KIND_BOUND = 600
/** Payload kinds whose lines are parentUuid-chain nodes; every other
 *  record kind (session-meta, tool-settlement, receipt, unknown-retained)
 *  is session metadata the fold needs whole. */
const PRUNE_CHAIN_KINDS = new Set(['input', 'output', 'attachment', 'notice', 'boundary', 'progress'])

/**
 * Prune dead fork branches at the byte level, before any full parse.
 *
 * Every rewind/fork strands a branch in the append-only file forever; the
 * fold discards them AFTER parse — by which point the parse has paid for
 * every dead byte. This walk indexes record lines by their FIXED-offset
 * recordId, picks the last non-sidechain conversation row as the live
 * leaf, and walks leaf→root. LINK TRUTH COMES FROM THE PARSED LINE: each
 * hop decodes exactly one line through the real read seam (validate +
 * project) and follows the ENTRY's own parentUuid — byte heuristics only
 * ever choose which single lines to decode, so content that echoes record
 * spellings (a tool result quoting a transcript) can never misroute the
 * walk. Cost: O(live chain) line decodes + native byte scans.
 *
 * Kept: every non-record and metadata-kind line, plus every line of a
 * live-chain recordId (a settled pair keeps both lines). Dropped: chain-
 * node lines no live-leaf walk reaches. Stitching only pays when at least
 * half the buffer is dead chain bytes; anything unexpected (foreign lines,
 * an unparsable leaf, no leaf at all) returns the buffer unchanged.
 */
export function pruneRecordBranchesBeforeParse(buf: Buffer): Buffer {
  const NEWLINE = 0x0a
  const QUOTE = 0x22
  const PREFIX_LEN = RECORD_LINE_PREFIX.length

  // Flat stride-2 line index [start, end) for chain-node lines; keepRanges
  // for everything else (metadata kinds, non-record lines). idToSlots maps
  // recordId → every slot holding a line of that id (settled pairs).
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

  // One line through the REAL read seam: validated record → projected entry.
  const decodeSlot = (slot: number): Record<string, unknown> | null => {
    const d = decodeTranscriptBuffer<Record<string, unknown>>(
      buf.subarray(nodeIdx[slot * 2]!, nodeIdx[slot * 2 + 1]!),
    )
    return d.entries.length === 1 ? d.entries[0]! : null
  }

  // The live leaf: the LAST chain node that decodes to a non-sidechain
  // entry. Every candidate is parse-confirmed — no byte heuristic may pick
  // the leaf, because a skipped legitimate leaf would prune the real tail.
  let leaf: Record<string, unknown> | null = null
  for (let slot = nodeIds.length - 1; slot >= 0; slot--) {
    const e = decodeSlot(slot)
    if (e === null || e.isSidechain === true) continue
    leaf = e
    break
  }
  if (leaf === null) return buf

  // Walk leaf→root along the PARSED entries' parentUuid. A parent absent
  // from the index terminates the walk — normal for post-boundary chains.
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
    // The LAST published line of the parent id carries its settled state.
    cur = decodeSlot(slots[slots.length - 1]!)
  }
  if (liveIds.size === 0) return buf

  // Stitch only when at least half the buffer is dead chain bytes — near
  // break-even the concat memcpy dominates the parse savings.
  const deadBytes = chainBytes - liveBytes
  if (deadBytes < len >> 1) return buf

  // Interleave kept metadata lines with live chain lines in file order —
  // both indexes are already offset-sorted — and concat once.
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

/**
 * Session-scoped entry kinds that must survive a pre-boundary truncation.
 * Held as raw JSON marker strings so the scanner filters lines by bytes:
 * the entry kind travels as `metaKind` on the session-meta record, and
 * collected lines re-decode through the projecting read seam.
 */
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
/** Record lines open with the envelope's first key. */
const RECORD_CARRY_PREFIX = Buffer.from('{"schemaVersion":')
/** The kinds the pre-boundary metadata pass may fold — record lines
 *  re-decode through the read seam before this is consulted. */
const PRE_BOUNDARY_METADATA_KINDS = new Set(
  METADATA_TYPE_MARKERS.map(m => /"metaKind":"([^"]+)"/.exec(m)![1]!),
)
// A carry shorter than this cannot yet rule out the record-envelope prefix.
const METADATA_PREFIX_BOUND = 25
