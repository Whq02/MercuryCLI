import type { UUID } from 'crypto'
import type { Message } from './message.js'
import type { ContentReplacementRecord } from '../utils/toolResultStorage.js'
import type { FileHistorySnapshot } from '../utils/fileHistory.js'
import type { FileAttribution, StorageRowOf, StoredRow, WorktreeBinding } from '../rows/storage.js'

export type SerializedMessage = Message & {
  cwd: string
  entrypoint?: string
  sessionId: UUID
  version: string
  gitBranch?: string
  slug?: string
}

export type TranscriptMessage = SerializedMessage & {
  parentUuid: UUID | null
  logicalParentUuid?: UUID
  isSidechain: boolean
  agentId?: string
  crewName?: string
  agentName?: string
  agentColor?: string
  promptId?: string
  workload?: string
}

export type SummaryMessage = {
  [K in keyof StorageRowOf<'summary'>]: StorageRowOf<'summary'>[K]
}

export type CustomTitleMessage = {
  [K in keyof StorageRowOf<'custom-title'>]: StorageRowOf<'custom-title'>[K]
}

export type AiTitleMessage = {
  [K in keyof StorageRowOf<'ai-title'>]: StorageRowOf<'ai-title'>[K]
}

export type LastPromptMessage = {
  [K in keyof StorageRowOf<'last-prompt'>]: StorageRowOf<'last-prompt'>[K]
}

export type TaskSummaryMessage = {
  [K in keyof StorageRowOf<'task-summary'>]: StorageRowOf<'task-summary'>[K]
}

export type TagMessage = {
  [K in keyof StorageRowOf<'tag'>]: StorageRowOf<'tag'>[K]
}

export type AgentNameMessage = {
  [K in keyof StorageRowOf<'agent-name'>]: StorageRowOf<'agent-name'>[K]
}

export type AgentColorMessage = {
  [K in keyof StorageRowOf<'agent-color'>]: StorageRowOf<'agent-color'>[K]
}

export type AgentSettingMessage = {
  [K in keyof StorageRowOf<'agent-setting'>]: StorageRowOf<'agent-setting'>[K]
}

export type PRLinkMessage = {
  [K in keyof StorageRowOf<'pr-link'>]: StorageRowOf<'pr-link'>[K]
}

export type ModeEntry = {
  [K in keyof StorageRowOf<'mode'>]: StorageRowOf<'mode'>[K]
}

export type AdvisorSwitchEntry = {
  [K in keyof StorageRowOf<'advisor-switch'>]: StorageRowOf<'advisor-switch'>[K]
}

export type SessionModelEntry = {
  [K in keyof StorageRowOf<'model'>]: StorageRowOf<'model'>[K]
}

export type PersistedWorktreeSession = {
  [K in keyof WorktreeBinding]: WorktreeBinding[K]
}

export type WorktreeStateEntry = {
  [K in keyof StorageRowOf<'worktree-state'>]: StorageRowOf<'worktree-state'>[K]
}

export type ContentReplacementEntry = {
  [K in keyof StorageRowOf<'content-replacement'>]: StorageRowOf<'content-replacement'>[K]
}

export type FileHistorySnapshotMessage = {
  [K in keyof StorageRowOf<'file-history-snapshot'>]: StorageRowOf<'file-history-snapshot'>[K]
}

export type FileAttributionState = {
  [K in keyof FileAttribution]: FileAttribution[K]
}

export type AttributionSnapshotMessage = {
  [K in keyof StorageRowOf<'attribution-snapshot'>]: StorageRowOf<'attribution-snapshot'>[K]
}

export type SpeculationAcceptMessage = {
  [K in keyof StorageRowOf<'speculation-accept'>]: StorageRowOf<'speculation-accept'>[K]
}

export type ContextCollapseCommitEntry = {
  [K in keyof StorageRowOf<'context-collapse-commit'>]: StorageRowOf<'context-collapse-commit'>[K]
}

export type ContextCollapseSnapshotEntry = {
  [K in keyof StorageRowOf<'context-collapse-snapshot'>]: StorageRowOf<'context-collapse-snapshot'>[K]
}

export type Entry =
  StoredRow

export type LogOption = {
  date: string
  messages: SerializedMessage[]
  fullPath?: string
  value: number
  created: Date
  modified: Date
  firstPrompt: string
  messageCount?: number
  fileSize?: number
  isSidechain: boolean
  isLite?: boolean
  sessionId?: string
  crewName?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  isCrewmate?: boolean
  leafUuid?: UUID
  summary?: string
  customTitle?: string
  tag?: string
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  gitBranch?: string
  projectPath?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  endedOnError?: boolean
  mode?: 'coordinator' | 'normal'
  advisor?: boolean
  model?: string
  worktreeSession?: PersistedWorktreeSession | null
  contentReplacements?: ContentReplacementRecord[]
}

export function sortLogs(logs: LogOption[]): LogOption[] {
  return logs.sort(
    (a, b) =>
      b.modified.getTime() - a.modified.getTime() ||
      b.created.getTime() - a.created.getTime(),
  )
}
