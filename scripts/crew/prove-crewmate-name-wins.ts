#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
const homeRoot = process.env.MERCURY_CONFIG_DIR ?? join(tmpdir(), 'mw')
mkdirSync(homeRoot, { recursive: true })
const home = mkdtempSync(join(homeRoot, 'crewmate-name-wins-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
let failures = 0
let checks = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the crewmate-name proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/tasks.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { generateTaskId } = await import('../../src/Task.ts')
const { registerAsyncAgent, completeAgentTask, enqueueAgentNotification, killAsyncAgent, registerAgentName } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { applyTaskOffsetsAndEvictions } = await import('../../src/utils/task/framework.ts')
const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const queue = await import('../../src/input-core/command-queue.ts')
const { getAgentTranscriptPath, getAgentMetadataPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { asAgentId } = await import('../../src/types/ids.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
const { liveMessagesFor } = await import('../../src/services/crew/liveComms.ts')
type Message = import('../../src/types/message.ts').Message
type AppState = import('../../src/state/AppStateStore.ts').AppState

const FAKE_DEF = { agentType: 'mercury-general', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
type SendAnswer = { data: { success: boolean; message: string; routing?: { target?: string } } }
type Store = { get: () => AppState; set: (u: (prev: AppState) => AppState) => void }
function makeStore(): Store {
  let st: AppState = getDefaultAppState()
  return { get: () => st, set: u => { st = u(st) } }
}
function makeCtx(store: Store, messages: Message[], crewCtx: { crewName: string; leadAgentId: string }): never {
  return {
    getAppState: () => ({ ...store.get(), crewContext: crewCtx }),
    setAppState: store.set,
    setAppStateForTasks: store.set,
    options: { tools: [] },
    abortController: new AbortController(),
    messages,
  } as never
}

let n = 0
const stamp = (): string => new Date(1_700_000_000_000 + ++n * 1000).toISOString()
const launchRow = (toolUseId: string, name: string, description: string): Message =>
  ({
    type: 'assistant',
    uuid: `a-${++n}`,
    timestamp: stamp(),
    requestId: undefined,
    message: {
      id: `msg_${toolUseId}`,
      model: 'claude-fable-5-1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, prompt: `work as ${description}`, subagent_type: 'mercury-general', run_in_background: true, name } }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'tool_use',
    },
  }) as unknown as Message
const mintReceipt = (AgentTool as unknown as { mapToolResultToToolResultBlockParam: (o: unknown, id: string) => unknown }).mapToolResultToToolResultBlockParam
const receiptRow = (toolUseId: string, agentId: string, name: string, description: string): Message => {
  const block = mintReceipt({ isAsync: true, status: 'async_launched', agentId, description, prompt: `work as ${description}`, outputFile: join(home, `${agentId}.output`), canReadOutputFile: false, agentName: name }, toolUseId)
  return { type: 'user', uuid: `u-${++n}`, timestamp: stamp(), message: { role: 'user', content: [block] } } as unknown as Message
}
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
const writeSidecar = (agentId: string, name: string, description: string, launchedAt: number): void => {
  const path = getAgentMetadataPath(asAgentId(agentId))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ agentType: 'mercury-general', description, model: 'claude-fable-5-1', name, launchedAt }))
}
const launchPlain = (store: Store, transcript: Message[], name: string, description: string, launchedAt: number): string => {
  const id = generateTaskId('local_agent')
  const toolUseId = `toolu_${id}`
  registerAsyncAgent({ agentId: id, description, prompt: `work as ${description}`, selectedAgent: FAKE_DEF, setAppState: store.set as never })
  registerAgentName(name, id, store.set as never)
  transcript.push(launchRow(toolUseId, name, description), receiptRow(toolUseId, id, name, description))
  seedTranscript(id, `work as ${description}`, `${description}: done`)
  writeSidecar(id, name, description, launchedAt)
  return id
}
const finish = (store: Store, id: string, description: string): void => {
  completeAgentTask({ agentId: id }, store.set as never)
  enqueueAgentNotification({ taskId: id, description, status: 'completed', setAppState: store.set as never })
  queue.resetCommandQueue()
}
const evict = (store: Store, id: string): void => {
  store.set(prev => ({ ...prev, tasks: { ...prev.tasks, [id]: { ...prev.tasks[id], evictAfter: 0 } as never } }))
  applyTaskOffsetsAndEvictions(store.set as never, {}, [id])
  queue.resetCommandQueue()
}
const send = (ctx: never, to: string, message: string, requestId: string): Promise<SendAnswer> =>
  SendMessageTool.call({ to, message } as never, ctx, undefined as never, { requestId } as never) as Promise<SendAnswer>
const rowOf = (store: Store, id: string): { status?: string } | undefined => store.get().tasks[id] as { status?: string } | undefined
const settleResumed = (store: Store, id: string): void => {
  killAsyncAgent(id, store.set as never)
  store.set(prev => {
    const tasks = { ...prev.tasks }
    delete tasks[id]
    return { ...prev, tasks }
  })
  queue.resetCommandQueue()
}
const inbox = async (crew: string, name: string): Promise<string[]> => {
  const rows = (await liveMessagesFor(crew, name).catch(() => [])) as Array<{ text?: string }>
  return rows.map(row => row.text ?? '')
}

const PLAIN_AT = Date.now() - 300_000
const CREW = 'name-wins-crew'
const crewDir = join(home, 'crews', CREW)
mkdirSync(crewDir, { recursive: true })
const roster = (members: Array<{ agentId: string; name: string; joinedAt: number }>): void => {
  writeFileSync(join(crewDir, 'config.json'), JSON.stringify({ name: CREW, createdAt: PLAIN_AT - 60_000, leadAgentId: 'lead-fixture', members: [
    { agentId: 'lead-fixture', name: 'crew-lead', joinedAt: PLAIN_AT - 60_000, tmuxPaneId: '', cwd: home, subscriptions: [] },
    ...members.map(m => ({ ...m, tmuxPaneId: '', cwd: home, subscriptions: [] })),
  ] }))
}

console.log('============================================================')
console.log(' a crewmate is reached by its name even when a plain sub-agent carried it earlier')
console.log('============================================================')

section('§1 THE FIXTURE — a plain sub-agent named alpha finished (its row still listed, its name still in the registry); then a crewmate alpha joined the roster')
const store = makeStore()
const transcript: Message[] = []
const ctx = makeCtx(store, transcript, { crewName: CREW, leadAgentId: 'lead-fixture' })
roster([])
const plain = launchPlain(store, transcript, 'alpha', 'reply done as a plain sub-agent', PLAIN_AT)
finish(store, plain, 'reply done as a plain sub-agent')
const plainStartedAt = (store.get().tasks[plain] as { startTime?: number } | undefined)?.startTime ?? Date.now()
check('the plain sub-agent finished and its row is still listed', rowOf(store, plain)?.status === 'completed', JSON.stringify(rowOf(store, plain)))
check('the registry still routes the name to the finished plain sub-agent (the rung that answered first)', store.get().agentNameRegistry.get('alpha') === plain)
const crewmateJoinedAt = plainStartedAt + 30_000
roster([{ agentId: 'seat-alpha', name: 'alpha', joinedAt: crewmateJoinedAt }])
check('the crewmate alpha is on the roster, the newer launch of the name (its join clock after the plain row\'s start)', crewmateJoinedAt > plainStartedAt && crewmateJoinedAt > PLAIN_AT, `${crewmateJoinedAt} vs ${plainStartedAt}`)

section('§2 THE PIN — a message to alpha reaches the crewmate, and the plain sub-agent is not resumed (RED on the base: the registry row wins)')
const first = await send(ctx, 'alpha', 'ping for the crewmate', 'req_name_1')
console.log(`  the answer: ${JSON.stringify(first.data)}`)
check('the reply says the message went to the crewmate\'s inbox', first.data.success === true && /delivered to alpha's inbox/.test(first.data.message) && first.data.routing?.target === '@alpha', first.data.message)
check('…and never that a finished agent was resumed', !/resumed/.test(first.data.message), first.data.message)
check('the plain sub-agent was NOT resumed — its row still reads completed', rowOf(store, plain)?.status === 'completed', JSON.stringify(rowOf(store, plain)))
const rows = await inbox(CREW, 'alpha')
check('the crewmate\'s inbox carries the message', rows.some(text => text.includes('ping for the crewmate')), JSON.stringify(rows).slice(0, 300))

section('§3 THE ROW LEFT THE LIST — the finished plain sub-agent evicted, its launch still recorded on disk: the crewmate still wins')
evict(store, plain)
check('the row is gone and the registry no longer holds the name (the next rung is the recorded launch)', rowOf(store, plain) === undefined && !store.get().agentNameRegistry.has('alpha'))
const second = await send(ctx, 'alpha', 'second ping', 'req_name_2')
console.log(`  the answer: ${JSON.stringify(second.data)}`)
check('the message still reaches the crewmate\'s inbox', second.data.success === true && /delivered to alpha's inbox/.test(second.data.message), second.data.message)
check('the plain sub-agent was not resumed from its transcript', rowOf(store, plain) === undefined, JSON.stringify(rowOf(store, plain)))

section('§4 THE OTHER ORDER — a plain sub-agent launched AFTER the crewmate left the roster is the newest, and a message to its name resumes it, as the law says')
roster([])
const late = launchPlain(store, transcript, 'alpha', 'a later plain launch', Date.now())
finish(store, late, 'a later plain launch')
const third = await send(ctx, 'alpha', 'a word for the later launch', 'req_name_3')
console.log(`  the answer: ${JSON.stringify(third.data)}`)
check('with no crewmate of the name on the roster, the finished plain sub-agent is resumed with the message', third.data.success === true && /resumed in the background/.test(third.data.message) && rowOf(store, late)?.status === 'running', third.data.message)
settleResumed(store, late)

section('§4b TWO LIVE — a plain sub-agent still RUNNING under the name, launched after the crewmate joined, is the newest launch and takes the message; one launched before it does not')
{
  const seat = Date.now() - 200_000
  roster([{ agentId: 'seat-alpha', name: 'alpha', joinedAt: seat }])
  const older = launchPlain(store, transcript, 'alpha', 'an older plain launch still running', seat - 60_000)
  store.set(prev => ({ ...prev, tasks: { ...prev.tasks, [older]: { ...prev.tasks[older], startTime: seat - 60_000 } as never } }))
  const toOlder = await send(ctx, 'alpha', 'a word while both live', 'req_name_4')
  console.log(`  the answer: ${JSON.stringify(toOlder.data)}`)
  check('a running plain sub-agent launched BEFORE the crewmate joined loses the name: the crewmate takes the message', toOlder.data.success === true && /delivered to alpha's inbox/.test(toOlder.data.message), toOlder.data.message)
  store.set(prev => ({ ...prev, tasks: { ...prev.tasks, [older]: { ...prev.tasks[older], startTime: seat + 60_000 } as never } }))
  const toNewer = await send(ctx, 'alpha', 'a word for the newest', 'req_name_5')
  console.log(`  the answer: ${JSON.stringify(toNewer.data)}`)
  check('a running plain sub-agent launched AFTER the crewmate joined is the newest launch and takes the message', toNewer.data.success === true && /delivered to agent alpha/.test(toNewer.data.message) && !/inbox/.test(toNewer.data.message), toNewer.data.message)
  settleResumed(store, older)
  roster([])
}

section('§5 THE WORDS — the tool\'s prompt says a live crewmate wins the name over a finished sub-agent')
const promptSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'SendMessageTool', 'prompt.ts'), 'utf8')
check('the prompt names the rule (RED on the base)', /crewmate[^\n]*wins|newest launch[^\n]*crewmate|crewmate on the roster[^\n]*reaches/i.test(promptSrc), 'no sentence about a crewmate winning the name')

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
