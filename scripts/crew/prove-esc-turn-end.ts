#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QueuedCommand } from '../../src/types/textInputTypes.js'
import type { StdoutMessage } from '../../src/entrypoints/sdk/controlTypes.js'

process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('a scratch config home is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { createTurnDriver } = await import('../../src/cli/headless/turnDriver.js')
const { createNoticeRow } = await import('../../src/services/engine-connector/queuedNotices.js')
const { MessageMetaProvider, NameplateClock } = await import('../../src/components/messages/TranscriptNameplate.js')
const { renderToString } = await import('../../src/utils/staticRender.js')
const { createElement } = await import('react')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { Text } = await import('../../src/ink.js')
const { getQueuedCommandAttachments } = await import('../../src/utils/attachments/queuedCommands.js')
await import('../../src/tasks.js')
const { registerAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { getRunningTasks } = await import('../../src/utils/task/framework.js')
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.js')
const { resetCommandQueue } = await import('../../src/input-core/command-queue.js')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const flush = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve() }
const stamp = new Date(0)
stamp.setHours(18, 58, 1, 0)
let state = { tasks: {} } as Parameters<typeof getRunningTasks>[0]
const setState = (update: (prev: typeof state) => typeof state): void => { state = update(state) }
const task = registerAsyncAgent({ agentId: 'crew-worker', description: 'the worker', prompt: 'keep working', setAppState: setState, selectedAgent: { agentType: 'mercury-general' } as never })
const beforeCrew = JSON.stringify(projectWorkRoster(state.tasks))
const queue: QueuedCommand[] = [{ mode: 'prompt', value: 'start work' }]
const outputs: StdoutMessage[] = []
const deliveries: string[] = []
const turns: string[] = []
const waits: number[] = []
const sleeps: Array<() => void> = []
let now = 0
let loading = false
const driver = createTurnDriver({
  dequeue: () => queue.shift(),
  dequeueCommand: command => {
    const index = queue.indexOf(command)
    return index < 0 ? undefined : queue.splice(index, 1)[0]
  },
  peek: () => queue[0],
  queuedMainThread: () => queue,
  settleWindowMs: 1000,
  notifyLifecycle: () => {},
  enqueueOutput: message => outputs.push(message),
  writeDirect: async message => { outputs.push(message) },
  drainSdkEvents: () => [],
  executeTurn: async (...args: unknown[]) => {
    const [command, , deliver, notices = []] = args as [QueuedCommand, QueuedCommand[], (message: StdoutMessage) => void, QueuedCommand[]?]
    for (const attachment of await getQueuedCommandAttachments(notices)) {
      if (attachment.type === 'queued_command') deliveries.push(String(attachment.prompt))
    }
    turns.push(String(command.value))
    deliveries.push(String(command.value))
    deliver({ type: 'result', subtype: 'success' } as StdoutMessage)
  },
  beforeCycle: async () => {},
  onTurnStart: () => undefined,
  onTurnSettled: () => {},
  hasWaitableBackgroundTasks: () => getRunningTasks(state).length > 0,
  hasHoldableBackgroundAgents: () => getRunningTasks(state).length > 0,
  waitableBackgroundTaskCount: () => getRunningTasks(state).length,
  onAgentWait: count => waits.push(count),
  takePendingSuggestion: () => null,
  settleIdle: async () => 'stay',
  closeOutput: async () => {},
  notifySessionState: value => { loading = value === 'running' },
  isShuttingDown: () => false,
  idleTimerStop: () => {},
  idleTimerStart: () => {},
  onCycleError: error => { throw error },
  shutdown: () => {},
  clock: { now: () => now, sleep: () => new Promise<void>(resolve => sleeps.push(resolve)) },
})
const tick = async (): Promise<void> => {
  now += 100
  for (const resolve of sleeps.splice(0)) resolve()
  await flush()
}
const notice = (id: string): string => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "${id}" completed</summary>\n</task-notification>`
const arrive = (id: string): void => {
  queue.push({ mode: 'task-notification', value: notice(id), priority: 'later', queueId: id, sentAt: stamp.toISOString() })
  driver.kick()
}

driver.kick()
await flush()
check('the base turn waits on a real running crew record', loading && driver.phase() === 'waiting_for_agents' && driver.hasHeldResult())
driver.releaseHold()
await flush()
check('esc releases the loading edge without waiting for the polling clock', !loading && !driver.hasHeldResult(), `loading=${loading}, phase=${driver.phase()}`)
await tick()
check('the interrupted turn settles while the crew keeps running', !loading && driver.phase() === 'idle' && !task.abortController!.signal.aborted && JSON.stringify(projectWorkRoster(state.tasks)) === beforeCrew)

arrive('first-worker')
await flush()
const row = createNoticeRow(notice('first-worker'), stamp.getTime())
const painted = (await renderToString(createElement(MessageMetaProvider, { message: row }, createElement(Text, null, createElement(NameplateClock), 'Agent "first-worker" completed')), 178)).replace(/\s+/g, ' ').trim()
console.log(`notice row: "${painted}"`)
check('a notice after esc stays held without reopening the lead turn', !loading && !driver.isRunning() && queue.length === 1 && turns.length === 1, `loading=${loading}, phase=${driver.phase()}`)
check('the held row quotes the arrival clock', painted.includes('held since 18:58:01'), painted)
arrive('second-worker')
await flush()

const repl = readFileSync(join(import.meta.dir, '../../src/screens/REPL.tsx'), 'utf8')
const gate = repl.match(/if \(seatCommand !== undefined && isLoadingRef\.current\) \{[\s\S]*?\n      \}/)?.[0]
if (!gate) throw new Error('the session-command queued gate was not found')
const receipts: string[] = []
new Function('seatCommand', 'isLoadingRef', 'addNotification', 'getCommandName', 'RECEIPT_TIMEOUT_MS', gate)({ name: 'compact' }, { current: loading }, (notice: { text: string }) => receipts.push(notice.text), (command: { name: string }) => command.name, 1)
console.log(`command row: "${receipts[0] ?? '/compact runs now'}"`)
check('a command typed after esc never paints queued behind the crew', receipts.length === 0, receipts.join(' | '))
queue.push({ mode: 'prompt', value: '/compact', queueId: 'operator-compact' })
driver.kick()
await flush()
await tick()
check('the next line starts at once and receives held notices first, in arrival order', JSON.stringify(deliveries.slice(1)) === JSON.stringify([notice('first-worker'), notice('second-worker'), '/compact']), JSON.stringify(deliveries.slice(1)))
check('the held notices never start autonomous model turns', JSON.stringify(turns) === JSON.stringify(['start work', '/compact']), JSON.stringify(turns))
check('the command runs exactly once and the held notices leave no queue entries', turns.filter(turn => turn === '/compact').length === 1 && queue.length === 0)
check('the crew row and its controller are unchanged after delivery', !task.abortController!.signal.aborted && JSON.stringify(projectWorkRoster(state.tasks)) === beforeCrew)
driver.releaseHold()
await tick()
resetCommandQueue()

const { ask } = await import('../../src/QueryEngine.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.js')
const { setIsInteractive } = await import('../../src/bootstrap/state.js')
const { flushSessionStorage } = await import('../../src/utils/sessionStorage.js')
setIsInteractive(false)
let engineState = getDefaultAppState()
let commandReads: unknown[] = []
let commandCalls = 0
const messages: import('../../src/types/message.js').Message[] = []
const initialNotices: QueuedCommand[] = ['first-worker', 'second-worker'].map(id => ({ mode: 'task-notification', value: notice(id), sentAt: stamp.toISOString() }))
const engineOutputs: unknown[] = []
for await (const message of ask({
  prompt: '/compact',
  cwd: process.env.MERCURY_CONFIG_DIR!,
  tools: [],
  commands: [{
    type: 'local', name: 'compact', description: 'inspect the command input', userInvocable: true, supportsNonInteractive: true,
    load: async () => ({ call: async (_args: string, context: { messages: unknown[] }) => {
      commandCalls++
      commandReads = [...context.messages]
      return { type: 'text', value: 'command ran' }
    } }),
  }] as never,
  mcpClients: [], agents: [],
  canUseTool: async () => { throw new Error('no tool is part of this command') },
  customSystemPrompt: 'a hermetic local command',
  thinkingConfig: { type: 'disabled' },
  getAppState: () => engineState,
  setAppState: update => { engineState = update(engineState) },
  getReadFileCache: () => createFileStateCacheWithSizeLimit(10),
  setReadFileCache: () => {},
  mutableMessages: messages,
  initialNotices,
} as Parameters<typeof ask>[0])) engineOutputs.push(message)
await flushSessionStorage()
const delivered = (rows: unknown[]): string[] => rows.flatMap(row => {
  const value = row as { type?: string; queued?: boolean; attachment?: { type?: string; commandMode?: string; prompt?: string } }
  return value.type === 'attachment' && value.attachment?.commandMode === 'task-notification' && !value.queued ? [value.attachment.prompt ?? ''] : []
})
check('the real engine supplies both notices before the session command executes', commandCalls === 1 && JSON.stringify(delivered(commandReads)) === JSON.stringify(initialNotices.map(command => command.value)), JSON.stringify(delivered(commandReads)))
check('the same delivered rows survive the one-shot engine writeback once', JSON.stringify(delivered(messages)) === JSON.stringify(initialNotices.map(command => command.value)) && engineOutputs.some(message => (message as { type?: string }).type === 'result'))
const deliveredRow = messages.find(message => message.type === 'attachment')
if (deliveredRow) {
  const taken = (await renderToString(createElement(MessageMetaProvider, { message: deliveredRow }, createElement(Text, null, createElement(NameplateClock), 'Agent "first-worker" completed')), 178)).replace(/\s+/g, ' ').trim()
  check('delivery replaces the held plate with the next turn delivery clock', !taken.includes('held') && /^\d\d:\d\d:\d\d /.test(taken), taken)
}
console.log(`\nesc-turn-end: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
