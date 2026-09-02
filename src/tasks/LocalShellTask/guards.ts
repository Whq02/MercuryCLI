import type { TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'

/**
 * The shell-task state shape and its type guard, kept free of UI and
 * runtime imports so state/selector/dialog modules can narrow task unions
 * without dragging in the task implementation.
 */

/** The UI display variant (contract data): a plain shell or a monitor. */
export type BashTaskKind = 'bash' | 'monitor'

export type LocalShellTaskState = TaskStateBase & {
  /** Kept as local_bash for backward compatibility with persisted state. */
  type: 'local_bash'
  command: string
  result?: {
    code: number
    interrupted: boolean
  }
  /** Whether the completion status already went out in an attachment. */
  completionStatusSentInAttachment: boolean
  /** The live shell command handle; nulled at settlement. */
  shellCommand: ShellCommand | null
  /** Unregisters the process-exit cleanup for this task. */
  unregisterCleanup?: () => void
  cleanupTimeoutId?: ReturnType<typeof setTimeout>
  /** The last total line count reported to the model. */
  lastReportedTotalLines: number
  isBackgrounded: boolean
  /** The spawning agent's id; absent = the main thread. */
  agentId?: AgentId
  /** Display variant; presentation only (labels, dialog title, pill noun). */
  kind?: BashTaskKind
  /** The cwd captured at launch — verification evidence must be attributed
   *  to the tree the command actually ran in, and the process cwd may move
   *  before settlement. */
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
