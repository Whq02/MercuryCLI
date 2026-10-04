#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { mock } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeOllama, FAKE_OLLAMA_MODEL, serveFakeOllama, type FakeOllama, type FakeOllamaResponse } from '../local-setup/fixtures/fake-ollama.ts'

const SCRATCH_ROOT = existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir()
const HOME = mkdtempSync(join(SCRATCH_ROOT, 'local-warm-proof-'))
const CWD = mkdtempSync(join(SCRATCH_ROOT, 'local-warm-cwd-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_ENTRYPOINT = 'headless'
delete process.env.NODE_ENV
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_DISABLE_1M_CONTEXT
delete process.env.MERCURY_MODEL

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(pred: () => boolean, ms: number, step = 25): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return true
    await sleep(step)
  }
  return pred()
}

const MODEL = FAKE_OLLAMA_MODEL
const SECOND = 'qwen3.5:9b-q4_K_M'
const PERSISTED = `local/${MODEL}`
const PERSISTED_SECOND = `local/${SECOND}`
const TRAINED_MAX = 262_144
const SERVER_KEEP_ALIVE_MS = 5 * 60_000

type Hit = { at: number; method: string; path: string; body: Record<string, unknown> | undefined; raw: string; expiryBefore?: string; expiryAfter?: string }
const hits: Hit[] = []
const fixtureNow = (): number => 1_800_000_000_000
const fixtureKnobs = { chatDelayMs: 0, serverKeepAliveMs: SERVER_KEEP_ALIVE_MS }
let reloads = 0
const promptCache = new Map<string, string>()

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}
function parseGoDuration(raw: unknown): number | 'unload' | 'never' | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number') return raw === 0 ? 'unload' : raw < 0 ? 'never' : raw * 1000
  if (typeof raw !== 'string') return undefined
  if (raw === '0' || raw === '0s') return 'unload'
  if (raw.startsWith('-')) return 'never'
  let total = 0
  for (const m of raw.matchAll(/(\d+(?:\.\d+)?)(h|m|s|ms)/g)) {
    const n = Number(m[1])
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n
  }
  return total
}
function renderPrompt(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]).map(rec) : []
  const parts: string[] = []
  for (const [index, m] of messages.entries()) {
    parts.push(`${String(m?.role)}:${typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')}`)
    if (index === 0 && m?.role === 'system' && body.tools !== undefined) parts.push(`tools:${JSON.stringify(body.tools)}`)
  }
  if (messages.length === 0 && body.tools !== undefined) parts.push(`tools:${JSON.stringify(body.tools)}`)
  return parts.join('\n') + '\n'
}
function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}
const tokensOf = (chars: number): number => Math.floor(chars / 4)
const row = (obj: unknown): string => `${JSON.stringify(obj)}\n`

