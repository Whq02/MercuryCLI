import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { join } from 'node:path'

const root = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const tasks = await import(join(root, 'utils/tasks.ts'))
const { TaskGetTool } = await import(join(root, 'tools/TaskGetTool/TaskGetTool.ts'))
const record = { id: '7', subject: 'Check the result', description: 'Read every field', status: 'pending', blocks: ['9'], blockedBy: ['2', '3'], owner: 'extra-field', metadata: { hidden: true } }
const list = spyOn(tasks, 'getTaskListId').mockReturnValue('fixture-list')
const read = spyOn(tasks, 'getTask').mockImplementation(async (_list, id) => id === '7' ? record as never : null)
try {
  const present = await TaskGetTool.call({ taskId: '7' } as never, {} as never)
  assert.deepEqual(present, { data: { task: { id: '7', subject: record.subject, description: record.description, status: 'pending', blocks: ['9'], blockedBy: ['2', '3'] } } })
  assert.deepEqual(await TaskGetTool.call({ taskId: 'missing' } as never, {} as never), { data: { task: null } })
  assert.equal(TaskGetTool.inputSchema.safeParse({ taskId: '7', extra: true }).success, false)
  assert.deepEqual(TaskGetTool.mapToolResultToToolResultBlockParam({ task: null }, 'call'), { type: 'tool_result', tool_use_id: 'call', content: 'Task not found' })
  const text = TaskGetTool.mapToolResultToToolResultBlockParam(present.data, 'call')
  assert.deepEqual(text, { type: 'tool_result', tool_use_id: 'call', content: '#7: Check the result\nStatus: pending\nDescription: Read every field\nDepends on: #2, #3\nBlocks: #9' })
  console.log('PASS task detail projection, missing result, strict input and dependency words')
} finally { list.mockRestore(); read.mockRestore() }
