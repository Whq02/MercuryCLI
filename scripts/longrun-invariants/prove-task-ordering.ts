#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'task-ordering-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TASK_LIST_ID = 'vigil-q9-proof'

await import('../../src/tasks.js')
const tasksStore = await import('../../src/utils/tasks.js')
const { TaskCreateTool } = await import('../../src/tools/TaskCreateTool/TaskCreateTool.js')
const { TaskUpdateTool } = await import('../../src/tools/TaskUpdateTool/TaskUpdateTool.js')
const { createTask, getTask, listTasks, resetTaskList } = tasksStore

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const LIST = 'vigil-q9-proof'
const baseTask = (subject: string, status: string): Record<string, unknown> => ({
  subject,
  description: 'q9 fixture',
  status,
  blocks: [],
  blockedBy: [],
})

const ctx = {
  setAppState: () => {},
  getAppState: () => ({}),
  abortController: new AbortController(),
} as never

section('§A the guarded reset: a task created in the await window survives')
{
  await resetTaskList(LIST)
  await createTask(LIST, baseTask('done-one', 'completed') as never)
  await createTask(LIST, baseTask('done-two', 'completed') as never)
  const wiped = await resetTaskList(LIST, { onlyIfAllCompleted: true })
  check('all-completed list: the guarded reset proceeds', wiped === true)
  check('…and the list is empty', (await listTasks(LIST)).length === 0)

  await createTask(LIST, baseTask('done-three', 'completed') as never)
  const freshId = await createTask(LIST, baseTask('fresh-window-task', 'pending') as never)
  const wiped2 = await resetTaskList(LIST, { onlyIfAllCompleted: true })
  check('a live task ABORTS the guarded wipe', wiped2 === false)
  const fresh = await getTask(LIST, freshId)
  check('the window task SURVIVES', fresh?.subject === 'fresh-window-task', JSON.stringify(fresh))
  check('nothing else was dropped either', (await listTasks(LIST)).length === 2)

  const wiped3 = await resetTaskList(LIST)
  check('the unconditional reset (team ops contract) still wipes', wiped3 === true && (await listTasks(LIST)).length === 0)
}

section('§B TaskUpdate reports what actually landed')
{
  await resetTaskList(LIST)
  const id = await createTask(LIST, baseTask('edge-target', 'pending') as never)
  const res = (await TaskUpdateTool.call(
    { taskId: id, addBlocks: ['9999'], subject: 'renamed' } as never,
    ctx,
  )) as { data: { success: boolean; error?: string; updatedFields: string[] } }
  check(
    'a dependency edge to a MISSING task reports failure, not success',
    res.data.success === false && /missing task/i.test(res.data.error ?? ''),
    JSON.stringify(res.data),
  )
  check('…while naming the fields that did land', /subject/.test(res.data.error ?? ''))
  const after = await getTask(LIST, id)
  check('the landed field is really on disk', after?.subject === 'renamed')

  const ok = (await TaskUpdateTool.call(
    { taskId: id, status: 'in_progress' } as never,
    ctx,
  )) as { data: { success: boolean } }
  check('a clean update still succeeds', ok.data.success === true)

  const gone = (await TaskUpdateTool.call(
    { taskId: '424242', status: 'completed' } as never,
    ctx,
  )) as { data: { success: boolean; error?: string } }
  check("a missing task reports 'Task not found'", gone.data.success === false && /not found/i.test(gone.data.error ?? ''))
}

section('§C batch mutations are ordered (concurrency declarations)')
{
  type ToolLike = { isConcurrencySafe: (i?: unknown) => boolean }
  check(
    'TaskCreate declares NOT concurrency-safe (shared-store read-modify-write)',
    (TaskCreateTool as unknown as ToolLike).isConcurrencySafe({}) === false,
  )
  check(
    'TaskUpdate declares NOT concurrency-safe',
    (TaskUpdateTool as unknown as ToolLike).isConcurrencySafe({}) === false,
  )
}

