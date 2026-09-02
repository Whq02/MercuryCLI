// sessionStorage/writer — the append side of session persistence: the
// Project singleton's per-file write queues (serialize-at-enqueue, batched
// drain, one serialized disk chain), the recordTranscript API with
// incremental parent tracking, explicit message settlement,
// the tombstone path, CCRv2 internal-event mirroring, and the sync
// metadata appender. Mercury-owned.
// PRESERVE-CONTRACT: JSONL line BYTES — resume and forensics read them
// back.

import type { UUID } from 'crypto'
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { appendFile as fsAppendFile, mkdir, readFile, stat } from 'fs/promises'
import { basename, dirname } from 'path'
import memoize from 'lodash-es/memoize.js'
import {
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  isSessionPersistenceDisabled,
} from '../../bootstrap/state.js'
import { type AgentId, asAgentId } from '../../types/ids.js'
import type {
  ContentReplacementEntry,
  Entry,
  FileHistorySnapshotMessage,
  PersistedWorktreeSession,
  TranscriptMessage,
} from '../../types/logs.js'
import type { AttributionSnapshotMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import type { QueueOperationMessage } from '../../types/messageQueueTypes.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { registerExitCliffSeam } from '../exitCliffDrain.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { isFsInaccessible } from '../errors.js'
import type { FileHistorySnapshot } from '../fileHistory.js'
import { formatFileSize } from '../format.js'
import { getFsImplementation } from '../fsOperations.js'
import { getBranch } from '../git.js'
import { isShuttingDown } from '../gracefulShutdown.js'
import { logError } from '../log.js'
import { isCompactBoundaryMessage } from '../messages.js'
import {
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
} from '../sessionStoragePortable.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import {
  cleanMessagesForLogging,
  getFirstMeaningfulUserMessageTextContent,
  type Transcript,
} from './chain.js'
import { loadSessionFile } from './loading.js'
import {
  getAgentTranscriptPath,
  getEntrypoint,
  getNodeEnv,
  getTranscriptPath,
  getTranscriptPathForSession,
  getUserType,
  isChainParticipant,
  isTranscriptMessage,
} from './paths.js'
import {
  encodeTranscriptLine,
  resetTranscriptFormatCacheForTesting,
} from './vnext.js'

// MACRO.VERSION read once at module scope — bun's --define does not reach
// async contexts (bun#26168), so the async writers read this const.
const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

// Tombstone slow-path ceiling: that path reads and rewrites the WHOLE file,
// and session files reach multiple GB (inc-3930) — refuse rather than OOM.
const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

/**
 * Memoized sessionId → set of message uuids on disk. The dedup authority
 * for main-session writes; primed opportunistically by getLastSessionLog.
 */
export const getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<UUID>> => {
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  },
  (sessionId: UUID) => sessionId,
)

/**
 * Sidechain destination captured ONCE at agent launch.
 * getAgentTranscriptPath re-derives from the LIVE session identity on
 * every call, so a /clear or cross-session resume mid-agent would split
 * one agent's chain across directories no reader reunites. Launch
 * registers the destination; every later write for that agent routes here.
 * Module-lifetime, one entry per launched agent.
 */
// ── the store-health seam (B15: silent-store-failure disclosure) ───────────
// The correct operator sentence has always existed one screen below
// (describeTranscriptStoreFailure) and only ever reached the debug log —
// the product silently stopped saving the session. The writer publishes a
// tiny subscribable health fact here; the chat raises ONE sticky
// notification carrying the sentence after two consecutive drain failures
// and clears it on the first successful drain (prove-store-failure-surfaces).
export type TranscriptStoreHealth = { failing: boolean; sentence: string | null }
let storeHealth: TranscriptStoreHealth = { failing: false, sentence: null }
const storeHealthListeners = new Set<() => void>()
function setStoreHealth(next: TranscriptStoreHealth): void {
  if (storeHealth.failing === next.failing && storeHealth.sentence === next.sentence) return
  storeHealth = next
  for (const listener of storeHealthListeners) listener()
}
export function transcriptStoreHealth(): TranscriptStoreHealth {
  return storeHealth
}
export function subscribeTranscriptStoreHealth(listener: () => void): () => void {
  storeHealthListeners.add(listener)
  return () => storeHealthListeners.delete(listener)
}

const agentTranscriptDestinations = new Map<string, string>()

export function registerAgentTranscriptDestination(
  agentId: string,
  filePath: string,
): void {
  agentTranscriptDestinations.set(agentId, filePath)
}

/**
 * Per-FILE dedup set for agent sidechain writes, seeded from
 * disk once so a fresh process resuming an agent dedups against what the
 * file already holds. Keyed by file path, not agentId — the destination
 * can shift across sessions. Deliberately separate from the main session's
 * set: fork-inherited parents share uuids with the main transcript and
 * must STILL land in the agent file once.
 */
export const getAgentFileMessages = memoize(
  async (filePath: string): Promise<Set<string>> => {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      return new Set()
    }
    const set = new Set<string>()
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as {
          annotations?: { uuid?: string }
        }
        // Record lines carry the entry uuid in annotations
        // (derive-don't-move).
        const uuid = e.annotations?.uuid
        if (typeof uuid === 'string') set.add(uuid)
      } catch {
        // torn tail line — the reader tolerates it, so the seeder does too
      }
    }
    return set
  },
  (filePath: string) => filePath,
)

let project: Project | null = null
let cleanupRegistered = false

export function getProject(): Project {
  if (!project) {
    project = new Project()

    if (!cleanupRegistered) {
      registerCleanup(async () => {
        // Order matters: flush queued writes, THEN re-append metadata so
        // titles/tags sit inside the bounded tail window the lite reader
        // scans — a /rename followed by enough messages would otherwise
        // push the title entry out and --resume would show the derived
        // firstPrompt instead.
        await project?.flush()
        try {
          project?.reAppendSessionMetadata()
        } catch {
          // exit cleanup must finish even if the re-append cannot
        }
      })
      // The exit cliff's named seam: appends queued AFTER the cleanup flush
      // (session-end hook progress, the final result record) sit in the
      // 100ms drain timer process.exit discards — the cliff drains them by
      // name instead (TASK-017 D3 census: the append's close was in flight
      // at the cliff on every -p run).
      registerExitCliffSeam({
        name: 'transcript-writer',
        phase: 1,
        settle: () => project?.flush() ?? Promise.resolve(),
      })
      cleanupRegistered = true
    }
  }
  return project
}

/** The live Project when one exists — never instantiates one (the exit cliff
 *  peeks; only a recorded turn creates). */
export function peekProject(): Project | null {
  return project
}

