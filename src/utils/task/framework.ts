import type { AppState } from '../../state/AppState.js'
import type { TaskStatus } from '../../Task.js'
import { isTerminalTaskStatus } from '../../Task.js'
import { isBackgroundTask, type TaskState } from '../../tasks/types.js'
import { emitTaskStarted } from '../sdkEventQueue.js'
import { getTaskOutputDelta } from './diskOutput.js'
import { projectTaskExecution } from './executionProjection.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export const POLL_INTERVAL_MS: Unbuilt = unbuilt('src/utils/task/framework.ts:10')
export const PANEL_GRACE_MS: Unbuilt = unbuilt('src/utils/task/framework.ts:11')

type TaskAppStateSetter = (...args: Unbuilt[]) => Unbuilt

export function updateTaskState<T extends TaskState = TaskState>(
  taskId: string,
  setAppState: TaskAppStateSetter,
  updater: (task: T) => T,
): void {
  return notBuilt('src/utils/task/framework.ts:15')
}

export function registerTask(task: TaskState, setAppState: TaskAppStateSetter): void {
  return notBuilt('src/utils/task/framework.ts:32')
}

function retainedEvictionDue(task: TaskState, now: number): boolean {
  if ('paused' in task && task.paused !== undefined) return false
  if (!('retain' in task)) return true
  const deadline = task.evictAfter
  return deadline !== undefined && deadline <= now
}

function pruneAgentNameRegistry(
  registry: AppState['agentNameRegistry'],
  taskId: string,
): AppState['agentNameRegistry'] {
  const staleNames: string[] = []
  for (const [name, agentId] of registry) {
    if (String(agentId) === taskId) staleNames.push(name)
  }
  if (staleNames.length === 0) return registry
  const pruned = new Map(registry)
  for (const name of staleNames) pruned.delete(name)
  return pruned
}


export function taskOwnerGone(task: TaskState): string | null {
  if (task.status !== 'running') return null
  if (task.type === 'local_bash') {
    const handle = (task as { shellCommand?: { status?: string } | null }).shellCommand
    if (handle === null || handle === undefined) return 'its command handle is gone'
    if (handle.status !== 'running' && handle.status !== 'backgrounded') return `its command already ${handle.status}`
    return null
  }
  if (task.type === 'local_agent') {
    const controller = (task as { abortController?: AbortController }).abortController
    if (controller === undefined) return 'its controller is gone'
    if (controller.signal.aborted) return 'its controller was stopped before the row settled'
    return null
  }
  return null
}

export type LiveWorkCounts = {
  total: number
  shells: number
  agents: number
  other: number
}

export function liveBackgroundCounts(tasks: Record<string, TaskState> | undefined): LiveWorkCounts {
  const counts: LiveWorkCounts = { total: 0, shells: 0, agents: 0, other: 0 }
  for (const task of Object.values(tasks ?? {})) {
    if (!isBackgroundTask(task) || isTerminalTaskStatus(task.status as TaskStatus)) continue
    if (taskOwnerGone(task) !== null) continue
    counts.total++
    if (task.type === 'local_bash') counts.shells++
    else if (task.type === 'local_agent') counts.agents++
    else counts.other++
  }
  return counts
}

export function liveWorkWords(counts: LiveWorkCounts): string {
  const parts: string[] = []
  const say = (n: number, one: string, many: string): void => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`)
  }
  say(counts.shells, 'shell command', 'shell commands')
  say(counts.agents, 'crewmate', 'crewmates')
  say(counts.other, 'background task', 'background tasks')
  if (parts.length === 0) return 'nothing'
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export function settleOwnerlessTasks(
  setAppState: TaskAppStateSetter,
  now?: number,
): Array<{ id: string; reason: string }> {
  return notBuilt('src/utils/task/framework.ts:136')
}

export function evictTerminalTask(taskId: string, setAppState: TaskAppStateSetter): void {
  return notBuilt('src/utils/task/framework.ts:160')
}

export function getRunningTasks(state: AppState): TaskState[] {
  return notBuilt('src/utils/task/framework.ts:174')
}

export async function generateTaskAttachments(state: AppState): Promise<{
  updatedTaskOffsets: Record<string, number>
  evictedTaskIds: string[]
}> {
  return notBuilt('src/utils/task/framework.ts:178')
}

export function applyTaskOffsetsAndEvictions(
  setAppState: TaskAppStateSetter,
  updatedTaskOffsets: Record<string, number>,
  evictedTaskIds: string[],
): void {
  return notBuilt('src/utils/task/framework.ts:200')
}
