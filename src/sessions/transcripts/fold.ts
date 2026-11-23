import type { UUID } from 'crypto'
import type { AgentId } from './ids.js'
import type {
  AttributionSnapshotEntry,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  Entry,
  FileHistorySnapshotEntry,
  PersistedWorktreeSession,
  TranscriptMessage,
  TurnEnded,
} from './transcriptEntries.js'
import type { StorageRowKind, StorageRowOf } from '../../engine/rows/storage.js'
import { isCompactBoundaryMessage } from '../../engine/message-shapes/systemMessages.js'
import type { ContentReplacementRecord } from '../../engine/tool-dispatch/toolResultStorage.js'
import { isPersistedProgressEntry } from './paths.js'
import { createTranscriptRows, transcriptRows } from './rowGraph.js'

export type TranscriptFoldState = {
  messages: Map<UUID, TranscriptMessage>
  summaries: Map<UUID, string>
  customTitles: Map<UUID, string>
  tags: Map<UUID, string>
  agentNames: Map<UUID, string>
  agentColors: Map<UUID, string>
  agentSettings: Map<UUID, string>
  sessionBriefs: Map<UUID, string>
  sessionBriefAdds: Map<UUID, string>
  prNumbers: Map<UUID, number>
  prUrls: Map<UUID, string>
  prRepositories: Map<UUID, string>
  modes: Map<UUID, 'coordinator' | 'normal'>
  advisorSwitches: Map<UUID, boolean>
  swarmSwitches: Map<UUID, boolean>
  sessionModels: Map<UUID, string>
  worktreeStates: Map<UUID, PersistedWorktreeSession | null>
  fileHistorySnapshots: Map<UUID, FileHistorySnapshotEntry>
  attributionSnapshots: Map<UUID, AttributionSnapshotEntry>
  contentReplacements: Map<UUID, ContentReplacementRecord[]>
  agentContentReplacements: Map<AgentId, ContentReplacementRecord[]>
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry | undefined
  turnEnds: Map<UUID, TurnEnded>
  turnsOpen: Map<UUID, true>
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
    sessionBriefs: new Map(),
    sessionBriefAdds: new Map(),
    prNumbers: new Map(),
    prUrls: new Map(),
    prRepositories: new Map(),
    modes: new Map(),
    advisorSwitches: new Map(),
    swarmSwitches: new Map(),
    sessionModels: new Map(),
    worktreeStates: new Map(),
    fileHistorySnapshots: new Map(),
    attributionSnapshots: new Map(),
    contentReplacements: new Map(),
    agentContentReplacements: new Map(),
    contextCollapseCommits: [],
    contextCollapseSnapshot: undefined,
    turnEnds: new Map(),
    turnsOpen: new Map(),
    progressBridge: new Map(),
  }
}

function noteRowBehindTurnEnd(state: TranscriptFoldState, row: TranscriptMessage): void {
  const ended = state.turnEnds.get(row.sessionId)
  if (ended === undefined || row.isSidechain || state.messages.has(row.uuid)) return
  if (row.type === 'attachment') ended.trailing.push(row.uuid)
  else if (row.type === 'user' || (row.type === 'assistant' && row.isApiErrorMessage !== true)) {
    state.turnEnds.delete(row.sessionId)
    state.turnsOpen.set(row.sessionId, true)
  }
}

function appendReplacements<K>(map: Map<K, ContentReplacementRecord[]>, key: K, additions: ContentReplacementRecord[]): void {
  let records = map.get(key)
  if (!records) map.set(key, records = [])
  records.push(...additions)
}

function applyMessage(st: TranscriptFoldState, entry: TranscriptMessage): void {
  const row =
    entry.parentUuid && st.progressBridge.has(entry.parentUuid)
      ? { ...entry, parentUuid: st.progressBridge.get(entry.parentUuid) ?? null }
      : entry
  noteRowBehindTurnEnd(st, row)
  transcriptRows(st.messages).set(row.uuid, row)
  if (isCompactBoundaryMessage(row)) {
    st.contextCollapseCommits.length = 0
    st.contextCollapseSnapshot = undefined
  }
}

type RowFolder = { [K in StorageRowKind]: (st: TranscriptFoldState, entry: StorageRowOf<K>) => void }

const noop = (): void => {}