/** @internal Reset shared flush/queue state between tests. */
export function resetProjectFlushStateForTesting(): void {
  project?._resetFlushState()
}

/** @internal Drop the singleton so tests with different config homes don't
 *  inherit a stale sessionFile pointer. */
export function resetProjectForTesting(): void {
  resetTranscriptFormatCacheForTesting()
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

/** Route transcript persistence through CCR v2 internal worker events
 *  instead of v1 Session Ingress. */
export function setInternalEventWriter(writer: InternalEventWriter): void {
  getProject().setInternalEventWriter(writer)
}

type InternalEventReader = () => Promise<
  { payload: Record<string, unknown>; agent_id?: string }[] | null
>

/** Register the CCR v2 readers (foreground + subagent) that resume uses to
 *  reconstruct conversation state on reconnection. */
export function setInternalEventReader(
  reader: InternalEventReader,
  subagentReader: InternalEventReader,
): void {
  getProject().setInternalEventReader(reader)
  getProject().setInternalSubagentEventReader(subagentReader)
}

/** @internal Simulates hydrateRemoteSession's URL wiring for tests. */
export function setRemoteIngressUrlForTesting(url: string): void {
  getProject().setRemoteIngressUrl(url)
}

// win-c instrumentation: cumulative count of messages examined by
// recordTranscript. The O(new) law is proven against this counter — visits
// must track NEW messages, never the accumulated history per append.
let transcriptMessagesVisited = 0
export function getTranscriptMessagesVisited(): number {
  return transcriptMessagesVisited
}

/**
 * Record a message slice to the session file, deduplicating against what
 * disk already holds and threading parentUuid correctly across calls.
 *
 * Already-recorded messages advance the parent cursor ONLY while they form
 * a prefix of the slice. Both real shapes fall out correctly:
 * - growing-array callers (QueryEngine, queryHelpers, tasks): recorded
 *   messages are always a prefix → tracked → new messages chain onto them;
 * - compaction (useLogMessages): the new boundary/summary come FIRST, then
 *   recorded messagesToKeep → not a prefix → untracked → the boundary gets
 *   parentUuid=null, which is exactly what truncates the --continue chain
 *   at the compact point.
 * Without the dedup-with-tracking, post-compaction messagesToKeep (same
 * uuids as pre-compact) would be skipped by appendEntry yet still advance
 * the cursor, chaining new messages onto pre-compact uuids and orphaning
 * the boundary.
 *
 * `startingParentUuidHint` lets useLogMessages hand over the previous
 * slice's parent instead of paying an O(n) rediscovery scan.
 *
 * Returns the last recorded chain-participant's uuid — or the tracked
 * prefix uuid when the slice was all-recorded (rewind, /resume) — so the
 * caller's chain survives every shape. Progress persists but nothing
 * chains to it (isChainParticipant).
 */
export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
  /** Pre-maintained REPL-id set (hot-path cadence C3c) — see
   *  cleanMessagesForLogging. */
  replIds?: Set<string>,
): Promise<UUID | null> {
  transcriptMessagesVisited += messages.length
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages, replIds)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)
  const newMessages: typeof cleanedMessages = []
  let startingParentUuid: UUID | undefined = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid as UUID)) {
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid as UUID
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }
  // The newest leaf THIS process appended wins as the new segment's parent
  // whenever it exists: the in-memory scan above follows the CALLER's array
  // order, which diverges from the on-disk chain when turns interleave (a
  // headless engine per delivered turn; a model-switch breadcrumb turn
  // recorded between two prompts hooked the next prompt onto the wrong
  // sibling and forked the chain — the latest-leaf reader then dropped a
  // whole turn). The leaf IS the on-disk truth; the scan remains the anchor
  // for a resumed file's first record, where no leaf exists yet. THE READ IS
  // ATOMIC WITH THE WRITE (the class's second instance, closed at the seam):
  // reading the leaf HERE — outside insertMessageChain's serialized section
  // — let two overlapping recordTranscript calls capture the same leaf and
  // fork the chain again (prove-concurrent-chain-fork), so the preference is
  // resolved INSIDE the write via preferLiveLeaf; the flag carries only the
  // has-any-records fact, which never un-happens.
  const preferLiveLeaf = messageSet.size > 0
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
      preferLiveLeaf,
    )
  }
  const lastRecorded = newMessages.findLast(isChainParticipant)
  if (lastRecorded) return lastRecorded.uuid as UUID
  // An all-recorded slice returns the freshest anchor available: the live
  // leaf when records exist (read here is fine — nothing was written), else
  // the scan's tracked prefix.
  if (preferLiveLeaf) {
    const leaf = getProject().currentSessionChainLeaf
    if (leaf !== undefined) return leaf
  }
  return startingParentUuid ?? null
}

/**
 * Explicit settlement of an already-recorded message — the
 * producer-facing verb over the writer's settleMessage. Fire-and-forget
 * safe: enqueue order puts it behind the original record.
 */
export function settleTranscriptMessage(message: Message): Promise<void> {
  return getProject().settleMessage(message)
}

export async function recordSidechainTranscript(
  messages: Message[],
  agentId?: string,
  startingParentUuid?: UUID | null,
) {
  await getProject().insertMessageChain(
    cleanMessagesForLogging(messages),
    true,
    agentId,
    startingParentUuid,
  )
}

export async function recordQueueOperation(queueOp: QueueOperationMessage) {
  await getProject().insertQueueOperation(queueOp)
}

/** Remove one message by uuid — the tombstone verb for orphans left by
 *  failed streaming attempts. */
export async function removeTranscriptMessage(targetUuid: UUID): Promise<void> {
  await getProject().removeMessageByUuid(targetUuid)
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
) {
  await getProject().insertFileHistorySnapshot(
    messageId,
    snapshot,
    isSnapshotUpdate,
  )
}

export async function recordAttributionSnapshot(
  snapshot: AttributionSnapshotMessage,
) {
  await getProject().insertAttributionSnapshot(snapshot)
}

export async function recordContentReplacement(
  replacements: ContentReplacementRecord[],
  agentId?: AgentId,
) {
  await getProject().insertContentReplacement(replacements, agentId)
}

/** Clear the session-file pointer after switchSession/regenerateSessionId;
 *  the next file materializes lazily on the first real message. */
export async function resetSessionFilePointer() {
  getProject().resetSessionFile()
}

