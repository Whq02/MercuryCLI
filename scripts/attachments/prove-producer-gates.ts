import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { join, resolve } from 'node:path'

const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[arg + 1]!)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const registry = await import(join(root, 'src/services/lsp/LSPDiagnosticRegistry.ts'))
const manager = await import(join(root, 'src/services/lsp/manager.ts'))
const tasks = await import(join(root, 'src/utils/tasks.ts'))
const { BASH_TOOL_NAME } = await import(join(root, 'src/tools/BashTool/toolName.ts'))
const { TASK_UPDATE_TOOL_NAME } = await import(join(root, 'src/tools/TaskUpdateTool/constants.ts'))
const { getLSPDiagnosticAttachments } = await import(join(root, 'src/utils/attachments/diagnostics.ts'))
const { getTaskReminderAttachments } = await import(join(root, 'src/utils/attachments/reminders.ts'))
const events: string[] = []
let pending: Array<{ files: unknown[] }> = [{ files: [] }]
const spies = [
  spyOn(manager, 'getLspServerManager').mockImplementation(() => ({ async revalidateOpenDocuments() { events.push('refresh'); throw new Error('fixture refresh failure') }, isFileOpen() { return false } }) as never),
  spyOn(registry, 'checkForLSPDiagnostics').mockImplementation(() => { events.push('read'); const rows = pending; pending = []; return rows as never }),
  spyOn(registry, 'clearAllLSPDiagnostics').mockImplementation(() => { events.push('clear'); pending = [] }),
]
try {
  assert.deepEqual(await getLSPDiagnosticAttachments({ options: { tools: [] } } as never), [])
  assert.deepEqual(events, [])
  assert.deepEqual(await getLSPDiagnosticAttachments({ options: { tools: [{ name: BASH_TOOL_NAME }] } } as never), [{ type: 'diagnostics', files: [], isNew: true }])
  assert.deepEqual(events, ['refresh', 'read'])
  events.length = 0
  assert.deepEqual(await getLSPDiagnosticAttachments({ options: { tools: [{ name: BASH_TOOL_NAME }] } } as never), [])
  assert.deepEqual(events, ['refresh', 'read'])
  assert.equal(events.includes('clear'), false)
  console.log('PASS diagnostics gate, refresh failure isolation, delivery order and no table-wide clear behind a lane read')
  let enabled = true
  let lists = 0
  const content = [{ id: '1', subject: 'fixture task' }]
  spies.push(spyOn(tasks, 'isTaskToolsEnabled').mockImplementation(() => enabled))
  spies.push(spyOn(tasks, 'getTaskListId').mockReturnValue('fixture-list'))
  spies.push(spyOn(tasks, 'listTasks').mockImplementation(async () => { lists++; return content as never }))
  const context = { options: { tools: [{ name: TASK_UPDATE_TOOL_NAME }] } }
  const turn = () => ({ type: 'assistant', message: { content: [{ type: 'text', text: 'turn' }] } })
  const history = Array.from({ length: 10 }, turn)
  enabled = false
  assert.deepEqual(await getTaskReminderAttachments(history as never, {} as never), [])
  enabled = true
  assert.deepEqual(await getTaskReminderAttachments(history as never, { options: { tools: [] } } as never), [])
  assert.deepEqual(await getTaskReminderAttachments(undefined, context as never), [])
  assert.deepEqual(await getTaskReminderAttachments(history.slice(1) as never, context as never), [])
  assert.equal(lists, 0)
  const rows = await getTaskReminderAttachments(history as never, context as never)
  assert.deepEqual(rows, [{ type: 'task_reminder', content, itemCount: 1 }])
  assert.equal((rows[0] as any).content, content)
  assert.equal(lists, 1)
  const touch = { type: 'assistant', message: { content: [{ type: 'tool_use', name: TASK_UPDATE_TOOL_NAME, id: 'touch', input: {} }] } }
  assert.deepEqual(await getTaskReminderAttachments([...history, touch] as never, context as never), [])
  const reminder = { type: 'attachment', attachment: { type: 'task_reminder', content: [], itemCount: 0 } }
  assert.deepEqual(await getTaskReminderAttachments([...history, reminder] as never, context as never), [])
  assert.equal(lists, 1)
  console.log('PASS task admission, inclusive cadence, list identity and independent resets')
} finally {
  for (const spy of spies) spy.mockRestore()
}
console.log('PASS producer gates')
