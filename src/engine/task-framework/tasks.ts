import { join } from 'node:path'
import * as fs from 'node:fs'

import uniqBy from 'lodash-es/uniqBy.js'
import { z } from 'zod'

import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getIsNonInteractiveSession, getSessionId } from '../../boot/process-state/processState.js'
import { publishAtomic } from '../../platform/substrate/fileStore.js'
import { groupCommitLane, type GroupCommitLane } from '../../platform/substrate/groupCommit.js'
import { acquirePidLockWithRetry, noteLockRelease } from '../../platform/substrate/pidLock.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { getMercuryHome, isEnvTruthy } from '../../platform/environment/envUtils.js'
import { lazySchema } from '../../platform/primitives/lazySchema.js'
import { logError } from '../../platform/logs/errorLog.js'
import { getErrnoCode } from '../../platform/errors/errors.js'
import { createSignal } from '../../platform/async/signal.js'
import { jsonParse, jsonStringify } from '../../platform/logs/slowOperations.js'
import { passedOver } from '../../platform/errors/passedOver.js'


export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

const TaskStatusSchema = lazySchema(() => z.enum(TASK_STATUSES))

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

export function isTaskToolsEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_TASKS')) || !getIsNonInteractiveSession()
}

export function getTaskListId(): string {
  return flagEnv('MERCURY_TASK_LIST_ID') || getSessionId()
}

export async function listSessionMission(): Promise<Task[]> {
  return uniqBy(await listTasks(getTaskListId()), task => task.id)
}

export function sanitizePathComponent(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '-')
}


export function getTasksDir(taskListId: string): string {
  return join(getMercuryHome(), 'tasks', sanitizePathComponent(taskListId))
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return join(getTasksDir(taskListId), `${sanitizePathComponent(taskId)}.json`)
}

export async function ensureTasksDir(taskListId: string): Promise<void> {
  await fs.promises.mkdir(getTasksDir(taskListId), { recursive: true })
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
  } catch (error) {
    passedOver(error)
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
  let raw: string
  try {
    raw = await fs.promises.readFile(epochPath(taskListId), 'utf8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return 0
    throw error
  }
  const parsed = jsonParse(raw) as { epoch?: unknown } | undefined
  if (typeof parsed?.epoch !== 'number' || !Number.isFinite(parsed.epoch)) {
    throw new SyntaxError(`invalid task epoch in ${epochPath(taskListId)}`)
  }
  return parsed.epoch
}

function isTaskBodyName(name: string): boolean {
  return name.endsWith('.json') && !name.startsWith('.')
}

async function listTaskIdsOnDisk(taskListId: string): Promise<string[]> {
  try {
    const names = await fs.promises.readdir(getTasksDir(taskListId))
    return names
      .filter(isTaskBodyName)
      .map(name => name.slice(0, -'.json'.length))
      .sort(byCreationOrder)
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return []
    throw error
  }
}

function byCreationOrder(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return a < b ? -1 : a > b ? 1 : 0
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
  let raw: string
  try {
    raw = await fs.promises.readFile(highWatermarkPath(taskListId), 'utf8')
  } catch (error) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return 0
    throw error
  }
  const parsed = jsonParse(raw)
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new SyntaxError(`invalid highwatermark in ${highWatermarkPath(taskListId)}`)
  }
  return parsed
}

export async function resetTaskList(
  taskListId: string,
  opts?: { onlyIfAllCompleted?: boolean },
): Promise<boolean> {
  await ensureTasksDir(taskListId)
  const reset = await withLock(listLockPath(taskListId), 'tasks-reset', async () => {
    if (opts?.onlyIfAllCompleted) {
      const tasks = await listTasks(taskListId)
      if (tasks.length === 0 || tasks.some(task => task.status !== 'completed')) return false
    }
    const highest = await highestNumericIdOnDisk(taskListId)
    if (highest > (await readHighWatermark(taskListId))) {
      await publishAtomic(highWatermarkPath(taskListId), jsonStringify(highest))
    }
    const epoch = (await readTaskEpoch(taskListId)) + 1
    await publishAtomic(epochPath(taskListId), jsonStringify({ epoch, resetAt: new Date().toISOString() }))
    let names: string[] = []
    try {
      names = await fs.promises.readdir(getTasksDir(taskListId))
    } catch (error) {
      passedOver(error)
    }
    for (const name of names) {
      if (!isTaskBodyName(name)) continue
      try {
        await fs.promises.unlink(join(getTasksDir(taskListId), name))
      } catch (error) {
        passedOver(error)
      }
    }
    return true
  })
  if (reset) notifyTasksUpdated()
  return reset
}