/**
 * Adopt the existing file after --continue/--resume (bare-stamp). Call after
 * switchSession + resetSessionFilePointer + restoreSessionMetadata, when
 * getTranscriptPath() derives the resumed path and the cache holds final
 * metadata (--name title, resumed mode/tag/agent).
 *
 * Setting sessionFile NOW — rather than waiting for the first message —
 * is what lets the exit handler's reAppendSessionMetadata run (it bails on
 * a null pointer). Without it, `-c -n foo` followed by quit-before-message
 * drops the title: cached correctly, written never. The file already
 * exists on disk (it was just loaded), so no orphan can result.
 *
 * skipTitleRefresh: the cache was populated from the same disk read
 * microseconds ago, so a tail refresh is a no-op — except under --name,
 * where it would clobber the fresh CLI title with the stale disk value.
 * After this write disk == cache, and later calls absorb SDK writes
 * normally.
 */
export function adoptResumedSessionFile(): void {
  const project = getProject()
  project.sessionFile = getTranscriptPath()
  project.reAppendSessionMetadata(true)
  // A resumed file's own newest leaf is unknown to THIS process until it
  // records; recordTranscript's first turn finds the on-disk parent through
  // the in-memory scan (the resumed messages carry it), so leaving the leaf
  // undefined here is correct — the fallback only fires when the turn shares
  // nothing with disk, and a resumed turn always shares its anchor.
  project.currentSessionChainLeaf = undefined
}

/** Append one context-collapse commit, in commit order — restore replays
 *  them sequentially into the rebuilt commit log. */
export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: 'marble-origami-commit',
    sessionId,
    ...commit,
  })
}

/** Snapshot the staged queue + spawn state after each ctx-agent spawn;
 *  restore keeps only the newest (last-wins). */
export async function recordContextCollapseSnapshot(snapshot: {
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: 'marble-origami-snapshot',
    sessionId,
    ...snapshot,
  })
}

export async function flushSessionStorage(): Promise<void> {
  await getProject().flush()
}

const REMOTE_FLUSH_INTERVAL_MS = 10

// Entry kinds that append unconditionally — no dedup, no message-set load.
// content-replacement is deliberately absent (it routes by agentId first),
// as are queue-operation and the transcript message kinds (dedup applies).
const ALWAYS_APPEND_KINDS = new Set<Entry['type']>([
  'summary',
  'custom-title',
  'ai-title',
  'last-prompt',
  'task-summary',
  'tag',
  'agent-name',
  'agent-color',
  'agent-setting',
  'pr-link',
  'file-history-snapshot',
  'attribution-snapshot',
  'speculation-accept',
  'mode',
  'worktree-state',
  'marble-origami-commit',
  'marble-origami-snapshot',
])

class Project {
  // Metadata cache for exactly one session: the live one.
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  // The uuid of the newest chain participant this process appended to the
  // session file — the parent a NEXT turn's first record links to when the
  // turn's own messages share nothing with the on-disk set. A headless
  // stream-json child builds a fresh QueryEngine per delivered turn (its
  // in-memory messages do not carry the prior turn's rows), so without this
  // every turn started a NEW chain root and loadFullLog's latest-leaf walk
  // returned only the last turn — a --resume, or a hop into the session,
  // showed one exchange. Undefined until the first append.
  currentSessionChainLeaf: UUID | undefined
  currentSessionAgentSetting: string | undefined
  currentSessionMode: 'coordinator' | 'normal' | undefined
  // Tri-state on purpose: undefined = never touched (write nothing),
  // null = exited the worktree, object = currently inside. Exit re-appends
  // the null so --resume can tell "left cleanly" from "crashed inside".
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  sessionFile: string | null = null
  // Buffered while sessionFile is null; materializeSessionFile flushes them
  // with the first real message — no metadata-only files at startup.
  private pendingEntries: Entry[] = []
  private remoteIngressUrl: string | null = null
  private internalEventWriter: InternalEventWriter | null = null
  private internalEventReader: InternalEventReader | null = null
  private internalSubagentEventReader: InternalEventReader | null = null
  private pendingWriteCount: number = 0
  private flushResolvers: Array<() => void> = []
  // Per-file write queues. Lines are serialized AT ENQUEUE (IDM-2
  // immutability): the durable bytes are the record AS PUBLISHED — a later
  // producer mutation is invisible to the drain. Settlement is explicit
  // (settleMessage), never timer-raced. Each item carries its resolve so
  // callers can await their specific write.
  private writeQueues = new Map<
    string,
    Array<{ line: string; resolve: () => void }>
  >()
  // Settlement state per recorded user/assistant uuid: the entry as last
  // persisted plus its serialized line, so settlement can re-append the
  // FINAL record (readers are last-wins per uuid) and skip byte-identical
  // no-ops.
  private settleState = new Map<
    string,
    {
      file: string
      entry: Entry
      lastLine: string
      /** SEMANTIC (entry-shape) bytes — the settle skip compares these,
       *  never the encoded line (record ordinals never repeat). */
      semanticLine: string
      /** The published record's creation ordinal — settlement
       *  re-publication preserves it (lineage). */
      creationOrdinal?: string
      /** The queued item for the as-published line. While it still sits in
       *  the queue (drain not fired), settlement swaps the line IN PLACE —
       *  the file gets ONE final line instead of publish+settle. */
      queued?: { line: string; resolve: () => void }
    }
  >()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private FLUSH_INTERVAL_MS = 100
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024
  // One in-memory chain serializes EVERY disk mutation of the session file
  // — batched append-drains AND the tombstone. Without it the tombstone's
  // stat→truncate window can interleave with a drain and corrupt the
  // just-appended bytes. The dual-branch.then(fn, fn) plus the
  // swallowed stored tail keep one rejection from latching the chain and
  // starving all future writes.
  private fileWriteChain: Promise<unknown> = Promise.resolve()

  constructor() {}

  /** @internal Test seam — drops queues, timers, and settlement state. */
  _resetFlushState(): void {
    this.settleState = new Map()
    this.pendingWriteCount = 0
    this.flushResolvers = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.activeDrain = null
    this.fileWriteChain = Promise.resolve()
    this.writeQueues = new Map()
  }

  private incrementPendingWrites(): void {
    this.pendingWriteCount++
  }

  private decrementPendingWrites(): void {
    this.pendingWriteCount--
    if (this.pendingWriteCount === 0) {
      for (const resolve of this.flushResolvers) {
        resolve()
      }
      this.flushResolvers = []
    }
  }

