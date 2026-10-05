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

export type AdvisorSwitchEntry = {
  [K in keyof StorageRowOf<'advisor-switch'>]: StorageRowOf<'advisor-switch'>[K]
}

export type SessionModelEntry = {
  [K in keyof StorageRowOf<'model'>]: StorageRowOf<'model'>[K]
}

export type PersistedWorktreeSession = {
  [K in keyof WorktreeBinding]: WorktreeBinding[K]
}

export type ContentReplacementEntry = {
  [K in keyof StorageRowOf<'content-replacement'>]: StorageRowOf<'content-replacement'>[K]
}

export type FileHistorySnapshotEntry = {
  [K in keyof StorageRowOf<'file-history-snapshot'>]: StorageRowOf<'file-history-snapshot'>[K]
}

export type FileAttributionState = {
  [K in keyof FileAttribution]: FileAttribution[K]
}

export type AttributionSnapshotEntry = {
  [K in keyof StorageRowOf<'attribution-snapshot'>]: StorageRowOf<'attribution-snapshot'>[K]
}

export type ContextCollapseCommitEntry = {
  [K in keyof StorageRowOf<'context-collapse-commit'>]: StorageRowOf<'context-collapse-commit'>[K]
}

export type ContextCollapseSnapshotEntry = {
  [K in keyof StorageRowOf<'context-collapse-snapshot'>]: StorageRowOf<'context-collapse-snapshot'>[K]
}

export type Entry =
  StoredRow

export type SessionListing = {
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
  attributionSnapshots?: AttributionSnapshotEntry[]
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

export function sortSessionListings(logs: SessionListing[]): SessionListing[] {
  return logs.sort(
    (a, b) =>
      b.modified.getTime() - a.modified.getTime() ||
      b.created.getTime() - a.created.getTime(),
  )
}
