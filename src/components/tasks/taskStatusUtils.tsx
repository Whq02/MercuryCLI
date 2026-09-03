
import type { TaskState, BackgroundTaskState } from '../../tasks/types.js'
import { isBackgroundTask } from '../../tasks/types.js'
import {
  isLocalAgentTask,
  isPanelAgentTask,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { summarizeRecentActivities } from '../../utils/collapseReadSearch.js'
import {
  deriveTeammatePhase,
  lastActionWasLeadHandoff,
  teammatePhaseLabel,
} from '../../utils/swarm/teamPhases.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import {
  deriveAgentLifecycle,
  type AgentLifecycle,
} from '../../services/agentResults/lifecycle.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../../tools/AgentTool/agentColorManager.js'
import type { Theme } from '../../utils/theme.js'

export function teammateRole(color: string | undefined): keyof Theme | undefined {
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
  awaitingPlanApproval?: boolean
  hasError?: boolean
  shutdownRequested?: boolean
}

export function getTaskStatusIcon(
  status: string,
  flags?: TaskStatusFlags,
): string {
  if (flags?.hasError) return GLYPH.fail
  if (flags?.awaitingPlanApproval) return '?'
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
  if (flags?.awaitingPlanApproval) return 'warning'
  if (flags?.shutdownRequested) return 'warning'
  if (flags?.isIdle) return 'background'
  if (status === 'running') return 'background'
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'killed') return 'warning'
  return 'background'
}

export function describeTeammateActivity(task: TaskState): string {
  if (!isInProcessTeammateTask(task)) return ''
  const progress = task.progress as
    | {
        recentActivitySummary?: string
        lastActivity?: { description?: string }
        recentActivities?: Array<{
          activityDescription?: string
          isSearch?: boolean
          isRead?: boolean
        }>
      }
    | undefined
  const phase = deriveTeammatePhase({
    status: task.status,
    isIdle: task.isIdle === true,
    shutdownRequested: task.shutdownRequested === true,
    awaitingPlanApproval: task.awaitingPlanApproval === true,
    hasProgress: progress !== undefined,
    ...(task.isIdle === true
      ? {
          lastActionWasLeadHandoff: lastActionWasLeadHandoff(
            task.messages as ReadonlyArray<unknown> | undefined,
          ),
        }
      : {}),
  })
  if (phase === 'working') {
    return (
      summarizeRecentActivities(progress?.recentActivities ?? []) ??
      progress?.recentActivitySummary ??
      progress?.lastActivity?.description ??
      'working'
    )
  }
  return teammatePhaseLabel(phase)
}

export function shouldHideTasksFooter(
  tasks: TaskState[],
  spinnerTreeShowing: boolean,
): boolean {
  if (!spinnerTreeShowing) return false
  const manageable = tasks.filter(task => isManageableTask(task))
  if (manageable.length === 0) return false
  return manageable.every(task => isInProcessTeammateTask(task))
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
