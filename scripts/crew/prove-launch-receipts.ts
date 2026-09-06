#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'launch-receipts-'))
process.env.MERCURY_CONFIG_DIR = scratch
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const lr = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const queue = await import('../../src/input-core/command-queue.ts')
const { readTailWindow, AGENT_TAIL_READ_CAP_BYTES } = await import('../../src/services/resources/adapters/agent.ts')
type Message = import('../../src/types/message.ts').Message
type AppState = import('../../src/state/AppStateStore.ts').AppState

let n = 0
const stamp = (): string => new Date(1_700_000_000_000 + ++n * 1000).toISOString()
const assistantLaunch = (): Message =>
  ({
    type: 'assistant',
    uuid: `a-${++n}`,
    timestamp: stamp(),
    requestId: undefined,
    message: {
      id: 'msg_launch',
      model: 'claude-fable-5-1',
      role: 'assistant',
      content: [
        { type: 'text', text: 'launching two' },
        { type: 'tool_use', id: 'toolu_one', name: 'Agent', input: { description: 'harbour-count', prompt: 'switch-seat: count the harbour', subagent_type: 'mercury-general', run_in_background: true } },
        { type: 'tool_use', id: 'toolu_two', name: 'Agent', input: { description: 'lantern-index', prompt: 'switch-seat: index the lanterns', subagent_type: 'mercury-general', run_in_background: true } },
      ],
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'tool_use',
    },
  }) as unknown as Message
const receiptText = (agentId: string): string =>
  `${lr.BACKGROUND_LAUNCH_LINE}\nagentId: ${agentId} (internal — do not mention it to the user). To continue this agent, use SendMessage addressed to that id.\nThe agent is working in the background — you will be notified automatically when it completes.`
const userReceipts = (): Message =>
  ({
    type: 'user',
    uuid: `u-${++n}`,
    timestamp: stamp(),
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_one', content: [{ type: 'text', text: receiptText('agent-one') }] },
        { type: 'tool_result', tool_use_id: 'toolu_two', content: [{ type: 'text', text: receiptText('agent-two') }] },
      ],
    },
  }) as unknown as Message
