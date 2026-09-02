// Attachment vocabulary — the Attachment union, every member type, and the
// exported reminder/config constants. Submodules import types from HERE (never the barrel —
// no cycles); the barrel re-exports the whole vocabulary unchanged.

import type { Base64ImageSource, ContentBlockParam, ImageBlockParam } from '../../types/wire.js'
import type { ReadResourceResult } from '../../services/mcp/sdk.js'
import type { UUID } from 'crypto'
import type {
  HookEvent,
  SyncHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'
import type { MessageOrigin } from 'src/types/message.js'
import type { DiagnosticFile } from '../../services/diagnosticTracking.js'
import type { DiscoverySignal } from '../../services/skillSearch/signals.js'
import type { TaskStatus, TaskType } from '../../Task.js'
import type { Output as FileReadToolOutput } from '../../tools/FileReadTool/FileReadTool.js'
import type { InstructionSourceEntry } from '../../services/instructions/contracts.js'
import type { EffortLevel } from '../effort.js'
import type { HookBlockingError } from '../hooks.js'
import type { Task } from '../tasks.js'
import type { TodoList } from '../todo/types.js'

export const TODO_REMINDER_CONFIG = {
  TURNS_SINCE_WRITE: 10,
  TURNS_BETWEEN_REMINDERS: 10,
} as const

/** WARM RE-SURFACING (coordinator-tooling T3, mechanism 1): the contract
 *  rides the agent's context at birth (a session with a contract and no
 *  reminder yet surfaces IMMEDIATELY — drift is context fade, and the fix
 *  is re-injection, no agent action needed) and re-enters on this cadence
 *  as the session runs long. Touching the contract tool resets the clock —
 *  an agent holding its agreement warm is never nagged. */
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
  // The per-turn cap (five files × 4KB) bounds one injection, but a long
  // session keeps finding NEW files to surface — tens of thousands of
  // tokens per session in production measurement. This session-cumulative
  // byte ceiling ends prefetching outright once ~3 full injections have
  // landed; by then the memories that matter are in context. The counter
  // is derived by scanning the transcript, not tracked on toolUseContext,
  // precisely so compaction resets it: the old attachments left context,
  // and surfacing them again became legitimate.
  MAX_SESSION_BYTES: 60 * 1024,
} as const

export const VERIFY_PLAN_REMINDER_CONFIG = {
  TURNS_BETWEEN_REMINDERS: 10,
} as const

export type FileAttachment = {
  type: 'file'
  filename: string
  content: FileReadToolOutput
  /** True when size limits clipped the content below. */
  truncated?: boolean
  /** CWD-relative path captured at creation, so display never shifts with later cd. */
  displayPath: string
}

export type CompactFileReferenceAttachment = {
  type: 'compact_file_reference'
  filename: string
  /** CWD-relative path captured at creation, so display never shifts with later cd. */
  displayPath: string
}

export type PDFReferenceAttachment = {
  type: 'pdf_reference'
  filename: string
  pageCount: number
  fileSize: number
  /** CWD-relative path captured at creation, so display never shifts with later cd. */
  displayPath: string
}

