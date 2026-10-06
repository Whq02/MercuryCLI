
import type { TaskState, BackgroundTaskState } from '../../tasks/types.js'
import { isBackgroundTask } from '../../tasks/types.js'
import {
  isLocalAgentTask,
  isPanelAgentTask,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import {
  deriveAgentLifecycle,
  type AgentLifecycle,
} from '../../services/agentResults/lifecycle.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../../tools/AgentTool/agentColorManager.js'
import type { Theme } from '../../utils/theme.js'

export function crewmateRole(color: string | undefined): keyof Theme | undefined {
  if (color === undefined) return undefined
  return (AGENT_COLOR_TO_THEME_COLOR as Record<string, keyof Theme>)[color]
}

export function isTerminalStatus(status: string): boolean {
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

export type TaskStatusFlags = {
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
  if (status === 'running') {
    if (flags?.isIdle) return '…'
    return GLYPH.inProgress
  }
  if (status === 'completed') return GLYPH.check
  if (status === 'failed') return GLYPH.fail
  if (status === 'killed') return GLYPH.fail
  return GLYPH.dot
}

export function getTaskStatusColor(
  status: string,
  flags?: TaskStatusFlags,
): 'success' | 'error' | 'warning' | 'background' {
  if (flags?.hasError) return 'error'
  if (flags?.shutdownRequested) return 'warning'
  if (flags?.isIdle) return 'background'
  if (status === 'running') return 'background'
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'killed') return 'warning'
  return 'background'
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

export { isLocalAgentTask }