const foldRow: RowFolder = {
  user: applyMessage,
  assistant: applyMessage,
  system: applyMessage,
  attachment: applyMessage,
  progress: (st, entry) => {
    if (!isPersistedProgressEntry(entry)) return
    const parent =
      entry.parentUuid && st.progressBridge.has(entry.parentUuid)
        ? st.progressBridge.get(entry.parentUuid) ?? null
        : entry.parentUuid ?? null
    st.progressBridge.set(entry.uuid, parent)
  },
  summary: (st, entry) => {
    if (entry.leafUuid) st.summaries.set(entry.leafUuid, entry.summary)
  },
  'custom-title': (st, entry) => {
    if (entry.sessionId) st.customTitles.set(entry.sessionId, entry.customTitle)
  },
  'ai-title': noop,
  'last-prompt': noop,
  'task-summary': noop,
  tag: (st, entry) => {
    if (entry.sessionId) st.tags.set(entry.sessionId, entry.tag)
  },
  'agent-name': (st, entry) => {
    if (entry.sessionId) st.agentNames.set(entry.sessionId, entry.agentName)
  },
  'agent-color': (st, entry) => {
    if (entry.sessionId) st.agentColors.set(entry.sessionId, entry.agentColor)
  },
  'agent-setting': (st, entry) => {
    if (entry.sessionId) st.agentSettings.set(entry.sessionId, entry.agentSetting)
  },
  'session-brief': (st, entry) => {
    if (!entry.sessionId) return
    if (typeof entry.brief === 'string') st.sessionBriefs.set(entry.sessionId, entry.brief)
    else st.sessionBriefs.delete(entry.sessionId)
  },
  'session-brief-add': (st, entry) => {
    if (entry.sessionId && typeof entry.briefAdd === 'string') st.sessionBriefAdds.set(entry.sessionId, entry.briefAdd)
  },
  'pr-link': (st, entry) => {
    if (!entry.sessionId) return
    st.prNumbers.set(entry.sessionId, entry.prNumber)
    st.prUrls.set(entry.sessionId, entry.prUrl)
    st.prRepositories.set(entry.sessionId, entry.prRepository)
  },
  mode: (st, entry) => {
    if (entry.sessionId) st.modes.set(entry.sessionId, entry.mode)
  },
  'advisor-switch': (st, entry) => {
    if (entry.sessionId) st.advisorSwitches.set(entry.sessionId, entry.on === true)
  },
  'swarm-switch': (st, entry) => {
    if (entry.sessionId) st.swarmSwitches.set(entry.sessionId, entry.on === true)
  },
  model: (st, entry) => {
    if (entry.sessionId && typeof entry.model === 'string' && entry.model) st.sessionModels.set(entry.sessionId, entry.model)
  },
  'worktree-state': (st, entry) => {
    if (entry.sessionId) st.worktreeStates.set(entry.sessionId, entry.worktreeSession)
  },
  'content-replacement': (st, entry) => {
    if (entry.agentId) appendReplacements(st.agentContentReplacements, entry.agentId, entry.replacements)
    else appendReplacements(st.contentReplacements, entry.sessionId, entry.replacements)
  },
  'file-history-snapshot': (st, entry) => {
    st.fileHistorySnapshots.set(entry.messageId, entry)
  },
  'attribution-snapshot': (st, entry) => {
    st.attributionSnapshots.set(entry.messageId, entry)
  },
  'speculation-accept': noop,
  'context-collapse-commit': (st, entry) => {
    st.contextCollapseCommits.push(entry)
  },
  'context-collapse-snapshot': (st, entry) => {
    st.contextCollapseSnapshot = entry
  },
  'queue-operation': noop,
  'turn-start': (st, entry) => {
    if (entry.sessionId) st.turnsOpen.set(entry.sessionId, true)
  },
  'turn-end': (st, entry) => {
    if (!entry.sessionId) return
    st.turnEnds.set(entry.sessionId, { turnId: entry.turnId, status: entry.status, trailing: [] })
    st.turnsOpen.delete(entry.sessionId)
  },
}

export function applyTranscriptEntry(st: TranscriptFoldState, entry: Entry): void {
  if (!Object.hasOwn(foldRow, entry.type)) return
  const handler = foldRow[entry.type] as (state: TranscriptFoldState, row: Entry) => void
  handler(st, entry)
}

export function finishTranscriptFold(state: TranscriptFoldState): void {
  transcriptRows(state.messages).finish()
}