  private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.incrementPendingWrites()
    try {
      return await fn()
    } finally {
      this.decrementPendingWrites()
    }
  }

  /** The INSERT serialization domain — chain-parent resolution and the leaf
   *  advance must be mutually exclusive across overlapping
   *  insertMessageChain calls (trackWrite only COUNTS pending writes; the
   *  file-line queue serializes bytes, not parent decisions — two
   *  overlapping bodies both read the same leaf and forked the chain:
   *  prove-concurrent-chain-fork). A separate queue from fileWriteChain on
   *  purpose: the body's own appendEntry rides fileWriteChain, and nesting
   *  one domain inside itself would deadlock. Both .then branches run fn so
   *  a predecessor's rejection never starves the successor. */
  private insertChainQueue: Promise<unknown> = Promise.resolve()
  private serializeInsert<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.insertChainQueue.then(
      () => fn(),
      () => fn(),
    )
    this.insertChainQueue = run.catch(() => {})
    return run
  }

  /**
   * Run fn as the sole holder of the disk chain. Both .then branches run
   * fn so a predecessor's rejection never starves the successor; the
   * stored tail swallows rejections so the chain cannot latch.
   */
  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.fileWriteChain.then(
      () => fn(),
      () => fn(),
    )
    this.fileWriteChain = run.catch(() => {})
    return run
  }

  private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    // Serialize NOW — the published snapshot is what persists (IDM-2).
    return this.enqueueRawLine(
      filePath,
      encodeTranscriptLine(filePath, entry as Record<string, unknown>).line,
    )
  }

  private enqueueRawLine(
    filePath: string,
    line: string,
    capture?: (item: { line: string; resolve: () => void }) => void,
  ): Promise<void> {
    return new Promise<void>(resolve => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      const item = { line, resolve }
      queue.push(item)
      capture?.(item)
      this.scheduleDrain()
    })
  }

  /** Consecutive drain failures — the retry backoff's ladder and the
   *  once-per-streak error-ring gate. Reset by any successful drain. */
  private drainFailureStreak = 0

  private scheduleDrain(): void {
    if (this.flushTimer) {
      return
    }
    // A failing drain re-arms on a growing interval (100ms → 5s cap) so a
    // scanner-held file is retried, never hammered.
    const interval = Math.min(this.FLUSH_INTERVAL_MS * 2 ** this.drainFailureStreak, 5_000)
    // SYNC callback + a tracked promise — this was the tree's ONE
    // setTimeout(async …): an append failure rejected the callback's own
    // promise unhandled, skipped `activeDrain = null` (every later flush()
    // then rethrew instantly without draining — the latch), and skipped the
    // re-arm (TASK-017 S2, transcript-drain-drops-batch-on-append-failure +
    // transcript-flush-latches-on-one-append-error). The failure now lands
    // in the error ring once per streak, activeDrain clears in a finally,
    // and the un-landed batch — requeued by the drain itself — earns the
    // backoff retry.
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      // The ladder already recorded the failure; the timer has no caller
      // to report it to.
      this.runDrain().catch(() => {})
    }, interval)
  }

  /**
   * The ONE drain owner (release-hardening audit rank 16). Every drain —
   * the timer's and flush()'s — rides this wrapper, so the failure ladder
   * (the streak, the store-health sentence, the backoff re-arm) applies
   * regardless of who started it. flush() used to call drainWriteQueue()
   * directly: a turn-boundary flush that failed (a scanner holding the
   * .jsonl, ENOSPC) rethrew to its caller and did nothing else — no streak,
   * no sticky sentence, and no timer re-armed, so the requeued batch waited
   * for the next enqueue; the exit-time flush was the last one, and the
   * turn was dropped. The returned promise rejects with the drain's error
   * so flush() callers still see the truth.
   */
  private runDrain(): Promise<void> {
    const run = this.drainWriteQueue()
    this.activeDrain = run
    return run
      .then(
        () => {
          this.drainFailureStreak = 0
          setStoreHealth({ failing: false, sentence: null })
        },
        err => {
          if (this.drainFailureStreak === 0) logError(err)
          this.drainFailureStreak++
          // Two consecutive failures = a condition, not a blip: publish
          // the owner's own sentence for the chat's sticky notification.
          if (this.drainFailureStreak >= 2) {
            setStoreHealth({ failing: true, sentence: err instanceof Error ? err.message : String(err) })
          }
          throw err
        },
      )
      .finally(() => {
        if (this.activeDrain === run) this.activeDrain = null
        // Anything enqueued while draining — and any requeued failure
        // remainder — earns the next timer, at the streak's backoff.
        if (this.writeQueues.size > 0) {
          this.scheduleDrain()
        }
      })
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      // Missing directory is the expected cause — but some network
      // filesystems return odd codes, so retry after mkdir regardless.
      try {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        await fsAppendFile(filePath, data, { mode: 0o600 })
      } catch (error) {
        throw describeTranscriptStoreFailure(filePath, error)
      }
    }
  }

  private drainWriteQueue(): Promise<void> {
    // Disk work rides the shared chain, so an in-flight tombstone (which
    // also holds it) can never see an append land inside its stat→truncate
    // window; a timer firing mid-tombstone just queues behind.
    return this.serializeWrite(() => this._drainWriteQueueInner())
  }

  private async _drainWriteQueueInner(): Promise<void> {
    // Fault-isolating across files (FN-015 rank 57): the loop used to
    // rethrow at the first append failure, so every file whose queue sat
    // after the failing one in insertion order stopped persisting for as
    // long as the fault lasted — a wedged sidechain starved every later
    // agent's transcript, a wedged session file starved every sidechain —
    // and the delete sweep was skipped. Per-file failures are collected,
    // the remaining files drain, and the aggregate rethrows so flush()
    // callers and the store-health ladder still see the truth.
    const failures: Array<{ filePath: string; error: unknown }> = []
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        continue
      }
      const batch = queue.splice(0)

      // `landed` counts batch items whose bytes reached disk (their
      // resolvers settled). On an append failure the UN-LANDED tail goes
      // BACK to the front of the queue with its resolvers intact — the old
      // shape discarded the spliced batch and its promises with the stack
      // frame (no requeue, no notice: turns on screen but missing from the
      // transcript and --resume; TASK-017 S2). The failure then rethrows so
      // flush() callers see the truth while the timer's backoff retries.
      let landed = 0

      try {
        let content = ''
        let pending = 0

        for (const { line } of batch) {
          if (content.length + line.length >= this.MAX_CHUNK_BYTES) {
            // Chunk boundary: land these bytes and settle their promises
            // before accumulating more.
            await this.appendToFile(filePath, content)
            for (let i = landed; i < landed + pending; i++) {
              batch[i]!.resolve()
            }
            landed += pending
            pending = 0
            content = ''
          }

          content += line
          pending++
        }

        if (content.length > 0) {
          await this.appendToFile(filePath, content)
          for (let i = landed; i < landed + pending; i++) {
            batch[i]!.resolve()
          }
          landed += pending
        }
      } catch (err) {
        queue.unshift(...batch.slice(landed))
        failures.push({ filePath, error: err })
      }
    }

    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        this.writeQueues.delete(filePath)
      }
    }

    if (failures.length === 1) throw failures[0]!.error
    if (failures.length > 1) {
      const detail = failures
        .map(({ filePath, error }) => `${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`)
        .join('; ')
      throw new Error(`${failures.length} transcript files could not be written — ${detail}`)
    }
  }

  resetSessionFile(): void {
    this.sessionFile = null
    this.pendingEntries = []
    this.settleState = new Map()
    // A switchSession/regenerateSessionId/clear starts a new file — the old
    // session's leaf must never parent the new one's first record.
    this.currentSessionChainLeaf = undefined
  }

  /**
   * Push cached metadata back to EOF so it stays inside the tail window
   * the lite reader scans.
   *
   * Two call contexts, different file-order consequences:
   * - during compaction (compact/reactiveCompact): entries land just
   *   before the boundary marker — the pre-boundary metadata scan recovers
   *   them;
   * - on exit (cleanup handler): entries land at absolute EOF after every
   *   boundary — which is what lets the loader's pre-compact skip find
   *   them without a forward scan.
   *
   * SDK-mutable fields (custom-title, tag) get external-writer safety:
   * refresh the cache from the tail FIRST, so a fresher value written by
   * an external process (SDK renameSession/tagSession) is absorbed and
   * re-appended — not overwritten by our stale cache. Absent tail entries
   * leave the cache authoritative.
   *
   * The re-append is unconditional even when the value is already in the
   * tail: during compaction a title 40KB from EOF sits inside TODAY's
   * window but will fall out as the post-compaction session grows —
   * skipping "already visible" values would defeat the call. Fields the
   * SDK cannot write (last-prompt, agent-*, mode, pr-link) have no
   * external-writer concern.
   */
  reAppendSessionMetadata(skipTitleRefresh = false): void {
    if (!this.sessionFile) return
    const sessionId = getSessionId() as UUID
    if (!sessionId) return

    // One sync tail read (same window as the lite reader). Empty string on
    // failure → extraction misses → the cache stands.
    const tail = readFileTailSync(this.sessionFile)

    // The startsWith envelope anchor filters to top-level record lines at
    // column 0; the metaKind marker then names the session-meta kind — a
    // "metaKind":"tag" INSIDE a serialized tool_use input sits on a line
    // whose own payload kind differs, and its extraction misses.
    const isMetaLine = (l: string, metaKind: string): boolean =>
      l.startsWith('{"schemaVersion":') && l.includes(`"metaKind":"${metaKind}"`)
    const tailLines = tail.split('\n')
    if (!skipTitleRefresh) {
      const titleLine = tailLines.findLast((l: string) =>
        isMetaLine(l, 'custom-title'),
      )
      if (titleLine) {
        const tailTitle = extractLastJsonStringField(titleLine, 'customTitle')
        // `!== undefined` separates no-match from matched-empty: an
        // external customTitle:"" clears the cache so the write below
        // skips it, instead of resurrecting a stale title.
        if (tailTitle !== undefined) {
          this.currentSessionTitle = tailTitle || undefined
        }
      }
    }
    const tagLine = tailLines.findLast((l: string) => isMetaLine(l, 'tag'))
    if (tagLine) {
      const tailTag = extractLastJsonStringField(tagLine, 'tag')
      // Likewise: tagSession(id, null) writes tag:"" to clear.
      if (tailTag !== undefined) {
        this.currentSessionTag = tailTag || undefined
      }
    }

    // last-prompt first, so the fields tail readers need most (title, tag)
    // land closest to EOF.
    if (this.currentSessionLastPrompt) {
      appendEntryToFile(this.sessionFile, {
        type: 'last-prompt',
        lastPrompt: this.currentSessionLastPrompt,
        sessionId,
      })
    }
    if (this.currentSessionTitle) {
      appendEntryToFile(this.sessionFile, {
        type: 'custom-title',
        customTitle: this.currentSessionTitle,
        sessionId,
      })
    }
    if (this.currentSessionTag) {
      appendEntryToFile(this.sessionFile, {
        type: 'tag',
        tag: this.currentSessionTag,
        sessionId,
      })
    }
    if (this.currentSessionAgentName) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-name',
        agentName: this.currentSessionAgentName,
        sessionId,
      })
    }
    if (this.currentSessionAgentColor) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-color',
        agentColor: this.currentSessionAgentColor,
        sessionId,
      })
    }
    if (this.currentSessionAgentSetting) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-setting',
        agentSetting: this.currentSessionAgentSetting,
        sessionId,
      })
    }
    if (this.currentSessionMode) {
      appendEntryToFile(this.sessionFile, {
        type: 'mode',
        mode: this.currentSessionMode,
        sessionId,
      })
    }
    if (this.currentSessionWorktree !== undefined) {
      appendEntryToFile(this.sessionFile, {
        type: 'worktree-state',
        worktreeSession: this.currentSessionWorktree,
        sessionId,
      })
    }
    if (
      this.currentSessionPrNumber !== undefined &&
      this.currentSessionPrUrl &&
      this.currentSessionPrRepository
    ) {
      appendEntryToFile(this.sessionFile, {
        type: 'pr-link',
        sessionId,
        prNumber: this.currentSessionPrNumber,
        prUrl: this.currentSessionPrUrl,
        prRepository: this.currentSessionPrRepository,
        timestamp: new Date().toISOString(),
      })
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.activeDrain) {
      await this.activeDrain
    }
    // Through the one drain owner: a failed flush walks the same ladder
    // the timer's drain does (streak, sentence, re-arm) and still rejects
    // here so the caller sees the truth.
    await this.runDrain()

    // Non-queue tracked work (the tombstone) may still be settling.
    if (this.pendingWriteCount === 0) {
      return
    }
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  /**
   * Tombstone one message by uuid. The target is almost always the newest
   * entry, so the fast path reads only the tail, splices the line out with
   * a positional write + truncate, and never touches the rest of the file.
   */
  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    return this.trackWrite(() =>
      this.serializeWrite(async () => {
        if (this.sessionFile === null) return
        // Land queued appends FIRST, inside the held chain, so a
        // still-queued orphan reaches disk before the search and the byte
        // layout is final; the chain keeps every ASYNC drain out for the
        // whole span. The read→truncate below is one SYNCHRONOUS block —
        // the only other writer (the sync metadata path via
        // appendEntryToFile, which bypasses queue and chain) runs on this
        // same JS thread and cannot interleave a sync block. Uses
        // _drainWriteQueueInner (queue-only), NOT flush(): flush awaits
        // pendingWriteCount===0 and trackWrite already incremented it —
        // calling flush here would self-deadlock.
        await this._drainWriteQueueInner()
        try {
          let fileSize = 0
          const fd = openSync(this.sessionFile, 'r+')
          try {
            const { size } = fstatSync(fd)
            fileSize = size
            if (size === 0) return

            const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
            const tailStart = size - chunkLen
            const buf = Buffer.allocUnsafe(chunkLen)
            const bytesRead = readSync(fd, buf, 0, chunkLen, tailStart)
            const tail = buf.subarray(0, bytesRead)

            // Search the full `"uuid":"…"` pattern — a bare uuid would
            // also match a child's parentUuid. Entries serialize without
            // key-value whitespace, and uuids are ASCII, so a byte search
            // is exact.
            const needle = `"uuid":"${targetUuid}"`
            const matchIdx = tail.lastIndexOf(needle)

            if (matchIdx >= 0) {
              // 0x0a never occurs inside a UTF-8 continuation, so
              // byte-level line scanning is safe even entering mid-char.
              const prevNl = tail.lastIndexOf(0x0a, matchIdx)
              // Preceding newline outside the window and not at file
              // start ⇒ the line exceeds the window — slow path.
              if (prevNl >= 0 || tailStart === 0) {
                const lineStart = prevNl + 1 // 0 when prevNl === -1
                const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
                const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead

                const absLineStart = tailStart + lineStart
                const afterLen = bytesRead - lineEnd
                // Truncate, then re-append the survivors. In the common
                // case (target is last) afterLen is 0 — one ftruncate.
                ftruncateSync(fd, absLineStart)
                if (afterLen > 0) {
                  writeSync(fd, tail, lineEnd, afterLen, absLineStart)
                }
                return
              }
            }
          } finally {
            closeSync(fd)
          }

          // Slow path: the target scrolled past the tail window — rare;
          // needs many large entries between write and tombstone. Same
          // sync-block atomicity, whole-file rewrite, bounded.
          if (fileSize > MAX_TOMBSTONE_REWRITE_BYTES) {
            logForDebugging(
              `Skipping tombstone removal: session file too large (${formatFileSize(fileSize)})`,
              { level: 'warn' },
            )
            return
          }
          const content = readFileSync(this.sessionFile, { encoding: 'utf-8' })
          const lines = content.split('\n').filter((line: string) => {
            if (!line.trim()) return true
            try {
              const entry = jsonParse(line)
              return entry.uuid !== targetUuid
            } catch {
              return true // malformed lines are the reader's problem, not ours
            }
          })
          writeFileSync(this.sessionFile, lines.join('\n'), {
            encoding: 'utf8',
          })
        } catch {
          // no file yet — nothing to tombstone
        }
      }),
    )
  }

  /**
   * One persistence gate for appendEntry AND materializeSessionFile: test
   * env (unless explicitly re-enabled), cleanupPeriodDays=0,
   * --no-session-persistence, or MERCURY_SKIP_PROMPT_HISTORY. Harness-
   * spawned test sessions set the env var so they never pollute /resume.
   */
  private shouldSkipPersistence(): boolean {
    const allowTestPersistence = isEnvTruthy(
      process.env.TEST_ENABLE_SESSION_PERSISTENCE,
    )
    return (
      (getNodeEnv() === 'test' && !allowTestPersistence) ||
      getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
      isSessionPersistenceDisabled() ||
      isEnvTruthy(process.env.MERCURY_SKIP_PROMPT_HISTORY)
    )
  }

  /**
   * First real message: create the file, stamp cached startup metadata,
   * flush the buffered entries. The persistence gate applies here too —
   * reAppendSessionMetadata writes through the sync path, which would
   * otherwise mint a metadata-only file despite --no-session-persistence.
   */
  private async materializeSessionFile(): Promise<void> {
    if (this.shouldSkipPersistence()) return
    this.ensureCurrentSessionFile()
    // mode/agentSetting were cache-only until now; this writes them.
    this.reAppendSessionMetadata()
    if (this.pendingEntries.length > 0) {
      const buffered = this.pendingEntries
      this.pendingEntries = []
      for (const entry of buffered) {
        await this.appendEntry(entry)
      }
    }
  }

  async insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    teamInfo?: { teamName?: string; agentName?: string },
    /** Resolve the parent from the LIVE chain leaf at write time (inside
     *  this serialized section) instead of the caller's snapshot — the
     *  atomic-leaf law: two overlapping recordTranscript calls must chain
     *  one after the other, never both onto a shared stale leaf
     *  (prove-concurrent-chain-fork). The caller's startingParentUuid
     *  remains the anchor when no leaf exists yet (a resumed file's first
     *  record). */
    preferLiveLeaf: boolean = false,
  ) {
    return this.trackWrite(() => this.serializeInsert(async () => {
      let parentUuid: UUID | null = startingParentUuid ?? null
      // The birth-race carve-in (delivery-verifier C2): preferLiveLeaf is
      // computed OUTSIDE this serialized section, and its inverse — "no
      // records yet" — un-happens exactly once, at birth, between the
      // compute and the write. Two same-tick first writers both computed
      // false, the second ignored the leaf the first had just set, and the
      // chain forked at the root — the display walk drops a whole batch.
      // The law: a main-chain record never roots while a live leaf stands.
      if (!isSidechain && (preferLiveLeaf || parentUuid === null)) {
        const leaf = this.currentSessionChainLeaf
        if (leaf !== undefined) parentUuid = leaf
      }

      // Only a user/assistant message materializes the file; hook progress
      // or attachments alone stay buffered.
      if (
        this.sessionFile === null &&
        messages.some(m => m.type === 'user' || m.type === 'assistant')
      ) {
        await this.materializeSessionFile()
      }

      // One branch lookup covers the whole chain.
      let gitBranch: string | undefined
      try {
        gitBranch = await getBranch()
      } catch {
        gitBranch = undefined // not a repo, or git unavailable
      }

      const sessionId = getSessionId()
      const slug = getPlanSlugCache().get(sessionId)

      for (const message of messages) {
        const isCompactBoundary = isCompactBoundaryMessage(message)

        // Tool results carry their own parent: the uuid of the assistant
        // message that issued the tool_use (stamped at creation). Others
        // chain sequentially.
        let effectiveParentUuid = parentUuid
        if (
          message.type === 'user' &&
          'sourceToolAssistantUUID' in message &&
          message.sourceToolAssistantUUID
        ) {
          effectiveParentUuid = message.sourceToolAssistantUUID
        }

        const transcriptMessage: TranscriptMessage = {
          parentUuid: isCompactBoundary ? null : effectiveParentUuid,
          // The boundary's logical parent keeps the pre-compact lineage
          // findable; its type spells UUID | undefined (no null), so null
          // folds to undefined — both mean "none", and undefined drops out
          // of serialization.
          logicalParentUuid: isCompactBoundary
            ? (parentUuid ?? undefined)
            : undefined,
          isSidechain,
          teamName: teamInfo?.teamName,
          agentName: teamInfo?.agentName,
          promptId:
            message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
          agentId,
          ...message,
          // Session stamps AFTER the spread — this ordering is load-
          // bearing. --fork-session and --resume deliver SerializedMessage
          // shapes still carrying the SOURCE session's sessionId/cwd
          // (removeExtraFields strips only parentUuid/isSidechain). Left
          // unstamped, FRESH.jsonl holds messages stamped with session A
          // while content-replacement entries stamp FRESH — and the
          // sessionId-keyed replacement lookup on load misses, losing the
          // records.
          userType: getUserType(),
          entrypoint: getEntrypoint(),
          cwd: getCwd(),
          sessionId,
          version: VERSION,
          gitBranch,
          slug,
        }
        await this.appendEntry(transcriptMessage)
        if (isChainParticipant(message)) {
          parentUuid = message.uuid
          // The engine lane's newest leaf (a sidechain is an agent's own
          // branch, never the main chain's tail).
          if (!isSidechain) this.currentSessionChainLeaf = message.uuid as UUID
        }
      }

      // Remember this turn's prompt for the resume picker's "what was I
      // doing" line; overwritten every turn by design.
      if (!isSidechain) {
        const text = getFirstMeaningfulUserMessageTextContent(messages)
        if (text) {
          const flat = text.replace(/\n/g, ' ').trim()
          this.currentSessionLastPrompt =
            flat.length > 200 ? flat.slice(0, 200).trim() + '…' : flat
        }
      }
    }))
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ) {
    return this.trackWrite(async () => {
      const fileHistoryMessage: FileHistorySnapshotMessage = {
        type: 'file-history-snapshot',
        messageId,
        snapshot,
        isSnapshotUpdate,
      }
      await this.appendEntry(fileHistoryMessage)
    })
  }

  async insertQueueOperation(queueOp: QueueOperationMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(queueOp)
    })
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(snapshot)
    })
  }

  async insertContentReplacement(
    replacements: ContentReplacementRecord[],
    agentId?: AgentId,
  ) {
    return this.trackWrite(async () => {
      const entry: ContentReplacementEntry = {
        type: 'content-replacement',
        sessionId: getSessionId() as UUID,
        agentId,
        replacements,
      }
      await this.appendEntry(entry)
    })
  }

  async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
    if (this.shouldSkipPersistence()) {
      return
    }

    const currentSessionId = getSessionId() as UUID
    const isCurrentSession = sessionId === currentSessionId

    let sessionFile: string
    if (isCurrentSession) {
      // Pre-materialization entries buffer until the first real message.
      if (this.sessionFile === null) {
        this.pendingEntries.push(entry)
        return
      }
      sessionFile = this.sessionFile
    } else {
      const existing = await this.getExistingSessionFile(sessionId)
      if (!existing) {
        logError(
          new Error(
            `appendEntry: session file not found for other session ${sessionId}`,
          ),
        )
        return
      }
      sessionFile = existing
    }

    // Metadata kinds append unconditionally — no dedup, no set load.
    if (ALWAYS_APPEND_KINDS.has(entry.type)) {
      void this.enqueueWrite(sessionFile, entry)
      return
    }

    if (entry.type === 'content-replacement') {
      // Routed by scope: subagent records to the sidechain file (AgentTool
      // resume reads them there), main-thread records to the session file
      // (/resume reads them there).
      const targetFile = entry.agentId
        ? (agentTranscriptDestinations.get(entry.agentId) ??
          getAgentTranscriptPath(entry.agentId))
        : sessionFile
      void this.enqueueWrite(targetFile, entry)
      return
    }

    if (entry.type === 'queue-operation') {
      void this.enqueueWrite(sessionFile, entry)
      return
    }

    // What remains is a TranscriptMessage (user/assistant/attachment/
    // system) — the deduplicated kinds. The narrowing is by exhaustion:
    // the three routes above consumed every other member of the Entry
    // union (a Set membership test doesn't narrow for the compiler).
    const message = entry as TranscriptMessage
    const isAgentSidechain =
      message.isSidechain && message.agentId !== undefined
    // The launch-captured destination wins: live session
    // identity can change mid-agent, the chain must not.
    const targetFile = isAgentSidechain
      ? (agentTranscriptDestinations.get(message.agentId!) ??
        getAgentTranscriptPath(asAgentId(message.agentId!)))
      : sessionFile

    // Sidechain writes dedup against their OWN file's set,
    // never the main session's: fork-inherited parents share uuids with
    // the main transcript and must still land in the agent file once —
    // resume-of-fork loads the full inherited context from it. Without the
    // per-file set, a resumed continuation re-recorded its whole restored
    // transcript every round and file bytes grew superlinearly.
    //
    // The split governs only the LOCAL write. Remote persistence keeps one
    // Last-Uuid chain per sessionId — re-POSTing a uuid it already holds
    // 409s until retries exhaust and the process dies (inc-4718 class) —
    // hence sidechain entries never reach persistToRemote below.
    if (isAgentSidechain) {
      const agentSet = await getAgentFileMessages(targetFile)
      if (!agentSet.has(message.uuid)) {
        agentSet.add(message.uuid)
        this.enqueueMessageWrite(targetFile, message)
      }
      return
    }

    const messageSet = await getSessionMessages(sessionId)
    if (!messageSet.has(message.uuid)) {
      this.enqueueMessageWrite(targetFile, message)
      // The set is MAIN-FILE-authoritative: sidechain uuids must never
      // enter it. If they did, recordTranscript would skip writing the
      // message to the main file, the next main message would chain onto a
      // uuid existing only in the agent file, and --resume's chain walk
      // would die at the dangling ref. (Remote has the mirror-image
      // constraint — inc-4718 above.)
      messageSet.add(message.uuid)

      if (isTranscriptMessage(message)) {
        await this.persistToRemote(sessionId, message)
      }
    }
  }

  /** Enqueue a message line and register its settlement state (IDM-2):
   *  the as-published line plus the live queue item, so settlement can
   *  swap in place (drain pending → ONE final line) or re-append
   *  last-wins (already drained). */
  private enqueueMessageWrite(file: string, entry: Entry): void {
    const encoded = encodeTranscriptLine(file, entry as Record<string, unknown>)
    const line = encoded.line
    if (entry.type === 'user' || entry.type === 'assistant') {
      const state: {
        file: string
        entry: Entry
        lastLine: string
        semanticLine: string
        creationOrdinal?: string
        queued?: { line: string; resolve: () => void }
      } = {
        file,
        entry,
        lastLine: line,
        // The settle skip compares SEMANTIC bytes — the record encoding
        // mints fresh ordinals, so encoded lines never repeat even
        // unchanged.
        semanticLine: jsonStringify(entry) + '\n',
        ...(encoded.record
          ? { creationOrdinal: String(encoded.record.creationOrdinal) }
          : {}),
      }
      void this.enqueueRawLine(file, line, item => {
        state.queued = item
      })
      this.settleState.set(entry.uuid, state)
    } else {
      void this.enqueueRawLine(file, line)
    }
  }

  /**
   * Explicit settlement: persist the FINAL state of an
   * already-recorded message. Readers are last-wins per uuid, so the
   * settled line supersedes the as-published snapshot on load. Producers
   * call this at their settlement points (usage/stop arrival on
   * message_delta, provider-receipt attach) — the old rely-on-late-
   * serialization mutation window is absent. Byte-identical settlements
   * skip; a never-recorded uuid is a no-op (its eventual record already
   * serializes final state at enqueue).
   */
  async settleMessage(message: Message): Promise<void> {
    if (this.shouldSkipPersistence()) return
    const cached = this.settleState.get(message.uuid)
    if (!cached) return
    const [cleaned] = cleanMessagesForLogging([message])
    if (!cleaned) return
    const settled = { ...cached.entry, ...cleaned } as Entry
    const semanticLine = jsonStringify(settled) + '\n'
    if (semanticLine === cached.semanticLine) return
    // Settlement re-publication: the record keeps its creation
    // ordinal, advances updateOrdinal, and marks `updates` — receipts ride
    // the same atomic line.
    const line = encodeTranscriptLine(
      cached.file,
      settled as Record<string, unknown>,
      {
        ...(cached.creationOrdinal
          ? { settleCreationOrdinal: cached.creationOrdinal }
          : {}),
      },
    ).line
    cached.entry = settled
    cached.semanticLine = semanticLine
    cached.lastLine = line
    // Fast path: the as-published line is still queued — swap it in place
    // and the file receives one final line instead of publish+settle.
    const queue = this.writeQueues.get(cached.file)
    if (cached.queued && queue && queue.includes(cached.queued)) {
      cached.queued.line = line
      return
    }
    cached.queued = undefined
    await this.enqueueRawLine(cached.file, line)
  }

  /** Resolve (once) the current session's file path; creation happens at
   *  first write, not here. */
  private ensureCurrentSessionFile(): string {
    if (this.sessionFile === null) {
      this.sessionFile = getTranscriptPath()
    }
    return this.sessionFile
  }

  /** Path of ANOTHER session's existing file, or null. Positive results
   *  cache — one stat per session per process. */
  private existingSessionFiles = new Map<string, string>()
  private async getExistingSessionFile(
    sessionId: UUID,
  ): Promise<string | null> {
    const cached = this.existingSessionFiles.get(sessionId)
    if (cached) return cached

    const targetFile = getTranscriptPathForSession(sessionId)
    try {
      await stat(targetFile)
      this.existingSessionFiles.set(sessionId, targetFile)
      return targetFile
    } catch (e) {
      if (isFsInaccessible(e)) return null
      throw e
    }
  }

  private async persistToRemote(sessionId: UUID, entry: TranscriptMessage) {
    if (isShuttingDown()) {
      return
    }

    // CCR v2: transcript messages ride internal worker events.
    if (this.internalEventWriter) {
      try {
        await this.internalEventWriter(
          'transcript',
          entry as unknown as Record<string, unknown>,
          {
            ...(isCompactBoundaryMessage(entry) && { isCompaction: true }),
            ...(entry.agentId && { agentId: entry.agentId }),
          },
        )
      } catch {
        logForDebugging('Failed to write transcript as internal event')
      }
      return
    }
  }

  setRemoteIngressUrl(url: string): void {
    this.remoteIngressUrl = url
    logForDebugging(`Remote persistence enabled with URL: ${url}`)
    if (url) {
      // Remote consumers watch live — don't sit on messages for 100ms.
      this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
    }
  }

  setInternalEventWriter(writer: InternalEventWriter): void {
    this.internalEventWriter = writer
    logForDebugging(
      'CCR v2 internal event writer registered for transcript persistence',
    )
    this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
  }

  setInternalEventReader(reader: InternalEventReader): void {
    this.internalEventReader = reader
    logForDebugging(
      'CCR v2 internal event reader registered for session resume',
    )
  }

  setInternalSubagentEventReader(reader: InternalEventReader): void {
    this.internalSubagentEventReader = reader
    logForDebugging(
      'CCR v2 subagent event reader registered for session resume',
    )
  }

  getInternalEventReader(): InternalEventReader | null {
    return this.internalEventReader
  }

  getInternalSubagentEventReader(): InternalEventReader | null {
    return this.internalSubagentEventReader
  }
}