function wrapFixture(base: FakeOllama): FakeOllama {
  const state = base.state
  const iso = (ms: number): string => new Date(ms).toISOString()
  const load = (tag: string, body: Record<string, unknown>): { contextLength: number; expiresAt: string } => {
    const numCtx = rec(body.options)?.num_ctx
    const before = state.loaded.get(tag)
    const contextLength = typeof numCtx === 'number' ? numCtx : before?.contextLength ?? 4096
    if (before !== undefined && before.contextLength !== contextLength) {
      reloads += 1
      promptCache.delete(tag)
    }
    const keep = parseGoDuration(body.keep_alive)
    if (keep === 'unload') {
      state.loaded.delete(tag)
      promptCache.delete(tag)
      return { contextLength: 0, expiresAt: iso(fixtureNow()) }
    }
    const expiresAt = keep === 'never' ? '0001-01-01T00:00:00Z' : iso(fixtureNow() + (keep ?? fixtureKnobs.serverKeepAliveMs))
    const entry = { contextLength, expiresAt }
    state.loaded.set(tag, entry)
    return entry
  }
  async function* chatRows(tag: string, body: Record<string, unknown>): AsyncIterable<string> {
    const render = renderPrompt(body)
    const cached = tokensOf(commonPrefixLength(promptCache.get(tag) ?? '', render))
    const total = tokensOf(render.length)
    promptCache.set(tag, render)
    if (fixtureKnobs.chatDelayMs > 0) await sleep(fixtureKnobs.chatDelayMs)
    const numPredict = rec(body.options)?.num_predict
    const budget = typeof numPredict === 'number' && numPredict > 0 ? numPredict : 3
    const think = body.think === true
    const pieces = ['pong', ' from', ' the fixture'].slice(0, budget)
    let emitted = 0
    if (think && emitted < budget) {
      yield row({ model: tag, created_at: iso(fixtureNow()), message: { role: 'assistant', content: '', thinking: 'one' }, done: false })
      emitted += 1
    }
    for (const piece of pieces) {
      if (emitted >= budget) break
      yield row({ model: tag, created_at: iso(fixtureNow()), message: { role: 'assistant', content: piece }, done: false })
      emitted += 1
    }
    yield row({
      model: tag,
      created_at: iso(fixtureNow()),
      message: { role: 'assistant', content: '' },
      done_reason: emitted >= budget && budget < 3 ? 'length' : 'stop',
      done: true,
      total_duration: 1_000_000,
      load_duration: 0,
      prompt_eval_count: total,
      prompt_eval_cached_count: cached,
      prompt_eval_duration: (total - cached) * 3_000_000,
      eval_count: emitted,
      eval_duration: emitted * 25_000_000,
    })
  }
  return {
    state,
    async handle(method: string, path: string, rawBody: string): Promise<FakeOllamaResponse> {
      let body: Record<string, unknown> | undefined
      try {
        body = rawBody.trim() === '' ? undefined : rec(JSON.parse(rawBody))
      } catch {
        body = undefined
      }
      const tag = typeof body?.model === 'string' ? body.model : ''
      const hit: Hit = { at: fixtureNow(), method, path, body, raw: rawBody, expiryBefore: state.loaded.get(tag)?.expiresAt }
      hits.push(hit)
      if (method === 'POST' && path === '/api/chat' && body !== undefined && state.pulled.has(tag)) {
        load(tag, body)
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: tag, created_at: iso(fixtureNow()), message: { role: 'assistant', content: '' }, done: true, done_reason: 'load' }) }
        }
        return { status: 200, headers: { 'content-type': 'application/x-ndjson' }, body: chatRows(tag, body) }
      }
      if (method === 'POST' && path === '/api/generate' && body !== undefined && state.pulled.has(tag)) {
        const loaded = load(tag, body)
        hit.expiryAfter = loaded.expiresAt
        if (typeof body.prompt !== 'string' || body.prompt === '') {
          return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: tag, created_at: iso(fixtureNow()), response: '', done: true, done_reason: loaded.contextLength === 0 ? 'unload' : 'load' }) }
        }
      }
      return base.handle(method, path, rawBody)
    },
  }
}

