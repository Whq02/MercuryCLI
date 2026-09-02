import type { TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'


export type BashTaskKind = 'bash' | 'monitor'

export type LocalShellTaskState = TaskStateBase & {
  type: 'local_bash'
  command: string
  result?: {
    code: number
    interrupted: boolean
  }
  completionStatusSentInAttachment: boolean
  shellCommand: ShellCommand | null
  unregisterCleanup?: () => void
  cleanupTimeoutId?: ReturnType<typeof setTimeout>
  lastReportedTotalLines: number
  isBackgrounded: boolean
  agentId?: AgentId
  kind?: BashTaskKind
  verifyCwd?: string
}

export function isLocalShellTask(task: unknown): task is LocalShellTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_bash'
  )
}
