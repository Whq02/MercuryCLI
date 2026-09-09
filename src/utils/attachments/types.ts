
import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '../../types/wire.js'
import type { ReadResourceResult } from '../../services/mcp/sdk.js'
import type { UUID } from 'crypto'
import type {
  HookEvent,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { BoundPrefixSection, BoundPrefixToolMark, DeadThinkingMark, MessageOrigin } from 'src/types/message.js'
import type { BypassedAskRoad, PermissionMode } from '../../types/permissions.js'
import type { DiagnosticFile } from '../../services/diagnosticTracking.js'
import type { DiscoverySignal } from '../../services/skillSearch/signals.js'
import type { TaskStatus, TaskType } from '../../Task.js'
import type { Output as FileReadToolOutput } from '../../tools/FileReadTool/FileReadTool.js'
import type { InstructionSourceEntry } from '../../services/instructions/contracts.js'
import type { EffortLevel } from '../effort.js'
import type { HookBlockingError } from '../hooks.js'
import type { Task } from '../tasks.js'

export const TASK_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export const CONTRACT_REMINDER_CONFIG = {
  TURNS_SINCE_TOUCH: 12,
  TURNS_BETWEEN_REMINDERS: 12,
} as const

export const PLAN_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

export const AUTO_MODE_ATTACHMENT_CONFIG = {
  TURNS_BETWEEN_ATTACHMENTS: 5,
  FULL_REMINDER_EVERY_N_ATTACHMENTS: 5,
} as const

export const RELEVANT_MEMORIES_CONFIG = {
  MAX_SESSION_BYTES: 60 * 1024,
} as const

export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export type FileAttachment = {
  type: 'file'
  filename: string
  content: FileReadToolOutput
  truncated?: boolean
  displayPath: string
}

export type CompactFileReferenceAttachment = {
  type: 'compact_file_reference'
  filename: string
  displayPath: string
}

export type PDFReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  pageCount: number
  fileSize: number
  displayPath: string
}

export type AlreadyReadFileAttachment = {
  type: 'already_read_file'
  filename: string
  content: FileReadToolOutput
  truncated?: boolean
  displayPath: string
}

export type AgentMentionAttachment = {
  type: 'agent_mention'
  agentType: string
}

export type AsyncHookResponseAttachment = {
  type: 'async_hook_response'
  processId: string
  hookName: string
  hookEvent: HookEvent | 'FileSuggestion'
  toolName?: string
  response: SyncHookJSONOutput
  stdout: string
  stderr: string
  exitCode?: number
}