const noticeRow = (toolUseId: string, taskId: string, status: string): Message =>
  ({
    type: 'user',
    uuid: `u-${++n}`,
    timestamp: stamp(),
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>Agent "x" ${status}</summary>\n</task-notification>`,
    },
  }) as unknown as Message
const foregroundPair = (): Message[] => [
  {
    type: 'assistant',
    uuid: `a-${++n}`,
    timestamp: stamp(),
    requestId: undefined,
    message: { id: 'msg_fg', model: 'claude-fable-5-1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'foreground-walk', prompt: 'walk', subagent_type: 'mercury-general' } }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'tool_use' },
  } as unknown as Message,
  {
    type: 'user',
    uuid: `u-${++n}`,
    timestamp: stamp(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: [{ type: 'text', text: 'the walk is done: three lanterns' }] }] },
  } as unknown as Message,
]

const transcript: Message[] = [assistantLaunch(), userReceipts(), ...foregroundPair(), noticeRow('toolu_two', 'agent-two', 'completed')]

console.log('============================================================')
console.log(' launch receipts — a receipt never stands without a record or a notice')
console.log('============================================================')

section('R1 · the receipts')
const receipts = lr.backgroundLaunchReceipts(transcript)
check('two background launches carry receipts, in order', receipts.length === 2 && receipts[0]!.toolUseId === 'toolu_one' && receipts[1]!.toolUseId === 'toolu_two', JSON.stringify(receipts))
check('each receipt names the agent id the tool result carried', receipts[0]?.agentId === 'agent-one' && receipts[1]?.agentId === 'agent-two')
check('each receipt carries the launch words: description, prompt, agent type, the launch clock', receipts[0]?.description === 'harbour-count' && receipts[0]?.prompt === 'switch-seat: count the harbour' && receipts[0]?.agentType === 'mercury-general' && Number.isFinite(receipts[0]?.launchedAt))
check('a foreground Agent result is not a launch receipt', !receipts.some(r => r.toolUseId === 'toolu_fg'))

section('R2 · the settled set')
const settled = lr.settledLaunchIds(transcript)
check('the notice settles its tool-use id and its task id', settled.has('toolu_two') && settled.has('agent-two') && !settled.has('toolu_one') && !settled.has('agent-one'))

section('R3 · the orphans')
const orphans = lr.orphanedBackgroundLaunches(transcript, new Set())
check('the launch without a notice or a record is the one orphan', orphans.length === 1 && orphans[0]!.agentId === 'agent-one', JSON.stringify(orphans))
check('a live record clears it', lr.orphanedBackgroundLaunches(transcript, new Set(['agent-one'])).length === 0)
check('a live record under the tool-use id clears it too', lr.orphanedBackgroundLaunches(transcript, new Set(['toolu_one'])).length === 0)

section('R4 · the reconciliation: one record, one notice, once')
let state: AppState = getDefaultAppState()
const getAppState = (): AppState => state
const setAppState = (updater: (prev: AppState) => AppState): void => {
  state = updater(state)
}
queue.resetCommandQueue()
const before = Date.now()
const settledNow = lr.reconcileBackgroundLaunchesOnResume(transcript, getAppState, setAppState)
check('the orphan is settled', settledNow.length === 1 && settledNow[0]!.agentId === 'agent-one')
const record = (state.tasks as Record<string, { type?: string; status?: string; toolUseId?: string; isBackgrounded?: boolean; evictAfter?: number; notified?: boolean; description?: string; endTime?: number; agentType?: string; error?: string; retain?: boolean }>)['agent-one']
check('a settled record stands in the store under the agent id: local_agent · killed · backgrounded · its tool-use id', record !== undefined && record.type === 'local_agent' && record.status === 'killed' && record.toolUseId === 'toolu_one' && record.isBackgrounded === true && record.description === 'harbour-count', JSON.stringify(record))
check('the record settles through the panel grace (an eviction deadline in the future, the retain gate present) and names the restart', record !== undefined && (record.evictAfter ?? 0) > before && (record.endTime ?? 0) >= before && record.retain === false && record.error === 'stopped by a runner restart')
check('the record is marked notified — its notice went out', record?.notified === true)
check('the settled launch that already carried a notice got nothing', (state.tasks as Record<string, unknown>)['agent-two'] === undefined)
const queued = queue.getCommandQueue()
const notice = queued.find(cmd => cmd.mode === 'task-notification')
check('exactly one task-notification is queued for the model', queued.length === 1 && notice !== undefined, JSON.stringify(queued.map(c => c.mode)))

section('R5 · the notice the model reads')
const noticeText = typeof notice?.value === 'string' ? notice.value : ''
check('it carries the launch\'s tool-use id and the task id', noticeText.includes('<tool-use-id>toolu_one</tool-use-id>') && noticeText.includes('<task-id>agent-one</task-id>'))
check('its status is the stop word', noticeText.includes('<status>killed</status>'))
check('its summary names the agent, the stop and the restart, and asks for a relaunch only if wanted', noticeText.includes(`<summary>${lr.restartStopSummary('harbour-count')}</summary>`) && /runner restarted before it finished/.test(noticeText) && /relaunch it if the result is still wanted/.test(noticeText))

section('R4b · idempotence')
const again = lr.reconcileBackgroundLaunchesOnResume(transcript, getAppState, setAppState)
check('a second pass with the record live settles nothing more', again.length === 0 && queue.getCommandQueue().length === 1)
queue.resetCommandQueue()
let fresh: AppState = getDefaultAppState()
const withNotice = [...transcript, noticeRow('toolu_one', 'agent-one', 'killed')]
const afterNotice = lr.reconcileBackgroundLaunchesOnResume(withNotice, () => fresh, u => { fresh = u(fresh) })
check('a later resume that finds the notice in the transcript settles nothing (the notice is the pairing)', afterNotice.length === 0 && queue.getCommandQueue().length === 0 && Object.keys(fresh.tasks).length === 0)

section('R6 · the Inspect adapter reads a bounded tail')
const small = join(scratch, 'small.output')
writeFileSync(small, 'one\ntwo\nthree\n')
const whole = readTailWindow(small)
check('a file under the cap is read whole', whole.text === 'one\ntwo\nthree\n' && whole.cut === false && whole.total === 14)
const big = join(scratch, 'big.output')
const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'x'.repeat(40)}`)
writeFileSync(big, lines.join('\n') + '\n')
const tail = readTailWindow(big, 500)
check('a file over the cap is cut to the tail window, at a line boundary, with the total named', tail.cut === true && tail.total === lines.join('\n').length + 1 && tail.text.length <= 500 && tail.text.startsWith('line ') && tail.text.endsWith('\n'), JSON.stringify({ len: tail.text.length, head: tail.text.slice(0, 12) }))
check('the tail window ends with the stream\'s last line', tail.text.trimEnd().endsWith(lines[lines.length - 1]!))
check('the cap is half a megabyte', AGENT_TAIL_READ_CAP_BYTES === 512 * 1024)

section('R7 · the seams in source')
const print = src('src/cli/print.ts')
check('the runner reconciles inside the one resume closure both roads share', /const \{ reconcileBackgroundLaunchesOnResume \} = await import\('\.\.\/tasks\/LocalAgentTask\/launchReceipts\.js'\)/.test(print) && /reconcileBackgroundLaunchesOnResume\(messages, getAppState, setAppState\)/.test(print))
check('…the cold road (--continue/--resume) and the warm claim (resume: true) both run it', /if \(options\.continue \|\| options\.resume\) await hydrateResumedRun\(\)/.test(print) && /if \(request\.resume === true\) await hydrateResumedRun\(\)/.test(print))
const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
check('the receipt line is the Agent tool\'s own first line', agentTool.includes(`'${lr.BACKGROUND_LAUNCH_LINE}',`))
const adapter = src('src/services/resources/adapters/agent.ts')
check('the detail view reads through the bounded tail window, never the whole file', /const window = readTailWindow\(contentPath\)/.test(adapter) && !/readFileSync\(contentPath/.test(adapter))
const footer = src('src/components/PromptInput/Notifications.tsx')
check('the footer\'s model is the focused chat\'s effective model (the band\'s window owner), never the screen\'s own slot', /getFocusedSessionConnector\(\)\.modelFacts\(\)\.effective/.test(footer) && /useSyncExternalStore\(subscribeFocusedModel, getFocusedModel, getFocusedModel\)/.test(footer) && !/state\.mainLoopModel/.test(footer))
const local = src('src/tasks/LocalAgentTask/LocalAgentTask.tsx')
check('the notification owner accepts the caller\'s truer summary', /summary\?: string/.test(local) && /args\.summary \?\?/.test(local))

section('R8 · the address — the receipt\'s id routes, the name routes, a dead address says why')
await import('../../src/tasks.ts')
const { toAgentId } = await import('../../src/types/ids.ts')
const { generateTaskId } = await import('../../src/Task.ts')
const { registerAsyncAgent, enqueueAgentNotification } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const FAKE_DEF = { agentType: 'mercury-general', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
type SendAnswer = { data: { success: boolean; message: string } }
function makeStore(): { get: () => AppState; set: (u: (prev: AppState) => AppState) => void } {
  let st: AppState = getDefaultAppState()
  return {
    get: () => st,
    set: u => {
      st = u(st)
    },
  }
}
function makeCtx(store: ReturnType<typeof makeStore>): never {
  return {
    getAppState: store.get,
    setAppState: store.set,
    setAppStateForTasks: store.set,
    options: { tools: [] },
    abortController: new AbortController(),
    messages: [],
  } as never
}
{
  const minted = generateTaskId('local_agent')
  check(`the task minter's id (${minted}) is an agent id to the validator the resolver reads`, toAgentId(minted) !== null)
  const parsed = lr.backgroundLaunchReceipts([assistantLaunch(), userReceipts()])
  check('the receipt parser reads the id the receipt names', parsed.length === 2 && parsed[0]?.agentId === 'agent-one')
  const store = makeStore()
  const ctx = makeCtx(store)
  registerAsyncAgent({ agentId: minted, description: 'harbour-count', prompt: 'count the harbour', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  const byId = (await SendMessageTool.call({ to: minted, message: 'a word for the harbour' } as never, ctx, undefined as never, { requestId: 'req_1' } as never)) as SendAnswer
  check("SendMessage to the receipt's id queues the message for the running agent", byId.data.success === true && /Message queued for/.test(byId.data.message), byId.data.message)
  const pending = (): string[] => ((store.get().tasks[minted] as { pendingMessages?: string[] } | undefined)?.pendingMessages ?? [])
  check("…and the words sit in that task's pending queue", pending().includes('a word for the harbour'))
  store.set(prev => ({ ...prev, agentNameRegistry: new Map([['harbour', minted]]) }))
  const byName = (await SendMessageTool.call({ to: 'harbour', message: 'a second word' } as never, ctx, undefined as never, { requestId: 'req_2' } as never)) as SendAnswer
  check("SendMessage to the launch's name routes to the same task", byName.data.success === true && /Message queued for/.test(byName.data.message) && pending().includes('a second word'), byName.data.message)
  const ghost = generateTaskId('local_agent')
  const toGhost = (await SendMessageTool.call({ to: ghost, message: 'anyone there' } as never, ctx, undefined as never, { requestId: 'req_3' } as never)) as SendAnswer
  check('an id with no running task and no transcript is refused with the facts — no running task, no transcript, which address to use', toGhost.data.success === false && !/is registered/.test(toGhost.data.message) && /no running task/i.test(toGhost.data.message) && /no transcript/i.test(toGhost.data.message), toGhost.data.message)
  const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
  check("the receipt's address line names the id and, for a named launch, the name — the two addresses the resolver reads", /continuationHint\(async\.agentId, async\.agentName\)/.test(agentTool) && agentTool.includes('or to its name "${name}"') && agentTool.includes("input.name ? { agentName: input.name } : {}"))
  const prompt = src('src/tools/SendMessageTool/prompt.ts')
  check("the tool's prompt tells the model both addresses reach a launched sub-agent", prompt.includes('addressed by the id its launch receipt names, or by the name the launch gave it'))
  const ids = src('src/types/ids.ts')
  const task = src('src/Task.ts')
  check('the id grammar has one owner: the minter reads the alphabet the validator reads', ids.includes('export const TASK_ID_ALPHABET') && task.includes("import { TASK_ID_ALPHABET, TASK_ID_SUFFIX_LENGTH } from './types/ids.js'") && !/const TASK_ID_ALPHABET = /.test(task))
}

section("R8b · a queued-guidance resume re-registers the id — the old run's notice never latches the resumed run's row")
const { completeAgentTask } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
for (const ordering of ['old-first', 'resumed-first'] as const) {
  queue.resetCommandQueue()
  const store = makeStore()
  const id = generateTaskId('local_agent')
  const first = registerAsyncAgent({ agentId: id, description: 'twice', prompt: 'count twice', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  completeAgentTask({ agentId: id }, store.set as never)
  const second = registerAsyncAgent({ agentId: id, description: 'twice', prompt: 'count twice', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  check(`${ordering}: the resume minted a fresh controller for the same id`, first.abortController !== second.abortController && store.get().tasks[id]?.status === 'running')
  const oldNotice = (): void =>
    enqueueAgentNotification({ taskId: id, description: 'twice', status: 'completed', setAppState: store.set as never, controller: first.abortController })
  const resumedSettle = (): void => {
    completeAgentTask({ agentId: id }, store.set as never)
    enqueueAgentNotification({ taskId: id, description: 'twice', status: 'completed', setAppState: store.set as never, controller: second.abortController })
  }
  if (ordering === 'old-first') {
    oldNotice()
    const row = store.get().tasks[id] as { status?: string; notified?: boolean } | undefined
    check("old-first: the old run's notice leaves the resumed row running and unlatched", row?.status === 'running' && row.notified !== true, JSON.stringify(row ? { status: row.status, notified: row.notified } : row))
    resumedSettle()
  } else {
    resumedSettle()
    oldNotice()
  }
  const notes = (): number => queue.getCommandQueue().filter(c => c.mode === 'task-notification').length
  check(`${ordering}: two runs, two notices`, notes() === 2, `${notes()} notice(s)`)
  enqueueAgentNotification({ taskId: id, description: 'twice', status: 'completed', setAppState: store.set as never, controller: second.abortController })
  check(`${ordering}: the resumed run's second report is swallowed by its own latch`, notes() === 2, `${notes()} notice(s)`)
}
{
  queue.resetCommandQueue()
  const store = makeStore()
  const id = generateTaskId('local_agent')
  const first = registerAsyncAgent({ agentId: id, description: 'fails late', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  completeAgentTask({ agentId: id }, store.set as never)
  const second = registerAsyncAgent({ agentId: id, description: 'fails late', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  enqueueAgentNotification({ taskId: id, description: 'fails late', status: 'failed', error: 'late failure', setAppState: store.set as never, controller: first.abortController })
  const row = store.get().tasks[id] as { notified?: boolean } | undefined
  check("an old run's FAILED notice goes out and leaves the resumed row unlatched", queue.getCommandQueue().filter(c => c.mode === 'task-notification').length === 1 && row?.notified !== true, JSON.stringify(row?.notified))
  const lifecycle = src('src/tools/AgentTool/agentToolUtils.ts')
  check('every notice the lifecycle enqueues names its registration (completed, killed, failed)', (lifecycle.match(/controller: args\.abortController,/g) ?? []).length >= 3, String((lifecycle.match(/controller: args\.abortController,/g) ?? []).length))
  void second
}
{
  queue.resetCommandQueue()
  const store = makeStore()
  const id = generateTaskId('local_agent')
  registerAsyncAgent({ agentId: id, description: 'once', prompt: 'count once', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  completeAgentTask({ agentId: id }, store.set as never)
  enqueueAgentNotification({ taskId: id, description: 'once', status: 'completed', setAppState: store.set as never })
  enqueueAgentNotification({ taskId: id, description: 'once', status: 'completed', setAppState: store.set as never })
  check('a token-less notice still latches the row once', queue.getCommandQueue().filter(c => c.mode === 'task-notification').length === 1)
}

section('R8c · a named launch: the foreground road registers the name, the handover receipt names it, both eviction roads prune it')
{
  const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
  const foreground = src('src/tools/AgentTool/foregroundExecution.tsx')
  check('the async road registers the launch name through the one alias helper, after its registration', /registerAsyncAgent\(\{[\s\S]{0,1500}registerAgentName\(input\.name, earlyAgentId, rootSetAppState\)/.test(agentTool))
  check('the foreground road receives the name and registers it through the same helper, after its registration', /name: input\.name,/.test(agentTool) && /registerAgentForeground\(\{[\s\S]{0,1200}if \(name !== undefined\) registerAgentName\(name, syncAgentId, rootSetAppState\)/.test(foreground))
  check('the handover receipt carries the name, so its address line names both addresses', /status: 'async_launched',[\s\S]{0,900}\.\.\.\(name !== undefined \? \{ agentName: name \} : \{\}\)/.test(foreground))
  const { applyTaskOffsetsAndEvictions } = await import('../../src/utils/task/framework.ts')
  const taskModule = (await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')) as { registerAgentName?: (name: string, agentId: string, set: unknown) => void }
  const registerAgentName = taskModule.registerAgentName
  check("the alias helper is the task module's own export", typeof registerAgentName === 'function')
  const store = makeStore()
  const older = generateTaskId('local_agent')
  const newer = generateTaskId('local_agent')
  registerAsyncAgent({ agentId: older, description: 'scout', prompt: 'scout the harbour', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  registerAgentName?.('scout', older, store.set)
  registerAgentName?.('elder', older, store.set)
  registerAsyncAgent({ agentId: newer, description: 'scout again', prompt: 'scout the harbour', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  registerAgentName?.('scout', newer, store.set)
  check('the registry routes each name to its latest holder', store.get().agentNameRegistry.get('scout') === newer && store.get().agentNameRegistry.get('elder') === older, JSON.stringify([...store.get().agentNameRegistry.entries()]))
  completeAgentTask({ agentId: older }, store.set as never)
  enqueueAgentNotification({ taskId: older, description: 'scout', status: 'completed', setAppState: store.set as never })
  store.set(prev => ({ ...prev, tasks: { ...prev.tasks, [older]: { ...prev.tasks[older], evictAfter: 0 } as never } }))
  applyTaskOffsetsAndEvictions(store.set as never, {}, [older])
  const registry = store.get().agentNameRegistry
  check('the batch sweep evicts the settled task AND its alias; a name reassigned to a newer launch survives', store.get().tasks[older] === undefined && !registry.has('elder') && registry.get('scout') === newer, JSON.stringify([...registry.entries()]))
}

section("R8d · a worker a running workflow owns is never re-created by a message; a resume reads the live owner right before it registers")
{
  const wf = (await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')) as {
    registerWorkflowTask: Function
    completeWorkflowTask: Function
    updateWorkflowProgressBatch: Function
    workflowOwningAgent?: (tasks: unknown, agentId: string) => { id: string } | undefined
  }
  const resumeModule = (await import('../../src/tools/AgentTool/resumeAgent.ts')) as {
    resumeAgentBackground: Function
    liveAgentOwner?: (agentId: string, tasks: unknown) => { kind: string; words: string } | null
  }
  const { completeAgentTask, failAgentTask, killAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
  const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
  const { asAgentId } = await import('../../src/types/ids.ts')
  const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
  const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
  const { getSessionId } = await import('../../src/bootstrap/state.ts')
  const { mkdirSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  let ordinal = 0
  const seedTranscript = (agentId: string, opening: string, reply: string): void => {
    const sessionId = String(getSessionId())
    const at = new Date(1_700_000_100_000).toISOString()
    const entry = (uuid: string, parentUuid: string | null, role: 'user' | 'assistant', text: string) => ({
      type: role, uuid, parentUuid, isSidechain: true, agentId, sessionId, timestamp: at,
      message: role === 'user' ? { role, content: text } : { id: `msg_${uuid.slice(-4)}`, role, model: 'fixture', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } },
    })
    const encode = (e: unknown): string => JSON.stringify(entryToRecord(e as never, { sessionId, nextOrdinal: () => ordinalOf(++ordinal), observedAt: at, source: { channel: 'interactive' } } as never))
    const first = `00000000-0000-4000-8000-0000000${String(++ordinal).padStart(5, '0')}`
    const second = `00000000-0000-4000-8000-0000000${String(++ordinal).padStart(5, '0')}`
    const path = getAgentTranscriptPath(asAgentId(agentId))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, [entry(first, null, 'user', opening), entry(second, first, 'assistant', reply)].map(encode).join('\n') + '\n')
  }
  check('the workflow task module owns the ownership read', typeof wf.workflowOwningAgent === 'function')
  check("the resume road exports its live-owner decision", typeof resumeModule.liveAgentOwner === 'function')
  const store = makeStore()
  const ctx = makeCtx(store)
  const child = generateTaskId('local_agent')
  const settledChild = generateTaskId('local_agent')
  const workflowTask = wf.registerWorkflowTask({ taskId: 'wf-task-1', script: '', workflowRunId: 'wf_fixture_run', workflowName: 'fixture-flow', setAppState: store.set }) as { agentControllers: Map<string, AbortController> }
  workflowTask.agentControllers.set(child, new AbortController())
  workflowTask.agentControllers.set(settledChild, new AbortController())
  wf.updateWorkflowProgressBatch('wf-task-1', [
    { type: 'workflow_agent', index: 1, label: 'fixture-worker', agentId: child, state: 'progress' },
    { type: 'workflow_agent', index: 2, label: 'second-worker', agentId: settledChild, state: 'progress' },
  ], store.set)
  const toChild = (await SendMessageTool.call({ to: child, message: 'finish the bounded slice' } as never, ctx, undefined as never, { requestId: 'req_wf1' } as never)) as SendAnswer
  check("a message to a running workflow's worker is refused, naming the workflow and the child ref, never a resume", toChild.data.success === false && toChild.data.message.includes('fixture-flow') && toChild.data.message.includes(`mercury://workflow/wf_fixture_run?child=${child}`) && !/resumed/.test(toChild.data.message), toChild.data.message.slice(0, 200))
  check('…and no task was registered under the child id', store.get().tasks[child] === undefined)
  check('the ownership read names the workflow that owns the child', wf.workflowOwningAgent?.(store.get().tasks, child)?.id === 'wf-task-1')
  check("…and answers nothing for an id no workflow owns", wf.workflowOwningAgent?.(store.get().tasks, generateTaskId('local_agent')) === undefined)
  if (typeof resumeModule.liveAgentOwner === 'function') {
    seedTranscript(child, 'build the slice', 'building')
    let refusal = ''
    try {
      await resumeModule.resumeAgentBackground({ agentId: child, prompt: 'go on', toolUseContext: ctx })
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error)
    }
    check('a resume of a live workflow child throws naming the workflow, and registers nothing', refusal.includes('fixture-flow') && store.get().tasks[child] === undefined, refusal.slice(0, 200))
    const raced = generateTaskId('local_agent')
    seedTranscript(raced, 'race me', 'racing')
    const pending = resumeModule.resumeAgentBackground({ agentId: raced, prompt: 'go on', toolUseContext: ctx }) as Promise<unknown>
    const live = registerAsyncAgent({ agentId: raced, description: 'raced', prompt: 'race me', selectedAgent: FAKE_DEF, setAppState: store.set as never })
    let racedRefusal = ''
    try {
      await pending
    } catch (error) {
      racedRefusal = error instanceof Error ? error.message : String(error)
    }
    const racedRow = store.get().tasks[raced] as { status?: string; registration?: AbortController } | undefined
    check('a live owner appearing between the lookup and the registration prevents the duplicate: the resume throws, the live row and its registration stand', /running/.test(racedRefusal) && racedRow?.status === 'running' && racedRow.registration === live.abortController, racedRefusal.slice(0, 160))
    killAsyncAgent(raced, store.set as never)
  }
  await wf.completeWorkflowTask('wf-task-1', null, 2, [], store.set)
  check('once the workflow settled, nothing owns the child', wf.workflowOwningAgent?.(store.get().tasks, settledChild) === undefined)
  const afterSettle = (await SendMessageTool.call({ to: settledChild, message: 'anyone there' } as never, ctx, undefined as never, { requestId: 'req_wf2' } as never)) as SendAnswer
  check('a settled child resumes only through the transcript road (no transcript here ⇒ its own precise refusal, not the workflow words)', afterSettle.data.success === false && /no transcript/i.test(afterSettle.data.message) && !afterSettle.data.message.includes('fixture-flow'), afterSettle.data.message.slice(0, 160))
  const twice = generateTaskId('local_agent')
  const first = registerAsyncAgent({ agentId: twice, description: 'twice', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  completeAgentTask({ agentId: twice }, store.set as never)
  const second = registerAsyncAgent({ agentId: twice, description: 'twice', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  ;(completeAgentTask as Function)({ agentId: twice }, store.set, first.abortController)
  ;(killAsyncAgent as Function)(twice, store.set, 'late stop', first.abortController)
  ;(failAgentTask as Function)(twice, 'late failure', store.set, first.abortController)
  const successor = store.get().tasks[twice] as { status?: string } | undefined
  check("an earlier run's late complete, kill and fail leave the successor running, its controller untouched", successor?.status === 'running' && second.abortController.signal.aborted === false, JSON.stringify(successor?.status))
  ;(completeAgentTask as Function)({ agentId: twice }, store.set, second.abortController)
  check("…and the successor's own settle lands", (store.get().tasks[twice] as { status?: string } | undefined)?.status === 'completed')
  const resumeSrc = src('src/tools/AgentTool/resumeAgent.ts')
  const checkAt = resumeSrc.indexOf('const owner = liveAgentOwner(agentId, tasksNow)')
  const registerAt = resumeSrc.indexOf('const task = registerAsyncAgent({', checkAt)
  check('the resume checks the live owner right before it registers, with no await between', checkAt > 0 && registerAt > checkAt && !/\bawait\b/.test(resumeSrc.slice(checkAt, registerAt)))
  const sendSrc = src('src/tools/SendMessageTool/SendMessageTool.ts')
  const askAt = sendSrc.indexOf('workflowOwningAgent(context.getAppState().tasks')
  check('the message road asks the workflow owner before it reads a transcript', askAt > 0 && askAt < sendSrc.indexOf('const transcriptPath = agentTranscriptPathOf(String(agentId))'))
  check('no new registration road, worktree fallback or permission road was added (one registration, the two fallback mentions, the one pre-existing permission default)', (resumeSrc.match(/registerAsyncAgent\(/g) ?? []).length === 1 && (resumeSrc.match(/cwdFallback/g) ?? []).length === 2 && (resumeSrc.match(/behavior: 'allow'/g) ?? []).length === 1 && !/process\.env\./.test(resumeSrc))
}

section('R8e · every non-terminal row has a live owner; the exit card counts what is alive, by kind, and names where to see it')
{
  const fw = await import('../../src/utils/task/framework.ts')
  const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
  const { workRowRuns } = await import('../../src/services/engine-connector/workCounts.ts')
  const { registerMainSessionTask } = await import('../../src/tasks/LocalMainSessionTask.ts')
  const wf = (await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')) as { registerWorkflowTask: Function; completeWorkflowTask: Function; pauseWorkflowTask: Function }
  const { killAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
  const store = makeStore()
  const crewAgents = (): number => projectWorkRoster(store.get().tasks ?? {}).filter(r => workRowRuns(r) && (r.kind === 'agent' || r.kind === 'named')).length
  const shellId = generateTaskId('local_bash')
  store.set(prev => ({ ...prev, tasks: { ...prev.tasks, [shellId]: { id: shellId, type: 'local_bash', status: 'running', description: 'sleep 60', command: 'sleep 60', isBackgrounded: true, startTime: Date.now(), notified: false, shellCommand: { status: 'running' } } as never } }))
  let counts = fw.liveBackgroundCounts(store.get().tasks)
  check('a live shell command counts as a shell command, with words a person can act on', counts.total === 1 && counts.shells === 1 && counts.agents === 0 && fw.liveWorkWords(counts) === '1 shell command', JSON.stringify(counts))
  check('…while the crew view lists no agent (the two surfaces now say different things for a reason the card names)', crewAgents() === 0)
  const { taskId: stoppedQuery } = registerMainSessionTask('a stopped background query', store.set as never)
  ;(store.get().tasks[stoppedQuery] as { abortController?: AbortController }).abortController?.abort()
  const before = store.get().tasks[stoppedQuery] as { status?: string } | undefined
  check("a stopped background query's row reads running with its controller gone — the owner law names it", before?.status === 'running' && fw.taskOwnerGone(before as never) === 'its controller was stopped before the row settled', String(fw.taskOwnerGone(before as never)))
  counts = fw.liveBackgroundCounts(store.get().tasks)
  check('…and the count leaves it out', counts.total === 1 && counts.agents === 0, JSON.stringify(counts))
  const settled = fw.settleOwnerlessTasks(store.set as never)
  const after = store.get().tasks[stoppedQuery] as { status?: string; stopReason?: string } | undefined
  check('…the door settles it to killed with the reason on the row', settled.length === 1 && settled[0]?.id === stoppedQuery && after?.status === 'killed' && after.stopReason === 'its controller was stopped before the row settled', JSON.stringify(after?.status))
  const liveAgent = generateTaskId('local_agent')
  registerAsyncAgent({ agentId: liveAgent, description: 'alive', prompt: 'work', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  wf.registerWorkflowTask({ taskId: 'wf-paused', script: '', workflowRunId: 'wf_paused_run', workflowName: 'paused-flow', setAppState: store.set })
  wf.pauseWorkflowTask('wf-paused', store.set)
  check('a live agent and a paused workflow have nothing to settle', fw.settleOwnerlessTasks(store.set as never).length === 0 && (store.get().tasks[liveAgent] as { status?: string } | undefined)?.status === 'running' && (store.get().tasks['wf-paused'] as { status?: string } | undefined)?.status === 'paused')
  counts = fw.liveBackgroundCounts(store.get().tasks)
  check('the words name the kinds in order', fw.liveWorkWords(counts) === '1 shell command and 1 agent' && fw.liveWorkWords({ total: 4, shells: 2, agents: 1, workflows: 1, teammates: 0, other: 0 }) === '2 shell commands, 1 agent and 1 workflow' && fw.liveWorkWords({ total: 0, shells: 0, agents: 0, workflows: 0, teammates: 0, other: 0 }) === 'nothing', fw.liveWorkWords(counts))
  check('…and the crew view agrees on the agent', crewAgents() === 1)
  const child = generateTaskId('local_agent')
  wf.registerWorkflowTask({ taskId: 'wf-gone', script: '', workflowRunId: 'wf_gone_run', workflowName: 'gone-flow', setAppState: store.set })
  registerAsyncAgent({ agentId: child, description: 'a child row', prompt: 'p', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  await wf.completeWorkflowTask('wf-gone', null, 1, [], store.set)
  check('a leftover child row with a live controller is counted by both surfaces alike (never settled on a guess)', fw.taskOwnerGone(store.get().tasks[child] as never) === null && fw.liveBackgroundCounts(store.get().tasks).agents === 2 && crewAgents() === 2)
  killAsyncAgent(liveAgent, store.set as never)
  killAsyncAgent(child, store.set as never)
  const exitSrc = src('src/commands/exit/exit.tsx')
  check('the exit command settles ownerless rows, then counts by kind, and hands the words to the card', exitSrc.indexOf('settleOwnerlessTasks(context.setAppState)') > 0 && exitSrc.indexOf('settleOwnerlessTasks(context.setAppState)') < exitSrc.indexOf('liveBackgroundCounts(') && exitSrc.includes('liveWords={liveWorkWords(counts)}'))
  const confirmSrc = src('src/components/MercuryExitConfirm.tsx')
  check('the card says what is alive by kind and where to see it', confirmSrc.includes('{liveWords} still running') && confirmSrc.includes('see them with /tasks'))
  const sessionSrc = src('src/tasks/LocalMainSessionTask.ts')
  check("the background session's abort branch settles its row before it returns", /killAsyncAgent\(taskId, args\.setAppState, 'stopped'\)\n\s*return\n/.test(sessionSrc))
}

section('R9 · one status per agent — the inspection verbs read one fact, on the registry or on disk')
const { agentAdapter } = await import('../../src/services/resources/adapters/agent.ts')
const { transcriptAdapter } = await import('../../src/services/resources/adapters/transcript.ts')
const { parseMercuryRef } = await import('../../src/services/resources/contracts.ts')
const { getAgentTranscriptPath, getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { asAgentId } = await import('../../src/types/ids.ts')
const { getTaskOutputPath } = await import('../../src/utils/task/diskOutput.ts')
const { mkdirSync } = await import('node:fs')
const { dirname } = await import('node:path')
const { INTERRUPT_MESSAGE } = await import('../../src/utils/messages/rejectionText.ts')
type Resolved = { state: string; note?: string; resource?: { summary?: string; text?: string; structured?: Record<string, unknown> } }
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
let rowSeq = 0
const recordWriter = { sessionId: 'launch-receipts-proof' as never, nextOrdinal: () => ordinalOf(++rowSeq), observedAt: '2026-06-19T12:00:00.000Z', source: { channel: 'sdk' } as const }
const row = (type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify(entryToRecord({ type, uuid: `00000000-0000-4000-8000-${String(rowSeq + 1).padStart(12, '0')}`, timestamp: stamp(), message: { role: type, content }, ...extra } as never, recordWriter as never))
function writeTranscript(id: string, rows: string[]): string {
  const file = getAgentTranscriptPath(asAgentId(id))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, rows.join('\n') + '\n')
  return file
}
const PROMPT_ROW = row('user', 'plant the foliage')
const CALL_ROW = (id: string): string => row('assistant', [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/tmp/notes.md' } }])
const RESULT_ROW = (id: string): string => row('user', [{ type: 'tool_result', tool_use_id: id, content: 'the notes' }])
const transcripts = {
  stopped: [PROMPT_ROW, CALL_ROW('toolu_s1'), RESULT_ROW('toolu_s1'), row('user', [{ type: 'text', text: INTERRUPT_MESSAGE }])],
  failed: [PROMPT_ROW, row('assistant', [{ type: 'text', text: 'half the foliage is planted' }]), row('assistant', [{ type: 'text', text: 'API Error: OpenAI stream fault after partial content (read-failed) — terminated' }], { isApiErrorMessage: true })],
  completed: [PROMPT_ROW, CALL_ROW('toolu_c1'), RESULT_ROW('toolu_c1'), row('assistant', [{ type: 'text', text: 'the foliage is planted' }])],
  cut: [PROMPT_ROW, CALL_ROW('toolu_x1'), RESULT_ROW('toolu_x1'), CALL_ROW('toolu_x2')],
} as const
const EXPECTED: Record<keyof typeof transcripts, RegExp> = {
  stopped: /^stopped \(transcript on disk\)/,
  failed: /^failed \(transcript on disk\)/,
  completed: /^completed \(transcript on disk\)/,
  cut: /^cut off mid-turn \(transcript on disk\)/,
}
{
  const empty = { getAppState: () => ({ tasks: {} }), owner: '@proof', cwd: scratch } as never
  for (const kind of Object.keys(transcripts) as Array<keyof typeof transcripts>) {
    const id = generateTaskId('local_agent')
    writeTranscript(id, [...transcripts[kind]])
    const detail = (await agentAdapter.resolve(parseMercuryRef(`mercury://agent/${id}`)!, empty)) as Resolved
    check(`a registry miss with a transcript that ended ${kind}: the detail view reads it from the transcript's own end`, detail.state === 'ok' && EXPECTED[kind].test(detail.resource?.summary ?? ''), detail.resource?.summary ?? detail.note)
    const report = (await agentAdapter.resolve(parseMercuryRef(`mercury://agent/${id}?child=report`)!, empty)) as Resolved
    check(`…and the report view speaks the same word`, report.state === 'ok' && EXPECTED[kind].test(report.resource?.summary ?? ''), report.resource?.summary ?? report.note)
    const sid = getSessionId()
    const viaTranscript = (await transcriptAdapter.resolve(parseMercuryRef(`mercury://transcript/agent/${sid}/agent-${id}`)!, empty)) as Resolved
    check(`…and the transcript verb, never "finished agent execution" (${kind})`, viaTranscript.state === 'ok' && !/finished agent execution/.test(viaTranscript.resource?.summary ?? '') && new RegExp(`\\b${kind === 'cut' ? 'cut off mid-turn' : kind}\\b`).test(viaTranscript.resource?.summary ?? ''), viaTranscript.resource?.summary ?? viaTranscript.note)
  }
  const live = generateTaskId('local_agent')
  writeTranscript(live, [...transcripts.completed])
  const withRow = { getAppState: () => ({ tasks: { [live]: { id: live, type: 'local_agent', status: 'killed', description: 'foliage', startTime: Date.now() - 5000, endTime: Date.now() } } }), owner: '@proof', cwd: scratch } as never
  const killed = (await agentAdapter.resolve(parseMercuryRef(`mercury://agent/${live}`)!, withRow)) as Resolved
  check('a killed registry row reads stopped on the detail view', /^stopped /.test(killed.resource?.summary ?? ''), killed.resource?.summary)
  const sid = getSessionId()
  const killedTranscript = (await transcriptAdapter.resolve(parseMercuryRef(`mercury://transcript/agent/${sid}/agent-${live}`)!, withRow)) as Resolved
  check('…and the transcript verb reads the registry\'s word too', /\bstopped\b/.test(killedTranscript.resource?.summary ?? '') && !/finished agent execution/.test(killedTranscript.resource?.summary ?? ''), killedTranscript.resource?.summary)
  const runningRow = { getAppState: () => ({ tasks: { [live]: { id: live, type: 'local_agent', status: 'running', description: 'foliage', startTime: Date.now() - 5000 } } }), owner: '@proof', cwd: scratch } as never
  const runningTranscript = (await transcriptAdapter.resolve(parseMercuryRef(`mercury://transcript/agent/${sid}/agent-${live}`)!, runningRow)) as Resolved
  check('a running registry row reads running on the transcript verb', /\brunning\b/.test(runningTranscript.resource?.summary ?? '') && !/finished/.test(runningTranscript.resource?.summary ?? ''), runningTranscript.resource?.summary)
  const stubbed = generateTaskId('local_agent')
  writeTranscript(stubbed, [...transcripts.completed])
  const stub = getTaskOutputPath(stubbed)
  mkdirSync(dirname(stub), { recursive: true })
  writeFileSync(stub, '')
  const stubRow = { getAppState: () => ({ tasks: { [stubbed]: { id: stubbed, type: 'local_agent', status: 'running', description: 'foliage', startTime: Date.now(), outputFile: stub } } }), owner: '@proof', cwd: scratch } as never
  const stubReport = (await agentAdapter.resolve(parseMercuryRef(`mercury://agent/${stubbed}?child=report`)!, stubRow)) as Resolved
  check('an empty .output stub beside a real transcript: the report reads the transcript (1 tool call), never 0 entries', /1 tool call\(s\)/.test(stubReport.resource?.summary ?? '') && !/0 entries/.test(stubReport.resource?.summary ?? ''), stubReport.resource?.summary ?? stubReport.note)
  const { taskNotFoundWords } = await import('../../src/tasks/stopTask.ts')
  const evicted = generateTaskId('local_agent')
  writeTranscript(evicted, [...transcripts.stopped])
  const words = await taskNotFoundWords(evicted)
  check("TaskStop on an evicted agent names the transcript's end and the resume door", /No running task with id/.test(words) && /ends stopped/.test(words) && /SendMessage/.test(words), words)
  check('TaskStop on an id with nothing behind it keeps the plain miss', (await taskNotFoundWords(generateTaskId('local_agent'))).startsWith('No task found with id'))
}

section('R10 · a death is delivered once — the typed cause, what landed, never a second notice')
const { runAsyncAgentLifecycle } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
const { createAssistantMessage, createAssistantAPIErrorMessage, createUserMessage } = await import('../../src/utils/messages.ts')
const { streamFaultAfterPartialText, STREAM_FAULT_RECOVERY_NUDGE } = await import('../../src/services/api/errors.ts')
const META = { prompt: 'plant the foliage', resolvedAgentModel: 'gpt-5.6-sol', isBuiltInAgent: false, startTime: Date.now(), agentType: 'mercury-general', isAsync: true }
const FAULT = streamFaultAfterPartialText('OpenAI', 'read-failed', 'terminated')
async function deathOf(name: string, writes: string[]): Promise<{ record: { status?: string; error?: string; notified?: boolean } | undefined; notes: string[]; id: string }> {
  queue.resetCommandQueue()
  const store = makeStore()
  const id = generateTaskId('local_agent')
  const task = registerAsyncAgent({ agentId: id, description: name, prompt: 'plant the foliage', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  async function* stream(): AsyncGenerator<Message, void> {
    yield createUserMessage({ content: 'plant the foliage' })
    let w = 0
    for (const path of writes) {
      const toolUseId = `toolu_w${++w}`
      yield createAssistantMessage({ content: [{ type: 'tool_use', id: toolUseId, name: 'Write', input: { file_path: path, content: 'x' } }] })
      yield createUserMessage({ content: [{ type: 'tool_result', tool_use_id: toolUseId, content: `File created successfully at: ${path}` }] })
    }
    yield createAssistantMessage({ content: 'half the foliage is planted' })
    yield createAssistantAPIErrorMessage({ content: FAULT })
    yield createUserMessage({ content: STREAM_FAULT_RECOVERY_NUDGE, isMeta: true })
    yield createAssistantAPIErrorMessage({ content: FAULT })
  }
  await runAsyncAgentLifecycle({
    taskId: id,
    abortController: task.abortController!,
    makeStream: () => stream() as never,
    metadata: META,
    description: name,
    toolUseContext: { options: { tools: [] }, toolUseId: `toolu_${name}` } as never,
    rootSetAppState: store.set as never,
    agentIdForCleanup: id,
    enableSummarization: false,
    getWorktreeResult: async () => ({}),
  })
  return {
    record: store.get().tasks[id] as { status?: string; error?: string; notified?: boolean } | undefined,
    notes: queue.getCommandQueue().filter(c => c.mode === 'task-notification').map(c => String(c.value ?? '')),
    id,
  }
}
{
  const death = await deathOf('foliage', ['/tmp/foliage.gd'])
  check('the exhausted ladder settles the task failed once, carrying the typed cause', death.record?.status === 'failed' && death.record.error === FAULT, JSON.stringify(death.record))
  check("exactly one failed notice reached the queue, at the 'next' band", death.notes.length === 1 && /<status>failed<\/status>/.test(death.notes[0] ?? '') && queue.getCommandQueue().every(c => c.priority === 'next'), `${death.notes.length} notes`)
  check('the notice carries the typed cause', (death.notes[0] ?? '').includes(FAULT))
  check('the notice says what landed on disk — the one write', /1 file write landed: \/tmp\/foliage\.gd/.test(death.notes[0] ?? ''), (death.notes[0] ?? '').slice(0, 400))
  check('the partial text rides the notice as partial work, never as a report', /half the foliage is planted/.test(death.notes[0] ?? ''))
  enqueueAgentNotification({ taskId: death.id, description: 'foliage', status: 'failed', error: FAULT, setAppState: () => {} })
  check('a second death report for the same task is swallowed by the notified latch', queue.getCommandQueue().filter(c => c.mode === 'task-notification').length === 1)
  const bare = await deathOf('bare-foliage', [])
  check('a child that wrote nothing says so', bare.notes.length === 1 && /no file writes landed/.test(bare.notes[0] ?? ''), (bare.notes[0] ?? '').slice(0, 400))
  const send = src('src/tools/SendMessageTool/SendMessageTool.ts')
  check('a resume of a settled agent names its real end — never "was stopped" for a failure', !send.includes('was stopped (status: ${liveLocal.status})'))
  queue.resetCommandQueue()
}

section('R11 · the hand-back — every exit that is not a clean finish carries the partial text, the files, the tool count, the cause and the way back')
{
  const { AbortError, DeadlineExceededError } = await import('../../src/utils/errors.ts')
  type Exit = { name: string; thrown: () => Error; cause: RegExp; status: 'failed' | 'killed' }
  const exits: Exit[] = [
    { name: 'budget-cut', thrown: () => new Error('provider throttled — the 5-minute recovery budget is spent after 3 declared waits (HTTP 429); the agent stopped — retry later, or raise MERCURY_RECOVERY_BUDGET_MINUTES'), cause: /provider throttled/, status: 'failed' },
    { name: 'stall', thrown: () => new DeadlineExceededError('no progress for 900000ms'), cause: /no progress/, status: 'failed' },
    { name: 'provider-fault', thrown: () => new Error('the provider closed the stream mid-turn'), cause: /closed the stream/, status: 'failed' },
    { name: 'kill', thrown: () => new AbortError(), cause: /stopped/, status: 'killed' },
  ]
  for (const exit of exits) {
    queue.resetCommandQueue()
    const store = makeStore()
    const id = generateTaskId('local_agent')
    const task = registerAsyncAgent({ agentId: id, description: `leaves-${exit.name}`, prompt: 'survey the harbour', selectedAgent: FAKE_DEF, setAppState: store.set as never })
    async function* stream(): AsyncGenerator<Message, void> {
      yield createUserMessage({ content: 'survey the harbour' })
      yield createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_w1', name: 'Write', input: { file_path: '/tmp/harbour-notes.md', content: 'x' } }] })
      yield createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_w1', content: 'File created successfully at: /tmp/harbour-notes.md' }] })
      yield createAssistantMessage({ content: 'three piers counted so far, the fourth is behind the crane' })
      if (exit.name === 'kill') task.abortController?.abort()
      throw exit.thrown()
    }
    await runAsyncAgentLifecycle({
      taskId: id,
      abortController: task.abortController!,
      makeStream: () => stream() as never,
      metadata: META,
      description: `leaves-${exit.name}`,
      toolUseContext: { options: { tools: [] }, toolUseId: `toolu_${exit.name}` } as never,
      rootSetAppState: store.set as never,
      agentIdForCleanup: id,
      enableSummarization: false,
      getWorktreeResult: async () => ({}),
    })
    const row = store.get().tasks[id] as { status?: string; error?: string } | undefined
    const notes = queue.getCommandQueue().filter(c => c.mode === 'task-notification').map(c => String(c.value ?? ''))
    const note = notes[0] ?? ''
    check(`${exit.name}: the record settles ${exit.status} once and one notice goes out`, row?.status === exit.status && notes.length === 1, `${row?.status} · ${notes.length} notice(s)`)
    check(`${exit.name}: the notice carries the partial text as a result`, /<result>[\s\S]*three piers counted so far[\s\S]*<\/result>/.test(note), note.slice(0, 400))
    check(`${exit.name}: the notice names the cause`, exit.cause.test(note), note.slice(0, 300))
    check(`${exit.name}: the notice says what landed on disk`, /1 file write landed: \/tmp\/harbour-notes\.md/.test(note), note.slice(0, 300))
    check(`${exit.name}: the notice counts the tools it ran`, /<tool_uses>1<\/tool_uses>/.test(note), note.slice(0, 400))
    check(`${exit.name}: the notice carries the envelope with the observed changes`, /<envelope v="\d+" status="(failed|stopped)">/.test(note) && /changed \(observed\)/.test(note), note.slice(-400))
    check(`${exit.name}: the notice names the way back`, /its work is kept/.test(note) && /resume it from the crew view/.test(note), note.slice(0, 400))
  }
  const painter = src('src/components/messages/UserAgentNotificationMessage.tsx')
  check('the notification card paints a kept partial result as its own line', /partial result kept/.test(painter) && /partialResultOf\(param\.text\)/.test(painter))
  const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
  const failedBranch = agentTool.slice(agentTool.indexOf("if (status === 'failed')"), agentTool.indexOf("if (status === 'completed')"))
  check("the sync road's failed result carries the envelope and says the work is kept", /envelopeFor\(data\)/.test(failedBranch) && /its work is kept/.test(failedBranch))
  queue.resetCommandQueue()
}

section('R12 · durability — every row an agent yields is on its transcript first; a hard crash between rows loses nothing already shown')
{
  const { spawnSync } = await import('node:child_process')
  const { existsSync, mkdirSync } = await import('node:fs')
  const childHome = mkdtempSync(join(tmpdir(), 'durability-child-'))
  const childScript = join(childHome, 'child.ts')
  writeFileSync(childScript, [
    ";(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }",
    "import { writeFileSync } from 'node:fs'",
    "const [road, home, root, agentId] = process.argv.slice(2) as [string, string, string, string]",
    "process.env.MERCURY_CONFIG_DIR = home",
    "process.env.MERCURY_CREDENTIAL_STORE = 'file'",
    "const { enableConfigs } = await import(root + '/src/utils/config.ts')",
    "enableConfigs()",
    "const storage = await import(root + '/src/utils/sessionStorage.ts')",
    "const { asAgentId } = await import(root + '/src/types/ids.ts')",
    "const path = storage.getAgentTranscriptPath(asAgentId(agentId))",
    "storage.registerAgentTranscriptDestination(agentId, path)",
    "writeFileSync(home + '/agent-path.txt', path)",
    "const row = (uuid: string, parentUuid: string | null, text: string) => ({ type: 'user', uuid, parentUuid, isSidechain: true, timestamp: new Date().toISOString(), message: { role: 'user', content: text } })",
    "const rows = [row('00000000-0000-4000-8000-0000000000c1', null, 'one'), row('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000c1', 'two'), row('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000c2', 'three')]",
    "if (road === 'durable') {",
    "  const runner = await import(root + '/src/tools/AgentTool/runAgent.ts')",
    "  let parent: string | null = null",
    "  for (const r of rows) { await runner.landAgentTranscriptRows([r as never], agentId, parent as never); parent = r.uuid }",
    "} else {",
    "  let parent: string | null = null",
    "  for (const r of rows) { void storage.recordSidechainTranscript([r as never], agentId, parent as never).catch(() => {}); parent = r.uuid }",
    "}",
    "process.kill(process.pid, 'SIGKILL')",
  ].join('\n'))
  const rowsOnDisk = (road: 'durable' | 'fire-and-forget'): number | null => {
    const home = join(childHome, road)
    mkdirSync(home, { recursive: true })
    const env = { ...process.env }
    delete env.NODE_ENV
    const agentId = generateTaskId('local_agent')
    const run = spawnSync(process.execPath, ['run', childScript, road, home, ROOT, agentId], { cwd: ROOT, encoding: 'utf8', env, timeout: 60_000 })
    const pathFile = join(home, 'agent-path.txt')
    if (!existsSync(pathFile)) return null
    const path = readFileSync(pathFile, 'utf8')
    if (!existsSync(path)) return 0
    return (readFileSync(path, 'utf8').match(/"content":"(?:one|two|three)"/g) ?? []).length
  }
  const control = rowsOnDisk('fire-and-forget')
  check('the control: rows handed to the writer and a crash at once — the batch window loses them (fewer than three on disk)', control !== null && control < 3, String(control))
  const durable = rowsOnDisk('durable')
  check('the durable road: every row is on disk before the next one is handed on — three on disk after the crash', durable === 3, String(durable))
  const runner = src('src/tools/AgentTool/runAgent.ts')
  check('the runner lands every recordable row before it yields (no fire-and-forget record left on its stream)', /export async function landAgentTranscriptRows\(/.test(runner) && !/void recordSidechainTranscript\(/.test(runner))
  const lifecycle = src('src/tools/AgentTool/agentToolUtils.ts')
  const foreground = src('src/tools/AgentTool/foregroundExecution.tsx')
  check("the lifecycle's non-clean exits flush the transcript before the notice goes out", (lifecycle.match(/await flushSessionStorage\(\)/g) ?? []).length >= 2 && (foreground.match(/await flushSessionStorage\(\)/g) ?? []).length >= 2)
}

section('R13 · a seat cut by the recovery budget resumes ONCE by itself, with a receipt row; never on a kill, a stop, a hand resume, a live owner, or a second time')
{
  const lifecycle = (await import('../../src/tools/AgentTool/agentToolUtils.ts')) as {
    recoveryBudgetCutOf?: (error: unknown) => string | null
    armBudgetCutResume?: (args: Record<string, unknown>) => unknown
    automaticResumePending?: (taskId: string) => boolean
  }
  const { AbortError } = await import('../../src/utils/errors.ts')
  const budgetCut = () => new Error('provider throttled — the 5-minute recovery budget is spent after 3 declared waits (HTTP 429); the agent stopped — retry later, or raise MERCURY_RECOVERY_BUDGET_MINUTES')
  check('the lifecycle reads a budget cut from the runner\'s own words', typeof lifecycle.recoveryBudgetCutOf === 'function' && lifecycle.recoveryBudgetCutOf?.(budgetCut()) !== null && lifecycle.recoveryBudgetCutOf?.(new Error('the provider closed the stream')) === null && lifecycle.recoveryBudgetCutOf?.(new AbortError()) === null)
  check('the arm and its pending read are the lifecycle\'s own exports', typeof lifecycle.armBudgetCutResume === 'function' && typeof lifecycle.automaticResumePending === 'function')
  if (typeof lifecycle.armBudgetCutResume === 'function' && typeof lifecycle.automaticResumePending === 'function') {
    const arm = lifecycle.armBudgetCutResume
    const pending = lifecycle.automaticResumePending
    const wf = (await import('../../src/tasks/LocalWorkflowTask/LocalWorkflowTask.js')) as { registerWorkflowTask: Function }
    const { completeAgentTask, failAgentTask, killAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
    const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    const receipts = (): string[] => queue.getCommandQueue().filter(c => c.mode === 'task-notification').map(c => String(c.value ?? '')).filter(v => /<status>resumed<\/status>/.test(v))
    {
      queue.resetCommandQueue()
      const store = makeStore()
      const id = generateTaskId('local_agent')
      const task = registerAsyncAgent({ agentId: id, description: 'cut by the budget', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
      failAgentTask(id, budgetCut().message, store.set as never, task.abortController)
      const resumes: Array<Record<string, unknown>> = []
      arm({ taskId: id, description: 'cut by the budget', registration: task.abortController, toolUseContext: makeCtx(store), rootSetAppState: store.set, delayMs: 5, resume: async (args: Record<string, unknown>) => { resumes.push(args); return { agentId: id } } })
      check('a budget-cut failure arms one pending resume', pending(id) === true)
      await settle(60)
      check('…it fires once, marked automatic, carrying the resume note', resumes.length === 1 && resumes[0]?.automatic === true && typeof resumes[0]?.prompt === 'string' && /recovery budget/.test(String(resumes[0]?.prompt)), JSON.stringify(resumes).slice(0, 200))
      check('…and leaves a receipt row in the parent\'s transcript, exactly one', receipts().length === 1 && /resumed by itself/.test(receipts()[0] ?? ''), (receipts()[0] ?? '').slice(0, 200))
      check('…and nothing stays pending', pending(id) === false)
      const before = resumes.length
      arm({ taskId: id, description: 'cut by the budget', registration: task.abortController, toolUseContext: makeCtx(store), rootSetAppState: store.set, delayMs: 5, resume: async (args: Record<string, unknown>) => { resumes.push(args); return { agentId: id } } })
      await settle(60)
      check('a second arm for the same cut fires nothing', resumes.length === before && receipts().length === 1)
    }
    {
      queue.resetCommandQueue()
      const store = makeStore()
      const fired: string[] = []
      const resumeInto = (label: string) => async () => { fired.push(label); return {} }
      const byHand = generateTaskId('local_agent')
      const first = registerAsyncAgent({ agentId: byHand, description: 'by hand', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
      failAgentTask(byHand, budgetCut().message, store.set as never, first.abortController)
      arm({ taskId: byHand, description: 'by hand', registration: first.abortController, toolUseContext: makeCtx(store), rootSetAppState: store.set, delayMs: 30, resume: resumeInto('by-hand') })
      registerAsyncAgent({ agentId: byHand, description: 'by hand', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
      const stoppedEarly = generateTaskId('local_agent')
      const se = registerAsyncAgent({ agentId: stoppedEarly, description: 'stopped', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
      killAsyncAgent(stoppedEarly, store.set as never)
      check('a killed row is not a failed row of its registration — the arm refuses to fire for it', arm({ taskId: stoppedEarly, description: 'stopped', registration: se.abortController, toolUseContext: makeCtx(store), rootSetAppState: store.set, delayMs: 5, resume: resumeInto('stopped') }) !== null)
      const evicted = generateTaskId('local_agent')
      const e = registerAsyncAgent({ agentId: evicted, description: 'evicted', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
      failAgentTask(evicted, budgetCut().message, store.set as never, e.abortController)
      arm({ taskId: evicted, description: 'evicted', registration: e.abortController, toolUseContext: makeCtx(store), rootSetAppState: store.set, delayMs: 30, resume: resumeInto('evicted') })
      store.set(prev => { const tasks = { ...prev.tasks }; delete tasks[evicted]; return { ...prev, tasks } })
      const owned = generateTaskId('local_agent')
      const o = registerAsyncAgent({ agentId: owned, description: 'owned', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
      failAgentTask(owned, budgetCut().message, store.set as never, o.abortController)
      arm({ taskId: owned, description: 'owned', registration: o.abortController, toolUseContext: makeCtx(store), rootSetAppState: store.set, delayMs: 30, resume: resumeInto('owned') })
      const workflowTask = wf.registerWorkflowTask({ taskId: 'wf-owner', script: '', workflowRunId: 'wf_owner_run', workflowName: 'owner-flow', setAppState: store.set }) as { agentControllers: Map<string, AbortController> }
      workflowTask.agentControllers.set(owned, new AbortController())
      const automatic = generateTaskId('local_agent')
      const a = registerAsyncAgent({ agentId: automatic, description: 'automatic', prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
      failAgentTask(automatic, budgetCut().message, store.set as never, a.abortController)
      const armed = arm({ taskId: automatic, description: 'automatic', registration: a.abortController, toolUseContext: makeCtx(store), rootSetAppState: store.set, delayMs: 30, automaticResume: true, resume: resumeInto('automatic') })
      check("an automatic run's own budget cut arms nothing (one automatic resume per cut chain)", armed === null && pending(automatic) === false)
      await settle(120)
      check('a hand resume, a stop, an eviction and a live workflow owner each stop the automatic resume; no receipt row for any', fired.length === 0 && receipts().length === 0, JSON.stringify(fired))
      completeAgentTask({ agentId: byHand }, store.set as never)
    }
    {
      const { cancelAutomaticResume } = await import('../../src/tools/AgentTool/agentToolUtils.ts')
      for (const kind of ['budget-cut', 'stop'] as const) {
        queue.resetCommandQueue()
        const store = makeStore()
        const id = generateTaskId('local_agent')
        const task = registerAsyncAgent({ agentId: id, description: kind, prompt: 'count', selectedAgent: FAKE_DEF, setAppState: store.set as never })
        async function* stream(): AsyncGenerator<Message, void> {
          yield createUserMessage({ content: 'count' })
          yield createAssistantMessage({ content: 'one so far' })
          if (kind === 'stop') {
            task.abortController?.abort()
            throw new AbortError()
          }
          throw budgetCut()
        }
        await runAsyncAgentLifecycle({ taskId: id, abortController: task.abortController!, makeStream: () => stream() as never, metadata: META, description: kind, toolUseContext: { options: { tools: [] }, toolUseId: `toolu_${kind}` } as never, rootSetAppState: store.set as never, agentIdForCleanup: id, enableSummarization: false, getWorktreeResult: async () => ({}) })
        const armed = pending(id)
        const cancelled = cancelAutomaticResume(id)
        check(kind === 'budget-cut' ? 'the lifecycle arms the one automatic resume on a budget cut' : "the lifecycle's stop road arms nothing", kind === 'budget-cut' ? armed && cancelled : !armed && !cancelled)
      }
    }
    const lifecycleSrc = src('src/tools/AgentTool/agentToolUtils.ts')
    const resumeSrc = src('src/tools/AgentTool/resumeAgent.ts')
    check('the lifecycle arms the resume only when the failure is a budget cut, never on the stop road', (lifecycleSrc.match(/armBudgetCutResume\(\{/g) ?? []).length === 1 && /const budgetCut = recoveryBudgetCutOf\(error\)/.test(lifecycleSrc) && /if \(budgetCut !== null && !args\.automaticResume\)/.test(lifecycleSrc))
    check('the resume road carries the automatic mark into the lifecycle it starts', /automaticResume: args\.automatic === true/.test(resumeSrc))
  }
  queue.resetCommandQueue()
}

section('R14 · nothing load-bearing on the partial shapes: an old notice paints as before, a resume receipt settles no launch, the envelope keeps its keys, an old transcript reads unchanged')
{
  const painter = (await import('../../src/components/messages/UserAgentNotificationMessage.tsx')) as { partialResultOf?: (text: string) => string | null }
  check("the card's partial decision is a pure export", typeof painter.partialResultOf === 'function')
  if (typeof painter.partialResultOf === 'function') {
    const oldFailed = '<task-notification>\n<task-id>a1</task-id>\n<status>failed</status>\n<summary>Agent "x" failed: boom</summary>\n</task-notification>'
    const newFailed = '<task-notification>\n<task-id>a1</task-id>\n<status>failed</status>\n<summary>Agent "x" failed: boom — its work is kept</summary>\n<result>three piers so far</result>\n</task-notification>'
    const completed = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "x" completed</summary>\n<result>done</result>\n</task-notification>'
    check('an old-shaped failed notice (no result) paints as before — no partial line', painter.partialResultOf(oldFailed) === null)
    check('a failed notice with a result paints the kept partial', painter.partialResultOf(newFailed) === 'three piers so far')
    check("a completed notice's result is a report, never a partial", painter.partialResultOf(completed) === null)
  }
  const launchMsg = assistantLaunch()
  const receiptsMsg = userReceipts()
  const resumedRow = createUserMessage({ content: '<task-notification>\n<task-id>agent-one</task-id>\n<tool-use-id>toolu_launch_one</tool-use-id>\n<status>resumed</status>\n<summary>Agent "one" resumed by itself</summary>\n</task-notification>' })
  const endedRow = createUserMessage({ content: '<task-notification>\n<task-id>agent-one</task-id>\n<tool-use-id>toolu_launch_one</tool-use-id>\n<status>completed</status>\n<summary>Agent "one" completed</summary>\n</task-notification>' })
  const orphansWithResumed = lr.orphanedBackgroundLaunches([launchMsg, receiptsMsg, resumedRow], new Set())
  const orphansWithEnd = lr.orphanedBackgroundLaunches([launchMsg, receiptsMsg, endedRow], new Set())
  check('a resume receipt row settles no launch (a restart during the resumed run still writes the death notice)', orphansWithResumed.some(o => o.agentId === 'agent-one'), JSON.stringify(orphansWithResumed.map(o => o.agentId)))
  check("…while the run's own terminal notice does settle it", !orphansWithEnd.some(o => o.agentId === 'agent-one'))
  const { buildAgentResultEnvelope } = await import('../../src/services/agentResults/normalize.ts')
  const failedEnvelope = await buildAgentResultEnvelope({ agentId: generateTaskId('local_agent'), agentType: 'mercury-general', status: 'failed', finalText: 'three piers so far', usage: { totalTokens: 1, toolUseCount: 1, durationMs: 1 } })
  const completedEnvelope = await buildAgentResultEnvelope({ agentId: generateTaskId('local_agent'), agentType: 'mercury-general', status: 'completed', finalText: 'four piers', usage: { totalTokens: 1, toolUseCount: 1, durationMs: 1 } })
  check('the envelope of a non-clean exit carries exactly the keys a finished one carries', JSON.stringify(Object.keys(failedEnvelope).sort()) === JSON.stringify(Object.keys(completedEnvelope).sort()), Object.keys(failedEnvelope).join(','))
  {
    const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
    const { getAgentTranscript } = await import('../../src/utils/sessionStorage/logs.ts')
    const { asAgentId } = await import('../../src/types/ids.ts')
    const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
    const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
    const { getSessionId } = await import('../../src/bootstrap/state.ts')
    const { mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')
    const old = generateTaskId('local_agent')
    const sessionId = String(getSessionId())
    let n = 900
    const encode = (e: unknown): string => JSON.stringify(entryToRecord(e as never, { sessionId, nextOrdinal: () => ordinalOf(++n), observedAt: '2026-01-01T00:00:00.000Z', source: { channel: 'interactive' } } as never))
    const rowsOld = [
      { type: 'user', uuid: '00000000-0000-4000-8000-0000000000d1', parentUuid: null, isSidechain: true, agentId: old, sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'old prompt' } },
      { type: 'assistant', uuid: '00000000-0000-4000-8000-0000000000d2', parentUuid: '00000000-0000-4000-8000-0000000000d1', isSidechain: true, agentId: old, sessionId, timestamp: '2026-01-01T00:00:00.000Z', message: { id: 'msg_old', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'old reply' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    const path = getAgentTranscriptPath(asAgentId(old))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, rowsOld.map(encode).join('\n') + '\n')
    const loaded = await getAgentTranscript(asAgentId(old))
    check('an old-shaped transcript reads its two rows unchanged', loaded !== null && loaded.messages.length === 2 && loaded.messages.map(m => m.type).join(',') === 'user,assistant')
  }
}

console.log(failures === 0 ? '\nprove-launch-receipts: ALL LAWS HOLD' : `\nprove-launch-receipts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
