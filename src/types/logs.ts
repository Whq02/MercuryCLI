// ============================================================================
//  src/types/logs.ts — the in-memory transcript entry vocabulary.
//
//  The durable format is the versioned MercuryRecord envelope (src/fabric):
//  the entry codec (fabric/entryCodec) encodes these shapes at the write
//  seam and projects them back at the read seam, so the `type`
//  discriminators and per-entry field names below are STABLE — a session
//  written by one build must be readable by another. The per-line metadata
//  fields (`version`, `userType`, `entrypoint`, `cwd`, `sessionId`,
//  `gitBranch`, `slug`) ride the record's annotations and are read back by
//  resume and forensics. Mercury-only lite metadata is optional and its
//  UNDEFINED value means "unknowable", never "false".
// ============================================================================
import type { UUID } from 'crypto'
import type { AgentId } from './ids.js'
import type { Message } from './message.js'
import type { QueueOperationMessage } from './messageQueueTypes.js'
import type { ContentReplacementRecord } from '../utils/toolResultStorage.js'
import type { FileHistorySnapshot } from '../utils/fileHistory.js'

/**
 * A message as written to disk: the message plus the per-line metadata.
 * `entrypoint` distinguishes the CLI from the SDK language bindings and is
 * populated from the entrypoint environment variable; `slug` names
 * resume-adjacent files such as plans.
 */
export type SerializedMessage = Message & {
  cwd: string
  userType: string
  entrypoint?: string
  sessionId: UUID
  version: string
  gitBranch?: string
  slug?: string
}

/**
 * A transcript message adds the chain and identity fields. The optional
 * logical parent preserves the logical chain when the parent is nulled at
 * a session break; the agent id enables subagent resume; the prompt id
 * correlates user prompts with telemetry.
 */
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
  /** The leaf uuid this summary summarises. */
  leafUuid: UUID
}

/** A user-set title. Kept distinct from the AI title so user renames always
 *  win on read, metadata re-append never clobbers a rename with an
 *  ephemeral AI title, and a check-and-set on "no custom title" only
 *  matches user titles. */
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

/** Written by forking the main thread mid-turn so a process listing can
 *  show what the agent is doing rather than the last user prompt. */
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
  /** owner/repo form. */
  prRepository: string
  /** ISO timestamp of the link. */
  timestamp: string
}

/** The session mode pair (contract data; also the listing shape's mode). */
export type ModeEntry = {
  type: 'mode'
  mode: 'coordinator' | 'normal'
  sessionId: UUID
}

/**
 * The persisted worktree record: a deliberate subset of the in-memory
 * worktree session, excluding the ephemeral first-run analytics fields
 * (creation duration, sparse-paths flag). Duplicated by design — do not
 * import the in-memory type.
 */
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

/** Last-wins: entering writes the record, exiting writes null; restored on
 *  resume only if the worktree path still exists on disk. */
export type WorktreeStateEntry = {
  type: 'worktree-state'
  worktreeSession: PersistedWorktreeSession | null
  sessionId: UUID
}

/**
 * Blocks whose in-context representation was swapped for a smaller stub,
 * replayed on resume for prompt-cache stability; written once per
 * enforcement pass that replaced at least one block. An agent id means the
 * record belongs to a subagent sidechain; absence means the main thread.
 */
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

/** Character-level authorship for one file. */
export type FileAttributionState = {
  contentHash: string
  mercuryContribution: number
  mtime: number
}

export type AttributionSnapshotMessage = {
  type: 'attribution-snapshot'
  messageId: UUID
  /** The client surface the snapshot came from (contract data). */
  surface: 'cli' | 'ide' | 'web' | 'api'
  fileStates: Record<string, FileAttributionState>
  promptCount: number
  promptCountAtLastCommit: number
  permissionPromptCount: number
  permissionPromptCountAtLastCommit: number
  escapeCount: number
  escapeCountAtLastCommit: number
}

/** Persisted-record format: NO sessionId member — old records stay valid. */
export type SpeculationAcceptMessage = {
  type: 'speculation-accept'
  timestamp: string
  timeSavedMs: number
}

/**
 * Context-collapse commit: append-only, replayed in order (a later commit
 * may reference an earlier one's summary). Persists only what rebuilds the
 * splice — the archived messages are ordinary transcript messages; on
 * restore the archive list is empty and filled lazily. The maximum
 * collapse id across entries reseeds the id counter. The discriminator is
 * deliberately opaque so a descriptive name does not leak into external
 * builds through the generic transcript dispatch.
 */
export type ContextCollapseCommitEntry = {
  type: 'marble-origami-commit'
  sessionId: UUID
  collapseId: string
  /** The summary placeholder's uuid. */
  summaryUuid: string
  /** The full placeholder string. */
  summaryContent: string
  /** The plain summary text. */
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}

/**
 * Context-collapse snapshot: LAST-WINS — only the most recent is applied.
 * Staged boundaries are uuids, not collapse ids, because uuids are
 * session-stable while collapse ids reset.
 */
export type ContextCollapseSnapshotEntry = {
  type: 'marble-origami-snapshot'
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

/** Every line the session JSONL can hold. */
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

/**
 * A session as offered by listing/resume UIs. `isLite` means messages were
 * not loaded; `endedOnError` is Mercury-only and its undefined value means
 * UNKNOWABLE (e.g. a session written by another harness); `worktreeSession`
 * null means exited, undefined means never entered.
 */
export type LogOption = {
  date: string
  messages: SerializedMessage[]
  fullPath?: string
  value: number
  created: Date
  modified: Date
  firstPrompt: string
  /** Visible-message count from a FULL transcript load; absent on the lite
   *  stat/head-tail ladder, which never measures it (rows show file size
   *  instead — a count the tier never took is not claimed as 0). */
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
  /** UNWRAPPED snapshots (the chain builder strips the entry envelope). */
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

/**
 * Sort sessions by modified date descending, ties broken by created date
 * descending. Sorts IN PLACE and returns the same array.
 */
export function sortLogs(logs: LogOption[]): LogOption[] {
  return logs.sort(
    (a, b) =>
      b.modified.getTime() - a.modified.getTime() ||
      b.created.getTime() - a.created.getTime(),
  )
}
