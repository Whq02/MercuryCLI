import type { TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'

export type BashTaskKind = 'bash' | 'monitor'

export type ShellKillSource = 'operator' | 'agent-end'

export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash'
  command: string
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null
  lastReportedTotalLines: number
  isBackgrounded: boolean
  result?: {
    code: number
    interrupted: boolean
  }
  unregisterCleanup?: () => void
  cleanupTimeoutId?: NodeJS.Timeout
  agentId?: AgentId
  killedBy?: ShellKillSource
  kind?: BashTaskKind
  verifyCwd?: string
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    (task as { type?: unknown }).type === 'local_bash'
  )
}
