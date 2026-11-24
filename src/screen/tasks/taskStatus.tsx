import type { TaskState, BackgroundTaskState } from '../../engine/tasks/taskState.js'
import { isBackgroundTask } from '../../engine/tasks/taskState.js'
import {
  isCrewmateTask,
  isPanelCrewmateTask,
} from '../../engine/tasks/local-agent/crewmateTask.js'
import { GLYPH } from '../theme/glyphs.js'
import {
  deriveCrewmateLifecycle,
  type CrewmateLifecycle,
} from '../../crew/agent-results/lifecycle.js'

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

export function isManageableTask(task: TaskState): task is BackgroundTaskState {
  const original: TaskState = task
  if (isBackgroundTask(task)) return true
  const candidate: TaskState = original
  if (isPanelCrewmateTask(candidate) && candidate.status === 'completed') {
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


export function crewmateLifecycleOf(task: TaskState): CrewmateLifecycle | undefined {
  if (!isCrewmateTask(task)) return undefined
  const row = task as { status: string; endTime?: number }
  return deriveCrewmateLifecycle({
    taskStatus: row.status,
    ...(row.endTime !== undefined ? { finishedAtMs: row.endTime } : {}),
    transcriptExists: isTerminalStatus(row.status),
  })
}