export async function sweepDeadEpochTasks(taskListId: string): Promise<number> {
  const epoch = await readTaskEpoch(taskListId)
  if (epoch === 0) return 0
  let names: string[] = []
  try {
    names = await fs.promises.readdir(getTasksDir(taskListId))
  } catch (error) {
    passedOver(error)
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
    } catch (error) {
      passedOver(error)
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
  let parsed: unknown
  try {
    parsed = jsonParse(raw)
  } catch {
    parsed = undefined
  }
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
  return tasks.filter(task => task !== null)
}

async function updateTaskUnlocked(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  const existing = await getTask(taskListId, taskId)
  if (!existing) return null
  const updated: Task = { ...existing, ...updates, id: existing.id }
  await publishAtomic(getTaskPath(taskListId, taskId), jsonStringify(updated, null, 2))
  notifyTasksUpdated()
  return updated
}

export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  if (!(await getTask(taskListId, taskId))) return null
  return withLock(taskLockPath(taskListId, taskId), 'tasks-update', () =>
    updateTaskUnlocked(taskListId, taskId, updates),
  )
}

export async function deleteTask(taskListId: string, taskId: string): Promise<boolean> {
  const numericId = parseInt(taskId, 10)
  if (!Number.isNaN(numericId) && numericId > (await readHighWatermark(taskListId))) {
    await publishAtomic(highWatermarkPath(taskListId), jsonStringify(numericId))
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
}

export async function blockTask(taskListId: string, fromTaskId: string, toTaskId: string): Promise<boolean> {
  const [fromTask, toTask] = await Promise.all([getTask(taskListId, fromTaskId), getTask(taskListId, toTaskId)])
  if (!fromTask || !toTask) return false
  if (!fromTask.blocks.includes(toTaskId)) {
    await updateTask(taskListId, fromTaskId, { blocks: [...fromTask.blocks, toTaskId] })
  }
  if (!toTask.blockedBy.includes(fromTaskId)) {
    await updateTask(taskListId, toTaskId, { blockedBy: [...toTask.blockedBy, fromTaskId] })
  }
  return true
}


type ClaimTaskOptions = { checkAgentBusy?: boolean }

type ClaimTaskResult =
  | { success: true; task: Task }
  | { success: false; reason: 'task_not_found' }
  | { success: false; reason: 'already_claimed' | 'already_resolved'; task: Task }
  | { success: false; reason: 'blocked'; task: Task; blockedByTasks: string[] }
  | { success: false; reason: 'agent_busy'; task: Task; busyWithTasks: string[] }

async function claimChecked(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  checkAgentBusy: boolean,
  write: (updates: Partial<Omit<Task, 'id'>>) => Promise<Task | null>,
): Promise<ClaimTaskResult> {
  const task = await getTask(taskListId, taskId)
  if (!task) return { success: false, reason: 'task_not_found' }
  if (task.owner && task.owner !== claimantAgentId) return { success: false, reason: 'already_claimed', task }
  if (task.status === 'completed') return { success: false, reason: 'already_resolved', task }
  const tasks = await listTasks(taskListId)
  const unresolved = new Set(tasks.filter(other => other.status !== 'completed').map(other => other.id))
  const blockedByTasks = task.blockedBy.filter(id => unresolved.has(id))
  if (blockedByTasks.length > 0) return { success: false, reason: 'blocked', task, blockedByTasks }
  if (checkAgentBusy) {
    const busyWithTasks = tasks
      .filter(other => other.owner === claimantAgentId && other.id !== task.id && other.status !== 'completed')
      .map(other => other.id)
    if (busyWithTasks.length > 0) return { success: false, reason: 'agent_busy', task, busyWithTasks }
  }
  const claimed = await write({ owner: claimantAgentId })
  if (!claimed) return { success: false, reason: 'task_not_found' }
  return { success: true, task: claimed }
}

export async function claimTask(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  options?: ClaimTaskOptions,
): Promise<ClaimTaskResult> {
  if (!(await getTask(taskListId, taskId))) return { success: false, reason: 'task_not_found' }
  const taskLock = taskLockPath(taskListId, taskId)
  const write = (updates: Partial<Omit<Task, 'id'>>): Promise<Task | null> =>
    updateTaskUnlocked(taskListId, taskId, updates)
  if (options?.checkAgentBusy) {
    return withLock(listLockPath(taskListId), 'tasks-claim', () =>
      claimChecked(taskListId, taskId, claimantAgentId, true, updates =>
        withLock(taskLock, 'tasks-claim', () => write(updates)),
      ),
    )
  }
  return withLock(taskLock, 'tasks-claim', () => claimChecked(taskListId, taskId, claimantAgentId, false, write))
}