export type TeamInfo = {
  teamName?: string
  agentName?: string
}

/**
 * Sync tail read for reAppendSessionMetadata's external-writer check: the
 * same LITE_READ_BUF_SIZE window the lite reader scans, via one fd. Empty
 * string on ANY failure — callers then treat the cache as authoritative.
 */
function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, 'r')
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(
      Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset),
    )
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // the empty-string contract holds even when close itself throws
      }
    }
  }
}

/**
 * Synchronous single-entry append — the metadata path (titles, tags,
 * agent identity) and exit-time writers. Bypasses the queue by design:
 * these writes must survive process exit without a drain cycle. When this
 * is the first writer of a fresh session file, the transcript header lands
 * here.
 */
export function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  const fs = getFsImplementation()
  const line = encodeTranscriptLine(fullPath, entry).line
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    // Missing parent directories — create the path and retry the append; a
    // second failure propagates NAMED (see describeTranscriptStoreFailure).
    // The fs seam's mkdirSync is recursive BY CONTRACT (fsOperations.ts
    // hardcodes recursive:true), so a multi-level missing chain is covered
    // without passing the option.
    try {
      fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
      fs.appendFileSync(fullPath, line, { mode: 0o600 })
    } catch (error) {
      throw describeTranscriptStoreFailure(fullPath, error)
    }
  }
}

/**
 * Name a transcript-store write failure (FC-037): the raw filesystem errno
 * used to escape to the operator and abort the run with the cause unnamed —
 * the transcript never mentioned, the --no-session-persistence escape hatch
 * never offered. The original error rides as `cause`.
 */
function describeTranscriptStoreFailure(filePath: string, error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  return new Error(
    `the session transcript store is unwritable (${dirname(filePath)}): ${raw}. ` +
      `Repair the directory, or run with --no-session-persistence to skip transcripts for this run.`,
    { cause: error },
  )
}
