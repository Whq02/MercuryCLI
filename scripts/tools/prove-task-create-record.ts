import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { join } from 'node:path'

const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const tasks = await import(join(root, 'utils/tasks.ts'))
const { TaskCreateTool } = await import(join(root, 'tools/TaskCreateTool/TaskCreateTool.ts'))
const order: string[] = []
let draft: unknown
let fail = false
const list = spyOn(tasks, 'getTaskListId').mockImplementation(() => { order.push('list'); return 'fixture-list' })
const create = spyOn(tasks, 'createTask').mockImplementation(async (id, input) => { order.push('create'); assert.equal(id, 'fixture-list'); draft = input; if (fail) throw new Error('fixture create failed'); return '7' })
let state: any = { expandedView: 'other', kept: true }
const context = { setAppState(update: any) { order.push('expand'); state = update(state) } }
try {
  const input = { subject: 'Prove creation', description: 'Keep the contract', activeForm: 'Proving creation', metadata: { priority: 2 } }
  assert.deepEqual(await TaskCreateTool.call(input, context as never), { data: { task: { id: '7', subject: input.subject } } })
  assert.deepEqual(order, ['list', 'create', 'expand'])
  assert.deepEqual(draft, { subject: input.subject, description: input.description, activeForm: input.activeForm, status: 'pending', owner: undefined, blocks: [], blockedBy: [], metadata: input.metadata })
  assert.deepEqual(state, { expandedView: 'tasks', kept: true })
  const expanded = state
  await TaskCreateTool.call(input, context as never)
  assert.equal(state, expanded)
  fail = true
  order.length = 0
  await assert.rejects(TaskCreateTool.call(input, context as never), /fixture create failed/)
  assert.deepEqual(order, ['list', 'create'])
  assert.equal(TaskCreateTool.isConcurrencySafe({} as never), false)
  assert.equal(TaskCreateTool.isReadOnly({} as never), false)
  assert.equal(TaskCreateTool.inputSchema.safeParse({ ...input, extra: true }).success, false)
  assert.deepEqual(TaskCreateTool.mapToolResultToToolResultBlockParam({ task: { id: '7', subject: input.subject } }, 'call'), { type: 'tool_result', tool_use_id: 'call', content: 'Task #7 created successfully: Prove creation' })
  console.log('PASS task creation draft, effect order, idempotent expansion, failure and tool contracts')
} finally { list.mockRestore(); create.mockRestore() }
