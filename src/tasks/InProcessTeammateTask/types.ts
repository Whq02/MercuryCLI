import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { Message } from '../../types/message.js'
import type { TaskStateBase } from '../../Task.js'
import type { AgentProgress } from '../LocalAgentTask/LocalAgentTask.js'


export type TeammateIdentity = {
  agentId: string
  agentName: string
  teamName: string
  agentType?: string
  roleId?: string
  color?: string
  planModeRequired?: boolean
  parentSessionId?: string
}

export type InProcessTeammateTaskState = TaskStateBase & {
  type: 'in_process_teammate'
  identity: TeammateIdentity
  prompt: string
  model?: string
  agentDefinition?: AgentDefinition
  instructionAtSpawn?: { profile?: unknown; digest: string; [key: string]: any }
  abortController?: AbortController
  currentWorkAbortController?: AbortController
  unregisterCleanup?: () => void
  awaitingPlanApproval: boolean
  permissionMode?: PermissionMode
  error?: string
  result?: any
  progress?: any
  messages?: Message[]
  inProgressToolUseIDs?: Set<string>
  pendingUserMessages?: string[]
  spinnerVerb?: string
  pastTenseVerb?: string
  isIdle: boolean
  shutdownRequested: boolean
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

export const TEAMMATE_MESSAGES_UI_CAP = 50

export function appendCappedMessage<M>(prev: M[] | undefined, item: M): M[] {
  const next = [...(prev ?? []), item]
  if (next.length > TEAMMATE_MESSAGES_UI_CAP) {
    return next.slice(next.length - TEAMMATE_MESSAGES_UI_CAP)
  }
  return next
}