export type HookAttachment =
  | HookCancelledAttachment
  | {
      type: 'hook_blocking_error'
      blockingError: HookBlockingError
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookNonBlockingErrorAttachment
  | HookErrorDuringExecutionAttachment
  | {
      type: 'hook_stopped_continuation'
      message: string
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookSuccessAttachment
  | {
      type: 'hook_additional_context'
      content: string[]
      hookName: string
      toolUseID: string
      hookEvent: HookEvent
    }
  | HookSystemMessageAttachment
  | HookPermissionDecisionAttachment

export type HookPermissionDecisionAttachment = {
  type: 'hook_permission_decision'
  decision: 'allow' | 'deny'
  toolUseID: string
  hookEvent: HookEvent
}

export type BypassedAskAttachment = {
  type: 'bypassed_ask'
  toolUseID: string
  mode: PermissionMode
  road: BypassedAskRoad
  reason: string
}

export type HookSystemMessageAttachment = {
  type: 'hook_system_message'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
}

export type HookCancelledAttachment = {
  type: 'hook_cancelled'
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type HookErrorDuringExecutionAttachment = {
  type: 'hook_error_during_execution'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type HookSuccessAttachment = {
  type: 'hook_success'
  content: string
  hookName: string
  toolUseID: string
  hookEvent: HookEvent
  stdout?: string
  stderr?: string
  exitCode?: number
  command?: string
  durationMs?: number
}

export type HookNonBlockingErrorAttachment = {
  type: 'hook_non_blocking_error'
  hookName: string
  stderr: string
  stdout: string
  exitCode: number
  toolUseID: string
  hookEvent: HookEvent
  command?: string
  durationMs?: number
}

export type Attachment =
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  | {
      type: 'edited_text_file'
      filename: string
      snippet: string
    }
  | {
      type: 'edited_image_file'
      filename: string
      content: FileReadToolOutput
    }
  | {
      type: 'directory'
      path: string
      content: string
      displayPath: string
    }
  | {
      type: 'selected_lines_in_ide'
      ideName: string
      lineStart: number
      lineEnd: number
      filename: string
      content: string
      displayPath: string
    }
  | {
      type: 'opened_file_in_ide'
      filename: string
    }
  | {
      type: 'task_reminder'
      content: Task[]
      itemCount: number
    }
  | {
      type: 'contract_reminder'
      text: string
      status: string
      amendments: number
      ackOwed: boolean
    }
  | {
      type: 'nested_memory'
      path: string
      content: InstructionSourceEntry
      displayPath: string
    }
  | {
      type: 'relevant_memories'
      memories: {
        path: string
        content: string
        mtimeMs: number
        header?: string
        limit?: number
        rawContent?: string
      }[]
    }
  | {
      type: 'dynamic_skill'
      skillDir: string
      skillNames: string[]
      displayPath: string
    }
  | {
      type: 'skill_listing'
      content: string
      skillCount: number
      isInitial: boolean
      removedNames?: string[]
      truncation?: { budgetChars: number; nameOnly: number; withheld: number } | null
    }
  | {
      type: 'skill_discovery'
      skills: { name: string; description: string; shortId?: string }[]
      signal: DiscoverySignal
      source: 'native' | 'aki' | 'both'
    }
  | {
      type: 'queued_command'
      prompt: string | Array<ContentBlockParam>
      source_uuid?: UUID
      imagePasteIds?: number[]
      commandMode?: string
      origin?: MessageOrigin
      isMeta?: boolean
    }
  | {
      type: 'diagnostics'
      files: DiagnosticFile[]
      isNew: boolean
    }
  | {
      type: 'plan_mode'
      reminderType: 'full' | 'sparse'
      isSubAgent?: boolean
      planFilePath: string
      planExists: boolean
    }
  | {
      type: 'plan_mode_reentry'
      planFilePath: string
    }
  | {
      type: 'plan_mode_exit'
      planFilePath: string
      planExists: boolean
    }
  | {
      type: 'auto_mode'
      reminderType: 'full' | 'sparse'
    }
  | {
      type: 'auto_mode_exit'
    }
  | {
      type: 'mode_pack'
      mode: 'apollo' | 'autopilot'
      text: string
    }
  | {
      type: 'mode_pack_exit'
      mode: 'apollo' | 'autopilot'
      reason?: string
    }
  | {
      type: 'repo_surface_map'
      markdown: string
    }
  | {
      type: 'context_capsule'
      markdown: string
      digest: string
      semDigest?: string
      refs: string[]
      delta: string | null
    }
  | {
      type: 'ultra_effort'
      reminderType: 'full' | 'sparse'
    }
  | {
      type: 'ultra_effort_exit'
    }
  | {
      type: 'supercode_keyword'
    }
  | {
      type: 'critical_system_reminder'
      content: string
    }
  | {
      type: 'taste_recall'
      content: string
    }
  | {
      type: 'plan_file_reference'
      planFilePath: string
      planContent: string
    }
  | {
      type: 'mcp_resource'
      server: string
      uri: string
      name: string
      description?: string
      content: ReadResourceResult
    }
  | {
      type: 'command_permissions'
      allowedTools: string[]
      model?: string
    }
  | AgentMentionAttachment
  | {
      type: 'task_status'
      taskId: string
      taskType: TaskType
      status: TaskStatus
      description: string
      deltaSummary: string | null
      outputFilePath?: string
    }
  | AgentRosterAttachment
  | AsyncHookResponseAttachment
  | {
      type: 'token_usage'
      used: number
      total: number
      remaining: number
    }
  | {
      type: 'budget_usd'
      used: number
      total: number
      remaining: number
    }
  | {
      type: 'output_token_usage'
      turn: number
      session: number
      budget: number | null
    }
  | {
      type: 'structured_output'
      data: unknown
    }
  | TeammateMailboxAttachment
  | TeamContextAttachment
  | HookAttachment
  | BypassedAskAttachment
  | {
      type: 'invoked_skills'
      skills: Array<{
        name: string
        path: string
        content: string
      }>
    }
  | {
      type: 'verify_plan_reminder'
    }
  | {
      type: 'max_turns_reached'
      maxTurns: number
      turnCount: number
    }
  | {
      type: 'repetition_breaker'
      toolName: string
      outcome: 'failure' | 'success'
      streak: number
      cause: string
    }
  | {
      type: 'cycle_handoff'
      cause: string
      unfinished: string[]
      report: string
    }
  | {
      type: 'current_session_memory'
      content: string
      path: string
      tokenCount: number
    }
  | {
      type: 'teammate_shutdown_batch'
      count: number
    }
  | {
      type: 'compaction_reminder'
    }
  | {
      type: 'context_efficiency'
    }
  | {
      type: 'date_change'
      newDate: string
    }
  | {
      type: 'deepthink_effort'
    }
  | {
      type: 'deferred_tools_delta'
      addedNames: string[]
      addedLines: string[]
      removedNames: string[]
    }
  | {
      type: 'bound_prefix'
      boundKey: string
      rosterEnabled: boolean
      roster: BoundPrefixToolMark[]
      sections: BoundPrefixSection[]
      systemContext: Record<string, string>
    }
  | {
      type: 'dead_thinking'
      dead: DeadThinkingMark[]
    }
  | {
      type: 'agent_listing_delta'
      addedTypes: string[]
      addedLines: string[]
      removedTypes: string[]
      isInitial: boolean
      showConcurrencyNote: boolean
    }
  | {
      type: 'mcp_instructions_delta'
      addedNames: string[]
      addedBlocks: string[]
      removedNames: string[]
    }
  | {
      type: 'run_protocol_delta'
      tools: string[]
      body: string
    }
  | {
      type: 'harness_map_delta'
      added: string[]
      removed: string[]
    }
  | {
      type: 'lane_boundary'
      laneId: string
      goal: string
      boundary: string
    }
  | {
      type: 'bagel_console'
      errorCount: number
      warningCount: number
      sample: string
    }
  | {
      type: 'user_context'
      body: string
    }

export type TeammateMailboxAttachment = {
  type: 'teammate_mailbox'
  messages: Array<{
    from: string
    text: string
    timestamp: string
    color?: string
    summary?: string
  }>
}

export type TeamContextAttachment = {
  type: 'team_context'
  agentId: string
  agentName: string
  teamName: string
  teamConfigPath: string
  taskListPath: string
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

export type AgentRosterAttachment = {
  type: 'agent_roster'
  rows: AgentRosterRow[]
}
