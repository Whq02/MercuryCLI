#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH_ROOT = existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir()
const HOME = mkdtempSync(join(SCRATCH_ROOT, 'local-reload-fence-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_DISABLE_1M_CONTEXT
delete process.env.MERCURY_MODEL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const MODEL = 'qwen3.8:27b-mtp-q4_K_M'
const PERSISTED = `local/${MODEL}`
const SERVER_CONTEXT = 262144
const SERVER_BATCH = 512
const MERCURY_BATCH = 2048
const TRAINED_MAX = 262144

type RunnerOptions = { numCtx: number; numBatch: number }
type Hit = { seq: number; method: string; url: string; body: Record<string, unknown>; reloaded: boolean }
type Fixture = {
  runner: (RunnerOptions & { expiresAt: string }) | undefined
  cache: string
  starts: RunnerOptions[]
  hits: Hit[]
  replyWithToolCall: boolean
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const optionsWords = (o: RunnerOptions): string => `{num_ctx ${o.numCtx}, num_batch ${o.numBatch}}`
const fill = (body: Record<string, unknown>): RunnerOptions => {
  const options = rec(body.options)
  return { numCtx: typeof options?.num_ctx === 'number' ? options.num_ctx : SERVER_CONTEXT, numBatch: typeof options?.num_batch === 'number' ? options.num_batch : SERVER_BATCH }
}
function renderPrompt(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? (body.messages as unknown[]).map(rec) : []
  return messages.map(m => `${String(m?.role)}:${typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')}`).join('\n') + `\ntools:${JSON.stringify(body.tools ?? [])}\n`
}
function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}
const tokensOf = (chars: number): number => Math.floor(chars / 4)
const row = (obj: unknown): string => `${JSON.stringify(obj)}\n`
const fixtureNow = (): number => 1_800_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()

function ollamaScheduler(state: Fixture): Promise<{ server: Server; root: string }> {
  const schedule = (body: Record<string, unknown>): boolean => {
    const asked = fill(body)
    const resident = state.runner
    const reload = resident === undefined || resident.numCtx !== asked.numCtx || resident.numBatch !== asked.numBatch
    if (reload) {
      state.starts.push(asked)
      state.cache = ''
    }
    const keep = typeof body.keep_alive === 'string' && /^(\d+)m$/.test(body.keep_alive) ? Number(/^(\d+)m$/.exec(body.keep_alive)![1]) * 60_000 : 5 * 60_000
    state.runner = { ...asked, expiresAt: iso(fixtureNow() + keep) }
    return reload
  }
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const url = req.url ?? ''
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        const hit: Hit = { seq: state.hits.length + 1, method: req.method ?? 'GET', url, body, reloaded: false }
        state.hits.push(hit)
        if (url === '/api/tags') return json(res, 200, { models: [{ name: MODEL, model: MODEL, size: 17741872154, details: { family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M' } }] })
        if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
        if (url === '/api/ps') {
          return json(res, 200, { models: state.runner === undefined ? [] : [{ name: MODEL, model: MODEL, size: 20734048992, size_vram: 20734048992, context_length: state.runner.numCtx, expires_at: state.runner.expiresAt }] })
        }
        if (url === '/api/show' && req.method === 'POST') {
          if (body.model !== MODEL) return json(res, 404, { error: `model '${String(body.model)}' not found` })
          return json(res, 200, { modelfile: '', parameters: 'top_k 20\ntop_p 0.95\ntemperature 1', details: { family: 'qwen35', parameter_size: '27.3B', quantization_level: 'Q4_K_M' }, model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': TRAINED_MAX }, capabilities: ['completion', 'vision', 'tools', 'thinking'] })
        }
        if (url === '/api/generate' && req.method === 'POST') {
          hit.reloaded = schedule(body)
          return json(res, 200, { model: body.model, created_at: iso(fixtureNow()), response: '', done: true, done_reason: 'load' })
        }
        if (url === '/api/chat' && req.method === 'POST') {
          hit.reloaded = schedule(body)
          const render = renderPrompt(body)
          const cached = tokensOf(commonPrefixLength(state.cache, render))
          const total = tokensOf(render.length)
          state.cache = render
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          if (state.replyWithToolCall) {
            res.write(row({ model: body.model, created_at: iso(fixtureNow()), message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Bash', arguments: { command: 'sleep 65; date' } } }] }, done: false }))
          } else {
            res.write(row({ model: body.model, created_at: iso(fixtureNow()), message: { role: 'assistant', content: 'pong' }, done: false }))
          }
          res.write(row({ model: body.model, created_at: iso(fixtureNow()), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: total, prompt_eval_cached_count: cached, eval_count: 3 }))
          res.end()
          return
        }
        json(res, 404, { error: 'not found' })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}

const state: Fixture = { runner: undefined, cache: '', starts: [], hits: [], replyWithToolCall: false }
const ollama = await ollamaScheduler(state)
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest, LOCAL_DISCOVERY_TTL_MS } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const windowModule = (await import('../../src/services/providers/local/localWindow.ts')) as typeof import('../../src/services/providers/local/localWindow.ts') & Record<string, ((...args: never[]) => unknown) | undefined>
const { writeLocalWindowSetting, __resetLocalWindowsForTest, heldLocalWindow } = windowModule
const seam = <T>(fn: T | undefined): T | (() => undefined) => (typeof fn === 'function' ? fn : () => undefined)
const warmModule = await import('../../src/services/providers/local/localWarm.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')

type Yielded = { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ text?: string; name?: string; type?: string }> | string; usage?: Record<string, number> } }
function textOf(m: Yielded | undefined): string {
  const content = m?.message?.content
  if (typeof content === 'string') return content
  return (content ?? []).map(b => b.text ?? '').join('')
}
function paramsFor(messages: unknown[], extra: Record<string, unknown>): Record<string, unknown> {
  return {
    messages: messages as never,
    systemPrompt: ['You are a proof seat.'] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: {
      model: PERSISTED,
      querySource: 'main_thread',
      getToolPermissionContext: async () => ({ mode: 'default' }) as never,
      ...extra,
    } as never,
  }
}
const userRow = (text: string): unknown => ({ type: 'user', message: { role: 'user', content: text }, uuid: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`, timestamp: new Date().toISOString() })
async function send(messages: unknown[], extra: Record<string, unknown> = {}, road: 'local' | 'router' = 'local'): Promise<{ error: string | undefined; usage: Record<string, number> | undefined; texts: string[] }> {
  const params = paramsFor(messages, extra)
  const yielded: Yielded[] = []
  for await (const item of road === 'local' ? localCallModel(params as never) : routedCallModel(params as never)) yielded.push(item as never)
  const error = yielded.find(m => m.type === 'assistant' && m.isApiErrorMessage === true)
  const settled = yielded.filter(m => m.type === 'assistant' && m.isApiErrorMessage !== true)
  return { error: error ? textOf(error) : undefined, usage: settled.at(-1)?.message?.usage, texts: settled.map(textOf) }
}
const record = (): NonNullable<ReturnType<typeof localRecordFor>> => localRecordFor(PERSISTED)!
const hitsSince = (from: number): Hit[] => state.hits.slice(from)
const loads = (hits: Hit[]): Hit[] => hits.filter(h => h.url === '/api/generate' || h.url === '/api/chat')
const shape = (hits: Hit[]): string => hits.filter(h => !['/api/tags', '/api/version', '/api/show'].includes(h.url)).map(h => `${h.method} ${h.url}${h.url === '/api/chat' || h.url === '/api/generate' ? ` ${optionsWords(fill(h.body))}${h.reloaded ? ' RELOAD' : ''}` : ''}`).join(' → ')
const setsOf = (hits: Hit[]): string[] => [...new Set(loads(hits).map(h => optionsWords(fill(h.body))))]
const past = (): number => Date.now() - LOCAL_DISCOVERY_TTL_MS - 60_000
async function resetWorld(setting: 'server' | 'max' | number | undefined, opts: { resident?: RunnerOptions; freshDiscovery?: boolean } = {}): Promise<void> {
  __resetLocalDiscoveryForTest()
  __resetLocalWindowsForTest()
  warmModule.__resetLocalWarmForTest()
  state.runner = opts.resident === undefined ? undefined : { ...opts.resident, expiresAt: iso(fixtureNow() + 4 * 60_000) }
  state.cache = ''
  state.starts.length = 0
  state.hits.length = 0
  state.replyWithToolCall = false
  writeLocalWindowSetting({ id: MODEL }, setting)
  const probedAt = past()
  await refreshLocalDiscovery({ force: true, ...(opts.freshDiscovery === true ? {} : { now: () => probedAt }) })
}
const conversation: unknown[] = [userRow('Run the Bash tool exactly once with the command: sleep 65; date. Then reply with its output on one line.')]
const withToolRound = (): unknown[] => [
  ...conversation,
  { type: 'assistant', uuid: '00000000-0000-4000-8000-00000000a001', timestamp: new Date().toISOString(), message: { id: 'm1', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'sleep 65; date' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'user', uuid: '00000000-0000-4000-8000-00000000a002', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sun 27 Sep 2026 21:44:25 BST' }] } },
]

section('0 · the world: a fixture Ollama whose scheduler compares the WHOLE filled runner option set (num_ctx from OLLAMA_CONTEXT_LENGTH, num_batch 512 when a request states none) and restarts the runner, cache emptied, on any difference')
{
  await resetWorld(undefined)
  const seed = state.hits.length
  await fetch(`${ollama.root}/api/generate`, { method: 'POST', body: JSON.stringify({ model: MODEL }) })
  await fetch(`${ollama.root}/api/chat`, { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'x' }], options: { num_batch: MERCURY_BATCH } }) })
  await fetch(`${ollama.root}/api/chat`, { method: 'POST', body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'x' }], options: { num_ctx: SERVER_CONTEXT, num_batch: MERCURY_BATCH } }) })
  const hits = hitsSince(seed)
  check(`a bare load starts the runner at ${optionsWords({ numCtx: SERVER_CONTEXT, numBatch: SERVER_BATCH })}; a chat stating num_batch ${MERCURY_BATCH} restarts it; an explicit num_ctx equal to the server default is no difference`, state.starts.length === 2 && hits[0]!.reloaded && hits[1]!.reloaded && !hits[2]!.reloaded, `${state.starts.map(optionsWords).join(' · ')} — ${shape(hits)}`)
  check('the fixture models the Modelfile-free 27B the owner ran (trained 262144, tools, thinking, no KV geometry stated)', record().modelMaxContext === TRAINED_MAX && record().toolsDeclared === true && record().thinkingDeclared === true && record().geometry === undefined, JSON.stringify(record()))
}

section("1 · the owner's sequence under the window setting `server`: a turn, a 65-second tool round (the served read goes stale), the next turn — the base loads with a BARE option set before the chat and the runner restarts twice per round")
let baseline: { starts: number; sets: string[]; cachedOnRoundTwo: number | undefined }
{
  await resetWorld('server')
  const from = state.hits.length
  state.replyWithToolCall = true
  const first = await send(conversation)
  const firstHits = hitsSince(from)
  const firstChat = firstHits.find(h => h.url === '/api/chat')
  check("turn 1 settled on /api/chat with Mercury's num_batch and the server's own window (no num_ctx, or the served 262144 adopted)", first.error === undefined && firstChat !== undefined && rec(firstChat.body.options)?.num_batch === MERCURY_BATCH && [undefined, SERVER_CONTEXT].includes(rec(firstChat.body.options)?.num_ctx as number | undefined), first.error ?? shape(firstHits))
  const startsAfterFirst = state.starts.length
  record().servedReadAtMs = past()
  state.replyWithToolCall = false
  const again = state.hits.length
  const second = await send(withToolRound())
  const secondHits = hitsSince(again)
  const cachedOnRoundTwo = second.usage?.cache_read_input_tokens
  baseline = { starts: state.starts.length, sets: setsOf(state.hits.slice(from)), cachedOnRoundTwo }
  console.log(`  · turn 1: ${shape(firstHits)}`)
  console.log(`  · turn 2 (after a 65 s tool round): ${shape(secondHits)}`)
  console.log(`  · runner starts across the sequence: ${state.starts.length} — option sets seen: ${baseline.sets.join(' · ')} — cached on turn 2: ${String(cachedOnRoundTwo)}`)
  check('turn 2 settled (no refusal)', second.error === undefined, second.error ?? '')
  check(`ONE option set rides every request to the model (the base sends two: the served-window load ${optionsWords({ numCtx: SERVER_CONTEXT, numBatch: SERVER_BATCH })} beside the chat's ${optionsWords({ numCtx: SERVER_CONTEXT, numBatch: MERCURY_BATCH })})`, baseline.sets.length === 1, baseline.sets.join(' · '))
  check(`the runner started ONCE for the whole sequence (the base restarts it on the load and again on the chat, ${startsAfterFirst} starts by the end of turn 1)`, state.starts.length === 1, `${state.starts.length} starts: ${state.starts.map(optionsWords).join(' · ')}`)
  check('no request after the reply carries a set that differs from the chat\'s: the load before turn 2, when it rides at all, carries the held num_batch', loads(secondHits).every(h => fill(h.body).numBatch === MERCURY_BATCH), shape(secondHits))
  check('turn 2 hit the prompt cache (prompt_eval_cached_count > 0) — the base re-ingests everything (cached 0)', cachedOnRoundTwo !== undefined && cachedOnRoundTwo > 0, `cached ${String(cachedOnRoundTwo)}`)
  check('the session now holds the window the server serves the model at, adopted from /api/ps (no reload) — the chat carries it as num_ctx beside num_batch', heldLocalWindow(record())?.window === SERVER_CONTEXT && heldLocalWindow(record())?.adopted === true && secondHits.some(h => h.url === '/api/chat' && rec(h.body.options)?.num_ctx === SERVER_CONTEXT && rec(h.body.options)?.num_batch === MERCURY_BATCH), `${JSON.stringify(heldLocalWindow(record()))} — ${shape(secondHits)}`)
}

section('2 · the keep-alive touch and the confirmation after the reply carry the SAME set: a touch on the clock is POST /api/generate with the held num_ctx and num_batch, the confirmation is a GET /api/ps — neither restarts the runner')
{
  const history: unknown[] = [userRow('earlier question'), { type: 'assistant', uuid: '00000000-0000-4000-8000-00000000a55f', timestamp: new Date().toISOString(), message: { id: 'm1', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'earlier answer', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }]
  const context = () => ({ systemPrompt: ['x'], userContext: {}, systemContext: {}, toolUseContext: { options: { tools: [], thinkingConfig: { type: 'disabled' }, mainLoopModel: PERSISTED, agentDefinitions: { activeAgents: [], allAgents: [] }, commands: [], mcpClients: [], isNonInteractiveSession: true }, getAppState: () => ({ toolPermissionContext: { mode: 'default' }, mcp: { clients: [], tools: [] }, effortValue: undefined }), setAppState: () => {}, abortController: new AbortController(), messages: history }, forkContextMessages: history })
  bootstrap.setMainLoopModelOverride(PERSISTED)
  const disarm = warmModule.armLocalWarm(context as never, { live: () => true, io: { now: fixtureNow, settleMs: 10, tickMs: 60_000, ceilingMs: 10_000 } })
  const clockStarted = await (async () => {
    const until = Date.now() + 3_000
    while (Date.now() < until) {
      if (warmModule.localWarmFacts().clock === `ollama/${MODEL}`) return true
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    return false
  })()
  const startsBefore = state.starts.length
  const from = state.hits.length
  await warmModule.tick()
  const hits = hitsSince(from)
  const touch = hits.find(h => h.url === '/api/generate')
  check('the clock runs for the model (the warm itself was skipped: the conversation carries rows)', clockStarted && warmModule.localWarmFacts().skipped >= 1, JSON.stringify(warmModule.localWarmFacts()))
  check('the tick read /api/ps and touched: POST /api/generate {model, keep_alive 30m, options} with the held num_ctx and num_batch', touch !== undefined && touch.body.keep_alive === '30m' && rec(touch.body.options)?.num_ctx === SERVER_CONTEXT && rec(touch.body.options)?.num_batch === MERCURY_BATCH && hits[0]?.url === '/api/ps', shape(hits))
  check('the touch did not restart the runner', state.starts.length === startsBefore && touch?.reloaded === false, `${state.starts.length - startsBefore} restart(s)`)
  disarm()
  const { keepAliveTouchDue } = warmModule
  const soon = new Date(fixtureNow() + 4 * 60_000).toISOString()
  check("pure: under `server` with no held num_ctx, a runner another client holds at another window is NOT touched (the served figure this session read decides), while the session's own runner is", keepAliveTouchDue({ expires_at: soon, context_length: 65536 }, { numBatch: MERCURY_BATCH }, fixtureNow(), SERVER_CONTEXT).due === false && keepAliveTouchDue({ expires_at: soon, context_length: SERVER_CONTEXT }, { numBatch: MERCURY_BATCH }, fixtureNow(), SERVER_CONTEXT).due === true)
}

section('3 · every seat of the session sends the held set: the main thread, a crewmate and a workflow agent ride /api/chat with the same num_ctx and num_batch — no seat restarts the runner')
{
  await resetWorld(undefined)
  const from = state.hits.length
  const seats: Array<{ label: string; text: string; extra: Record<string, unknown> }> = [
    { label: 'the main thread', text: 'x'.repeat(80_000), extra: { querySource: 'main_thread' } },
    { label: 'a crewmate (Agent tool, mercury-crew)', text: 'y'.repeat(20_000), extra: { agentId: 'agent-000001', querySource: 'agent:builtin:mercury-crew' } },
    { label: 'a workflow agent (Workflow tool agent() call)', text: 'z'.repeat(60_000), extra: { agentId: 'agent-000002', querySource: 'agent:custom' } },
  ]
  for (const seat of seats) {
    const at = state.hits.length
    const outcome = await send([userRow(seat.text)], seat.extra, 'router')
    check(`${seat.label}: sent and settled`, outcome.error === undefined && outcome.texts.some(t => t.includes('pong')), outcome.error ?? shape(hitsSince(at)))
  }
  const sets = setsOf(hitsSince(from))
  check('one option set across the three seats and the runner started once', sets.length === 1 && state.starts.length === 1, `${sets.join(' · ')} — ${state.starts.length} start(s)`)
  const knobs = seam(windowModule.heldLocalKnobs)(record())
  check('the touch would carry that same set (the hold is the single source: heldLocalKnobs)', knobs !== undefined && JSON.stringify(knobs) === JSON.stringify({ numCtx: heldLocalWindow(record())?.window, numBatch: MERCURY_BATCH }), knobs === undefined ? 'no heldLocalKnobs seam' : JSON.stringify(knobs))
}

section('4 · a second session on the box (L26): the model is already resident at a window another session chose — under `server` a resident window that fits is adopted and never reloaded; under auto a resident window smaller than the session\'s own choice is reloaded once, up to the full window; an outgrown adoption is re-decided')
{
  const foreign = { numCtx: 131072, numBatch: MERCURY_BATCH }
  await resetWorld(undefined, { resident: foreign })
  check('discovery saw the model loaded at 131072 (served) by the other session', record().contextWindow?.tokens === 131072 && record().contextWindow?.source === 'served' && record().loaded === true, JSON.stringify(record().contextWindow))
  const autoFrom = state.hits.length
  const auto = await send([userRow('w'.repeat(40_000))])
  const autoChat = hitsSince(autoFrom).find(h => h.url === '/api/chat')
  check('under auto on an unread machine the session\'s own choice is the trained max (262144): the smaller resident window is NOT adopted — the chat carried 262144 and the runner restarted once, so auto still lands at the full window', auto.error === undefined && autoChat !== undefined && rec(autoChat.body.options)?.num_ctx === TRAINED_MAX && state.starts.length === 1 && heldLocalWindow(record())?.adopted === undefined && heldLocalWindow(record())?.reason === 'max', `${shape(hitsSince(autoFrom))} — ${state.starts.length} start(s) — ${JSON.stringify(heldLocalWindow(record()))}`)
  await resetWorld('server', { resident: foreign })
  const from = state.hits.length
  const outcome = await send([userRow('w'.repeat(40_000))])
  const hits = hitsSince(from)
  const chat = hits.find(h => h.url === '/api/chat')
  check('under `server` the ~10k-token turn adopted 131072: the chat carried num_ctx 131072 and the runner was NOT restarted (the base sends no num_ctx, Ollama fills its 262144 default and evicts the other session\'s copy)', outcome.error === undefined && chat !== undefined && rec(chat.body.options)?.num_ctx === 131072 && state.starts.length === 0, `${shape(hits)} — ${state.starts.length} start(s)`)
  check('the hold says so: adopted, reason srv, the words name the server\'s window', heldLocalWindow(record())?.adopted === true && heldLocalWindow(record())?.reason === 'srv' && (heldLocalWindow(record())?.words ?? '').includes('already holds'), JSON.stringify(heldLocalWindow(record())))
  check('the /config value words read the adopted figure as held this session', windowModule.localWindowValueWords(record()).includes('128k held this session (the window the server holds it at)'), windowModule.localWindowValueWords(record()))
  const again = state.hits.length
  const grown = await send([userRow('w'.repeat(600_000))])
  const grownHits = hitsSince(again)
  const grownChat = grownHits.find(h => h.url === '/api/chat')
  check('a later turn that outgrows the adopted window (≈150k) drops it and re-decides from the setting: under `server` the chat rode without num_ctx (the server\'s own 262144) and the runner restarted once — a reload only when the room is needed', grown.error === undefined && grownChat !== undefined && rec(grownChat.body.options)?.num_ctx === undefined && state.starts.length === 1 && heldLocalWindow(record())?.adopted === undefined, `${shape(grownHits)} — ${state.starts.length} start(s) — ${JSON.stringify(heldLocalWindow(record()))}`)
  await resetWorld(131072, { resident: { numCtx: 65536, numBatch: MERCURY_BATCH } })
  const set = state.hits.length
  const explicit = await send([userRow('v'.repeat(40_000))])
  const setChat = hitsSince(set).find(h => h.url === '/api/chat')
  check('an explicit setting (128k) is never overridden by adoption: the chat carried 131072 and the runner restarted', explicit.error === undefined && rec(setChat?.body.options)?.num_ctx === 131072 && state.starts.length === 1 && heldLocalWindow(record())?.adopted === undefined, `${shape(hitsSince(set))} — ${state.starts.length} start(s)`)
  const adoptable = seam(windowModule.adoptableLocalWindow)
  check('pure: adoptable only under auto or server, only when the resident window fits the estimate plus the output floor and is no smaller than the session\'s own choice, never when it equals the hold', adoptable({ window: 49152, setting: undefined }, 131072, 10_000) === true && adoptable({ window: undefined, setting: 'server' }, 131072, 10_000) === true && adoptable({ window: 49152, setting: 131072 }, 262144, 10_000) === false && adoptable({ window: 49152, setting: undefined }, 8192, 10_000) === false && adoptable({ window: 131072, setting: undefined }, 131072, 10_000) === false && adoptable({ window: 49152, setting: undefined }, 12_000, 11_500) === false && adoptable({ window: 262144, setting: undefined }, 131072, 10_000) === false, windowModule.adoptableLocalWindow === undefined ? 'no adoptableLocalWindow seam' : '')
}

section('5 · the served-window load itself: when the model is not resident and the window is the server\'s to choose, the load carries the held set (never a bare {model}); when the model IS resident, the road reads /api/ps and sends no load at all')
{
  await resetWorld('server')
  const from = state.hits.length
  const outcome = await send([userRow('q'.repeat(20_000))])
  const hits = hitsSince(from)
  const load = hits.find(h => h.url === '/api/generate')
  check('the first send under `server` on a cold server: GET /api/ps (not resident) → POST /api/generate carrying num_batch → GET /api/ps → the chat', outcome.error === undefined && hits[0]?.url === '/api/ps' && load !== undefined && rec(load.body.options)?.num_batch === MERCURY_BATCH && hits.indexOf(load) < hits.findIndex(h => h.url === '/api/chat'), shape(hits))
  check('one runner start for the load and the chat together (the same filled set)', state.starts.length === 1, `${state.starts.length}: ${state.starts.map(optionsWords).join(' · ')}`)
  record().servedReadAtMs = past()
  const again = state.hits.length
  await send([userRow('q'.repeat(20_000)), userRow('more')])
  const later = hitsSince(again)
  check('a stale read with the model resident: GET /api/ps, then the chat — no load rides', later[0]?.url === '/api/ps' && !later.some(h => h.url === '/api/generate') && later.some(h => h.url === '/api/chat') && state.starts.length === 1, shape(later))
  const base = state.hits.length
  const discoveryModule = (await import('../../src/services/providers/local/localDiscovery.ts')) as Record<string, ((...args: never[]) => unknown) | undefined>
  const loadBody = seam(discoveryModule.ollamaLoadBody as ((id: string, load?: { numCtx?: number; numBatch?: number }) => unknown) | undefined)
  check('pure: the load body carries exactly the knobs it is given, and none when given none', JSON.stringify(loadBody(MODEL, { numCtx: 4096, numBatch: 512 })) === JSON.stringify({ model: MODEL, options: { num_ctx: 4096, num_batch: 512 } }) && JSON.stringify(loadBody(MODEL, { numBatch: 2048 })) === JSON.stringify({ model: MODEL, options: { num_batch: 2048 } }) && JSON.stringify(loadBody(MODEL)) === JSON.stringify({ model: MODEL }), discoveryModule.ollamaLoadBody === undefined ? 'no ollamaLoadBody seam' : '')
  check('nothing else rode the wire for that check', state.hits.length === base)
}

ollama.server.close()
rmSync(HOME, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
