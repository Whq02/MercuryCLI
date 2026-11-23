import type { TaskStateBase } from '../taskBase.js'
import type { AgentId } from '../../../sessions/transcripts/ids.js'
import type { ShellCommand } from '../../../platform/shell/shellProcess.js'
import { isRecord } from '../../../platform/primitives/isRecord.js'

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
  return isRecord(task) && task.type === 'local_bash'
}
