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

/**
 * The durable, multi-process task list: one JSON body per task under the
 * Mercury home, with `.highwatermark` / `.epoch` / `.lock` sidecars, epoch-
 * based crash-safe resets, pid-liveness locking, and dependency edges.
 * A session, a team lead, and a fleet of teammates all mutate one list
 * concurrently; readers never take a lock, so every write is an atomic
 * publication.
 */

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

/** The fixed list id used by the tasks-only mode. */
export const DEFAULT_TASKS_MODE_TASK_LIST_ID = 'tasklist'

/** On when the env force-enables it OR the session is interactive. */
export function isTodoV2Enabled(): boolean {
  return isEnvTruthy(process.env.MERCURY_TASKS) || !getIsNonInteractiveSession()
}

let leaderTeamName: string | undefined

/**
 * The list id, resolved on EVERY call and returned unsanitised (path
 * sanitisation happens only where a path is built): the explicit env
 * override; the in-process teammate context's team (teammates share their
 * leader's list); the ambient team resolver; the leader-registered team;
 * else the session id.
 */
export function getTaskListId(): string {
  const override = process.env.MERCURY_TASK_LIST_ID
  if (override) return override
  if (isInProcessTeammate()) {
    const teamName = getTeammateContext()?.teamName
    if (teamName) return teamName
  }
  return getTeamName() || leaderTeamName || getSessionId()
}

/** A leader-registration change means subscribers are watching a different directory. */
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

/**
 * The PATH-COMPONENT sanitiser: every character outside [A-Za-z0-9_-]
 * becomes '-', case PRESERVED. A security requirement (no traversal, no
 * separators), applied to both the list id and the task id. Deliberately
 * different from the lower-casing NAME sanitiser below — the two disagree
 * on case and on '_', and both behaviours are load-bearing.
 */
export function sanitizePathComponent(input: string): string {
  return input.replace(/[^A-Za-z0-9_-]/g, '-')
}

/**
 * The NAME sanitiser used for team directories and the agent-status view's
 * derived list id: every non-alphanumeric becomes '-', LOWER-CASED. A
 * private copy — the exported twin lives in the swarm helpers, and the two
 * must not be unified with the path-component sanitiser above.
 */
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
    // Swallowed: callers surface failures from their own subsequent operations.
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

// ── change notification ─────────────────────────────────────────────────────

const tasksUpdatedSignal = createSignal()

/**
 * ONE emit wrapped in ONE silent try/catch: a throwing subscriber can never
 * fail the mutation that fired it, and it silently stops emission for the
 * remaining listeners — that is the contract.
 */
export function notifyTasksUpdated(): void {
  try {
    tasksUpdatedSignal.emit()
  } catch {
    // Silent by contract.
  }
}

export const onTasksUpdated = tasksUpdatedSignal.subscribe

// ── locking ─────────────────────────────────────────────────────────────────

// A process-scoped owner would let the mutex's same-owner adoption arm
// co-admit every concurrent in-process acquirer; the unique per-acquisition
// owner makes the second acquirer block instead.
let taskLockSeq = 0

function mintLockOwner(): string {
  return `tasks-${process.pid}-${++taskLockSeq}`
}

const LOCK_RETRY_OPTS = {
  liveness: 'assume-alive' as const,
  // Sized for ~ten concurrent agents each doing a scan plus reads plus a
  // write: the last caller in a ten-way race needs on the order of a
  // second, and this budget gives a few jittered seconds before the typed
  // busy error. A live holder is never stolen from.
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

// ── epoch and reset ─────────────────────────────────────────────────────────

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
    // Suffix filter ONLY (no dot check) — deliberately different from the
    // reset/sweep filter; inert today but specified as written.
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

/**
 * Crash-safe reset: record the high-water mark, durably publish the
 * incremented epoch (the COMMIT point — from that instant every reader
 * treats lower-epoch bodies as dead), and only then unlink the bodies.
 * An interrupted reset therefore never resurrects old tasks. Under
 * `onlyIfAllCompleted` the precondition is re-checked while HOLDING the
 * list lock — a lock-free check could otherwise wipe a task created inside
 * the await window; listing under the lock is safe because readers never
 * take it.
 */
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
    // Past the commit point: leftover bytes are garbage, not live tasks.
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
        // Ignored: the epoch filter already killed it.
      }
    }
    return true
  })
  if (result) notifyTasksUpdated()
  return result
}

/**
 * Reclaim dead-epoch bodies later: same suffix/dot filter as the reset,
 * epoch 0 is a no-op, unreadable/invalid bodies are left for diagnostics.
 * Notifies only when at least one body was removed.
 */
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
      // Unreadable bodies are the diagnostics path's to report.
    }
  }
  if (removed > 0) notifyTasksUpdated()
  return removed
}

// ── id allocation (the batched create lane) ────────────────────────────────

type CreateLaneState = { nextId: number; epoch: number }

