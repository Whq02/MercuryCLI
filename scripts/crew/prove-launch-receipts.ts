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
        { type: 'tool_use', id: 'toolu_one', name: 'Agent', input: { description: 'harbour-count', prompt: 'switch-seat: count the harbour', subagent_type: 'general-purpose', run_in_background: true } },
        { type: 'tool_use', id: 'toolu_two', name: 'Agent', input: { description: 'lantern-index', prompt: 'switch-seat: index the lanterns', subagent_type: 'general-purpose', run_in_background: true } },
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
    message: { id: 'msg_fg', model: 'claude-fable-5-1', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'foreground-walk', prompt: 'walk', subagent_type: 'general-purpose' } }], usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, stop_reason: 'tool_use' },
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
check('each receipt carries the launch words: description, prompt, agent type, the launch clock', receipts[0]?.description === 'harbour-count' && receipts[0]?.prompt === 'switch-seat: count the harbour' && receipts[0]?.agentType === 'general-purpose' && Number.isFinite(receipts[0]?.launchedAt))
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
const FAKE_DEF = { agentType: 'general-purpose', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
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
  registerAsyncAgent({ agentId: id, description: 'once', prompt: 'count once', selectedAgent: FAKE_DEF, setAppState: store.set as never })
  completeAgentTask({ agentId: id }, store.set as never)
  enqueueAgentNotification({ taskId: id, description: 'once', status: 'completed', setAppState: store.set as never })
  enqueueAgentNotification({ taskId: id, description: 'once', status: 'completed', setAppState: store.set as never })
  check('a token-less notice still latches the row once', queue.getCommandQueue().filter(c => c.mode === 'task-notification').length === 1)
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
const META = { prompt: 'plant the foliage', resolvedAgentModel: 'gpt-5.6-sol', isBuiltInAgent: false, startTime: Date.now(), agentType: 'general-purpose', isAsync: true }
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

console.log(failures === 0 ? '\nprove-launch-receipts: ALL LAWS HOLD' : `\nprove-launch-receipts: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
