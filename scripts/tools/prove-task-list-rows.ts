#!/usr/bin/env bun
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'task-list-rows-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_TASK_LIST_ID = 'task-list-rows-proof'
process.env.MERCURY_TASKS = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

await import('../../src/engine/tasks/tasks.js')
const { createTask, getTasksDir, resetTaskList, getTaskListId } = await import('../../src/engine/task-framework/tasks.js')
const { TaskListTool } = await import('../../src/tools/task-list/TaskListTool.js')
type Output = { tasks: { id: string; subject: string; status: string; owner?: string; blockedBy: string[] }[] }
const LIST = getTaskListId()
const ctx = { setAppState() {}, getAppState: () => ({}), abortController: new AbortController() } as never
const call = async (): Promise<Output> => ((await TaskListTool.call({} as never, ctx)) as { data: Output }).data
const text = (output: Output): string => (TaskListTool.mapToolResultToToolResultBlockParam!(output as never, 'toolu_list') as { content: string }).content
const task = (subject: string, extra: Record<string, unknown> = {}) => ({ subject, description: 'fixture', status: 'pending', blocks: [], blockedBy: [], ...extra })

try {
  await resetTaskList(LIST)

  section('§1 THE EMPTY LIST')
  const empty = await call()
  check('no tasks is an empty list', empty.tasks.length === 0, 'listTasks in src/engine/task-framework/tasks.ts returned rows for a fresh list; check resetTaskList and rowsOfCurrentList in src/tools/task-list/TaskListTool.ts')
  check('the model reads "No tasks found"', text(empty) === 'No tasks found', 'got ' + j(text(empty)) + '; mapToolResultToToolResultBlockParam in src/tools/task-list/TaskListTool.ts must return NO_TASKS for zero rows')
  check('the header is null', TaskListTool.renderToolUseMessage!({} as never, {} as never) === null, 'renderToolUseMessage in src/tools/task-list/TaskListTool.ts must return null')

  section('§2 THE ROWS — internal tasks hidden, blockers cleared by visible completions only, owner only when owned')
  const done = await createTask(LIST, task('Write the spec', { status: 'completed' }) as never)
  const hidden = await createTask(LIST, task('Internal bookkeeping', { status: 'completed', metadata: { _internal: true } }) as never)
  const open = await createTask(LIST, task('Build the thing', { status: 'in_progress', owner: 'atlas', blockedBy: [done, hidden] }) as never)
  const waiting = await createTask(LIST, task('Ship it', { blockedBy: [open, done] }) as never)
  const output = await call()
  check('the internal task is not listed', output.tasks.every(row => row.id !== hidden) && output.tasks.length === 3, j(output) + ' — the visible filter in src/tools/task-list/TaskListTool.ts must drop tasks with metadata._internal')
  const rows = Object.fromEntries(output.tasks.map(row => [row.id, row]))
  check('a blocker completed by a VISIBLE task is cleared; the completed INTERNAL blocker stays', j(rows[open]?.blockedBy) === j([hidden]), j(rows[open]) + ' — rowOf in src/tools/task-list/TaskListTool.ts must clear only blockers that are completed visible tasks')
  check('an open blocker stays, a completed one clears', j(rows[waiting]?.blockedBy) === j([open]), j(rows[waiting]) + ' — rowOf in src/tools/task-list/TaskListTool.ts must keep open blockers and clear completed ones')
  check('owner rides only when set, and the row keys keep their order', j(Object.keys(rows[open] ?? {})) === j(['id', 'subject', 'status', 'owner', 'blockedBy']) && !('owner' in (rows[waiting] ?? {})), j(output.tasks) + ' — rowOf in src/tools/task-list/TaskListTool.ts must add owner only when set, between status and blockedBy')
  check('rows keep the list order', j(output.tasks.map(row => row.id)) === j([done, open, waiting]), j(output.tasks.map(row => row.id)) + ' — rowsOfCurrentList in src/tools/task-list/TaskListTool.ts must keep the order listTasks (src/engine/task-framework/tasks.ts) returns')

  section('§3 THE MODEL TEXT — one line per row')
  const lines = text(output).split('\n')
  check('three lines', lines.length === 3, j(lines) + ' — mapToolResultToToolResultBlockParam in src/tools/task-list/TaskListTool.ts must emit one line per row')
  check('a completed row without owner or blockers', lines[0] === `#${done} [completed] Write the spec`, lines[0] + ' — lineOf in src/tools/task-list/TaskListTool.ts builds the row line')
  check('an owned row with its remaining blocker', lines[1] === `#${open} [in_progress] Build the thing (atlas) [blocked by #${hidden}]`, lines[1] + ' — lineOf in src/tools/task-list/TaskListTool.ts builds the row line')
  check('a pending row blocked by one', lines[2] === `#${waiting} [pending] Ship it [blocked by #${open}]`, lines[2] + ' — lineOf in src/tools/task-list/TaskListTool.ts builds the row line')
  const two = text({ tasks: [{ id: '9', subject: 'Two blockers', status: 'pending', blockedBy: ['1', '2'] }] })
  check('several blockers are joined with a comma', two === '#9 [pending] Two blockers [blocked by #1, #2]', two + ' — hashed in src/tools/task-list/TaskListTool.ts must join blocker ids with a comma and a space')

  section('§4 A TORN TASK BODY IS SKIPPED, NOT THE WHOLE LIST')
  writeFileSync(join(getTasksDir(LIST), '99.json'), '{"id":"99","subject":"torn')
  const torn = await call()
  check('the three readable tasks still list; the unparseable body is skipped (base: the whole list threw a SyntaxError)', j(torn.tasks.map(row => row.id)) === j([done, open, waiting]), j(torn.tasks) + ' — getTask and listTasks in src/engine/task-framework/tasks.ts must skip a task file that does not parse')
} finally {
  await resetTaskList(LIST).catch(() => false)
  rmSync(HOME, { recursive: true, force: true })
}
console.log(failures === 0 ? '\nPASS task list rows' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