export type AlreadyReadFileAttachment = {
  type: 'already_read_file'
  filename: string
  content: FileReadToolOutput
  /** True when size limits clipped the content below. */
  truncated?: boolean
  /** CWD-relative path captured at creation, so display never shifts with later cd. */
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
  /** The operator @-mentioned this file. */
  | FileAttachment
  | CompactFileReferenceAttachment
  | PDFReferenceAttachment
  | AlreadyReadFileAttachment
  /** An @-mentioned file changed on disk after it was read. */
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
      /** CWD-relative path captured at creation, so display never shifts with later cd. */
      displayPath: string
    }
  | {
      type: 'selected_lines_in_ide'
      ideName: string
      lineStart: number
      lineEnd: number
      filename: string
      content: string
      /** CWD-relative path captured at creation, so display never shifts with later cd. */
      displayPath: string
    }
  | {
      type: 'opened_file_in_ide'
      filename: string
    }
  | {
      type: 'todo_reminder'
      content: TodoList
      itemCount: number
    }
  | {
      type: 'task_reminder'
      content: Task[]
      itemCount: number
    }
  | {
      // The session's ADVISORY contract, re-surfaced (coordinator-tooling
      // T3: warm at birth + periodic on long sessions). Never a gate.
      type: 'contract_reminder'
      text: string
      status: string
      amendments: number
      /** The worker's acknowledgment is owed (draft/amended). */
      ackOwed: boolean
    }
  | {
      type: 'nested_memory'
      path: string
      content: InstructionSourceEntry
      /** CWD-relative path captured at creation, so display never shifts with later cd. */
      displayPath: string
    }
  | {
      type: 'relevant_memories'
      memories: {
        path: string
        content: string
        mtimeMs: number
        /**
         * The header (freshness + path), frozen at attachment-creation
         * time. Freezing is what keeps the rendered bytes turn-stable:
         * a render-time memoryAge(mtimeMs) reads Date.now(), and the day
         * "saved 3 days ago" ticks to "saved 4 days ago" the bytes
         * change and the prompt cache busts. Optional because resumed
         * sessions may carry attachments minted before this field
         * existed — the renderer recomputes for those.
         */
        header?: string
        /**
         * Present only when readMemoriesForSurfacing clipped the file: the
         * line count actually read. It rides into the readFileState entry
         * so change detection knows to skip this file — diffing against a
         * partial view would fabricate edits.
         */
        limit?: number
        /**
         * Raw on-disk bytes when the surfaced `content` is a FRAMED view that
         * differs from disk (the experience-card banner). Cached as the
         * readFileState diff baseline (with isPartialView) so getChangedFiles
         * compares the RAW file against disk — not the banner-wrapped text, which
         * would otherwise read as a spurious "edited" diff every turn.
         */
        rawContent?: string
      }[]
    }
  | {
      type: 'dynamic_skill'
      skillDir: string
      skillNames: string[]
      /** CWD-relative path captured at creation, so display never shifts with later cd. */
      displayPath: string
    }
  | {
      type: 'skill_listing'
      content: string
      skillCount: number
      isInitial: boolean
      /** Skills that LEFT the model-facing roster since the last listing
       *  (dialled to off or invocable, file removed, MCP server gone) —
       *  the removal arm the three sibling deltas always had (FN-013
       *  MCP-01: de-apply was invisible; the model kept selecting a skill
       *  it could only discover was gone by calling it). Optional because
       *  persisted listings predate the field; producers always set it. */
      removedNames?: string[]
      /** The budget's degradation record (FN-013 MCP-05): present exactly
       *  when the listing lost descriptions (name-only entries) or whole
       *  names (withheld) — a within-budget listing carries none. Optional
       *  because persisted listings predate the field. */
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
      /** Which queue lane this came from: an operator prompt or a system task-notification. */
      commandMode?: string
      /** The QueuedCommand's origin, kept intact through a mid-turn drain. */
      origin?: MessageOrigin
      /** QueuedCommand.isMeta, forwarded: true marks system-injected text, absent marks a human's. */
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
      // Fast onboarding (fork, MERCURY_ONBOARDING): the auto-derived repo
      // surface map, injected ONCE on the first turn in a repo that carries
      // no orientation doc (MERCURY.md, AGENTS.md or CLAUDE.md). Structure-only
      // by construction (repoSurfaceMap.ts).
      type: 'repo_surface_map'
      markdown: string
    }
  | {
      // MERCURY_PROJECT_INTEL: the task-scoped working set —
      // stable refs with role/reason/freshness, deterministic assembly
      // (projectIntel/capsule.ts). Dedup cursor = the thread's own message
      // history (last visible context_capsule digest): unchanged ⇒ never
      // re-attached; compaction/resume naturally re-attach; `delta` names
      // what changed vs the prior capsule when one existed.
      type: 'context_capsule'
      markdown: string
      digest: string
      /** Semantic identity: task+goal+marks — the churn law
       *  skips removals-only recency drift when this is unchanged. */
      semDigest?: string
      refs: string[]
      delta: string | null
    }
  | {
      // Supercode MODE standing reminder (fork): fires while
      // AppState.supercode is on (full first, sparse after), and
      // ultra_effort_exit fires once on flip-off.
      type: 'ultra_effort'
      reminderType: 'full' | 'sparse'
    }
  | {
      type: 'ultra_effort_exit'
    }
  | {
      // Per-TURN supercode keyword opt-in (fork). The submitted prompt carried
      // a triggerable `supercode` (keywordTrigger/supercode.ts skip rules) —
      // the keyword's confirming system-reminder, an explicit one-turn
      // opt-in to dynamic workflow orchestration. Distinct from the standing
      // /effort supercode MODE (ultra_effort above). Model-only (NULL_RENDERING).
      type: 'supercode_keyword'
    }
  | {
      type: 'critical_system_reminder'
      content: string
    }
  | {
      // Taste Loop recall (fork): a short, throttled, precision-biased reminder of
      // promoted operator-friction-derived taste lessons. Model-only / operator-
      // invisible (NULL_RENDERING_TYPES). Gated on tasteLoopEnabled() inside the
      // generator; off ⇒ never produced ⇒ byte-identical. See memdir/tasteLoop.ts.
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
      /** the repetition breaker ended the turn: the model ran the identical
       *  `toolName` call `streak` times in a row with the identical
       *  error/result, past the harness correction. */
      type: 'repetition_breaker'
      toolName: string
      outcome: 'failure' | 'success'
      streak: number
      cause: string
    }
  | {
      /** the cycle guard settled a stagnant turn with a
       *  handoff instead of another provider call. 2.6: `report` carries the
       *  rendered handoff payload (outcome · changed · strategies · evidence
       *  · why-repeat-fails · reopening input · resume ids). */
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
      /**
       * The "deepthink" keyword nudge — ALIGNED: a
       * turn-scoped isMeta prose reminder and nothing else (no effort,
       * budget, or wire change). Contract + research citations:
       * src/utils/effort.ts (DEEPTHINK block).
       */
      type: 'deepthink_effort'
    }
  | {
      type: 'deferred_tools_delta'
      addedNames: string[]
      addedLines: string[]
      removedNames: string[]
    }
  | {
      type: 'agent_listing_delta'
      addedTypes: string[]
      addedLines: string[]
      removedTypes: string[]
      /** First agent-roster announcement of the conversation. */
      isInitial: boolean
      /** Include the concurrent-launch note (plans without it built in). */
      showConcurrencyNote: boolean
    }
  | {
      type: 'mcp_instructions_delta'
      addedNames: string[]
      addedBlocks: string[]
      removedNames: string[]
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
  /**
   * The main conversation's user context (instruction files, the session
   * date) as a PERSISTED row: emitted once when the history carries none,
   * and again at the tail when the rendered body changes (a resumed session
   * on a new day, an edited instruction file). The earlier copies stay in
   * place — a prefix rebuilt per request invalidates every later thinking
   * block under the preserved-thinking check. `body` is the whole rendered
   * reminder (utils/userContextReminder.ts), the bytes the wire carries.
   */
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

