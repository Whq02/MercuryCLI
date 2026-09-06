
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
import { migrateTranscriptEntryKind } from '../../migrations/migrateTranscriptEntryKinds.js'

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

export function applyTranscriptEntry(st: TranscriptFoldState, entry: Entry): void {
  entry = migrateTranscriptEntryKind(entry)
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
  } else if (entry.type === 'context-collapse-commit') {
    contextCollapseCommits.push(entry)
  } else if (entry.type === 'context-collapse-snapshot') {
    st.contextCollapseSnapshot = entry
  }
}
