#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const homeRoot = process.env.MERCURY_CONFIG_DIR ?? join(tmpdir(), 'mw')
mkdirSync(homeRoot, { recursive: true })
const home = mkdtempSync(join(homeRoot, 'resume-by-name-'))
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
  console.log('\nTIMEOUT — the resume-by-name proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()
const ROOT = join(import.meta.dir, '..', '..')
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
await import('../../src/tasks.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { generateTaskId } = await import('../../src/Task.ts')
const { registerAsyncAgent, completeAgentTask, enqueueAgentNotification, killAsyncAgent, registerAgentName } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.js')
const { applyTaskOffsetsAndEvictions } = await import('../../src/utils/task/framework.ts')
const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const { AgentTool } = await import('../../src/tools/AgentTool/AgentTool.tsx')
const { getPrompt } = await import('../../src/tools/SendMessageTool/prompt.ts')
const lr = (await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')) as Record<string, unknown> & { BACKGROUND_LAUNCH_LINE: string }
const queue = await import('../../src/input-core/command-queue.ts')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { asAgentId, toAgentId } = await import('../../src/types/ids.ts')
const { entryToRecord } = await import('../../src/fabric/entryCodec.ts')
const { ordinalOf } = await import('../../src/fabric/ordinal.ts')
const { getSessionId } = await import('../../src/bootstrap/state.ts')
type Message = import('../../src/types/message.ts').Message
type AppState = import('../../src/state/AppStateStore.ts').AppState
type NamedReceipt = { toolUseId: string; agentId: string; name: string; description: string; launchedAt: number }
type Reader = (messages: readonly Message[]) => NamedReceipt[]
type ByName = (messages: readonly Message[], name: string) => NamedReceipt[]

const FAKE_DEF = { agentType: 'mercury-general', source: 'built-in', whenToUse: '', systemPrompt: '' } as never
type SendAnswer = { data: { success: boolean; message: string } }
type Store = { get: () => AppState; set: (u: (prev: AppState) => AppState) => void }
function makeStore(): Store {
  let st: AppState = getDefaultAppState()
  return { get: () => st, set: u => { st = u(st) } }
}
function makeCtx(store: Store, messages: Message[], team?: { teamName: string; leadAgentId: string }): never {
  return {
    getAppState: () => (team ? { ...store.get(), teamContext: team } : store.get()),
    setAppState: store.set,
    setAppStateForTasks: store.set,
    options: { tools: [] },
    abortController: new AbortController(),
    messages,
  } as never
}
const TODAY = (to: string): string => `Cannot deliver to "${to}": this session is not in a team and no in-process agent by that name exists, so the message would land in a default inbox nobody reads. Spawn a team first, or address a live subagent by name.`

let n = 0
const stamp = (): string => new Date(1_700_000_000_000 + ++n * 1000).toISOString()
const launchRow = (toolUseId: string, name: string | undefined, description: string): Message =>
  ({
    type: 'assistant',
    uuid: `a-${++n}`,
    timestamp: stamp(),
    requestId: undefined,
    message: {
      id: `msg_${toolUseId}`,
      model: 'claude-fable-5-1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, prompt: `work as ${description}`, subagent_type: 'mercury-general', run_in_background: true, ...(name !== undefined ? { name } : {}) } }],
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      stop_reason: 'tool_use',
    },
  }) as unknown as Message
const mintReceipt = (AgentTool as unknown as { mapToolResultToToolResultBlockParam: (o: unknown, id: string) => unknown }).mapToolResultToToolResultBlockParam
const receiptRow = (toolUseId: string, agentId: string, name: string | undefined, description: string): Message => {
  const block = mintReceipt({ isAsync: true, status: 'async_launched', agentId, description, prompt: `work as ${description}`, outputFile: join(home, `${agentId}.output`), canReadOutputFile: false, ...(name !== undefined ? { agentName: name } : {}) }, toolUseId)
  return { type: 'user', uuid: `u-${++n}`, timestamp: stamp(), message: { role: 'user', content: [block] } } as unknown as Message
}
const resultRow = (toolUseId: string, text: string): Message =>
  ({ type: 'user', uuid: `u-${++n}`, timestamp: stamp(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] } }) as unknown as Message
const textOf = (row: Message | undefined): string => {
  const content = (row as unknown as { message?: { content?: unknown } } | undefined)?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block => (block?.type === 'tool_result' && Array.isArray(block.content) ? block.content : [block]))
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
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
const launchNamed = (store: Store, transcript: Message[], name: string, description: string): string => {
  const id = generateTaskId('local_agent')
  const toolUseId = `toolu_${id}`
  registerAsyncAgent({ agentId: id, description, prompt: `work as ${description}`, selectedAgent: FAKE_DEF, setAppState: store.set as never })
  registerAgentName(name, id, store.set as never)
  transcript.push(launchRow(toolUseId, name, description), receiptRow(toolUseId, id, name, description))
  seedTranscript(id, `work as ${description}`, `${description}: done`)
  return id
}
const finishAndEvict = (store: Store, id: string, description: string): void => {
  completeAgentTask({ agentId: id }, store.set as never)
  enqueueAgentNotification({ taskId: id, description, status: 'completed', setAppState: store.set as never })
  store.set(prev => ({ ...prev, tasks: { ...prev.tasks, [id]: { ...prev.tasks[id], evictAfter: 0 } as never } }))
  applyTaskOffsetsAndEvictions(store.set as never, {}, [id])
  queue.resetCommandQueue()
}
const send = (ctx: never, to: string, message: unknown, requestId: string): Promise<SendAnswer> =>
  SendMessageTool.call({ to, message } as never, ctx, undefined as never, { requestId } as never) as Promise<SendAnswer>
const settleResumed = (store: Store, id: string): void => {
  killAsyncAgent(id, store.set as never)
  store.set(prev => {
    const tasks = { ...prev.tasks }
    delete tasks[id]
    return { ...prev, tasks }
  })
  queue.resetCommandQueue()
}
const rowOf = (store: Store, id: string): { status?: string; prompt?: string } | undefined => store.get().tasks[id] as { status?: string; prompt?: string } | undefined

console.log('============================================================')
console.log(' resume by name — a finished agent answers to its name as it answers to its id')
console.log('============================================================')

section('§1 THE FIXTURE — a named background launch: the registry holds the name while it runs; the sweep evicts the settled row AND prunes the name; the transcript stays on disk')
const store = makeStore()
const transcript: Message[] = []
const ctx = makeCtx(store, transcript)
const harbour = launchNamed(store, transcript, 'harbour-count', 'count the harbour')
check('the launch name is not an agent id, so only a name road can reach it', toAgentId('harbour-count') === null)
check('the registry routes the name to the launch while it runs', store.get().agentNameRegistry.get('harbour-count') === harbour)
const receiptWords = textOf(transcript[1])
check('the launch receipt the Agent tool minted promises both addresses: the id and the name', receiptWords.startsWith(lr.BACKGROUND_LAUNCH_LINE) && receiptWords.includes(`agentId: ${harbour}`) && receiptWords.includes('or to its name "harbour-count"'), receiptWords.slice(0, 300))
finishAndEvict(store, harbour, 'count the harbour')
check('once the settled row is evicted the registry no longer holds the name (the mechanism behind the defect)', store.get().tasks[harbour] === undefined && !store.get().agentNameRegistry.has('harbour-count'), JSON.stringify([...store.get().agentNameRegistry.entries()]))
check('…while its transcript stays on disk, the record the id road resumes from', existsSync(getAgentTranscriptPath(asAgentId(harbour))))

section('§2 THE ID ROAD (control) — a message to the finished agent\'s id resumes it from its transcript')
const byId = await send(ctx, harbour, 'a word for the harbour', 'req_id')
console.log(`  the answer: ${JSON.stringify(byId.data)}`)
check('the id road resumes the finished agent in the background', byId.data.success === true && /resumed in the background with your message/.test(byId.data.message), byId.data.message)
const rowById = rowOf(store, harbour)
check('…a fresh running row stands under the same id, its prompt the notice carrying the message', rowById?.status === 'running' && (rowById.prompt ?? '').includes('a word for the harbour'), JSON.stringify({ status: rowById?.status }))
settleResumed(store, harbour)

section('§3 THE PIN — the same message to the finished agent\'s NAME takes the resume road (RED on the base: the "spawn a team first" refusal)')
const byName = await send(ctx, 'harbour-count', 'a second word for the harbour', 'req_name')
console.log(`  the answer: ${JSON.stringify(byName.data)}`)
check('the name road resumes the finished agent exactly as the id road did', byName.data.success === true && /resumed in the background with your message/.test(byName.data.message), byName.data.message)
check('the words never say "spawn a team" for a name a finished agent carried', !/spawn a team/i.test(byName.data.message), byName.data.message)
check('the answer names the id the name resolved to', byName.data.message.includes(harbour), byName.data.message)
const rowByName = rowOf(store, harbour)
check('…the same outcome as the id road: a running row under the same id, its prompt the notice carrying the message', rowByName?.status === 'running' && (rowByName.prompt ?? '').includes('a second word for the harbour'), JSON.stringify({ status: rowByName?.status }))
settleResumed(store, harbour)

section('§4 A NAME NOBODY CARRIED, with agents in the session — the refusal names what it found and never says "spawn a team" (RED on the base)')
const lantern = launchNamed(store, transcript, 'lantern-index', 'index the lanterns')
const nobody = await send(ctx, 'nobody-here', 'anyone there', 'req_nobody')
console.log(`  the answer: ${JSON.stringify(nobody.data)}`)
check('the send is refused', nobody.data.success === false)
check('the refusal says no agent by that name is in this session', /no agent named nobody-here in this session/.test(nobody.data.message), nobody.data.message)
check('…names the finished agent by name', /finished agents are: [^;—]*harbour-count/.test(nobody.data.message), nobody.data.message)
check('…names the running agent by name', /running agents are: [^;—]*lantern-index/.test(nobody.data.message), nobody.data.message)
check('…and points at an id or one of those names, never at a team', /send to an id or one of those names/.test(nobody.data.message) && !/spawn a team/i.test(nobody.data.message), nobody.data.message)
check('the running launch is still reached by its name, as today (the live road is untouched)', (await send(ctx, 'lantern-index', 'keep going', 'req_live')).data.message.includes('Message delivered to agent lantern-index'))

section('§5 NOTHING LAUNCHED, NO TEAM — today\'s words stand (the one case that keeps them)')
{
  const bare = makeStore()
  const nothing = await send(makeCtx(bare, []), 'nobody-here', 'anyone there', 'req_nothing')
  check('a session that never launched a named agent and is in no team keeps the refusal it has today, verbatim', nothing.data.success === false && nothing.data.message === TODAY('nobody-here'), nothing.data.message)
}

section('§6 TWO FINISHED LAUNCHES WITH ONE NAME — the newest is resumed, and the answer says so (RED on the base)')
{
  const twin = makeStore()
  const twinTranscript: Message[] = []
  const twinCtx = makeCtx(twin, twinTranscript)
  const older = launchNamed(twin, twinTranscript, 'scout', 'scout the harbour')
  finishAndEvict(twin, older, 'scout the harbour')
  const newer = launchNamed(twin, twinTranscript, 'scout', 'scout the harbour again')
  finishAndEvict(twin, newer, 'scout the harbour again')
  check('both launches carried the name and both are evicted; the registry holds neither', older !== newer && !twin.get().agentNameRegistry.has('scout') && twin.get().tasks[older] === undefined && twin.get().tasks[newer] === undefined)
  const toScout = await send(twinCtx, 'scout', 'which of you', 'req_scout')
  console.log(`  the answer: ${JSON.stringify(toScout.data)}`)
  check('the newest launch is the one resumed', toScout.data.success === true && rowOf(twin, newer)?.status === 'running' && twin.get().tasks[older] === undefined, toScout.data.message)
  check('…and the answer says the name was carried by two launches and the newest was taken, naming its id', /newest of 2 launches/.test(toScout.data.message) && toScout.data.message.includes(newer), toScout.data.message)
  settleResumed(twin, newer)
  const cased = await send(twinCtx, 'SCOUT', 'which of you, loudly', 'req_scout_cased')
  check('a differently-cased spelling reaches the same launch when no exact name matches (the roster\'s own rule)', cased.data.success === true && rowOf(twin, newer)?.status === 'running', cased.data.message)
  settleResumed(twin, newer)
}

section('§7 A STRUCTURED MESSAGE to a finished agent\'s name outside a team — the refusal names the id and the plain-message resume, never "spawn a team" (RED on the base)')
{
  const question = await send(ctx, 'harbour-count', { type: 'question', content: 'still there?' }, 'req_q')
  console.log(`  the answer: ${JSON.stringify(question.data)}`)
  check('the question is refused: structured messages reach teammates only', question.data.success === false)
  check('…the refusal names the id and says a plain message to the name or the id resumes it', question.data.message.includes(harbour) && /plain message/.test(question.data.message) && /resume/.test(question.data.message) && !/spawn a team/i.test(question.data.message), question.data.message)
  const toId = await send(ctx, harbour, { type: 'question', content: 'still there?' }, 'req_q_id')
  check('…and the same words answer the id', toId.data.success === false && toId.data.message.includes(harbour) && !/spawn a team/i.test(toId.data.message), toId.data.message)
}

section('§8 THE TEAM ROAD UNTOUCHED — in a team the roster keeps its rules: a roster name is delivered to its inbox even when a finished launch carried it, a name nobody carried keeps the roster refusal, and only a finished launch no roster row names is resumed')
{
  const TEAM = 'resume-fixture-team'
  const teamDir = join(home, 'teams', TEAM)
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(join(teamDir, 'config.json'), JSON.stringify({ name: TEAM, createdAt: Date.now(), leadAgentId: 'lead-fixture', members: [
    { agentId: 'lead-fixture', name: 'team-lead', joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [] },
    { agentId: 'seat-1', name: 'harbour-count', joinedAt: 1, tmuxPaneId: '', cwd: home, subscriptions: [] },
  ] }))
  const crew = makeStore()
  const crewTranscript: Message[] = []
  const crewCtx = makeCtx(crew, crewTranscript, { teamName: TEAM, leadAgentId: 'lead-fixture' })
  const seat = launchNamed(crew, crewTranscript, 'harbour-count', 'count the harbour for the crew')
  finishAndEvict(crew, seat, 'count the harbour for the crew')
  const lone = launchNamed(crew, crewTranscript, 'lone-scout', 'scout alone')
  finishAndEvict(crew, lone, 'scout alone')
  const toSeat = await send(crewCtx, 'harbour-count', 'a crew word', 'req_crew_seat')
  check('a roster name goes to its inbox by the roster rules, even though a finished launch carried the same name', toSeat.data.success === true && /delivered to harbour-count's inbox/.test(toSeat.data.message) && crew.get().tasks[seat] === undefined, toSeat.data.message)
  const toNobody = await send(crewCtx, 'nobody-here', 'anyone there', 'req_crew_nobody')
  check('a name no launch carried keeps the roster refusal in the roster\'s own words', toNobody.data.success === false && /no such member on team "resume-fixture-team"/.test(toNobody.data.message), toNobody.data.message)
  const toLone = await send(crewCtx, 'lone-scout', 'a crew word for the scout', 'req_crew_lone')
  console.log(`  the answer: ${JSON.stringify(toLone.data)}`)
  check('a finished launch no roster row names is resumed from inside the team (RED on the base: the roster refusal)', toLone.data.success === true && /resumed in the background/.test(toLone.data.message) && rowOf(crew, lone)?.status === 'running', toLone.data.message)
  settleResumed(crew, lone)
}

section('§9 THE READER — the launch receipts by name, read-only, in transcript order')
{
  const reader = lr.namedLaunchReceipts as Reader | undefined
  const byName = lr.launchesNamed as ByName | undefined
  check('the launch-receipt module exports the read helpers (RED on the base)', typeof reader === 'function' && typeof byName === 'function')
  if (typeof reader === 'function' && typeof byName === 'function') {
    const rows: Message[] = [
      launchRow('toolu_named', 'harbour-count', 'count the harbour'),
      receiptRow('toolu_named', 'a0harbour1', 'harbour-count', 'count the harbour'),
      launchRow('toolu_unnamed', undefined, 'no name given'),
      receiptRow('toolu_unnamed', 'a0noname01', undefined, 'no name given'),
      launchRow('toolu_teammate', 'harbour-count', 'a teammate spawn'),
      resultRow('toolu_teammate', 'Teammate spawned. Agent id: seat-9, name: harbour-count, team: crew. The agent is running and will receive instructions through its mailbox.'),
      launchRow('toolu_fg', 'quiet-walk', 'a foreground walk'),
      resultRow('toolu_fg', 'the walk is done: three lanterns\nagentId: a0quietwalk (internal — do not mention it to the user). To continue this agent, use SendMessage addressed to that id.\nusage: 1 tool use'),
      launchRow('toolu_again', 'harbour-count', 'count the harbour again'),
      receiptRow('toolu_again', 'a0harbour2', 'harbour-count', 'count the harbour again'),
    ]
    const found = reader(rows)
    check('every launch that carried a name and whose result names an agent id is listed, in transcript order', found.map(r => `${r.name}=${r.agentId}`).join(' ') === 'harbour-count=a0harbour1 quiet-walk=a0quietwalk harbour-count=a0harbour2', JSON.stringify(found))
    check('a launch without a name is not listed', !found.some(r => r.agentId === 'a0noname01'))
    check('a teammate spawn (its receipt names no continuation id) is not listed — the team road keeps it', !found.some(r => r.agentId === 'seat-9'))
    check('a foreground completion pairs through the same continuation words', found.some(r => r.agentId === 'a0quietwalk' && r.name === 'quiet-walk' && r.description === 'a foreground walk'))
    check('the lookup by name returns the launches that carried it, oldest first, the newest last', byName(rows, 'harbour-count').map(r => r.agentId).join(' ') === 'a0harbour1 a0harbour2' && byName(rows, 'nobody').length === 0)
    check('the lookup matches the exact spelling first and falls back to a case-insensitive match', byName(rows, 'HARBOUR-COUNT').map(r => r.agentId).join(' ') === 'a0harbour1 a0harbour2')
    const agentTool = src('src/tools/AgentTool/AgentTool.tsx')
    check('the continuation words the reader pairs on are the Agent tool\'s own', agentTool.includes('`agentId: ${agentId} (internal — do not mention it to the user).'))
  }
}

section('§10 THE WORDS — the prompt tells the model a finished agent\'s name still reaches it (RED on the base)')
{
  const prompt = getPrompt()
  check('the prompt keeps the two-address sentence the receipts proof pins', prompt.includes('addressed by the id its launch receipt names, or by the name the launch gave it'))
  check('…and says the name reaches the agent after it has finished, the newest launch when two carried it', /running or finished/.test(prompt) && /newest/.test(prompt), prompt.split('\n').find(line => line.includes('launch receipt')) ?? '')
}

section('§11 THE SEAMS IN SOURCE')
{
  const sendSrc = src('src/tools/SendMessageTool/SendMessageTool.ts')
  const roadAt = sendSrc.indexOf('async function routeToLocalAgent(')
  const lookupAt = sendSrc.indexOf('launchesNamed(context.messages', roadAt)
  const giveUpAt = sendSrc.indexOf('if (agentId === undefined) return undefined', roadAt)
  check('the local-agent road reads the launch receipts by name before it gives up', roadAt > 0 && lookupAt > roadAt && giveUpAt > lookupAt)
  const noTeam = sendSrc.indexOf('if (!teamName) {')
  check('the no-team refusal is minted only after the session\'s launched agents are read', noTeam > 0 && /noTeamRefusal\(rawTo, context\)/.test(sendSrc.slice(noTeam, noTeam + 200)) && /function noTeamRefusal[\s\S]{0,200}knownLaunchedAgents\(context\)/.test(sendSrc))
  const receipts = src('src/tasks/LocalAgentTask/launchReceipts.ts')
  const helperAt = receipts.indexOf('export interface NamedLaunchReceipt')
  const helperEnd = receipts.indexOf('export function settledLaunchIds')
  const helper = helperAt >= 0 && helperEnd > helperAt ? receipts.slice(helperAt, helperEnd) : ''
  check('the read helper writes nothing: no state setter, no registry write (RED on the base: no helper)', helper.includes('export function launchesNamed') && !/setAppState|registerAgentName|writeFileSync/.test(helper))
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
