import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { Message } from '../../types/message.js'
import type { TaskStateBase } from '../../Task.js'
import type { AgentProgress } from '../LocalAgentTask/LocalAgentTask.js'

/**
 * Teammate identity + task-state shape, and the capped UI message mirror.
 */

/**
 * Plain identity data mirrored from the runtime context into app state.
 * The composite agent id has the shape `<agentName>@<teamName>`
 * (contract data).
 */
export type TeammateIdentity = {
  agentId: string
  /** Display name (NOT the canonical role id — the two differ). */
  agentName: string
  teamName: string
  /** The agent type this teammate runs as, when one was selected. */
  agentType?: string
  /** Canonical role id from the role resolver (decodes historical aliases). */
  roleId?: string
  color?: string
  planModeRequired?: boolean
  /** The leader's session id. */
  parentSessionId?: string
}

export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'
  identity: TeammateIdentity
  prompt: string
  /** Optional model override. */
  model?: string
  /** Many teammates run as general-purpose agents without a definition. */
  agentDefinition?: AgentDefinition
  /** Spawn-frozen instruction-resolution snapshot (profile + bundle digest). */
  instructionAtSpawn?: { profile?: unknown; digest: string; [key: string]: any }
  /** Kills the whole teammate. */
  abortController?: AbortController
  /** Aborts only the current turn. */
  currentWorkAbortController?: AbortController
  unregisterCleanup?: () => void
  awaitingPlanApproval: boolean
  /** Independently-cycled permission mode. */
  permissionMode?: PermissionMode
  error?: string
  result?: any
  /** Progress counters (loosely typed: UI fallback-union access patterns). */
  progress?: any
  /** The capped UI mirror only — mailbox messages live elsewhere. */
  messages?: Message[]
  /** In-progress tool-use ids, for animation. */
  inProgressToolUseIDs?: Set<string>
  /** Queued user messages pending delivery. */
  pendingUserMessages?: string[]
  /** UI spinner verb. */
  spinnerVerb?: string
  /** UI spinner verb, past tense (for the settled row). */
  pastTenseVerb?: string
  isIdle: boolean
  shutdownRequested: boolean
  /** Callbacks resolved when the teammate goes idle (leader waits, no poll). */
  onIdleCallbacks?: Array<() => void>
  lastReportedToolCount?: number
  lastReportedTokenCount?: number
}

export function isInProcessTeammateTask(task: unknown): task is InProcessTeammateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_teammate'
  )
}

/**
 * The displayed message list is capped (contract data: 50) by dropping the
 * oldest. This list duplicates conversation content into resident app
 * state — measurement attributed the bulk of per-agent memory growth to
 * that duplication, worst in long sessions with many teammates. Losing old
 * entries loses nothing: the authoritative conversation lives in the
 * runner's own array and on disk.
 */
export const TEAMMATE_MESSAGES_UI_CAP = 50

/** Append under the cap; always returns a new array (state immutability). */
export function appendCappedMessage<M>(prev: M[] | undefined, item: M): M[] {
  const next = [...(prev ?? []), item]
  if (next.length > TEAMMATE_MESSAGES_UI_CAP) {
    return next.slice(next.length - TEAMMATE_MESSAGES_UI_CAP)
  }
  return next
}
