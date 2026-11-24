#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QueuedCommand } from '../../src/screen/composer/input-core/textInput.js'
import type { RowDraft } from '../../src/engine/rows/project.js'

process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
if (!process.env.MERCURY_CONFIG_DIR) throw new Error('a scratch config home is required')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { createTurnDriver } = await import('../../src/daemon/runner/turnDriver.js')
const { createNoticeRow } = await import('../../src/engine/connector/queuedNotices.js')
const { MessageMetaProvider, NameplateClock } = await import('../../src/screen/messages/TranscriptNameplate.js')
const { renderToString } = await import('../../src/screen/renderer/staticRender.js')
const { createElement } = await import('react')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { Text } = await import('../../src/screen/themedRenderer.js')
const { getQueuedCommandAttachments } = await import('../../src/engine/attachments/queuedCommands.js')
await import('../../src/engine/tasks/tasks.js')
const { registerAsyncCrewmate } = await import('../../src/engine/tasks/local-agent/crewmateTask.js')
const { getRunningTasks } = await import('../../src/engine/task-framework/taskRegistry.js')
const { projectWorkRoster } = await import('../../src/engine/connector/workRoster.js')
const { resetCommandQueue } = await import('../../src/screen/composer/input-core/command-queue.js')

let failures = 0
const check = (label: string, ok: boolean, detail = '', hint = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
const flush = async (): Promise<void> => { for (let i = 0; i < 80; i++) await Promise.resolve() }
const stamp = new Date(0)
stamp.setHours(18, 58, 1, 0)
let state = { tasks: {} } as Parameters<typeof getRunningTasks>[0]
const setState = (update: (prev: typeof state) => typeof state): void => { state = update(state) }
const task = registerAsyncCrewmate({ agentId: 'crew-worker', description: 'the worker', prompt: 'keep working', setAppState: setState, selectedAgent: { agentType: 'mercury-crew' } as never })
const beforeCrew = JSON.stringify(projectWorkRoster(state.tasks))
const queue: QueuedCommand[] = [{ mode: 'prompt', value: 'start work' }]
const outputs: RowDraft[] = []
const deliveries: string[] = []
const turns: string[] = []
const waits: number[] = []
const sleeps: Array<() => void> = []
let now = 0
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
  drainRows: () => [],
  executeTurn: async (...args: unknown[]) => {
    const [command, , deliver, notices = []] = args as [QueuedCommand, QueuedCommand[], (message: RowDraft) => void, QueuedCommand[]?]
    for (const attachment of await getQueuedCommandAttachments(notices)) {
      if (attachment.type === 'queued_command') deliveries.push(String(attachment.prompt))
    }
    turns.push(String(command.value))
    deliveries.push(String(command.value))
    deliver({ type: 'outcome', status: 'completed' } as unknown as RowDraft)
  },
  beforeCycle: async () => {},
  onTurnStart: () => undefined,
  turnIdOf: () => 't-esc',
  openTurnRow: () => ({ type: 'turn', state: 'started', turn_id: 't-esc' }) as unknown as RowDraft,
  onTurnSettled: () => {},
  hasWaitableBackgroundTasks: () => getRunningTasks(state).length > 0,
  hasHoldableBackgroundAgents: () => getRunningTasks(state).length > 0,
  waitableBackgroundTaskCount: () => getRunningTasks(state).length,
  onAgentWait: count => waits.push(count),
  settleIdle: async () => 'stay',
  closeOutput: async () => {},
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
check('the base turn waits on a real running crew record', driver.phase() === 'waiting_for_agents' && driver.hasHeldResult(), '', 'createTurnDriver in src/daemon/runner/turnDriver.ts must enter the waiting_for_agents phase and hold the result while hasWaitableBackgroundTasks reports the registered crew task')
driver.releaseHold()
await flush()
check('esc releases the held result without waiting for the polling clock', !driver.hasHeldResult(), `phase=${driver.phase()}`, 'releaseHold in createTurnDriver (src/daemon/runner/turnDriver.ts) must clear the held result at once instead of waiting for the next clock sleep')
await tick()
check('the interrupted turn settles while the crew keeps running', driver.phase() === 'idle' && !task.abortController!.signal.aborted && JSON.stringify(projectWorkRoster(state.tasks)) === beforeCrew, '', 'after releaseHold the turn driver (src/daemon/runner/turnDriver.ts) must settle to idle without aborting or changing the running crew task')

arrive('first-worker')
await flush()
const row = createNoticeRow(notice('first-worker'), stamp.getTime())
const painted = (await renderToString(createElement(MessageMetaProvider, { message: row }, createElement(Text, null, createElement(NameplateClock), 'Agent "first-worker" completed')), 178)).replace(/\s+/g, ' ').trim()
console.log(`notice row: "${painted}"`)
check('a notice after esc stays held without reopening the lead turn', !driver.isRunning() && queue.length === 1 && turns.length === 1, `phase=${driver.phase()}`, 'a task-notification that arrives after esc must stay in the queue and start no turn; check the notice handling in createTurnDriver (src/daemon/runner/turnDriver.ts)')
check('the held row quotes the arrival clock', painted.includes('held since 18:58:01'), painted, 'the held plate must read held since the notice arrival time; check NameplateClock and the held plate in src/screen/messages/TranscriptNameplate.tsx and createNoticeRow in src/engine/connector/queuedNotices.ts')
arrive('second-worker')
await flush()

queue.push({ mode: 'prompt', value: '/compact', queueId: 'operator-compact' })
driver.kick()
await flush()
await tick()
check('the next line starts at once and receives held notices first, in arrival order', JSON.stringify(deliveries.slice(1)) === JSON.stringify([notice('first-worker'), notice('second-worker'), '/compact']), JSON.stringify(deliveries.slice(1)), 'the turn driver (src/daemon/runner/turnDriver.ts) must pass the held notices to executeTurn ahead of the next line, in arrival order')
check('the held notices never start autonomous model turns', JSON.stringify(turns) === JSON.stringify(['start work', '/compact']), JSON.stringify(turns), 'held notices must be delivered as attachments to the next command, never run as their own turns; check createTurnDriver in src/daemon/runner/turnDriver.ts')
check('the command runs exactly once and the held notices leave no queue entries', turns.filter(turn => turn === '/compact').length === 1 && queue.length === 0, '', 'the command must run once and delivery must remove every held notice from the queue; check createTurnDriver in src/daemon/runner/turnDriver.ts')
check('the crew row and its controller are unchanged after delivery', !task.abortController!.signal.aborted && JSON.stringify(projectWorkRoster(state.tasks)) === beforeCrew, '', 'delivering held notices must not abort or alter the crew task; check createTurnDriver in src/daemon/runner/turnDriver.ts and projectWorkRoster in src/engine/connector/workRoster.ts')
driver.releaseHold()
await tick()
resetCommandQueue()

const { ask } = await import('../../src/engine/rows/turn.js')
const { getDefaultAppState } = await import('../../src/screen/app-state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../../src/platform/files/fileStateCache.js')
const { setIsInteractive } = await import('../../src/boot/process-state/processState.js')
const { flushSessionStorage } = await import('../../src/sessions/transcripts/sessionStorage.js')
setIsInteractive(false)
let engineState = getDefaultAppState()
let commandReads: unknown[] = []
let commandCalls = 0
const messages: import('../../src/engine/message-shapes/message.js').Message[] = []
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
check('the real engine supplies both notices before the session command executes', commandCalls === 1 && JSON.stringify(delivered(commandReads)) === JSON.stringify(initialNotices.map(command => command.value)), JSON.stringify(delivered(commandReads)), 'ask in src/engine/rows/turn.ts must hand initialNotices to the session command as attachments (getQueuedCommandAttachments in src/engine/attachments/queuedCommands.ts) before it executes')
check('the same delivered rows survive the one-shot engine writeback once', JSON.stringify(delivered(messages)) === JSON.stringify(initialNotices.map(command => command.value)) && engineOutputs.some(message => (message as { type?: string }).type === 'outcome'), '', 'ask in src/engine/rows/turn.ts must write the delivered notice rows back to mutableMessages once and end with an outcome row')
const deliveredRow = messages.find(message => message.type === 'attachment')
if (deliveredRow) {
  const taken = (await renderToString(createElement(MessageMetaProvider, { message: deliveredRow }, createElement(Text, null, createElement(NameplateClock), 'Agent "first-worker" completed')), 178)).replace(/\s+/g, ' ').trim()
  check('delivery replaces the held plate with the next turn delivery clock', !taken.includes('held') && /^\d\d:\d\d:\d\d /.test(taken), taken, 'a delivered notice row must show its delivery clock instead of the held plate; check deliveredNoticeRow in src/engine/connector/queuedNotices.ts and NameplateClock in src/screen/messages/TranscriptNameplate.tsx')
}
console.log(`\nesc-turn-end: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
