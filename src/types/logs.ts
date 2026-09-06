import type { UUID } from 'crypto'
import type { AgentId } from './ids.js'
import type { Message } from './message.js'
import type { QueueOperationMessage } from './messageQueueTypes.js'
import type { ContentReplacementRecord } from '../utils/toolResultStorage.js'
import type { FileHistorySnapshot } from '../utils/fileHistory.js'

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
  teamName?: string
  agentName?: string
  agentColor?: string
  promptId?: string
}

export type SummaryMessage = {
  type: 'summary'
  summary: string
  leafUuid: UUID
}

export type CustomTitleMessage = {
  type: 'custom-title'
  customTitle: string
  sessionId: UUID
}

export type AiTitleMessage = {
  type: 'ai-title'
  aiTitle: string
  sessionId: UUID
}

export type LastPromptMessage = {
  type: 'last-prompt'
  lastPrompt: string
  sessionId: UUID
}

export type TaskSummaryMessage = {
  type: 'task-summary'
  summary: string
  sessionId: UUID
  timestamp: string
}

export type TagMessage = {
  type: 'tag'
  tag: string
  sessionId: UUID
}

export type AgentNameMessage = {
  type: 'agent-name'
  agentName: string
  sessionId: UUID
}

export type AgentColorMessage = {
  type: 'agent-color'
  agentColor: string
  sessionId: UUID
}

export type AgentSettingMessage = {
  type: 'agent-setting'
  agentSetting: string
  sessionId: UUID
}

export type PRLinkMessage = {
  type: 'pr-link'
  sessionId: UUID
  prNumber: number
  prUrl: string
  prRepository: string
  timestamp: string
}

export type ModeEntry = {
  type: 'mode'
  mode: 'coordinator' | 'normal'
  sessionId: UUID
}

export type PersistedWorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
}

export type WorktreeStateEntry = {
  type: 'worktree-state'
  worktreeSession: PersistedWorktreeSession | null
  sessionId: UUID
}

export type ContentReplacementEntry = {
  type: 'content-replacement'
  sessionId: UUID
  agentId?: AgentId
  replacements: ContentReplacementRecord[]
}

export type FileHistorySnapshotMessage = {
  type: 'file-history-snapshot'
  messageId: UUID
  snapshot: FileHistorySnapshot
  isSnapshotUpdate: boolean
}

export type FileAttributionState = {
  contentHash: string
  mercuryContribution: number
  mtime: number
}

export type AttributionSnapshotMessage = {
  type: 'attribution-snapshot'
  messageId: UUID
  surface: 'cli' | 'ide' | 'web' | 'api'
  fileStates: Record<string, FileAttributionState>
  promptCount: number
  promptCountAtLastCommit: number
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  escapeCount: number
  escapeCountAtLastCommit: number
}

export type SpeculationAcceptMessage = {
  type: 'speculation-accept'
  timestamp: string
  timeSavedMs: number
}

export type ContextCollapseCommitEntry = {
  type: 'context-collapse-commit'
  sessionId: UUID
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}

export type ContextCollapseSnapshotEntry = {
  type: 'context-collapse-snapshot'
  sessionId: UUID
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}

export type Entry =
  | TranscriptMessage
  | SummaryMessage
  | CustomTitleMessage
  | AiTitleMessage
  | LastPromptMessage
  | TaskSummaryMessage
  | TagMessage
  | AgentNameMessage
  | AgentColorMessage
  | AgentSettingMessage
  | PRLinkMessage
  | ModeEntry
  | WorktreeStateEntry
  | ContentReplacementEntry
  | FileHistorySnapshotMessage
  | AttributionSnapshotMessage
  | SpeculationAcceptMessage
  | ContextCollapseCommitEntry
  | ContextCollapseSnapshotEntry
  | QueueOperationMessage

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
  teamName?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  isTeammate?: boolean
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
