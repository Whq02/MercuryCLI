import assert from 'node:assert/strict'
import { spyOn } from 'bun:test'
import { join, resolve } from 'node:path'

const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(import.meta.dir, '../..') : resolve(process.argv[arg + 1]!)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const registry = await import(join(root, 'src/integrations/lsp/LSPDiagnosticRegistry.ts'))
const manager = await import(join(root, 'src/integrations/lsp/serverManagerLifecycle.ts'))
const tasks = await import(join(root, 'src/engine/task-framework/tasks.ts'))
const { BASH_TOOL_NAME } = await import(join(root, 'src/tools/kit/names/bash.ts'))
const { TASK_UPDATE_TOOL_NAME } = await import(join(root, 'src/tools/kit/names/taskUpdate.ts'))
const { getLSPDiagnosticAttachments } = await import(join(root, 'src/engine/attachments/diagnostics.ts'))
const { getTaskReminderAttachments } = await import(join(root, 'src/engine/attachments/reminders.ts'))
const events: string[] = []
let pending: Array<{ files: unknown[] }> = [{ files: [] }]
const spies = [
  spyOn(manager, 'getLspServerManager').mockImplementation(() => ({ async revalidateOpenDocuments() { events.push('refresh'); throw new Error('fixture refresh failure') }, isFileOpen() { return false } }) as never),
  spyOn(registry, 'checkForLSPDiagnostics').mockImplementation(() => { events.push('read'); const rows = pending; pending = []; return rows as never }),
  spyOn(registry, 'clearAllLSPDiagnostics').mockImplementation(() => { events.push('clear'); pending = [] }),
]
try {
  assert.deepEqual(await getLSPDiagnosticAttachments({ options: { tools: [] } } as never), [], 'getLSPDiagnosticAttachments in src/engine/attachments/diagnostics.ts must return nothing when the Bash tool is not in the tool list')
  assert.deepEqual(events, [], 'getLSPDiagnosticAttachments in src/engine/attachments/diagnostics.ts must not refresh or read diagnostics before the Bash tool gate passes')
  assert.deepEqual(await getLSPDiagnosticAttachments({ options: { tools: [{ name: BASH_TOOL_NAME }] } } as never), [{ type: 'diagnostics', files: [], isNew: true }], 'getLSPDiagnosticAttachments in src/engine/attachments/diagnostics.ts must still deliver the pending diagnostics row when the document refresh throws')
  assert.deepEqual(events, ['refresh', 'read'], 'src/engine/attachments/diagnostics.ts must refresh open documents first, then read, in that order')
  events.length = 0
  assert.deepEqual(await getLSPDiagnosticAttachments({ options: { tools: [{ name: BASH_TOOL_NAME }] } } as never), [], 'getLSPDiagnosticAttachments in src/engine/attachments/diagnostics.ts must return nothing when a second call finds no pending diagnostics')
  assert.deepEqual(events, ['refresh', 'read'], 'src/engine/attachments/diagnostics.ts must refresh then read on every call')
  assert.equal(events.includes('clear'), false, 'src/engine/attachments/diagnostics.ts must not call clearAllLSPDiagnostics after a lane read')
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
  assert.deepEqual(await getTaskReminderAttachments(history as never, {} as never), [], 'getTaskReminderAttachments in src/engine/attachments/reminders.ts must return nothing when task tools are disabled')
  enabled = true
  assert.deepEqual(await getTaskReminderAttachments(history as never, { options: { tools: [] } } as never), [], 'getTaskReminderAttachments in src/engine/attachments/reminders.ts must return nothing without the TaskUpdate tool')
  assert.deepEqual(await getTaskReminderAttachments(undefined, context as never), [], 'getTaskReminderAttachments in src/engine/attachments/reminders.ts must return nothing without messages')
  assert.deepEqual(await getTaskReminderAttachments(history.slice(1) as never, context as never), [], 'taskReminderDue in src/engine/attachments/reminders.ts must not fire before the turn cadence is reached')
  assert.equal(lists, 0, 'src/engine/attachments/reminders.ts must not call listTasks until a reminder is due')
  const rows = await getTaskReminderAttachments(history as never, context as never)
  assert.deepEqual(rows, [{ type: 'task_reminder', content, itemCount: 1 }], 'getTaskReminderAttachments in src/engine/attachments/reminders.ts must return one task_reminder row with the listed tasks and itemCount')
  assert.equal((rows[0] as any).content, content, 'src/engine/attachments/reminders.ts must pass the listTasks result through by identity')
  assert.equal(lists, 1, 'src/engine/attachments/reminders.ts must call listTasks once per delivered reminder')
  const touch = { type: 'assistant', message: { content: [{ type: 'tool_use', name: TASK_UPDATE_TOOL_NAME, id: 'touch', input: {} }] } }
  assert.deepEqual(await getTaskReminderAttachments([...history, touch] as never, context as never), [], 'a recent TaskUpdate call must reset the cadence in taskReminderDue in src/engine/attachments/reminders.ts')
  const reminder = { type: 'attachment', attachment: { type: 'task_reminder', content: [], itemCount: 0 } }
  assert.deepEqual(await getTaskReminderAttachments([...history, reminder] as never, context as never), [], 'a recent task_reminder attachment must reset the cadence in taskReminderDue in src/engine/attachments/reminders.ts')
  assert.equal(lists, 1, 'src/engine/attachments/reminders.ts must not call listTasks again when a reset blocks the reminder')
  console.log('PASS task admission, inclusive cadence, list identity and independent resets')
} finally {
  for (const spy of spies) spy.mockRestore()
}
console.log('PASS producer gates')
