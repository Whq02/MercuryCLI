// sessionStorage/fold — the transcript fold kernel: the accumulated state
// one entry at a time. One entry fold (applyTranscriptEntry) serves the
// full parse, the snapshot-plus-tail fast path, the incremental reader's
// growth reads and the point-in-time materialization, so no two roads can
// disagree about what a line means. Pure: no IO, no logging.
// Mercury-owned.

import type { UUID } from 'crypto'
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
import { isCompactBoundaryMessage } from '../messages.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import { isPersistedProgressEntry, isTranscriptMessage } from './paths.js'

/** Everything the per-entry fold accumulates BEFORE the post-passes
 *  (relinks, snip replay, leaf computation) run. The resume snapshot
 *  serializes exactly this shape, so the next load folds only the
 *  appended tail. */
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
