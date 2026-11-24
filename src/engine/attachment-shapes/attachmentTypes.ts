import type { ContentBlockParam } from '../message-shapes/wire.js'
import type { ReadResourceResult } from '../../integrations/mcp-shapes/sdk.js'
import type { UUID } from 'crypto'
import type { HookEvent } from '../../integrations/event-hooks/contract.js'
import type { BoundPrefixSection, BoundPrefixToolMark, DeadThinkingMark, MessageOrigin } from 'src/engine/message-shapes/message.js'
import type { BypassedAskRoad, PermissionMode } from '../../permissions/rules/permissions.js'
import type { DiagnosticFile } from '../../integrations/lsp/diagnosticTracking.js'
import type { DiscoverySignal } from '../../integrations/skill-search/skillDiscovery.js'
import type { TaskType } from '../tasks/taskBase.js'
import type { FileReadOutput } from './fileReadOutput.js'
import type { InstructionSourceEntry } from '../../sessions/instruction-contracts/contracts.js'
import type { Task } from '../task-framework/tasks.js'
import type { CapsuleSectionName } from './capsuleKinds.js'

export type CapsuleWorkingRef = {
  reason: 'read' | 'mentioned' | 'edited' | 'instructions'
  ref: string; path: string
}
export type CapsuleSection = {
  name: CapsuleSectionName
  kinds: Array<keyof AttachmentBodies>
  content: ContentBlockParam[]
}
export type AgentRosterRow = {
  taskId: string
  taskType: TaskType
  name: string
  address: string | null
  status: string
  wait: string | null
  description: string
  owed: string | null
  error: string | null
  outputFilePath?: string
  phase?: string
  agents?: Array<{ label: string; state: string }>
}

type FileLocation = { filename: string; displayPath: string }
type ReadFileBody = FileLocation & { content: FileReadOutput; truncated?: boolean }
type PathLocation = { path: string; displayPath: string }
type RosterDelta = { addedNames: string[]; removedNames: string[] }

type FileBodies = {
  file: ReadFileBody
  already_read_file: ReadFileBody
  compact_file_reference: FileLocation
  pdf_reference: FileLocation & { pageCount: number; fileSize: number }
  dropped_image_file: FileLocation & { reason: string; unread?: 'retry' | 'refused' }
  directory: PathLocation & { content: string }
  edited_text_file: { filename: string; snippet: string }
  edited_image_file: { filename: string; content: FileReadOutput }
  diagnostics: { files: DiagnosticFile[]; isNew: boolean }
  mcp_resource: { server: string; uri: string; name: string; description?: string; content: ReadResourceResult }
}

type ContextBodies = {
  nested_memory: PathLocation & { content: InstructionSourceEntry }
  current_session_memory: { path: string; content: string; tokenCount: number }
  context_capsule: {
    markdown: string; digest: string; refs: string[]; delta: string | null
    semDigest?: string; sectionDigest?: string; baseDigest?: string
    sections?: CapsuleSection[]; workingSet?: CapsuleWorkingRef[]
  }
  user_context: { body: string; context?: Record<string, string> }
  critical_system_reminder: { content: string }
  date_change: { newDate: string }
  context_efficiency: Record<never, never>
  bound_prefix: {
    boundKey: string; rosterEnabled: boolean; roster: BoundPrefixToolMark[]
    sections: BoundPrefixSection[]; systemContext: Record<string, string>
    userContext?: Record<string, string>
  }
  dead_thinking: { dead: DeadThinkingMark[] }
  dropped_thinking: { dropped: DeadThinkingMark[] }
}

