#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'task-ordering-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_TASK_LIST_ID = 'vigil-q9-proof'

await import('../../src/engine/tasks/tasks.js')
const tasksStore = await import('../../src/engine/task-framework/tasks.js')
const { TaskCreateTool } = await import('../../src/tools/task-create/TaskCreateTool.js')
const { TaskUpdateTool } = await import('../../src/tools/task-update/TaskUpdateTool.js')
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
  check('all-completed list: the guarded reset proceeds', wiped === true, 'resetTaskList with onlyIfAllCompleted in src/engine/task-framework/tasks.ts must return true when every task is completed')
  check('…and the list is empty', (await listTasks(LIST)).length === 0, 'resetTaskList in src/engine/task-framework/tasks.ts must delete every task body when the guard passes')

  await createTask(LIST, baseTask('done-three', 'completed') as never)
  const freshId = await createTask(LIST, baseTask('fresh-window-task', 'pending') as never)
  const wiped2 = await resetTaskList(LIST, { onlyIfAllCompleted: true })
  check('a live task ABORTS the guarded wipe', wiped2 === false, 'resetTaskList in src/engine/task-framework/tasks.ts must return false under onlyIfAllCompleted when any task is not completed')
  const fresh = await getTask(LIST, freshId)
  check('the window task SURVIVES', fresh?.subject === 'fresh-window-task', JSON.stringify(fresh) + ' — an aborted guarded reset in resetTaskList (src/engine/task-framework/tasks.ts) must leave the task files untouched')
  check('nothing else was dropped either', (await listTasks(LIST)).length === 2, 'an aborted guarded reset in resetTaskList (src/engine/task-framework/tasks.ts) must not delete any task')

  const wiped3 = await resetTaskList(LIST)
  check('the unconditional reset (crew ops contract) still wipes', wiped3 === true && (await listTasks(LIST)).length === 0, 'resetTaskList without options in src/engine/task-framework/tasks.ts must return true and delete every task')
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
  check('…while naming the fields that did land', /subject/.test(res.data.error ?? ''), 'the failed-edge error in src/tools/task-update/TaskUpdateTool.ts must name the fields that were applied; got: ' + JSON.stringify(res.data.error))
  const after = await getTask(LIST, id)
  check('the landed field is really on disk', after?.subject === 'renamed', 'TaskUpdateTool.call in src/tools/task-update/TaskUpdateTool.ts must still save the subject when a dependency edge fails; got: ' + JSON.stringify(after))

  const ok = (await TaskUpdateTool.call(
    { taskId: id, status: 'in_progress' } as never,
    ctx,
  )) as { data: { success: boolean } }
  check('a clean update still succeeds', ok.data.success === true, 'TaskUpdateTool.call in src/tools/task-update/TaskUpdateTool.ts must report success for a valid status change; got: ' + JSON.stringify(ok.data))

  const gone = (await TaskUpdateTool.call(
    { taskId: '424242', status: 'completed' } as never,
    ctx,
  )) as { data: { success: boolean; error?: string } }
  check("a missing task reports 'Task not found'", gone.data.success === false && /not found/i.test(gone.data.error ?? ''), 'TaskUpdateTool.call in src/tools/task-update/TaskUpdateTool.ts must return success false with a Task not found error; got: ' + JSON.stringify(gone.data))
}

section('§C batch mutations are ordered (concurrency declarations)')
{
  type ToolLike = { isConcurrencySafe: (i?: unknown) => boolean }
  check(
    'TaskCreate declares NOT concurrency-safe (shared-store read-modify-write)',
    (TaskCreateTool as unknown as ToolLike).isConcurrencySafe({}) === false,
    'src/tools/task-create/TaskCreateTool.ts must not set isConcurrencySafe to true (the default in src/tools/kit/tool.ts is false)',
  )
  check(
    'TaskUpdate declares NOT concurrency-safe',
    (TaskUpdateTool as unknown as ToolLike).isConcurrencySafe({}) === false,
    'src/tools/task-update/TaskUpdateTool.ts must keep isConcurrencySafe returning false',
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
