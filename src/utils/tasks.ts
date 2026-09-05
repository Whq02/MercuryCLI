import { join } from 'node:path'
import * as fs from 'node:fs'

import { z } from 'zod'

import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { publishAtomic } from '../substrate/fileStore.js'
import { groupCommitLane, type GroupCommitLane } from '../substrate/groupCommit.js'
import { acquirePidLockWithRetry, noteLockRelease } from '../substrate/pidLock.js'
import { uniq } from './array.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome, isEnvTruthy } from './envUtils.js'
import { lazySchema } from './lazySchema.js'
import { logError } from './log.js'
import { getErrnoCode } from './errors.js'
import { createSignal } from './signal.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { getTeamName } from './teammate.js'
import { getTeammateContext, isInProcessTeammate } from './teammateContext.js'
import { readTeamFileAsync } from './swarm/teamHelpers.js'


export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const

export const TaskStatusSchema = lazySchema(() => z.enum(TASK_STATUSES))
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TaskSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    subject: z.string(),
    description: z.string(),
    activeForm: z.string().optional(),
    owner: z.string().optional(),
    status: TaskStatusSchema(),
    blocks: z.array(z.string()),
    blockedBy: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).optional(),
    epoch: z.number().optional(),
  }),
)
export type Task = z.infer<ReturnType<typeof TaskSchema>>

export const DEFAULT_TASKS_MODE_TASK_LIST_ID = 'tasklist'

export function isTodoV2Enabled(): boolean {
  return isEnvTruthy(process.env.MERCURY_TASKS) || !getIsNonInteractiveSession()
}

let leaderTeamName: string | undefined

export function getTaskListId(): string {
  const override = process.env.MERCURY_TASK_LIST_ID
  if (override) return override
  if (isInProcessTeammate()) {
    const teamName = getTeammateContext()?.teamName
    if (teamName) return teamName
  }
  return getTeamName() || leaderTeamName || getSessionId()
}

export async function listSessionMission(): Promise<Task[]> {
  const own = String(getSessionId())
  const current = getTaskListId()
  const lists = current === own ? [own] : [own, current]
  const seen = new Set<string>()
  const rows: Task[] = []
  for (const listId of lists) {
    let tasks: Task[] = []
    try {
      tasks = await listTasks(listId)
    } catch {
      tasks = []
    }
    for (const task of tasks) {
      const id = listId === own ? task.id : `${listId}:${task.id}`
      if (seen.has(id)) continue
      seen.add(id)
      rows.push(id === task.id ? task : { ...task, id })
    }
  }
  return rows
}

export function setLeaderTeamName(teamName: string): void {
  if (leaderTeamName === teamName) return
  leaderTeamName = teamName
  notifyTasksUpdated()
}

export function clearLeaderTeamName(): void {
  if (leaderTeamName === undefined) return
  leaderTeamName = undefined
  notifyTasksUpdated()
}

export function sanitizePathComponent(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '-')
}

function sanitizeTeamNameForListId(teamName: string): string {
  return teamName.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
}

export function getTasksDir(taskListId: string): string {
  return join(getMercuryHome(), 'tasks', sanitizePathComponent(taskListId))
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return join(getTasksDir(taskListId), `${sanitizePathComponent(taskId)}.json`)
}

export async function ensureTasksDir(taskListId: string): Promise<void> {
  try {
    await fs.promises.mkdir(getTasksDir(taskListId), { recursive: true })
  } catch {
  }
}

function highWatermarkPath(taskListId: string): string {
  return join(getTasksDir(taskListId), '.highwatermark')
}

function epochPath(taskListId: string): string {
  return join(getTasksDir(taskListId), '.epoch')
}

function listLockPath(taskListId: string): string {
  return join(getTasksDir(taskListId), '.lock')
}

function taskLockPath(taskListId: string, taskId: string): string {
  return `${getTaskPath(taskListId, taskId)}.pidlock`
}


const tasksUpdatedSignal = createSignal()

export function notifyTasksUpdated(): void {
  try {
    tasksUpdatedSignal.emit()
  } catch {
  }
}

export const onTasksUpdated = tasksUpdatedSignal.subscribe


let taskLockSeq = 0

function mintLockOwner(): string {
  return `tasks-${process.pid}-${++taskLockSeq}`
}

const LOCK_RETRY_OPTS = {
  liveness: 'assume-alive' as const,
  retries: 30,
  minTimeoutMs: 5,
  maxTimeoutMs: 100,
}

async function withLock<T>(lockPath: string, label: string, fn: () => Promise<T>): Promise<T> {
  const { release } = await acquirePidLockWithRetry(lockPath, mintLockOwner(), LOCK_RETRY_OPTS)
  try {
    return await fn()
  } finally {
    noteLockRelease(label, await release())
  }
}