type CapabilityBodies = {
  agent_mention: { agentType: string }
  samples_road: { on: boolean }
  agent_roster: { rows: AgentRosterRow[] }
  dynamic_skill: { skillDir: string; skillNames: string[]; displayPath: string }
  invoked_skills: { skills: Array<{ name: string; path: string; content: string }> }
  skill_listing: {
    content: string; skillCount: number; isInitial: boolean; removedNames?: string[]
    truncation?: { budgetChars: number; nameOnly: number; withheld: number } | null
  }
  skill_discovery: { skills: Array<{ name: string; description: string; shortId?: string }>; signal: DiscoverySignal; source: 'native' | 'aki' | 'both' }
  deferred_tools_delta: RosterDelta & { body?: string; addedLines: string[] }
  mcp_instructions_delta: RosterDelta & { addedBlocks: string[] }
  mcp_servers_failed: { servers: Array<{ name: string; reason: string }>; body: string }
  held_tools: { names: string[]; body: string }
  tool_schema_delta: { tools: Array<{ name: string; digest: string }>; body: string }
  harness_map_delta: { added: string[]; removed: string[] }
  command_permissions: { allowedTools: string[]; model?: string }
}

type TurnBodies = {
  queued_command: {
    prompt: string | ContentBlockParam[]; source_uuid?: UUID; imagePasteIds?: number[]
    commandMode?: string; origin?: MessageOrigin; isMeta?: boolean; sentAt?: string; deliveredAt?: string
    boardEventIds?: string[]
  }
  compact_operator_messages: { messages: Array<{ ordinal: number; text: string; truncated?: boolean }>; omitted: number }
  task_reminder: { content: Task[]; itemCount: number }
  verify_plan_reminder: Record<never, never>
  hook: { outcome: HookRowOutcome; event: HookEvent; name: string; words: string; callId?: string; background?: true }
  bypassed_ask: { toolUseID: string; mode: PermissionMode; road: BypassedAskRoad; reason: string }
  mode_pack: { mode: 'apollo'; text: string }
  mode_pack_exit: { mode: 'apollo'; reason?: string }
  structured_output: { data: unknown }
  max_turns_reached: { maxTurns: number; turnCount: number }
  loop_stopped: { toolUseID: string; cycle: string[]; message: string }
  budget_usd: { used: number; total: number; remaining: number }
  output_token_usage: { turn: number; session: number; budget: number | null }
  usage_limit_notice: { key: string; provider: string; window: string; pct: number; resetsAt?: number; text: string }
  mission_status: { text: string; checks: number; state: 'armed' | 'paused'; verdict?: string }
  images_left_out: { count: number; images: number; sidePx: number }
  bagel_console: { errorCount: number; warningCount: number; sample: string }
}

type AttachmentBodies = FileBodies & ContextBodies & CapabilityBodies & TurnBodies
type AttachmentRow<Kind extends keyof AttachmentBodies> = { type: Kind } & AttachmentBodies[Kind]
export type Attachment = {
  [Kind in keyof AttachmentBodies]: AttachmentRow<Kind> & { capsuleReceipt?: string }
}[keyof AttachmentBodies]

export type FileAttachment = AttachmentRow<'file'>
export type AlreadyReadFileAttachment = AttachmentRow<'already_read_file'>
export type FoldFileReferenceAttachment = AttachmentRow<'compact_file_reference'>
export type PDFReferenceAttachment = AttachmentRow<'pdf_reference'>
export type DroppedImageAttachment = AttachmentRow<'dropped_image_file'>
export type AgentRosterAttachment = AttachmentRow<'agent_roster'>
export type HookAttachment = AttachmentRow<'hook'>
export type BypassedAskAttachment = AttachmentRow<'bypassed_ask'>

export const HOOK_ROW_OUTCOMES = ['context', 'block', 'stop', 'notice', 'failed', 'text'] as const
export type HookRowOutcome = (typeof HOOK_ROW_OUTCOMES)[number]
export const TASK_REMINDER_CONFIG = { TURNS_SINCE_WRITE: 10, TURNS_BETWEEN_REMINDERS: 10 } as const
export const FLOW_ATTACHMENT_CONFIG = { TURNS_BETWEEN_ATTACHMENTS: 5, FULL_REMINDER_EVERY_N_ATTACHMENTS: 5 } as const
