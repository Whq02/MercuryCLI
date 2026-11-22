import { join } from 'node:path'
import * as fs from 'node:fs'

import { z } from 'zod'

import { flagEnv } from '../substrate/flagRegistry.js'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import { publishAtomic } from '../substrate/fileStore.js'
import { groupCommitLane, type GroupCommitLane } from '../substrate/groupCommit.js'
import { acquirePidLockWithRetry, noteLockRelease } from '../substrate/pidLock.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome, isEnvTruthy } from './envUtils.js'
import { lazySchema } from './lazySchema.js'
import { logError } from './log.js'
import { getErrnoCode } from './errors.js'
import { createSignal } from './signal.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import { passedOver } from './passedOver.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'


export const TASK_STATUSES: Unbuilt = unbuilt('src/utils/tasks.ts:21')
export type TaskStatus = Unbuilt

export const TaskSchema: Unbuilt = unbuilt('src/utils/tasks.ts:26')
export type Task = Unbuilt

export function isTaskToolsEnabled(): boolean {
  return notBuilt('src/utils/tasks.ts:42')
}

export function getTaskListId(): string {
  return notBuilt('src/utils/tasks.ts:46')
}

export async function listSessionMission(): Promise<Task[]> {
  return notBuilt('src/utils/tasks.ts:50')
}

export function sanitizePathComponent(input: string): string {
  return notBuilt('src/utils/tasks.ts:63')
}


export function getTasksDir(taskListId: string): string {
  return notBuilt('src/utils/tasks.ts:68')
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return notBuilt('src/utils/tasks.ts:72')
}

export async function ensureTasksDir(taskListId: string): Promise<void> {
  return notBuilt('src/utils/tasks.ts:76')
}

function highWatermarkPath(taskListId: string): string {
  return notBuilt('src/utils/tasks.ts:80')
}

function epochPath(taskListId: string): string {
  return notBuilt('src/utils/tasks.ts:84')
}

function listLockPath(taskListId: string): string {
  return notBuilt('src/utils/tasks.ts:88')
}


const tasksUpdatedSignal: Unbuilt = unbuilt('src/utils/tasks.ts:97')

export function notifyTasksUpdated(): void {
  return notBuilt('src/utils/tasks.ts:99')
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
  return notBuilt('src/utils/tasks.ts:199')
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
  return notBuilt('src/utils/tasks.ts:342')
}

export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  return notBuilt('src/utils/tasks.ts:363')
}

export async function deleteTask(taskListId: string, taskId: string): Promise<boolean> {
  return notBuilt('src/utils/tasks.ts:374')
}

export async function blockTask(taskListId: string, fromTaskId: string, toTaskId: string): Promise<boolean> {
  return notBuilt('src/utils/tasks.ts:395')
}


type ClaimTaskOptions = { checkAgentBusy?: boolean }

type ClaimTaskResult =
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
  return notBuilt('src/utils/tasks.ts:417')
}