// Memoised per lock path for the process lifetime: a burst of creates
// shares one lock acquisition, one directory scan, and one change
// notification, while every creation still durably publishes its own body
// inside the batch with a unique, contiguous id. Under load, per-create
// lock contention dropped writes once the retry budget was exhausted.
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
      // Each entry's body publish is the durable act; the batch publish
      // only fires the single change notification for the whole group.
      publish: async () => {
        notifyTasksUpdated()
      },
    })
    createLanes.set(lockPath, lane)
  }
  return lane
}

/** Resolves to the new id (a decimal string). Ids are never reused: the high-water mark outlives deletes and resets. */
export async function createTask(taskListId: string, taskData: Omit<Task, 'id'>): Promise<string> {
  await ensureTasksDir(taskListId)
  return createLaneFor(taskListId).submit(async current => {
    const id = String(current.nextId)
    const body: Task = {
      ...taskData,
      id,
      // A never-reset list writes bodies indistinguishable from legacy ones.
      ...(current.epoch > 0 ? { epoch: current.epoch } : {}),
    }
    await publishAtomic(getTaskPath(taskListId, id), jsonStringify(body, null, 2))
    return { next: { ...current, nextId: current.nextId + 1 }, result: id }
  })
}

// ── read / write ────────────────────────────────────────────────────────────

/**
 * Validation FIRST, then the epoch filter — an unparseable body is missing
 * regardless of epoch. Missing file: silent null. Other read errors: debug
 * + error log, null. Schema failure: debug only, null.
 */
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
    // An unparseable body logs the debug line AND the error log.
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

/** Missing directory ⇒ empty list. The epoch is read once for the batch. */
export async function listTasks(taskListId: string): Promise<Task[]> {
  const ids = await listTaskIdsOnDisk(taskListId)
  if (ids.length === 0) return []
  const epoch = await readTaskEpoch(taskListId)
  const tasks = await Promise.all(ids.map(id => getTask(taskListId, id, epoch)))
  return tasks.filter((task): task is Task => task !== null)
}

/** The lock-free variant used while the caller already holds the relevant lock. */
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

/**
 * Existence is checked BEFORE the lock — a non-existent task must yield a
 * clean null without creating a lock artifact. The per-task lock covers the
 * read-merge-publish cycle; lock exhaustion propagates as the typed busy
 * error.
 */
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

/**
 * Takes no lock of its own. The high-water mark is raised FIRST so the id
 * can never be reissued; the dependency sweep write-backs go through the
 * LOCKING update, one per changed task. Any throw yields false.
 */
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
    // Any throw yields false, without logging.
    return false
  }
}

/**
 * The edge is stored redundantly on both endpoints. Either endpoint missing
 * ⇒ false with nothing changed; an edge both ends already carry ⇒ true (it
 * exists either way).
 */
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

// ── claiming ────────────────────────────────────────────────────────────────

export type ClaimTaskOptions = { checkAgentBusy?: boolean }

export type ClaimTaskResult =
  | { success: true; task: Task }
  | { success: false; reason: 'task_not_found' }
  | { success: false; reason: 'already_claimed' | 'already_resolved'; task: Task }
  | { success: false; reason: 'blocked'; task: Task; blockedByTasks: string[] }
  | { success: false; reason: 'agent_busy'; task: Task; busyWithTasks: string[] }

/**
 * Assign an owner under mutual exclusion. A blocked-by id naming no task in
 * the list is NOT a blocker — only ids present AND not completed block.
 * A claim never rejects: any throw is logged and reported as not-found.
 */
export async function claimTask(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  options?: ClaimTaskOptions,
): Promise<ClaimTaskResult> {
  try {
    // Shared lock-free existence pre-check: both modes answer not-found
    // without creating a lock artifact.
    if ((await getTask(taskListId, taskId)) === null) {
      return { success: false, reason: 'task_not_found' }
    }

    if (options?.checkAgentBusy) {
      // The "is this agent already busy?" question and the claim must be
      // atomic, so the checks run under the LIST lock over a single list
      // read. The held list lock does not cover the per-task lock, so the
      // successful claim goes through the LOCKING per-task update.
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
      // The per-task lock is already held, so the lock-free variant.
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

// ── team-derived views ──────────────────────────────────────────────────────

export type TeamMember = { agentId: string; name: string; agentType?: string }

export type AgentStatus = {
  agentId: string
  name: string
  agentType?: string
  status: 'busy' | 'idle'
  currentTasks: string[]
}

/**
 * Reads the team config through the swarm helpers (null when absent or
 * unreadable) and groups non-completed owned tasks by owner. Ownership
 * matches BOTH the display name and the full agent id (older tasks stored
 * the id, newer ones the name). The derived list id goes through the
 * lower-casing NAME sanitiser — unlike every other list-id path.
 */
export async function getAgentStatuses(teamName: string): Promise<AgentStatus[] | null> {
  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) return null
  const members: TeamMember[] = (teamFile.members ?? []).map(member => ({
    agentId: String(member.agentId),
    name: String(member.name),
    // No coercion: a member without an agentType keeps undefined.
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

/**
 * Free every non-completed task owned by a departed teammate (matched by id
 * OR display name), clearing the owner and returning the status to pending
 * in one update each. The team name is used VERBATIM as the list id here —
 * the divergence from the agent-status view above is deliberate.
 */
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
