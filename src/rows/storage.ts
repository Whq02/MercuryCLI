import type { UUID } from 'node:crypto'
import type { AgentId } from '../types/ids.js'
import type { TranscriptMessage } from '../types/logs.js'
import type { QueueOperationMessage } from '../types/messageQueueTypes.js'
import type { FileHistorySnapshot } from '../utils/fileHistory.js'
import type { ContentReplacementRecord } from '../utils/toolResultStorage.js'

export type WorktreeBinding = {
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

export type FileAttribution = {
  contentHash: string
  mercuryContribution: number
  mtime: number
}

type SessionField<K extends string, V> = { sessionId: UUID } & Record<K, V>

type StoragePayloads = {
  summary: { summary: string; leafUuid: UUID }
  'custom-title': SessionField<'customTitle', string>
  'ai-title': SessionField<'aiTitle', string>
  'last-prompt': SessionField<'lastPrompt', string>
  'task-summary': SessionField<'summary', string> & { timestamp: string }
  tag: SessionField<'tag', string>
  'agent-name': SessionField<'agentName', string>
  'agent-color': SessionField<'agentColor', string>
  'agent-setting': SessionField<'agentSetting', string>
  'pr-link': {
    sessionId: UUID
    prNumber: number
    prUrl: string
    prRepository: string
    timestamp: string
  }
  mode: SessionField<'mode', 'coordinator' | 'normal'>
  'advisor-switch': SessionField<'on', boolean>
  model: SessionField<'model', string>
  'worktree-state': SessionField<'worktreeSession', WorktreeBinding | null>
  'content-replacement': { sessionId: UUID; agentId?: AgentId; replacements: ContentReplacementRecord[] }
  'file-history-snapshot': { messageId: UUID; snapshot: FileHistorySnapshot; isSnapshotUpdate: boolean }
  'attribution-snapshot': {
    messageId: UUID
    surface: 'cli' | 'ide' | 'web' | 'api'
    fileStates: Record<string, FileAttribution>
    promptCount: number
    promptCountAtLastCommit: number
    permissionPromptCount: number
    permissionPromptCountAtLastCommit: number
    escapeCount: number
    escapeCountAtLastCommit: number
  }
  'speculation-accept': { timestamp: string; timeSavedMs: number }
  'context-collapse-commit': {
    sessionId: UUID
    collapseId: string
    summaryUuid: string
    summaryContent: string
    summary: string
    firstArchivedUuid: string
    lastArchivedUuid: string
  }
  'context-collapse-snapshot': {
    sessionId: UUID
    staged: Array<{ startUuid: string; endUuid: string; summary: string; risk: number; stagedAt: number }>
    armed: boolean
    lastSpawnTokens: number
  }
  'queue-operation': Omit<QueueOperationMessage, 'type'>
}

export type StorageRows = {
  [K in keyof StoragePayloads]: { type: K } & StoragePayloads[K]
} & {
  [K in TranscriptMessage['type']]: Extract<TranscriptMessage, { type: K }>
}
export type StorageRowKind = keyof StorageRows
export type StorageRowOf<K extends StorageRowKind> = StorageRows[K]
export type StoredRow = StorageRows[StorageRowKind]
export type StorageRowPolicy = {
  write: 'message' | 'append' | 'scoped' | 'ephemeral'
  fold: 'message' | 'metadata' | 'snapshot' | 'replacement' | 'collapse' | 'bridge' | 'none'
}

export const STORAGE_ROWS = {
  user: { write: 'message', fold: 'message' },
  assistant: { write: 'message', fold: 'message' },
  system: { write: 'message', fold: 'message' },
  attachment: { write: 'message', fold: 'message' },
  progress: { write: 'ephemeral', fold: 'bridge' },
  summary: { write: 'append', fold: 'metadata' },
  'custom-title': { write: 'append', fold: 'metadata' },
  'ai-title': { write: 'append', fold: 'none' },
  'last-prompt': { write: 'append', fold: 'none' },
  'task-summary': { write: 'append', fold: 'none' },
  tag: { write: 'append', fold: 'metadata' },
  'agent-name': { write: 'append', fold: 'metadata' },
  'agent-color': { write: 'append', fold: 'metadata' },
  'agent-setting': { write: 'append', fold: 'metadata' },
  'pr-link': { write: 'append', fold: 'metadata' },
  mode: { write: 'append', fold: 'metadata' },
  'advisor-switch': { write: 'append', fold: 'metadata' },
  model: { write: 'append', fold: 'metadata' },
  'worktree-state': { write: 'append', fold: 'metadata' },
  'content-replacement': { write: 'scoped', fold: 'replacement' },
  'file-history-snapshot': { write: 'append', fold: 'snapshot' },
  'attribution-snapshot': { write: 'append', fold: 'snapshot' },
  'speculation-accept': { write: 'append', fold: 'none' },
  'context-collapse-commit': { write: 'append', fold: 'collapse' },
  'context-collapse-snapshot': { write: 'append', fold: 'collapse' },
  'queue-operation': { write: 'append', fold: 'none' },
} as const satisfies Record<StorageRowKind, StorageRowPolicy>

export function storageRowPolicy(kind: string): StorageRowPolicy | undefined {
  return Object.hasOwn(STORAGE_ROWS, kind) ? STORAGE_ROWS[kind as StorageRowKind] : undefined
}

export const EPHEMERAL_STORAGE_PROGRESS: ReadonlySet<string> = new Set([
  'bash_progress',
  'powershell_progress',
  'mcp_progress',
])
