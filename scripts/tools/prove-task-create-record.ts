import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { join } from 'node:path'

const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const tasks = await import(join(root, 'engine/task-framework/tasks.ts'))
const { TaskCreateTool } = await import(join(root, 'tools/task-create/TaskCreateTool.ts'))
const order: string[] = []
let draft: unknown
let fail = false
const list = spyOn(tasks, 'getTaskListId').mockImplementation(() => { order.push('list'); return 'fixture-list' })
const create = spyOn(tasks, 'createTask').mockImplementation(async (id, input) => { order.push('create'); assert.equal(id, 'fixture-list'); draft = input; if (fail) throw new Error('fixture create failed'); return '7' })
let state: any = { expandedView: 'other', kept: true }
const context = { setAppState(update: any) { order.push('expand'); state = update(state) } }
try {
  const input = { subject: 'Prove creation', description: 'Keep the contract', activeForm: 'Proving creation', metadata: { priority: 2 } }
  assert.deepEqual(await TaskCreateTool.call(input, context as never), { data: { task: { id: '7', subject: input.subject } } }, 'TaskCreateTool.call result changed; check call() in src/tools/task-create/TaskCreateTool.ts returns { data: { task: { id, subject } } }')
  assert.deepEqual(order, ['list', 'create', 'expand'], 'effect order changed; call() in src/tools/task-create/TaskCreateTool.ts must run getTaskListId, then createTask, then setAppState(expandTasks)')
  assert.deepEqual(draft, { subject: input.subject, description: input.description, activeForm: input.activeForm, status: 'pending', owner: undefined, blocks: [], blockedBy: [], metadata: input.metadata }, 'task draft passed to createTask changed; check pendingTask() in src/tools/task-create/TaskCreateTool.ts')
  assert.deepEqual(state, { expandedView: 'tasks', kept: true }, 'app state after create is wrong; check expandTasks() in src/tools/task-create/TaskCreateTool.ts sets expandedView to tasks and keeps other fields')
  const expanded = state
  await TaskCreateTool.call(input, context as never)
  assert.equal(state, expanded, 'a second create replaced app state that was already expanded; expandTasks() in src/tools/task-create/TaskCreateTool.ts must return the same state object when expandedView is already tasks')
  fail = true
  order.length = 0
  await assert.rejects(TaskCreateTool.call(input, context as never), /fixture create failed/, 'a createTask failure must propagate out of TaskCreateTool.call in src/tools/task-create/TaskCreateTool.ts')
  assert.deepEqual(order, ['list', 'create'], 'after a createTask failure the app state must not be expanded; check call() in src/tools/task-create/TaskCreateTool.ts')
  assert.equal(TaskCreateTool.isConcurrencySafe({} as never), false, 'isConcurrencySafe in src/tools/task-create/TaskCreateTool.ts must return false')
  assert.equal(TaskCreateTool.isReadOnly({} as never), false, 'isReadOnly in src/tools/task-create/TaskCreateTool.ts must return false')
  assert.equal(TaskCreateTool.inputSchema.safeParse({ ...input, extra: true }).success, false, 'the input schema in src/tools/task-create/TaskCreateTool.ts must be a strictObject that rejects extra keys')
  assert.deepEqual(TaskCreateTool.mapToolResultToToolResultBlockParam({ task: { id: '7', subject: input.subject } }, 'call'), { type: 'tool_result', tool_use_id: 'call', content: 'Task #7 created successfully: Prove creation' }, 'tool result text changed; check mapToolResultToToolResultBlockParam in src/tools/task-create/TaskCreateTool.ts')
  console.log('PASS task creation draft, effect order, idempotent expansion, failure and tool contracts')
} finally { list.mockRestore(); create.mockRestore() }
