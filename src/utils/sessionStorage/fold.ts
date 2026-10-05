import type { UUID } from 'crypto'
import type { AgentId } from '../../types/ids.js'
import type {
  AttributionSnapshotEntry,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  Entry,
  FileHistorySnapshotEntry,
  PersistedWorktreeSession,
  TranscriptMessage,
} from '../../types/logs.js'
import type { StorageRowKind, StorageRowOf } from '../../rows/storage.js'
import { isCompactBoundaryMessage } from '../messages.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import { isPersistedProgressEntry } from './paths.js'
import { migrateTranscriptEntryKind } from '../../migrations/migrateTranscriptEntryKinds.js'
import { createTranscriptRows, transcriptRows } from './rowGraph.js'

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
  advisorSwitches: Map<UUID, boolean>
  sessionModels: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotEntry>
  attributionSnapshots: Map<UUID, AttributionSnapshotEntry>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  progressBridge: Map<UUID, UUID | null>
}

export function emptyFoldState(): TranscriptFoldState {
  return {
    messages: createTranscriptRows(),
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
    advisorSwitches: new Map(),
    sessionModels: new Map(),
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

function messageRow(state: TranscriptFoldState, row: TranscriptMessage): void {
  if (row.parentUuid && state.progressBridge.has(row.parentUuid)) row.parentUuid = state.progressBridge.get(row.parentUuid) ?? null
  transcriptRows(state.messages).set(row.uuid, row)
  if (isCompactBoundaryMessage(row)) {
    state.contextCollapseCommits.length = 0
    state.contextCollapseSnapshot = undefined
  }
}

function appendReplacements<K>(map: Map<K, ContentReplacementRecord[]>, key: K, additions: ContentReplacementRecord[]): void {
  let records = map.get(key)
  if (!records) map.set(key, records = [])
  records.push(...additions)
}

const foldRows = {
  user: messageRow,
  assistant: messageRow,
  attachment: messageRow,
  system: messageRow,
  progress: () => {},
  summary: (state, row) => { if (row.leafUuid) state.summaries.set(row.leafUuid, row.summary) },
  'custom-title': (state, row) => { if (row.sessionId) state.customTitles.set(row.sessionId, row.customTitle) },
  'ai-title': () => {},
  'last-prompt': () => {},
  'task-summary': () => {},
  tag: (state, row) => { if (row.sessionId) state.tags.set(row.sessionId, row.tag) },
  'agent-name': (state, row) => { if (row.sessionId) state.agentNames.set(row.sessionId, row.agentName) },
  'agent-color': (state, row) => { if (row.sessionId) state.agentColors.set(row.sessionId, row.agentColor) },
  'agent-setting': (state, row) => { if (row.sessionId) state.agentSettings.set(row.sessionId, row.agentSetting) },
  mode: (state, row) => { if (row.sessionId) state.modes.set(row.sessionId, row.mode) },
  'advisor-switch': (state, row) => { if (row.sessionId) state.advisorSwitches.set(row.sessionId, row.on === true) },
  model: (state, row) => { if (row.sessionId && typeof row.model === 'string' && row.model !== '') state.sessionModels.set(row.sessionId, row.model) },
  'worktree-state': (state, row) => { if (row.sessionId) state.worktreeStates.set(row.sessionId, row.worktreeSession) },
  'pr-link': (state, row) => {
    if (!row.sessionId) return
    state.prNumbers.set(row.sessionId, row.prNumber)
    state.prUrls.set(row.sessionId, row.prUrl)
    state.prRepositories.set(row.sessionId, row.prRepository)
  },
  'file-history-snapshot': (state, row) => { state.fileHistorySnapshots.set(row.messageId, row) },
  'attribution-snapshot': (state, row) => { state.attributionSnapshots.set(row.messageId, row) },
  'content-replacement': (state, row) => {
    if (row.agentId) appendReplacements(state.agentContentReplacements, row.agentId, row.replacements)
    else appendReplacements(state.contentReplacements, row.sessionId, row.replacements)
  },
  'context-collapse-commit': (state, row) => { state.contextCollapseCommits.push(row) },
  'context-collapse-snapshot': (state, row) => { state.contextCollapseSnapshot = row },
  'speculation-accept': () => {},
  'queue-operation': () => {},
} satisfies { [K in StorageRowKind]: (state: TranscriptFoldState, row: StorageRowOf<K>) => void }

export function applyTranscriptEntry(st: TranscriptFoldState, entry: Entry): void {
  entry = migrateTranscriptEntryKind(entry)
  if (isPersistedProgressEntry(entry)) {
    const parent = entry.parentUuid
    st.progressBridge.set(entry.uuid, parent && st.progressBridge.has(parent) ? st.progressBridge.get(parent) ?? null : parent)
    return
  }
  if (!Object.hasOwn(foldRows, entry.type)) return
  const reduce = foldRows[entry.type] as (state: TranscriptFoldState, row: Entry) => void
  reduce(st, entry)
}

export function finishTranscriptFold(state: TranscriptFoldState): void {
  transcriptRows(state.messages).finish()
}