const fixture = wrapFixture(createFakeOllama({ pulled: [MODEL, SECOND] }))
const served = await serveFakeOllama(fixture, 0)
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${served.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const { setEngineModelOverride, setOriginalCwd, setCwdState } = bootstrap
process.chdir(CWD)
setOriginalCwd(CWD)
setCwdState(CWD)
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const truthModule = await import('../../src/services/localServer/localServerTruth.ts')
truthModule.__resetLocalServerTruthForTest()
const SMALL_MACHINE = {
  loaded: [], listed: [], runners: [], launchForm: { kind: 'unknown' as const, note: 'fixture' },
  machine: { platform: 'darwin' as const, totalMemoryBytes: 16 * 1024 ** 3, usableMemoryBytes: 12 * 1024 ** 3, usableSource: 'fixture: 16 GiB, three quarters usable' },
  readAtMs: Date.now(),
}
let machineReads = 0
mock.module('../../src/services/localServer/localServerTruth.ts', () => ({
  ...truthModule,
  refreshLocalMachineTruth: async () => {
    machineReads++
    await Promise.resolve()
    truthModule.__pinLocalServerTruthForTest(SMALL_MACHINE)
    return SMALL_MACHINE
  },
}))
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { __resetLocalWindowsForTest, heldLocalWindow } = await import('../../src/services/providers/local/localWindow.ts')
const { compatLaneLiveProofState } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { getTools } = await import('../../src/tools.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
const { getSystemContext, getUserContext } = await import('../../src/context.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { appendSystemContext, prependUserContext } = await import('../../src/utils/api.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const { rosterOwnerFromToolUseContext } = await import('../../src/services/run/resolveOwner.ts')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
type WarmModule = typeof import('../../src/services/providers/local/localWarm.ts')
const warmModule: WarmModule | null = await import('../../src/services/providers/local/localWarm.ts').catch(() => null)

__resetLocalDiscoveryForTest()
__resetLocalWindowsForTest()
clearToolRosterLatches()
await refreshLocalDiscovery({ force: true })
const record = localRecordFor(PERSISTED)
const permissionContext = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
const tools = getTools(permissionContext as never)
const systemPromptSections = await getSystemPrompt(tools, PERSISTED, [], 'default')
const systemContext = await getSystemContext()
const userContext = await getUserContext()
const systemPrompt = asSystemPrompt(systemPromptSections)
const fullSystemPrompt = asSystemPrompt(appendSystemContext(systemPrompt, systemContext))
const thinkingConfig = { type: 'adaptive' as const }
const history: unknown[] = []
const appStateStub = { toolPermissionContext: permissionContext, mcp: { clients: [], tools: [] }, effortValue: undefined }
const toolUseContext = {
  options: { tools, thinkingConfig, engineModel: PERSISTED, agentDefinitions: { activeAgents: [], allAgents: [] }, commands: [], mcpClients: [], isNonInteractiveSession: true },
  getAppState: () => appStateStub,
  setAppState: () => {},
  abortController: new AbortController(),
  messages: history,
}
const context = () => ({ systemPrompt, userContext, systemContext, toolUseContext, forkContextMessages: history })
const ownerKey = String(rosterOwnerFromToolUseContext(toolUseContext as never))

const chats = (): Hit[] => hits.filter(h => h.method === 'POST' && h.path === '/api/chat')
const touches = (): Hit[] => hits.filter(h => h.method === 'POST' && h.path === '/api/generate')
const psReads = (): Hit[] => hits.filter(h => h.method === 'GET' && h.path === '/api/ps')
const shape = (list: Hit[]): string => list.map(h => `${h.method} ${h.path}${h.body?.model !== undefined ? ` ${String(h.body.model)}` : ''}`).join(' → ')
const optionsOf = (h: Hit | undefined): Record<string, unknown> => rec(h?.body?.options) ?? {}
const loadedEntry = (tag: string) => fixture.state.loaded.get(tag)
const expiresIn = (tag: string): number | undefined => {
  const entry = loadedEntry(tag)
  return entry === undefined ? undefined : Date.parse(entry.expiresAt) - fixtureNow()
}
let live = true

async function firstTurn(text: string): Promise<{ usage: Record<string, number> | undefined; error: string | undefined; texts: string[] }> {
  const messages = prependUserContext([createUserMessage({ content: text }) as never], userContext)
  const yielded: Array<{ type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ text?: string }> | string; usage?: Record<string, number> } }> = []
  for await (const item of localCallModel({
    messages: messages as never,
    systemPrompt: fullSystemPrompt,
    thinkingConfig: thinkingConfig as never,
    tools,
    signal: new AbortController().signal,
    options: {
      model: PERSISTED,
      querySource: 'main_thread',
      getToolPermissionContext: async () => permissionContext,
      agents: [],
      ownerKey,
      isNonInteractiveSession: true,
    } as never,
  })) yielded.push(item as never)
  const error = yielded.find(m => m.type === 'assistant' && m.isApiErrorMessage === true)
  const textOf = (m: (typeof yielded)[number]): string => (typeof m.message?.content === 'string' ? m.message.content : (m.message?.content ?? []).map(b => b.text ?? '').join(''))
  const settled = yielded.filter(m => m.type === 'assistant' && m.isApiErrorMessage !== true)
  return { usage: settled.at(-1)?.message?.usage, error: error ? textOf(error) : undefined, texts: settled.map(textOf) }
}

section('0 · the world: a fixture Ollama that records requests, models the prompt cache and keep_alive, and the real prompt + tool catalogue')
{
  check('discovery found the fixture model (ollama, tools, thinking)', record !== undefined && record.server === 'ollama' && record.toolsDeclared === true && record.thinkingDeclared === true && record.modelMaxContext === TRAINED_MAX, JSON.stringify(record))
  check(`the catalogue is the real one (${tools.length} tools) and the system prompt is the real one (${fullSystemPrompt.join('').length} chars)`, tools.length >= 20 && fullSystemPrompt.join('').length > 10_000)
  check('no load, chat or generate rode discovery', !hits.some(h => h.path === '/api/chat' || h.path === '/api/generate'), shape(hits))
}

section('1 · the seams: the module, the runner registration line and the turn seam')
{
  const print = readFileSync(join(ROOT, 'src/cli/run.ts'), 'utf8')
  const callModel = readFileSync(join(ROOT, 'src/services/providers/local/localCallModel.ts'), 'utf8')
  check('src/services/providers/local/localWarm.ts exists and exports armLocalWarm / noteLocalTurn / localWarmFacts', warmModule !== null && typeof warmModule.armLocalWarm === 'function' && typeof warmModule.noteLocalTurn === 'function' && typeof warmModule.localWarmFacts === 'function', 'the module is absent')
  const armLine = print.split('\n').find(line => line.includes('armLocalWarm('))
  check('src/cli/run.ts arms the warm ONCE with the side-question fallback bundle (the same prompt/tool assembly a turn uses) and the seat liveness', armLine !== undefined && armLine.includes('buildSideQuestionFallbackParams(') && armLine.includes('awaitingSessionClaim') && armLine.includes('inFlightAbort') && print.split('armLocalWarm(').length === 2, armLine ?? 'no armLocalWarm( line')
  check('src/services/providers/local/localCallModel.ts notes the real turn before dispatch (the warm yields the server; the touch learns the knobs)', callModel.includes('noteLocalTurn(record)') && callModel.indexOf('noteLocalTurn(record)') < callModel.indexOf('yield* compatChatCallModel('), 'no noteLocalTurn(record) before the dispatch')
}

section('2 · pre-warm on switch: the model becomes a local Ollama model and the server receives the first turn\'s prefix, one token, while nobody is waiting')
const disarm = warmModule?.armLocalWarm(context as never, { live: () => live, io: { now: fixtureNow, settleMs: 20, tickMs: 120, ceilingMs: 30_000 } })
let warmHit: Hit | undefined
{
  const before = chats().length
  setEngineModelOverride(PERSISTED)
  check('the effective model is the local one', getEngineModel() === PERSISTED, getEngineModel())
  const arrived = await waitFor(() => chats().length > before && (warmModule === null || warmModule.localWarmFacts().inFlight === null), 8_000)
  warmHit = chats()[before]
  check('a warm request reached the server after the switch, before any turn (the base sends nothing until the operator\'s first message)', arrived && warmHit !== undefined, `chats after the switch: ${chats().length - before}`)
  const body = warmHit?.body ?? {}
  const messages = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : []
  check('the warm body carries ONLY the rendered system prompt as its one message', messages.length === 1 && messages[0]?.role === 'system' && typeof messages[0]?.content === 'string' && (messages[0].content as string).length > 10_000, `${messages.length} messages: ${messages.map(m => String(m.role)).join(',')}`)
  check(`the warm body carries the tool catalogue as the turn will (${Array.isArray(body.tools) ? (body.tools as unknown[]).length : 0} tools — the roster the tool-payload plan gives the local road, deferred or whole)`, Array.isArray(body.tools) && (body.tools as unknown[]).length >= 5)
  check('the smallest generation: options.num_predict = 1 (Ollama 0.34.4 hands num_predict to llama-server as n_predict; 0 is not a bounded budget there)', optionsOf(warmHit).num_predict === 1, JSON.stringify(optionsOf(warmHit)))
  check('the window rides as the turn will send it: num_ctx (the auto window for this prefix) and num_batch', typeof optionsOf(warmHit).num_ctx === 'number' && (optionsOf(warmHit).num_ctx as number) >= 32_768 && typeof optionsOf(warmHit).num_batch === 'number', JSON.stringify(optionsOf(warmHit)))
  check('think as the session has it (thinking on → think:true), stream:true, truncate:false, no keep_alive', body.think === true && body.stream === true && body.truncate === false && body.keep_alive === undefined, JSON.stringify({ think: body.think, stream: body.stream, truncate: body.truncate, keep_alive: body.keep_alive }))
  check('no pre-load rode the wire (the warm chat loads the model itself)', !hits.slice(before).some(h => h.path === '/api/generate'), shape(hits.slice(before)))
  const facts = warmModule?.localWarmFacts()
  check('the warm is never counted as a turn: no local live-proof latch, no transcript row (the lane\'s settle latch stays null)', compatLaneLiveProofState('local') === null)
  check('the module reports the warm settled with the server\'s prompt count and no failure', facts !== undefined && facts.warmed.includes(`ollama/${MODEL}`) && facts.failed === 0 && facts.lastWarm !== null && (facts.lastWarm.usage?.inputTokens ?? 0) > 1000, JSON.stringify(facts))
  check('the held window is NOT written by the warm (the turn decides its own; the warm only reads a hold)', record !== undefined && heldLocalWindow(record) === undefined)
  check('a cold warm reads the fixture machine before choosing: 16 GiB fits 128k, below the trained 256k', machineReads === 1 && optionsOf(warmHit).num_ctx === 131072, `reads ${machineReads}, num_ctx ${String(optionsOf(warmHit).num_ctx)}`)
}

section('3 · the first real turn after the switch: the body prefix equals the warm\'s byte for byte and the server ingests only the operator\'s message')
{
  const before = chats().length
  const outcome = await firstTurn('say pong')
  const turnHit = chats()[before]
  check('the turn rode /api/chat once and settled (no refusal)', chats().length === before + 1 && turnHit !== undefined && outcome.error === undefined && outcome.texts.some(t => t.includes('pong')), outcome.error ?? shape(hits.slice(-4)))
  const warmRaw = warmHit?.raw ?? ''
  const turnRaw = turnHit?.raw ?? ''
  const systemRowEnd = warmRaw.indexOf('}]', warmRaw.indexOf('"messages":[')) + 1
  const toolsStart = warmRaw.indexOf('"tools":[')
  const toolsEnd = warmRaw.indexOf('],"stream"', toolsStart) + 1
  const commonBytes = commonPrefixLength(warmRaw, turnRaw)
  check(`the raw bodies share the prefix through the system row byte for byte (${commonBytes} common bytes of the warm's ${warmRaw.length})`, warmRaw !== '' && systemRowEnd > 0 && turnRaw.startsWith(warmRaw.slice(0, systemRowEnd)), `common ${commonBytes}, system row ends at ${systemRowEnd}`)
  check('the tool catalogue bytes ride the turn verbatim', toolsStart > 0 && toolsEnd > toolsStart && turnRaw.includes(warmRaw.slice(toolsStart, toolsEnd)))
  check('model, think, num_ctx and num_batch agree (the runner is not reloaded between the warm and the turn)', turnHit?.body?.model === warmHit?.body?.model && turnHit?.body?.think === warmHit?.body?.think && optionsOf(turnHit).num_ctx === optionsOf(warmHit).num_ctx && optionsOf(turnHit).num_batch === optionsOf(warmHit).num_batch && reloads === 0, `${JSON.stringify(optionsOf(warmHit))} vs ${JSON.stringify(optionsOf(turnHit))}, reloads ${reloads}`)
  check('the turn carries the operator\'s message after the prefix and no num_predict', Array.isArray(turnHit?.body?.messages) && (turnHit!.body!.messages as unknown[]).length >= 2 && optionsOf(turnHit).num_predict === undefined)
  const turnTotal = outcome.usage === undefined ? undefined : outcome.usage.input_tokens! + outcome.usage.cache_read_input_tokens!
  const cached = outcome.usage?.cache_read_input_tokens
  const delta = outcome.usage?.input_tokens
  check(`the server's cache covered the warm prefix: prompt_eval_cached_count = the warm's count (${String(cached)}), the delta is the operator's rows only (${String(delta)} of ${String(turnTotal)})`, cached !== undefined && delta !== undefined && cached > 1000 && cached === (warmModule?.localWarmFacts().lastWarm?.usage?.inputTokens ?? -1) && delta < cached / 10, `the first turn re-ingested the whole prompt: prompt_eval_count=${String(turnTotal)} cached=${String(cached)}`)
  check('the turn now holds the window it decided, equal to the warm\'s num_ctx', record !== undefined && heldLocalWindow(record)?.window === optionsOf(warmHit).num_ctx, `${String(record && heldLocalWindow(record)?.window)} vs ${String(optionsOf(warmHit).num_ctx)}`)
  check('the turn IS counted (the lane\'s live-proof latch is set by the turn, not the warm)', compatLaneLiveProofState('local') !== null)
}

section('4 · keep the model warm: a touch on the clock, keep_alive 30m with the session\'s own runner options, expires_at moves, never a reload, never keep_alive 0')
{
  await warmModule?.tick()
  await waitFor(() => touches().length > 0, 2_000)
  const before = touches().length
  const psBefore = psReads().length
  const arrived = await waitFor(() => touches().length >= before + 2, 4_000)
  const touch = touches()[before]
  check('the fixture saw the touch on the clock (two ticks, two touches)', arrived, `touches: ${touches().length - before} (the base has no keep-alive clock)`)
  check('the touch is POST /api/generate {model, keep_alive} with NO prompt', touch !== undefined && touch.body?.model === MODEL && touch.body?.prompt === undefined && touch.body?.keep_alive === '30m', JSON.stringify(touch?.body))
  check('the touch carries the SAME runner options as the chat (num_ctx, num_batch) so the scheduler keeps the runner and its cache', optionsOf(touch).num_ctx === optionsOf(warmHit).num_ctx && optionsOf(touch).num_batch === optionsOf(warmHit).num_batch && reloads === 0, `${JSON.stringify(optionsOf(touch))} reloads ${reloads}`)
  const firstTouch = touches()[0]
  const expiryBefore = firstTouch?.expiryBefore === undefined ? undefined : Date.parse(firstTouch.expiryBefore) - firstTouch.at
  const expiryAfter = firstTouch?.expiryAfter === undefined ? undefined : Date.parse(firstTouch.expiryAfter) - firstTouch.at
  check('the runner\'s expires_at moved from the server\'s own 5m to 30m out, witnessed at the first touch on the fixture clock even if an earlier tick beat this assertion', expiryBefore === SERVER_KEEP_ALIVE_MS && expiryAfter === 30 * 60_000 && expiresIn(MODEL) === 30 * 60_000, `before ${String(expiryBefore)} after ${String(expiryAfter)}`)
  check('every tick reads /api/ps before it touches (a touch only ever lands on a resident runner)', psReads().length - psBefore >= touches().length - before)
  check('no touch ever carries keep_alive 0', touches().every(t => t.body?.keep_alive !== 0 && t.body?.keep_alive !== '0'))
  check('no chat rode the clock (a touch is never a turn)', chats().length === 2, shape(chats()))
}

section('5 · the touch is polite: a longer server hold, a never-expiring runner, an unloaded model and another runner\'s window all get NO touch')
{
  const entry = loadedEntry(MODEL)!
  const between = async (): Promise<number> => {
    const from = touches().length
    await sleep(420)
    return touches().length - from
  }
  fixture.state.loaded.set(MODEL, { ...entry, expiresAt: new Date(fixtureNow() + 2 * 3_600_000).toISOString() })
  check('a runner the server already holds for 2h is not touched (never shortens a longer residency)', (await between()) === 0)
  fixture.state.loaded.set(MODEL, { ...entry, expiresAt: '0001-01-01T00:00:00Z' })
  check('a never-expiring runner (keep_alive -1) is not touched', (await between()) === 0)
  fixture.state.loaded.delete(MODEL)
  check('an unloaded model is never loaded by the clock (the next turn loads it, as today)', (await between()) === 0 && !loadedEntry(MODEL))
  fixture.state.loaded.set(MODEL, { contextLength: 4096, expiresAt: new Date(fixtureNow() + 60_000).toISOString() })
  check("a runner loaded with another window (4096) is not touched — a touch with this session's num_ctx would reload it", (await between()) === 0 && reloads === 0)
  fixture.state.loaded.set(MODEL, { ...entry, expiresAt: new Date(fixtureNow() + 60_000).toISOString() })
  const from = touches().length
  check('back on this session\'s runner with a minute left: the touch resumes', await waitFor(() => touches().length > from, 2_000))
  if (warmModule !== null) {
    const { keepAliveTouchDue } = warmModule
    const knobs = { numCtx: 131072, numBatch: 2048 }
    const soon = new Date(fixtureNow() + 4 * 60_000).toISOString()
    check('pure: due when resident, expiring within 30m and on this window', keepAliveTouchDue({ expires_at: soon, context_length: 131072 }, knobs, fixtureNow()).due === true)
    check('pure: not due when absent, past, beyond 30m, or on another window', keepAliveTouchDue(undefined, knobs, fixtureNow()).due === false && keepAliveTouchDue({ expires_at: '0001-01-01T00:00:00Z' }, knobs, fixtureNow()).due === false && keepAliveTouchDue({ expires_at: new Date(fixtureNow() + 31 * 60_000).toISOString() }, knobs, fixtureNow()).due === false && keepAliveTouchDue({ expires_at: soon, context_length: 4096 }, knobs, fixtureNow()).due === false)
  }
}

section('6 · a switch away: the clock stops and nothing is sent afterwards')
{
  setEngineModelOverride('claude-fable-5-1')
  const stopped = await waitFor(() => warmModule === null || warmModule.localWarmFacts().clock === null, 2_000)
  const touchesAt = touches().length
  const chatsAt = chats().length
  await sleep(500)
  check('the keep-alive clock stopped when the model left the local lane', stopped && (warmModule === null || warmModule.localWarmFacts().clock === null))
  check('nothing was sent after the switch away (no touch, no chat)', touches().length === touchesAt && chats().length === chatsAt, `touches +${touches().length - touchesAt}, chats +${chats().length - chatsAt}`)
}

section('7 · a second switch cancels the first: the in-flight warm is aborted and only the newest model\'s warm settles')
{
  fixtureKnobs.chatDelayMs = 400
  const before = chats().length
  const cancelledBefore = warmModule?.localWarmFacts().cancelled ?? 0
  setEngineModelOverride(PERSISTED_SECOND)
  await waitFor(() => chats().length > before, 2_000)
  setEngineModelOverride(PERSISTED)
  const settled = await waitFor(() => (warmModule?.localWarmFacts().warmed.includes(`ollama/${MODEL}`) ?? false) && warmModule?.localWarmFacts().inFlight === null && chats().length >= before + 2, 6_000)
  fixtureKnobs.chatDelayMs = 0
  const facts = warmModule?.localWarmFacts()
  check('the first warm (the second model) was cancelled by the later switch', facts !== undefined && facts.cancelled > cancelledBefore && !facts.warmed.includes(`ollama/${SECOND}`), JSON.stringify(facts))
  check('the newest model\'s warm settled; the fixture saw both requests in order, the last for the newest model', settled && chats()[before]?.body?.model === SECOND && chats().at(-1)?.body?.model === MODEL, shape(chats().slice(before)))
}

section('8 · a conversation that already carries rows gets NO warm (a prefix-only request would truncate the cache the server may hold for it); the clock still runs')
{
  const skippedBefore = warmModule?.localWarmFacts().skipped ?? 0
  const chatsAt = chats().length
  history.push(createUserMessage({ content: 'earlier question' }), { type: 'assistant', uuid: '00000000-0000-4000-8000-00000000a55f', timestamp: new Date().toISOString(), message: { id: 'm1', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'earlier answer', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  setEngineModelOverride(PERSISTED_SECOND)
  const skipped = await waitFor(() => (warmModule?.localWarmFacts().skipped ?? 0) > skippedBefore, 3_000)
  await sleep(300)
  check('the switch on a conversation with rows skipped the warm (one debug line) and sent no chat', skipped && chats().length === chatsAt, `skipped ${String(warmModule?.localWarmFacts().skipped)}, chats +${chats().length - chatsAt}`)
  check('the keep-alive clock follows the new model regardless', warmModule?.localWarmFacts().clock === `ollama/${SECOND}`, String(warmModule?.localWarmFacts().clock))
  check('pure: a meta user row alone is not a conversation; a user or assistant row is', warmModule !== null && warmModule.conversationHasRows([createUserMessage({ content: 'x', isMeta: true }) as never]) === false && warmModule.conversationHasRows([createUserMessage({ content: 'x' }) as never]) === true)
  history.length = 0
  setEngineModelOverride(PERSISTED)
  await waitFor(() => warmModule?.localWarmFacts().clock === `ollama/${MODEL}`, 2_000)
}

section('9 · a warm that fails says nothing: the server goes away, the warm fails quietly, no touch follows')
{
  served.server.closeAllConnections()
  await new Promise<void>(resolve => served.server.close(() => resolve()))
  const failedBefore = warmModule?.localWarmFacts().failed ?? 0
  setEngineModelOverride(PERSISTED_SECOND)
  const failed = await waitFor(() => (warmModule?.localWarmFacts().failed ?? 0) > failedBefore, 5_000)
  const touchesAt = touches().length
  await sleep(400)
  check('the warm failed without throwing and without a visible row (a debug line only)', failed && warmModule?.localWarmFacts().inFlight === null)
  check('no touch reaches a server that stopped answering', touches().length === touchesAt)
  disarm?.()
  check('disarmed: the clock is gone and nothing is armed', warmModule === null || (warmModule.localWarmFacts().clock === null && warmModule.localWarmFacts().armed === false))
}

live = false
process.chdir(ROOT)
rmSync(HOME, { recursive: true, force: true })
rmSync(CWD, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
