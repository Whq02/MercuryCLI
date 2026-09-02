// Shared task predicates and labels: manageability (the ONE gate
// the pill, the ↓/shift+↓ keys and the dialog share), terminal status, the
// status icon/colour tables (note the running/idle asymmetry), teammate
// activity text from the REAL lifecycle phase, and footer hiding.

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

/** A teammate's stored colour is an agent PALETTE name ('red'), not a theme
 *  role ('red_FOR_SUBAGENTS_ONLY'): every teammate nameplate resolves it
 *  through the palette map, and an unknown value paints uncoloured. */
export function teammateRole(color: string | undefined): keyof Theme | undefined {
  if (color === undefined) return undefined
  return (AGENT_COLOR_TO_THEME_COLOR as Record<string, keyof Theme>)[color]
}

/** The closed terminal set. */
export function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'killed'
}

/**
 * A task is manageable if it is running/pending background work, OR it is a
 * completed panel agent still inside its linger window. Dismissed rows carry
 * a zero deadline; an absent deadline means indefinite. Expiry is evaluated
 * at render time.
 */
export function isManageableTask(task: TaskState): task is BackgroundTaskState {
  const original: TaskState = task
  if (isBackgroundTask(task)) return true
  // The linger check reads the ORIGINAL row: the guard above narrows the
  // parameter away, so it is captured before the narrowing.
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

/** Icon precedence: error → approval → shutdown → RUNNING (before idle) →
 *  completed → failed → killed → bullet. */
export function getTaskStatusIcon(
  status: string,
  flags?: TaskStatusFlags,
): string {
  if (flags?.hasError) return GLYPH.fail
  if (flags?.awaitingPlanApproval) return '?'
  if (flags?.shutdownRequested) return GLYPH.warn
  if (status === 'running') {
    // The icon checks running BEFORE idle (the colour does the reverse).
    if (flags?.isIdle) return '…'
    return '▶\uFE0E'
  }
  if (status === 'completed') return GLYPH.check
  if (status === 'failed') return GLYPH.fail
  if (status === 'killed') return GLYPH.fail
  return GLYPH.dot
}

/** Colour precedence: error → approval → shutdown → IDLE (before status) →
 *  running → completed → failed → killed → background. */
export function getTaskStatusColor(
  status: string,
  flags?: TaskStatusFlags,
): 'success' | 'error' | 'warning' | 'background' {
  if (flags?.hasError) return 'error'
  if (flags?.awaitingPlanApproval) return 'warning'
  if (flags?.shutdownRequested) return 'warning'
  // The colour checks idle BEFORE status — any idle flag yields background.
  if (flags?.isIdle) return 'background'
  if (status === 'running') return 'background'
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'error'
  if (status === 'killed') return 'warning'
  return 'background'
}

/** Activity text from the REAL lifecycle phase — while working, the rolled
 *  up recent activity or the last description; otherwise the phase label. */
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
    // Working shows the last CONCRETE action (rolled-up search/read runs or
    // the newest described activity), never a generic spinner phrase.
    return (
      summarizeRecentActivities(progress?.recentActivities ?? []) ??
      progress?.recentActivitySummary ??
      progress?.lastActivity?.description ??
      'working'
    )
  }
  return teammatePhaseLabel(phase)
}

/** The tasks footer hides when the spinner tree is showing AND every
 *  visible manageable task is an in-process teammate; never otherwise, and
 *  never when there are none. */
export function shouldHideTasksFooter(
  tasks: TaskState[],
  spinnerTreeShowing: boolean,
): boolean {
  if (!spinnerTreeShowing) return false
  const manageable = tasks.filter(task => isManageableTask(task))
  if (manageable.length === 0) return false
  return manageable.every(task => isInProcessTeammateTask(task))
}

/**
 * The lifecycle vocabulary for a LOCAL AGENT row (spec 03-C2): the ONE
 * derivation (agentResults/lifecycle) fed with the facts this row owns —
 * status, the terminal stamp, and the transcript promise a terminal row
 * carries (the run loop persists as it goes; resume's typed failure owns
 * the rare gap). undefined for rows that are not local agents — nothing is
 * invented for shells, workflows, or teammates.
 */
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
