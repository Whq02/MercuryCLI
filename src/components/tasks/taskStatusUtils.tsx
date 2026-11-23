import type { TaskState, BackgroundTaskState } from '../../tasks/types.js'
import { isBackgroundTask } from '../../tasks/types.js'
import {
  isLocalAgentTask,
  isPanelAgentTask,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { GLYPH } from '../../utils/glyphs.js'
import {
  deriveAgentLifecycle,
  type AgentLifecycle,
} from '../../services/agentResults/lifecycle.js'

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export function isManageableTask(task: TaskState): task is BackgroundTaskState {
  const original: TaskState = task
  if (isBackgroundTask(task)) return true
  const candidate: TaskState = original
  if (isPanelAgentTask(candidate) && candidate.status === 'completed') {
    const deadline = candidate.evictAfter
    if (deadline === 0) return false
    if (deadline === undefined) return true
    return Date.now() < deadline
  }
  return false
}

type TaskStatusFlags = {
  isIdle?: boolean
  hasError?: boolean
  shutdownRequested?: boolean
}

export function getTaskStatusIcon(
  status: string,
  flags?: TaskStatusFlags,
): string {
  if (flags?.hasError) return GLYPH.fail
  if (flags?.shutdownRequested) return GLYPH.warn
  switch (status) {
    case 'running':
      return flags?.isIdle ? '…' : GLYPH.inProgress
    case 'completed':
      return GLYPH.check
    case 'failed':
    case 'killed':
      return GLYPH.fail
    default:
      return GLYPH.dot
  }
}

export function getTaskStatusColor(
  status: string,
  flags?: TaskStatusFlags,
): 'success' | 'error' | 'warning' | 'background' {
  if (flags?.hasError) return 'error'
  if (flags?.shutdownRequested) return 'warning'
  if (flags?.isIdle) return 'background'
  switch (status) {
    case 'running':
      return 'background'
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'warning'
    default:
      return 'background'
  }
}


export function agentLifecycleOf(task: TaskState): AgentLifecycle | undefined {
  if (!isLocalAgentTask(task)) return undefined
  return deriveAgentLifecycle({
    taskStatus: task.status,
    ...(task.endTime !== undefined ? { finishedAtMs: task.endTime } : {}),
    transcriptExists: isTerminalStatus(task.status),
  })
}

