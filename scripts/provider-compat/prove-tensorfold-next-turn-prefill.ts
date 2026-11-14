#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { untilAsync } from '../lib/untilAsync.ts'
import { foldTokens, startTensorFoldPromptFixture, type FoldReply, type FoldRequest, type FoldRow, type FoldTemplate, type TensorFoldPromptFixture, type TensorFoldPromptFixtureOptions } from './tensorfoldPromptFixture.ts'

const HOME = mkdtempSync(join(tmpdir(), 'tensorfold-next-turn-prefill-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_NEXT_TURN_PREFILL
delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { setEngineModelOverride } = await import('../../src/bootstrap/state.ts')
const { runCleanupFunctions } = await import('../../src/utils/cleanupRegistry.ts')
const usageLedger = await import('../../src/services/providers/local/tensorfoldUsage.ts')
const { stopTensorFold } = await import('../../src/services/tensorfold/serve.ts')
type Prefill = typeof import('../../src/services/providers/local/tensorfoldPrefill.ts')
const prefill = (await import('../../src/services/providers/local/tensorfoldPrefill.ts').catch(() => undefined)) as Prefill | undefined
type LocalModelRecord = import('../../src/services/providers/local/localDiscovery.ts').LocalModelRecord
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

const READ = FileReadTool.name
const SETTLE_MS = 15
const LOOK_MS = 20
const fileOf = (lines: number): string => Array.from({ length: lines }, (_, n) => `${n + 1}\tledger line ${n + 1}: a delivery of ${(n * 37) % 91} crates to bay ${(n * 13) % 17}`).join('\n')
const FILE = `${fileOf(40)}\n41\tThe number is 42.`
const callFor = (path: string): FoldReply => ({ reasoning: `The user wants the number in ${path}. I should read the file first.`, call: { name: READ, arguments: { file_path: path } } })
const ANSWER: FoldReply = { reasoning: 'Line 41 states the number.', text: 'The number is 42.' }
const NEXT = 'And what is that number doubled?'
const seed = (): string => prefill?.NEXT_TURN_SEED ?? 'ok'
const tail = (): number => foldTokens(`${seed()}<|im_end|>\n<|im_start|>assistant\n<think>\n`).length
const newMessage = foldTokens(`${NEXT}<|im_end|>\n<|im_start|>assistant\n<think>\n`).length

type Source = { querySource: string; agentId?: string; effort?: string; signal?: AbortSignal }
const MAIN: Source = { querySource: 'sdk' }
async function ask(record: LocalModelRecord, messages: unknown[], source: Source = MAIN): Promise<AssistantMessage[]> {
  const minted: AssistantMessage[] = []
  for await (const item of localCallModel({
    messages: messages as never,
    systemPrompt: ['You are a careful assistant in a terminal. A file is read before it is described.'] as never,
    thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
    tools: [FileReadTool] as never,
    signal: source.signal ?? new AbortController().signal,
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: `local/${record.id}`, isNonInteractiveSession: true, querySource: source.querySource, ...(source.agentId !== undefined ? { agentId: source.agentId } : {}), agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: source.effort ?? 'high' } as never,
  })) {
    if ((item as { type?: string }).type === 'assistant' && (item as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true) minted.push(item as AssistantMessage)
  }
  return minted
}

type World = { fixture: TensorFoldPromptFixture; record: LocalModelRecord; history: unknown[] }
type Engine = Partial<Omit<TensorFoldPromptFixtureOptions, 'model' | 'template' | 'capabilities'>>
async function world(template: FoldTemplate, capabilities: Record<string, boolean> | undefined, engine: Engine = {}, model = 'qwen3.5-2b'): Promise<World | undefined> {
  prefill?.__resetNextTurnPrefillForTest()
  prefill?.__setNextTurnPrefillIoForTest({ settleMs: SETTLE_MS, lookMs: LOOK_MS })
  usageLedger.__resetTensorFoldUsageForTest()
  const fixture = startTensorFoldPromptFixture({ model, template, ...(capabilities !== undefined ? { capabilities } : {}), ...engine })
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `tensorfold=${fixture.root}`
  await refreshLocalDiscovery({ force: true })
  const record = localRecordFor(`local/${model}`)
  if (record === undefined || record.server !== 'tensorfold') {
    fixture.stop()
    return undefined
  }
  setEngineModelOverride(`local/${model}`)
  return { fixture, record, history: [] }
}
async function callStep(w: World, path = '/work/alpha.txt', result = FILE, source: Source = MAIN, question = true): Promise<void> {
  if (question) w.history = [...w.history, createUserMessage({ content: `Read ${path} and tell me the number it holds.` })]
  w.fixture.reply(callFor(path))
  const minted = await ask(w.record, w.history, source)
  const use = minted.flatMap(row => row.message.content as Array<{ type: string; id?: string }>).find(block => block.type === 'tool_use')?.id
  w.history = [...w.history, ...minted, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: use, content: result }] as never })]
}
async function answerStep(w: World, source: Source = MAIN): Promise<void> {
  w.fixture.reply(ANSWER)
  w.history = [...w.history, ...(await ask(w.record, w.history, source))]
}
async function toolTurn(w: World, source: Source = MAIN, calls = 1): Promise<void> {
  for (let n = 0; n < calls; n++) await callStep(w, `/work/file${n + 1}.txt`, FILE, source, n === 0)
  await answerStep(w, source)
}
async function nextTurn(w: World): Promise<FoldRequest | undefined> {
  w.history = [...w.history, createUserMessage({ content: NEXT })]
  w.fixture.reply({ reasoning: '42 doubled is 84.', text: '84' })
  w.history = [...w.history, ...(await ask(w.record, w.history))]
  return real(w).at(-1)
}
const another = (w: World): Promise<number> => {
  const started = Date.now()
  return fetch(`${w.fixture.root}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: w.fixture.model, stream: true, messages: [{ role: 'user', content: 'another session asks' }] }) })
    .then(answer => answer.text())
    .then(() => Date.now() - started)
}
const ahead = (w: World): FoldRequest[] => w.fixture.requests.filter(request => request.background)
const real = (w: World): FoldRequest[] => w.fixture.requests.filter(request => !request.background)
const facts = (): ReturnType<Prefill['nextTurnPrefillFacts']> | undefined => prefill?.nextTurnPrefillFacts()
const settled = (count = 1): Promise<boolean> => untilAsync(() => (facts()?.completed ?? 0) >= count, 2000, 5)
const quiet = (ms = 120): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const rowsEqual = (a: readonly FoldRow[], b: readonly FoldRow[]): boolean => JSON.stringify(a) === JSON.stringify(b)
const CAPABLE = { prompt_cache: true, warm_turns: false }

section('1 · an engine that keeps prompt states and does not read the next turn ahead itself: Mercury sends the conversation as the next request will begin, and that request resumes whole')
{
  const w = await world('after-last-user', CAPABLE)
  check('the fixture is discovered as a TensorFold record that keeps prompt states and does not warm the next turn', w?.record.promptCache === true && w.record.warmTurns === false, JSON.stringify(w?.record))
  if (w !== undefined) {
    await toolTurn(w)
    const read = await settled()
    const sentAhead = ahead(w)
    check('after the reply that ends the turn one request reaches the engine that no turn asked for', read && sentAhead.length === 1, `${sentAhead.length} request(s), facts ${JSON.stringify(facts())}`)
    check('it is a background request that asks for eight tokens at most and one of thinking, where the turn\'s own requests carry a thinking budget', sentAhead.length === 1 && sentAhead[0]!.maxTokens === 8 && sentAhead[0]!.thinkingBudget === 1 && (real(w).at(-1)?.thinkingBudget ?? 0) > 1, JSON.stringify(w.fixture.requests.map(request => [request.background, request.maxTokens, request.thinkingBudget])))
    const whole = sentAhead.at(-1)
    const lastReal = real(w).at(-1)
    const opening = whole?.rows.slice(0, -1) ?? []
    check('its rows are the last request\'s rows, then the reply as one assistant row with its reasoning, then one user row', whole !== undefined && lastReal !== undefined && rowsEqual(opening.slice(0, lastReal.rows.length), lastReal.rows) && opening.length === lastReal.rows.length + 1 && opening.at(-1)?.role === 'assistant' && opening.at(-1)?.content === ANSWER.text && opening.at(-1)?.reasoning_content === ANSWER.reasoning && whole.rows.at(-1)?.role === 'user' && whole.rows.at(-1)?.content === seed(), JSON.stringify(whole?.rows.slice(-2)))
    const next = await nextTurn(w)
    check('the next turn\'s first request begins with exactly the rows that were read ahead', next !== undefined && rowsEqual(next.rows.slice(0, opening.length), opening) && next.rows.length === opening.length + 1, `${next?.rows.length} rows against ${opening.length}`)
    const unread = next === undefined ? -1 : next.promptTokens - next.cachedTokens
    check('the engine reads only the new message: every token before it is resumed (the turn before was read again here: 92 of 1,239 resumed)', next !== undefined && unread <= newMessage, `${next?.cachedTokens} of ${next?.promptTokens} resumed, ${unread} read, the new message is ${newMessage}`)
    check('Mercury\'s usage reading holds the three requests of the conversation and none of the read-ahead', usageLedger.tensorFoldTurnReadings().length === 3 && real(w).length === 3 && ahead(w).length >= 1, `${usageLedger.tensorFoldTurnReadings().length} readings, ${real(w).length} requests, ${ahead(w).length} read ahead`)
    w.fixture.stop()
  }
  const plain = await world('after-last-user', CAPABLE)
  if (plain !== undefined) {
    await toolTurn(plain, { querySource: 'sdk', effort: 'low' })
    await settled()
    const sentAhead = ahead(plain)
    check('where the turn\'s requests carry no thinking budget it asks for one token and names none', sentAhead.length === 1 && sentAhead[0]!.maxTokens === 1 && sentAhead[0]!.thinkingBudget === undefined && real(plain).every(request => request.thinkingBudget === undefined), JSON.stringify(plain.fixture.requests.map(request => [request.background, request.maxTokens, request.thinkingBudget])))
    plain.fixture.stop()
  }
}

section('2 · never in the way: it waits for the session to be idle on that engine, stops the moment a request of the session needs it, and leaves the engine to any other request')
{
  const w = await world('after-last-user', CAPABLE)
  if (w !== undefined) {
    w.fixture.holdBackground(1500)
    await toolTurn(w)
    const flying = await untilAsync(() => w.fixture.waiting() === 1, 2000, 5)
    check('the read-ahead is in flight once the turn has ended', flying, JSON.stringify(facts()))
    const started = Date.now()
    await nextTurn(w)
    const took = Date.now() - started
    const cut = await untilAsync(() => ahead(w).some(request => request.aborted), 1000, 5)
    check('a request of the session stops it: the engine sees that request go away', cut && facts()?.cut === 1, JSON.stringify(ahead(w).map(request => request.aborted)))
    check('the request itself does not wait for it', took < 1000, `${took} ms beside a read-ahead held for 1,500 ms`)
    check('and the turn that message began is read ahead in its turn', await untilAsync(() => ahead(w).length === 2 && w.fixture.waiting() === 1, 2000, 5), `${ahead(w).length} background request(s)`)
    w.fixture.stop()
  }
  const slow = await world('after-last-user', CAPABLE, { letsGoAfterMs: 400 })
  if (slow !== undefined) {
    prefill?.__setNextTurnPrefillIoForTest({ settleMs: SETTLE_MS, lookMs: LOOK_MS, slowCutMs: 80 })
    slow.fixture.holdBackground(1500)
    await toolTurn(slow)
    await untilAsync(() => slow.fixture.waiting() === 1, 2000, 5)
    slow.fixture.holdBackground(0)
    const started = Date.now()
    await nextTurn(slow)
    const took = Date.now() - started
    await quiet(200)
    slow.history = [...slow.history, createUserMessage({ content: 'Read it once more.' })]
    await callStep(slow, '/work/again.txt', FILE, MAIN, false)
    await answerStep(slow)
    await quiet(200)
    check('an engine that keeps a request of the session waiting behind a dropped read-ahead longer than the limit: that request waits once, and nothing is read ahead on that engine again in the session', took >= 350 && ahead(slow).length === 1 && ahead(slow)[0]!.aborted && real(slow).length === 5 && facts()?.slowed === 1, `the request took ${took} ms, ${ahead(slow).length} background request(s), ${real(slow).length} real, facts ${JSON.stringify(facts())}`)
    slow.fixture.stop()
  }
  const busy = await world('after-last-user', CAPABLE)
  if (busy !== undefined) {
    busy.fixture.holdNext(400)
    busy.fixture.reply({ reasoning: 'A crewmate thinks.', text: 'a crewmate answers' })
    const crewmate = ask(busy.record, [createUserMessage({ content: 'a crewmate\'s own question' })], { querySource: 'agent:custom', agentId: 'crewmate-1' })
    await untilAsync(() => busy.fixture.waiting() === 1, 1000, 5)
    await toolTurn(busy)
    await quiet()
    check('while a crewmate\'s request is in flight on the engine nothing is read ahead', ahead(busy).length === 0 && busy.fixture.waiting() === 1, `${ahead(busy).length} background request(s)`)
    await crewmate
    check('once it has ended the read-ahead starts', (await settled()) && ahead(busy).length >= 1, JSON.stringify(facts()))
    busy.fixture.stop()
  }
  const taken = await world('after-last-user', CAPABLE)
  if (taken !== undefined) {
    await callStep(taken)
    taken.fixture.holdNext(400)
    const other = another(taken)
    await untilAsync(() => taken.fixture.waiting() === 1, 1000, 5)
    await answerStep(taken)
    await other
    await quiet()
    check('while another session\'s request is on the engine nothing is read ahead, and that turn is left as it is', ahead(taken).length === 0 && facts()?.yielded === 1 && facts()?.started === 1, `${ahead(taken).length} background request(s), facts ${JSON.stringify(facts())}`)
    taken.fixture.stop()
  }
  const joined = await world('after-last-user', CAPABLE)
  if (joined !== undefined) {
    joined.fixture.holdBackground(1500)
    await toolTurn(joined)
    await untilAsync(() => joined.fixture.waiting() === 1, 2000, 5)
    joined.fixture.holdNext(300)
    const other = another(joined)
    const left = await untilAsync(() => ahead(joined).some(request => request.aborted), 1000, 5)
    const waited = await other
    check('another session\'s request that arrives while a read-ahead is in flight makes it go away', left && facts()?.yielded === 1 && facts()?.cut === 0, `facts ${JSON.stringify(facts())}`)
    check('that request is answered in its own time', waited < 1000, `${waited} ms for a request held 300 ms, beside a read-ahead held for 1,500 ms`)
    await quiet()
    check('and the read-ahead is not sent again behind it', ahead(joined).length === 1, `${ahead(joined).length} background request(s)`)
    joined.fixture.stop()
  }
}

section('3 · not where it would be wasted or wrong')
{
  const none = async (label: string, capabilities: Record<string, boolean> | undefined, arrange: (w: World) => void | Promise<void> = () => {}, source: Source = MAIN, engine: Engine = {}): Promise<void> => {
    const w = await world('after-last-user', capabilities, engine)
    if (w === undefined) return check(label, false, 'no TensorFold record')
    await arrange(w)
    await toolTurn(w, source)
    await quiet()
    check(label, ahead(w).length === 0 && real(w).length === 2, `${ahead(w).length} background request(s), ${real(w).length} real`)
    w.fixture.stop()
  }
  await none('an engine that reads the next turn ahead itself (warm_turns true)', { prompt_cache: true, warm_turns: true })
  await none('an engine that keeps no prompt states (prompt_cache false)', { prompt_cache: false, warm_turns: false })
  await none('an engine that does not say (no capability bits)', undefined)
  await none('an engine that does not show how many requests it has (no live block on /health)', CAPABLE, () => {}, MAIN, { showsLoad: false })
  process.env.MERCURY_LOCAL_NEXT_TURN_PREFILL = '0'
  await none('the switch off (MERCURY_LOCAL_NEXT_TURN_PREFILL=0)', CAPABLE)
  delete process.env.MERCURY_LOCAL_NEXT_TURN_PREFILL
  await none('a crewmate\'s conversation', CAPABLE, () => {}, { querySource: 'agent:custom', agentId: 'crewmate-1' })
  process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE = '1'
  await none('a conversation that is due a fold', CAPABLE)
  delete process.env.MERCURY_AUTOCOMPACT_PCT_OVERRIDE

  const calls = await world('after-last-user', CAPABLE)
  if (calls !== undefined) {
    await callStep(calls)
    await quiet()
    check('a reply that ends in a tool call (the turn goes on)', ahead(calls).length === 0, `${ahead(calls).length} background request(s)`)
    calls.fixture.stop()
  }
  const interrupted = await world('after-last-user', CAPABLE)
  if (interrupted !== undefined) {
    await callStep(interrupted)
    interrupted.fixture.holdNext(400)
    const stop = new AbortController()
    const answering = answerStep(interrupted, { querySource: 'sdk', signal: stop.signal }).catch(() => undefined)
    await untilAsync(() => interrupted.fixture.waiting() === 1, 1000, 5)
    stop.abort()
    await answering
    await quiet()
    check('a reply the user interrupted', ahead(interrupted).length === 0 && facts()?.offered === 0, `${ahead(interrupted).length} background request(s), facts ${JSON.stringify(facts())}`)
    interrupted.fixture.stop()
  }
  const switched = await world('after-last-user', CAPABLE)
  if (switched !== undefined) {
    switched.fixture.holdBackground(1500)
    await toolTurn(switched)
    await untilAsync(() => switched.fixture.waiting() === 1, 2000, 5)
    setEngineModelOverride('claude-opus-4-8')
    check('a model switch stops it', await untilAsync(() => ahead(switched).some(request => request.aborted), 1000, 5), JSON.stringify(facts()))
    switched.fixture.stop()
  }
  const ending = await world('after-last-user', CAPABLE)
  if (ending !== undefined) {
    ending.fixture.holdBackground(1500)
    await toolTurn(ending)
    await untilAsync(() => ending.fixture.waiting() === 1, 2000, 5)
    await runCleanupFunctions().catch(() => undefined)
    check('the session ending stops it', await untilAsync(() => ahead(ending).some(request => request.aborted), 1000, 5), JSON.stringify(facts()))
    ending.fixture.stop()
  }
  const stopping = await world('after-last-user', CAPABLE)
  if (stopping !== undefined) {
    stopping.fixture.holdBackground(1500)
    await toolTurn(stopping)
    await untilAsync(() => stopping.fixture.waiting() === 1, 2000, 5)
    const servedFile = join(HOME, 'served-for-the-stop.json')
    writeFileSync(servedFile, JSON.stringify({ name: stopping.record.id, repo: 'mlx-community/Qwen3.5-2B-MLX-4bit', port: Number(new URL(stopping.fixture.root).port), project: join(HOME, 'no-project') }))
    await stopTensorFold(stopping.record.id, { servedFile, forgetPort: () => {}, forgetHost: async () => {} }).catch(() => undefined)
    check('stopping the engine from Mercury ends it first, so the engine has nothing of it to finish', await untilAsync(() => ahead(stopping).some(request => request.aborted), 1000, 5) && facts()?.cut === 1, JSON.stringify(facts()))
    stopping.fixture.stop()
  }
  const folding = await world('after-last-user', CAPABLE)
  if (folding !== undefined) {
    folding.fixture.holdBackground(1500)
    await toolTurn(folding)
    await untilAsync(() => folding.fixture.waiting() === 1, 2000, 5)
    folding.fixture.holdBackground(0)
    folding.fixture.reply({ text: 'a summary' })
    await ask(folding.record, [...folding.history, createUserMessage({ content: 'Summarise the conversation.' })], { querySource: 'compact' })
    const before = ahead(folding).length
    await quiet()
    check('a fold stops it, and the conversation it read is not read ahead again', ahead(folding).some(request => request.aborted) && ahead(folding).length === before, `${before} then ${ahead(folding).length}`)
    folding.fixture.stop()
  }
  const far: LocalModelRecord = { id: 'qwen3.5-2b', server: 'tensorfold', baseUrl: 'http://192.168.4.20:8000/v1', promptCache: true, warmTurns: false, toolsDeclared: true }
  const near: LocalModelRecord = { ...far, baseUrl: 'http://127.0.0.1:8000/v1' }
  const main = { querySource: 'sdk', model: 'local/qwen3.5-2b' } as never
  check('an engine on another machine is left alone, the same engine on this one is not', prefill !== undefined && !prefill.nextTurnPrefillApplies(far, main) && prefill.nextTurnPrefillApplies(near, main))
  check('an Ollama, a llama.cpp, an LM Studio and a vLLM record are left alone', prefill !== undefined && (['ollama', 'llamacpp', 'lmstudio', 'vllm'] as const).every(server => !prefill.nextTurnPrefillApplies({ ...near, server }, main)))
}

section('4 · a long turn is read ahead in pieces that each end on a reply, so a message that comes early still finds the pieces before it')
{
  const result = foldTokens(FILE).length
  const staged = async (engine: Engine): Promise<World | undefined> => {
    const w = await world('after-last-user', CAPABLE, engine)
    prefill?.__setNextTurnPrefillIoForTest({ settleMs: SETTLE_MS, lookMs: LOOK_MS, tokensPerSecond: 60 })
    return w
  }
  const w = await staged({})
  if (w !== undefined) {
    await toolTurn(w, MAIN, 3)
    await settled()
    const stages = ahead(w)
    check('a turn of three tool calls, each result larger than one piece, goes out as three requests', stages.length === 3, `${stages.length} request(s), facts ${JSON.stringify(facts())}`)
    check('each ends on a reply of the turn and then the one user row: none inside a tool result, none between a result and the reply to it', stages.length > 0 && stages.every(request => request.rows.at(-1)?.role === 'user' && request.rows.at(-1)?.content === seed() && request.rows.at(-2)?.role === 'assistant'), JSON.stringify(stages.map(request => request.rows.slice(-2).map(row => row.role))))
    check('the last is the whole conversation, with the reply that ended the turn', stages.at(-1)?.rows.at(-2)?.content === ANSWER.text && stages.slice(0, -1).every(request => (request.rows.at(-2)?.tool_calls?.length ?? 0) > 0), '')
    check('each reads further than the one before it', stages.length > 1 && stages.every((request, index) => index === 0 || request.promptTokens > stages[index - 1]!.promptTokens), JSON.stringify(stages.map(request => request.promptTokens)))
    check('each resumes where the one before it ended: only the one user row is read twice', stages.length > 1 && stages.every((request, index) => index === 0 || stages[index - 1]!.promptTokens - request.cachedTokens <= tail()), JSON.stringify(stages.map(request => [request.promptTokens, request.cachedTokens])))
    const next = await nextTurn(w)
    check('the next turn resumes everything before its own message', next !== undefined && next.promptTokens - next.cachedTokens <= newMessage, `${next?.cachedTokens} of ${next?.promptTokens}`)
    w.fixture.stop()
  }
  const early = await staged({})
  if (early !== undefined) {
    early.fixture.holdBackground(1500, 3)
    await toolTurn(early, MAIN, 3)
    await untilAsync(() => early.fixture.waiting() === 1 && ahead(early).length === 3, 2000, 5)
    const pieces = ahead(early)
    const next = await nextTurn(early)
    check('a message that comes while the last piece is in flight resumes at the piece before it, and reads the one result after it', next !== undefined && pieces.length === 3 && pieces[2]!.aborted && next.cachedTokens >= pieces[1]!.promptTokens - tail() && next.promptTokens - next.cachedTokens < 2 * result, `${next?.cachedTokens} of ${next?.promptTokens} resumed, the piece before read to ${pieces[1]?.promptTokens}, a result is ${result} tokens, ${pieces.length} piece(s) sent`)
    early.fixture.stop()
  }
  const paused = await staged({})
  if (paused !== undefined) {
    paused.fixture.holdBackground(1500, 2)
    await toolTurn(paused, MAIN, 3)
    await untilAsync(() => paused.fixture.waiting() === 1 && ahead(paused).length === 2, 2000, 5)
    paused.fixture.holdBackground(0)
    paused.fixture.reply({ reasoning: 'A crewmate thinks.', text: 'a crewmate answers' })
    await ask(paused.record, [createUserMessage({ content: 'a crewmate\'s own question' })], { querySource: 'agent:custom', agentId: 'crewmate-1' })
    const done = await settled()
    const sent = ahead(paused)
    check('a crewmate\'s request stops the piece in flight, and once it has ended the read-ahead goes on from that piece: the piece before it is not sent again', done && sent.length === 4 && sent[1]!.aborted && !sent[2]!.aborted && sent[2]!.rows.length === sent[1]!.rows.length && sent.filter(request => request.rows.length === sent[0]!.rows.length).length === 1, JSON.stringify(sent.map(request => [request.rows.length, request.aborted])))
    paused.fixture.stop()
  }
  const coarse = await staged({ resumesAt: 'reply-starts' })
  if (coarse !== undefined) {
    await toolTurn(coarse, MAIN, 3)
    await settled()
    const stages = ahead(coarse)
    check('on an engine that resumes only where a reply starts, each piece resumes at the reply the piece before it ended on: no tool result is read twice', stages.length === 3 && stages.every((request, index) => index === 0 || stages[index - 1]!.promptTokens - request.cachedTokens < result / 2), `a result is ${result} tokens; ${JSON.stringify(stages.map(request => [request.promptTokens, request.cachedTokens]))}`)
    const next = await nextTurn(coarse)
    check('and the next turn reads the reply that ended the turn and its own message, no tool result', next !== undefined && next.promptTokens - next.cachedTokens < result / 2, `${next?.cachedTokens} of ${next?.promptTokens}`)
    coarse.fixture.stop()
  }
  const strict = await staged({ refusesOpenCalls: true })
  if (strict !== undefined) {
    await toolTurn(strict, MAIN, 3)
    await settled()
    const first = ahead(strict)
    check('an engine whose template refuses a tool call without its result: the first piece is refused and the conversation goes out whole at once', first.length === 2 && first[0]!.refused && !first[1]!.refused && first[1]!.rows.at(-2)?.content === ANSWER.text, JSON.stringify(first.map(request => [request.refused, request.rows.length])))
    strict.history = [...strict.history, createUserMessage({ content: 'Read them once more.' })]
    for (let n = 0; n < 3; n++) await callStep(strict, `/work/again${n + 1}.txt`, FILE, MAIN, false)
    await answerStep(strict)
    await settled(2)
    check('and no later turn on that engine is cut in pieces', ahead(strict).length === 3 && !ahead(strict).at(-1)!.refused, JSON.stringify(ahead(strict).map(request => [request.refused, request.rows.length])))
    strict.fixture.stop()
  }
  const rows: FoldRow[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: READ, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(4000) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b', function: { name: READ, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b', content: 'y'.repeat(400) },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', function: { name: READ, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: 'z'.repeat(4000) },
    { role: 'assistant', content: 'done' },
  ]
  const weigh = (row: FoldRow): number => Math.ceil(String(row.content ?? '').length / 4) + 4
  const cut = prefill?.nextTurnStages(rows as never, 2, 250, weigh as never) as FoldRow[][] | undefined
  check('the pieces of a conversation: two of them, the first ending on the reply after the first large result, the last the whole of it', cut !== undefined && cut.length === 2 && rowsEqual(cut[0]!, rows.slice(0, 5)) && rowsEqual(cut[1]!, rows), JSON.stringify(cut?.map(piece => piece.length)))
  check('a conversation smaller than one piece goes out whole, in one request', prefill !== undefined && (prefill.nextTurnStages(rows as never, 2, 5000, weigh as never) as unknown[]).length === 1)
}

section('5 · the same on an engine whose template keeps every row\'s reasoning: the reply alone is read ahead')
{
  const w = await world('every-row', CAPABLE, {}, 'qwen3.8-27b')
  if (w !== undefined) {
    await toolTurn(w)
    await settled()
    const sentAhead = ahead(w)
    const lastReal = real(w).at(-1)
    check('one request, and all it reads is the reply', sentAhead.length === 1 && lastReal !== undefined && sentAhead[0]!.cachedTokens >= lastReal.promptTokens - 1, JSON.stringify(sentAhead.map(request => [request.promptTokens, request.cachedTokens])))
    w.fixture.stop()
  }
}

prefill?.__resetNextTurnPrefillForTest()
console.log(`\nprove-tensorfold-next-turn-prefill: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