export async function readTaskEpoch(taskListId: string): Promise<number> {
  try {
    const raw = await fs.promises.readFile(epochPath(taskListId), 'utf8')
    const parsed = jsonParse(raw) as { epoch?: unknown } | undefined
    return typeof parsed?.epoch === 'number' ? parsed.epoch : 0
  } catch {
    return 0
  }
}

function isTaskBodyName(name: string): boolean {
  return name.endsWith('.json') && !name.startsWith('.')
}

async function listTaskIdsOnDisk(taskListId: string): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(getTasksDir(taskListId))
    return names.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

async function highestNumericIdOnDisk(taskListId: string): Promise<number> {
  let highest = 0
  for (const id of await listTaskIdsOnDisk(taskListId)) {
    const numeric = parseInt(id, 10)
    if (!Number.isNaN(numeric) && numeric > highest) highest = numeric
  }
  return highest
}

async function readHighWatermark(taskListId: string): Promise<number> {
  try {
    const raw = await fs.promises.readFile(highWatermarkPath(taskListId), 'utf8')
    const parsed = jsonParse(raw)
    return typeof parsed === 'number' && !Number.isNaN(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

export async function resetTaskList(
  taskListId: string,
  opts?: { onlyIfAllCompleted?: boolean },
): Promise<boolean> {
  await ensureTasksDir(taskListId)
  const result = await withLock(listLockPath(taskListId), 'tasks-reset', async () => {
    if (opts?.onlyIfAllCompleted) {
      const tasks = await listTasks(taskListId)
      if (tasks.length === 0 || tasks.some(task => task.status !== 'completed')) return false
    }
    const highest = await highestNumericIdOnDisk(taskListId)
    if (highest > (await readHighWatermark(taskListId))) {
      await publishAtomic(highWatermarkPath(taskListId), jsonStringify(highest))
    }
    const epoch = await readTaskEpoch(taskListId)
    await publishAtomic(
      epochPath(taskListId),
      jsonStringify({ epoch: epoch + 1, resetAt: new Date().toISOString() }),
    )
    let names: string[] = []
    try {
      names = await fs.promises.readdir(getTasksDir(taskListId))
    } catch {
      names = []
    }
    for (const name of names) {
      if (!isTaskBodyName(name)) continue
      try {
        await fs.promises.unlink(join(getTasksDir(taskListId), name))
      } catch {
      }
    }
    return true
  })
  if (result) notifyTasksUpdated()
  return result
}

export async function sweepDeadEpochTasks(taskListId: string): Promise<number> {
  const epoch = await readTaskEpoch(taskListId)
  if (epoch === 0) return 0
  let names: string[] = []
  try {
    names = await fs.promises.readdir(getTasksDir(taskListId))
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!isTaskBodyName(name)) continue
    const path = join(getTasksDir(taskListId), name)
    try {
      const parsed = TaskSchema().safeParse(jsonParse(await fs.promises.readFile(path, 'utf8')))
      if (!parsed.success) continue
      if ((parsed.data.epoch ?? 0) < epoch) {
        await fs.promises.unlink(path)
        removed += 1
      }
    } catch {
    }
  }
  if (removed > 0) notifyTasksUpdated()
  return removed
}


type CreateLaneState = { nextId: number; epoch: number }

const createLanes = new Map<string, GroupCommitLane<CreateLaneState>>()

function createLaneFor(taskListId: string): GroupCommitLane<CreateLaneState> {
  const lockPath = listLockPath(taskListId)
  let lane = createLanes.get(lockPath)
  if (!lane) {
    lane = groupCommitLane<CreateLaneState>({
      acquire: async () => {
        const { release } = await acquirePidLockWithRetry(lockPath, mintLockOwner(), LOCK_RETRY_OPTS)
        return async () => {
          noteLockRelease('tasks-create', await release())
        }
      },
      read: async () => {
        const highest = Math.max(await highestNumericIdOnDisk(taskListId), await readHighWatermark(taskListId))
        return { value: { nextId: highest + 1, epoch: await readTaskEpoch(taskListId) }, context: undefined }
      },
      publish: async () => {
        notifyTasksUpdated()
      },
    })
    createLanes.set(lockPath, lane)
  }
  return lane
}

export async function createTask(taskListId: string, taskData: Omit<Task, 'id'>): Promise<string> {
  await ensureTasksDir(taskListId)
  return createLaneFor(taskListId).submit(async current => {
    const id = String(current.nextId)
    const body: Task = {
      ...taskData,
      id,
      ...(current.epoch > 0 ? { epoch: current.epoch } : {}),
    }
    await publishAtomic(getTaskPath(taskListId, id), jsonStringify(body, null, 2))
    return { next: { ...current, nextId: current.nextId + 1 }, result: id }
  })
}


export async function getTask(taskListId: string, taskId: string, preloadedEpoch?: number): Promise<Task | null> {
  let raw: string
  try {
    raw = await fs.promises.readFile(getTaskPath(taskListId, taskId), 'utf8')
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return null
    logForDebugging(`task read failed: ${taskListId}/${taskId}: ${String(error)}`)
    logError(error)
    return null
  }
  const parsed = jsonParse(raw)
  if (parsed === undefined) {
    logForDebugging(`task body unparseable: ${taskListId}/${taskId}`)
    logError(new Error(`task body unparseable: ${taskListId}/${taskId}`))
    return null
  }
  const validated = TaskSchema().safeParse(parsed)
  if (!validated.success) {
    logForDebugging(`task body failed validation: ${taskListId}/${taskId}`)
    return null
  }
  const epoch = preloadedEpoch ?? (await readTaskEpoch(taskListId))
  if ((validated.data.epoch ?? 0) < epoch) return null
  return validated.data
}

export async function listTasks(taskListId: string): Promise<Task[]> {
  const ids = await listTaskIdsOnDisk(taskListId)
  if (ids.length === 0) return []
  const epoch = await readTaskEpoch(taskListId)
  const tasks = await Promise.all(ids.map(id => getTask(taskListId, id, epoch)))
  return tasks.filter((task): task is Task => task !== null)
}

async function updateTaskUnlocked(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  const existing = await getTask(taskListId, taskId)
  if (!existing) return null
  const merged: Task = { ...existing, ...updates, id: existing.id }
  await publishAtomic(getTaskPath(taskListId, taskId), jsonStringify(merged, null, 2))
  notifyTasksUpdated()
  return merged
}

export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  if ((await getTask(taskListId, taskId)) === null) return null
  return withLock(taskLockPath(taskListId, taskId), 'tasks-update', () =>
    updateTaskUnlocked(taskListId, taskId, updates),
  )
}

export async function deleteTask(taskListId: string, taskId: string): Promise<boolean> {
  try {
    const numeric = parseInt(taskId, 10)
    if (!Number.isNaN(numeric) && numeric > (await readHighWatermark(taskListId))) {
      await publishAtomic(highWatermarkPath(taskListId), jsonStringify(numeric))
    }
    try {
      await fs.promises.unlink(getTaskPath(taskListId, taskId))
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') return false
      throw error
    }
    for (const task of await listTasks(taskListId)) {
      const blocks = task.blocks.filter(id => id !== taskId)
      const blockedBy = task.blockedBy.filter(id => id !== taskId)
      if (blocks.length === task.blocks.length && blockedBy.length === task.blockedBy.length) continue
      await updateTask(taskListId, task.id, { blocks, blockedBy })
    }
    notifyTasksUpdated()
    return true
  } catch {
    return false
  }
}

export async function blockTask(taskListId: string, fromTaskId: string, toTaskId: string): Promise<boolean> {
  const [from, to] = await Promise.all([getTask(taskListId, fromTaskId), getTask(taskListId, toTaskId)])
  if (!from || !to) return false
  if (!from.blocks.includes(toTaskId)) {
    await updateTask(taskListId, fromTaskId, { blocks: [...from.blocks, toTaskId] })
  }
  if (!to.blockedBy.includes(fromTaskId)) {
    await updateTask(taskListId, toTaskId, { blockedBy: [...to.blockedBy, fromTaskId] })
  }
  return true
}


export type ClaimTaskOptions = { checkAgentBusy?: boolean }

export type ClaimTaskResult =
  | { success: true; task: Task }
  | { success: false; reason: 'task_not_found' }
  | { success: false; reason: 'already_claimed' | 'already_resolved'; task: Task }
  | { success: false; reason: 'blocked'; task: Task; blockedByTasks: string[] }
  | { success: false; reason: 'agent_busy'; task: Task; busyWithTasks: string[] }

export async function claimTask(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  options?: ClaimTaskOptions,
): Promise<ClaimTaskResult> {
  try {
    if ((await getTask(taskListId, taskId)) === null) {
      return { success: false, reason: 'task_not_found' }
    }

    if (options?.checkAgentBusy) {
      return await withLock(listLockPath(taskListId), 'tasks-claim', async () => {
        const tasks = await listTasks(taskListId)
        const task = tasks.find(candidate => candidate.id === taskId)
        if (!task) return { success: false, reason: 'task_not_found' } as const
        if (task.owner && task.owner !== claimantAgentId) {
          return { success: false, reason: 'already_claimed', task } as const
        }
        if (task.status === 'completed') {
          return { success: false, reason: 'already_resolved', task } as const
        }
        const openIds = new Set(tasks.filter(candidate => candidate.status !== 'completed').map(t => t.id))
        const blockedByTasks = task.blockedBy.filter(id => openIds.has(id))
        if (blockedByTasks.length > 0) {
          return { success: false, reason: 'blocked', task, blockedByTasks } as const
        }
        const busyWithTasks = tasks
          .filter(
            candidate =>
              candidate.id !== taskId && candidate.owner === claimantAgentId && candidate.status !== 'completed',
          )
          .map(candidate => candidate.id)
        if (busyWithTasks.length > 0) {
          return { success: false, reason: 'agent_busy', task, busyWithTasks } as const
        }
        const claimed = await updateTask(taskListId, taskId, { owner: claimantAgentId })
        if (!claimed) return { success: false, reason: 'task_not_found' } as const
        return { success: true, task: claimed } as const
      })
    }

    return await withLock(taskLockPath(taskListId, taskId), 'tasks-claim', async () => {
      const task = await getTask(taskListId, taskId)
      if (!task) return { success: false, reason: 'task_not_found' } as const
      if (task.owner && task.owner !== claimantAgentId) {
        return { success: false, reason: 'already_claimed', task } as const
      }
      if (task.status === 'completed') {
        return { success: false, reason: 'already_resolved', task } as const
      }
      const all = await listTasks(taskListId)
      const openIds = new Set(all.filter(candidate => candidate.status !== 'completed').map(t => t.id))
      const blockedByTasks = task.blockedBy.filter(id => openIds.has(id))
      if (blockedByTasks.length > 0) {
        return { success: false, reason: 'blocked', task, blockedByTasks } as const
      }
      const claimed = await updateTaskUnlocked(taskListId, taskId, { owner: claimantAgentId })
      if (!claimed) return { success: false, reason: 'task_not_found' } as const
      return { success: true, task: claimed } as const
    })
  } catch (error) {
    logForDebugging(`claimTask failed: ${taskListId}/${taskId}: ${String(error)}`)
    logError(error)
    return { success: false, reason: 'task_not_found' }
  }
}


export type TeamMember = { agentId: string; name: string; agentType?: string }

export type AgentStatus = {
  agentId: string
  name: string
  agentType?: string
  status: 'busy' | 'idle'
  currentTasks: string[]
}

export async function getAgentStatuses(teamName: string): Promise<AgentStatus[] | null> {
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) return null
  const members: TeamMember[] = (teamFile.members ?? []).map(member => ({
    agentId: String(member.agentId),
    name: String(member.name),
    agentType: member.agentType,
  }))
  const tasks = await listTasks(sanitizeTeamNameForListId(teamName))
  const open = tasks.filter(task => task.status !== 'completed' && task.owner)
  return members.map(member => {
    const ownedIds = uniq(
      open.filter(task => task.owner === member.name || task.owner === member.agentId).map(task => task.id),
    )
    return {
      ...member,
      status: ownedIds.length > 0 ? ('busy' as const) : ('idle' as const),
      currentTasks: ownedIds,
    }
  })
}

