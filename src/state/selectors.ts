// ============================================================================
//  src/state/selectors.ts — pure projections over app state: the viewed
//  agent, input routing, the closed task classification, and the esc
//  grammar (ONE owner — the key handler and the on-screen hint call the
//  same function, so the hint can never promise an action the key will not
//  perform).
// ============================================================================
import type { TaskState } from '../tasks/types.js'
import type { TaskType } from '../Task.js'
import {
  isPanelAgentTask,
  type LocalAgentTaskState,
} from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  isInProcessTeammateTask,
  type InProcessTeammateTaskState,
} from '../tasks/InProcessTeammateTask/types.js'
import type { AppState } from './AppStateStore.js'

/**
 * The in-process teammate task currently being viewed, or nothing when no
 * task is viewed, the id is unknown, or the task is not an in-process
 * teammate. Accepts a narrowed state.
 */
export function getViewedTeammateTask(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): InProcessTeammateTaskState | undefined {
  const taskId = appState.viewingAgentTaskId
  if (!taskId) return undefined
  const task = appState.tasks[taskId]
  if (!task || !isInProcessTeammateTask(task)) return undefined
  return task
}

/** Where typed input goes. */
export type ActiveAgentForInput =
  | { type: 'leader' }
  | { type: 'viewed'; task: InProcessTeammateTaskState }
  | { type: 'named_agent'; task: LocalAgentTaskState }

/**
 * Input routing. The local-agent branch uses the PANEL-ELIGIBILITY
 * predicate rather than a raw type check: the backgrounded main session
 * registers as a local agent and must never become an input destination.
 * Anything else falls back to the leader.
 */
export function getActiveAgentForInput(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks'>,
): ActiveAgentForInput {
  const taskId = appState.viewingAgentTaskId
  if (!taskId) return { type: 'leader' }
  const task = appState.tasks[taskId]
  if (!task) return { type: 'leader' }
  if (isInProcessTeammateTask(task)) return { type: 'viewed', task }
  if (isPanelAgentTask(task)) return { type: 'named_agent', task }
  return { type: 'leader' }
}

// ── the closed task classification (contract data) ─────────────────────────

export const VIEWABLE_TASK_TYPES = ['in_process_teammate', 'local_agent'] as const

export const NON_VIEWABLE_TASK_TYPES = [
  'local_bash',
  'remote_agent',
  'local_workflow',
  'monitor_mcp',
  'dream',
] as const

// Compile-time exhaustiveness: adding a task type without classifying it
// fails the build — a new agent kind silently invisible to the view layer
// is the defect class this prevents.
type ClassifiedTaskType =
  | (typeof VIEWABLE_TASK_TYPES)[number]
  | (typeof NON_VIEWABLE_TASK_TYPES)[number]
type IsEqual<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false
type Assert<T extends true> = T
export type EveryTaskTypeClassified = Assert<IsEqual<TaskType, ClassifiedTaskType>>

// ── the viewed-agent projection ────────────────────────────────────────────

/** The presentation record every agent-view surface renders from. */
export type ViewedAgent = {
  kind: 'in_process_teammate' | 'local_agent'
  taskId: string
  name: string
  color?: string
  /** Honest status label (idle/working for teammates; raw otherwise). */
  statusLabel: string
  isWorking: boolean
  subtitle: string
  escAction: 'interrupt' | 'main'
  task: TaskState
}

/**
 * Esc grammar for agent transcript views: `interrupt` exactly when the
 * task is an in-process teammate, its status is running, and it has a live
 * abort controller; `main` in every other case. An in-process teammate's
 * transcript is an interactive conversation, so esc aborts the TURN (never
 * the teammate); local agents are delegated never-stop work with their own
 * stop action; an idle or completed teammate has no live exchange, so esc
 * returns instead of silently swallowing the key.
 */
export function getViewedEscAction(task: TaskState): 'interrupt' | 'main' {
  if (
    isInProcessTeammateTask(task) &&
    task.status === 'running' &&
    task.currentWorkAbortController !== undefined
  ) {
    return 'interrupt'
  }
  return 'main'
}

/**
 * Esc grammar for attached daemon workers: `interrupt` when a worker
 * exists, has not ended, is not paused, and the turn is live; `detach`
 * otherwise.
 */
export function getAttachedEscAction(
  worker: { ended?: boolean; paused?: boolean } | null,
  turnLive: boolean,
): 'interrupt' | 'detach' {
  if (worker && !worker.ended && !worker.paused && turnLive) return 'interrupt'
  return 'detach'
}

/**
 * Project one task into the presentation record. Per-task and PURE, so
 * React consumers can subscribe to the identity-stable stored task and
 * project during render. Anything not viewable projects to nothing.
 */
export function projectViewedAgent(
  task: TaskState,
  agentNameRegistry: ReadonlyMap<string, string>,
): ViewedAgent | undefined {
  if (isInProcessTeammateTask(task)) {
    const running = task.status === 'running'
    return {
      kind: 'in_process_teammate',
      taskId: task.id,
      name: task.identity.agentName,
      color: task.identity.color,
      statusLabel: running ? (task.isIdle ? 'idle' : 'working') : task.status,
      isWorking: running && !task.isIdle,
      subtitle: task.prompt,
      escAction: getViewedEscAction(task),
      task,
    }
  }
  if (isPanelAgentTask(task)) {
    let registeredName: string | undefined
    for (const [name, taskId] of agentNameRegistry) {
      if (taskId === task.id) registeredName = name
    }
    return {
      kind: 'local_agent',
      taskId: task.id,
      name: registeredName ?? task.description,
      statusLabel: task.status,
      isWorking: task.status === 'running',
      subtitle: task.description,
      escAction: getViewedEscAction(task),
      task,
    }
  }
  return undefined
}

/** Store-shaped convenience: resolve the viewed id and project it. */
export function getViewedAgent(
  appState: Pick<AppState, 'viewingAgentTaskId' | 'tasks' | 'agentNameRegistry'>,
): ViewedAgent | undefined {
  const taskId = appState.viewingAgentTaskId
  if (!taskId) return undefined
  const task = appState.tasks[taskId]
  if (!task) return undefined
  return projectViewedAgent(task, appState.agentNameRegistry)
}
