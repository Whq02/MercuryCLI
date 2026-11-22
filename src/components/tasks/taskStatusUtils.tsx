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
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

function isTerminalStatus(status: string): boolean {
  return notBuilt('src/components/tasks/taskStatusUtils.tsx:14')
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

type TaskStatusFlags = Unbuilt

export function getTaskStatusIcon(
  status: string,
  flags?: TaskStatusFlags,
): string {
  return notBuilt('src/components/tasks/taskStatusUtils.tsx:37')
}

export function getTaskStatusColor(
  status: string,
  flags?: TaskStatusFlags,
): 'success' | 'error' | 'warning' | 'background' {
  return notBuilt('src/components/tasks/taskStatusUtils.tsx:53')
}


export function agentLifecycleOf(task: TaskState): AgentLifecycle | undefined {
  if (!isLocalAgentTask(task)) return undefined
  const row = task as { status: string; endTime?: number }
  return deriveAgentLifecycle({
    taskStatus: row.status,
    ...(row.endTime !== undefined ? { finishedAtMs: row.endTime } : {}),
    transcriptExists: isTerminalStatus(row.status),
  })
}