export type UnassignTasksResult = {
  unassignedTasks: Array<{ id: string; subject: string }>
  notificationMessage: string
}

export async function unassignTeammateTasks(
  teamName: string,
  teammateId: string,
  teammateName: string,
  reason: 'terminated' | 'shutdown',
): Promise<UnassignTasksResult> {
  const tasks = await listTasks(teamName)
  const owned = tasks.filter(
    task => task.status !== 'completed' && (task.owner === teammateId || task.owner === teammateName),
  )
  const unassignedTasks: Array<{ id: string; subject: string }> = []
  for (const task of owned) {
    await updateTask(teamName, task.id, { owner: undefined, status: 'pending' })
    unassignedTasks.push({ id: task.id, subject: task.subject })
  }
  if (unassignedTasks.length > 0) {
    logForDebugging(`unassigned ${unassignedTasks.length} task(s) from ${teammateName} (${reason})`)
  }
  const departed =
    reason === 'terminated' ? `${teammateName} was terminated.` : `${teammateName} has shut down.`
  const notificationMessage =
    unassignedTasks.length === 0
      ? departed
      : `${departed} ${unassignedTasks.length} task(s) were unassigned: ${unassignedTasks
          .map(task => `#${task.id} "${task.subject}"`)
          .join(', ')}. Use ${TASK_LIST_TOOL_NAME} to check availability and ${TASK_UPDATE_TOOL_NAME} with owner to reassign them to idle teammates.`
  return { unassignedTasks, notificationMessage }
}