section('§D the hide-timer caller is wired to the guard')
{
  const src = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'hooks', 'useTasksV2.ts'),
    'utf8',
  )
  check('the hide-timer reset passes onlyIfAllCompleted', src.includes('onlyIfAllCompleted: true'))
  check('an aborted wipe refetches instead of hiding the fresh task',
    src.includes('void this.#fetch()'))
  const store = readFileSync(join(import.meta.dir, '..', '..', 'src', 'utils', 'tasks.ts'), 'utf8')
  check('the guard re-verifies UNDER the lock (order: lock, then list)',
    /withLock\(listLockPath\(taskListId\),[^\n]*async \(\) => \{\s*\n\s*if \(opts\?\.onlyIfAllCompleted\)/.test(store))
  const upd = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'tools', 'TaskUpdateTool', 'TaskUpdateTool.ts'),
    'utf8',
  )
  check('assignment mail sits AFTER the applied-update check (no mail for a lost write)',
    upd.indexOf('nothing was applied') !== -1 && upd.indexOf('nothing was applied') < upd.indexOf('await writeToMailbox('))
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const { TasksV2Store } = await import('../../src/hooks/useTasksV2.js')
const { notifyTasksUpdated } = tasksStore

section('§E TasksV2Store: list reads never overlap — one running + one trailing, newest wins')
{
  let active = 0
  let maxActive = 0
  let calls = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(r => {
    releaseFirst = r
  })
  const stale = [{ ...baseTask('stale-task', 'pending'), id: '1' }]
  const fresh = [{ ...baseTask('fresh-task', 'pending'), id: '2' }]
  const store = new TasksV2Store({
    listTasksImpl: (async () => {
      calls++
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (calls === 1) {
          await firstGate
          return stale as never
        }
        return fresh as never
      } finally {
        active--
      }
    }) as never,
  })
  const unsub = store.subscribe(() => {})
  await sleep(20)
  notifyTasksUpdated()
  await sleep(120)
  check('a fetch requested mid-read starts NO second concurrent list read', maxActive === 1, `maxActive=${maxActive}`)
  releaseFirst()
  await sleep(120)
  const snap = store.getSnapshot()
  check(
    'the trailing re-read lands LAST — the newest disk state wins',
    snap?.[0]?.subject === 'fresh-task',
    JSON.stringify(snap?.map(t => t.subject)),
  )
  check('both reads happened (one running, one trailing)', calls >= 2, `calls=${calls}`)
  unsub()
}

section('§F a fetch in flight at last-unsubscribe cannot resurrect the store')
{
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  const store = new TasksV2Store({
    listTasksImpl: (async () => {
      await gate
      return [{ ...baseTask('still-open', 'pending'), id: '3' }] as never
    }) as never,
  })
  let notifies = 0
  const unsub = store.subscribe(() => notifies++)
  await sleep(20)
  unsub()
  const notifiesAtStop = notifies
  release()
  await sleep(80)
  const stats = store._statsForProofs()
  check(
    'the dead lifecycle completion re-armed NOTHING (no poll timer, no watcher, no debounce)',
    !stats.pollTimer && !stats.watcher && !stats.debounceTimer && !stats.hideTimer,
    JSON.stringify(stats),
  )
  check('…and the store stays stopped', stats.started === false && stats.subscribers === 0, JSON.stringify(stats))
  check('…and nobody was notified after stop', notifies === notifiesAtStop, `${notifiesAtStop} → ${notifies}`)
}

section('§G the hide-verify chain shares the cancellation token — no post-stop wipe')
{
  let resetCalls = 0
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  const completed = [{ ...baseTask('done-task', 'completed'), id: '9' }]
  const store = new TasksV2Store({
    hideDelayMs: 40,
    listTasksImpl: (async () => {
      calls++
      if (calls >= 2) await gate
      return completed as never
    }) as never,
    resetTaskListImpl: (async () => {
      resetCalls++
      return true
    }) as never,
    syncDeliverablesImpl: async () => {},
  })
  const unsub = store.subscribe(() => {})
  await sleep(150)
  check('the hide timer fired and its verify read is in flight', calls >= 2, `calls=${calls}`)
  unsub()
  release()
  await sleep(80)
  check(
    '…but the token drops it: NO disk wipe ran after the last unsubscribe',
    resetCalls === 0,
    `resetCalls=${resetCalls}`,
  )
  const stats = store._statsForProofs()
  check(
    'and the dead chain left zero live resources',
    !stats.watcher && !stats.pollTimer && !stats.hideTimer && !stats.debounceTimer && !stats.started,
    JSON.stringify(stats),
  )
}

await resetTaskList(LIST)
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
if (failures > 0) {
  console.log(`❌ ${failures} TASK-ORDERING PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TASK-ORDERING PROOFS PASS')
process.exit(0)
