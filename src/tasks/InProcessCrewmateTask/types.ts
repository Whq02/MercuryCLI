import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { Message } from '../../types/message.js'
import type { TaskStateBase } from '../../Task.js'
import type { AgentProgress } from '../LocalAgentTask/LocalAgentTask.js'
import type { AgentPauseV1 } from '../LocalAgentTask/agentPause.js'


export type CrewmateIdentity = {
  agentId: string
  agentName: string
  crewName: string
  agentType?: string
  roleId?: string
  color?: string
  parentSessionId?: string
}

export type InProcessCrewmateTaskState = TaskStateBase & {
  type: 'in_process_crewmate'
  identity: CrewmateIdentity
  prompt: string
  model?: string
  cwd?: string
  worktree?: string
  effort?: string
  transcriptAgentId?: string
  agentDefinition?: AgentDefinition
  instructionAtSpawn?: { profile?: unknown; digest: string; [key: string]: any }
  abortController?: AbortController
  currentWorkAbortController?: AbortController
  unregisterCleanup?: () => void
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
  paused?: AgentPauseV1
  onIdleCallbacks?: Array<() => void>
  lastReportedToolCount?: number
  lastReportedTokenCount?: number
}

export function isInProcessCrewmateTask(task: unknown): task is InProcessCrewmateTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'in_process_crewmate'
  )
}

export const CREWMATE_MESSAGES_UI_CAP = 50

export function appendCappedMessage<M>(prev: M[] | undefined, item: M): M[] {
  const next = [...(prev ?? []), item]
  if (next.length > CREWMATE_MESSAGES_UI_CAP) {
    return next.slice(next.length - CREWMATE_MESSAGES_UI_CAP)
  }
  return next
}
