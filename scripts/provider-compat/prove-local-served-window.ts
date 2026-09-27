#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-served-window-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_DISABLE_1M_CONTEXT

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const MODEL = 'qwen3.5:9b-q4_K_M'
type Hit = { method: string; url: string; body: Record<string, unknown> }
type FixtureState = {
  loaded: boolean
  loadedCtx: number | undefined
  serverDefault: number | undefined
  statesMax: boolean
  hits: Hit[]
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function ollamaFixture(state: FixtureState): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const url = req.url ?? ''
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        state.hits.push({ method: req.method ?? 'GET', url, body })
        const load = (): void => {
          const options = body.options as { num_ctx?: number } | undefined
          state.loaded = true
          state.loadedCtx = options?.num_ctx !== undefined ? Math.min(options.num_ctx, 262144) : state.serverDefault
        }
        if (url === '/api/tags') return json(res, 200, { models: [{ name: MODEL, model: MODEL, size: 6594474711, details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' } }] })
        if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
        if (url === '/api/ps') {
          return json(res, 200, {
            models: state.loaded && state.loadedCtx !== undefined ? [{ name: MODEL, model: MODEL, size: 11400000000, size_vram: 11400000000, context_length: state.loadedCtx, expires_at: '2026-01-01T00:00:00Z' }] : [],
          })
        }
        if (url === '/api/show' && req.method === 'POST') {
          if (body.model !== MODEL) return json(res, 404, { error: `model '${String(body.model)}' not found` })
          return json(res, 200, {
            modelfile: '',
            parameters: 'top_k 20\ntop_p 0.95\ntemperature 1',
            details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' },
            model_info: { 'general.architecture': 'qwen35', ...(state.statesMax ? { 'qwen35.context_length': 262144 } : {}) },
            capabilities: ['completion', 'vision', 'tools', 'thinking'],
          })
        }
        if (url === '/api/generate' && req.method === 'POST') {
          load()
          return json(res, 200, { model: body.model, created_at: '2026-01-01T00:00:00Z', response: '', done: true, done_reason: 'load' })
        }
        if (url === '/api/chat' && req.method === 'POST') {
          load()
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          res.write(JSON.stringify({ model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'pong' }, done: false }) + '\n')
          res.write(JSON.stringify({ model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 62000, eval_count: 1 }) + '\n')
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

const state: FixtureState = { loaded: false, loadedCtx: undefined, serverDefault: 262144, statesMax: true, hits: [] }
const ollama = await ollamaFixture(state)
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest, LOCAL_DISCOVERY_TTL_MS } = discovery
const { localRecordFor, getLocalModelOptions } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel, localPreComposeEstimate } = await import('../../src/services/providers/local/localCallModel.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
const windowModule = await import('../../src/services/providers/local/localWindow.ts')
const { doubledRequestWindow: autoLocalWindow, writeLocalWindowSetting, __resetLocalWindowsForTest, heldLocalWindow } = windowModule

const PERSISTED = `local/${MODEL}`

type Yielded = { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ text?: string }> | string } }
function textOf(m: Yielded | undefined): string {
  const content = m?.message?.content
  if (typeof content === 'string') return content
  return (content ?? []).map(b => b.text ?? '').join('')
}
function paramsFor(chars: number, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    messages: [{ type: 'user', message: { role: 'user', content: 'x'.repeat(chars) }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: [] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: {
      model: PERSISTED,
      querySource: 'user',
      getToolPermissionContext: async () => ({ mode: 'default' }) as never,
      ...extra,
    } as never,
  }
}
async function send(road: 'local' | 'router', extra: Record<string, unknown> = {}, chars = 248_000): Promise<{ error: string | undefined; texts: string[] }> {
  const params = paramsFor(chars, extra)
  const yielded: Yielded[] = []
  for await (const item of road === 'local' ? localCallModel(params as never) : routedCallModel(params as never)) yielded.push(item as never)
  const error = yielded.find(m => m.type === 'assistant' && m.isApiErrorMessage === true)
  return { error: error ? textOf(error) : undefined, texts: yielded.filter(m => m.type === 'assistant' && m.isApiErrorMessage !== true).map(textOf) }
}
const hitsSince = (from: number): Hit[] => state.hits.slice(from)
const numCtxOf = (hit: Hit | undefined): number | undefined => (hit?.body.options as { num_ctx?: number } | undefined)?.num_ctx
const shape = (hits: Hit[]): string => hits.map(h => `${h.method} ${h.url}${h.url === '/api/chat' || h.url === '/api/generate' ? ` num_ctx=${String(numCtxOf(h))}` : ''}`).join(' → ')
function resetWorld(opts: { loaded: boolean; serverDefault?: number; statesMax?: boolean; setting?: 'server' | 'max' | number | undefined }): void {
  __resetLocalDiscoveryForTest()
  __resetLocalWindowsForTest()
  state.loaded = opts.loaded
  state.loadedCtx = opts.loaded ? (opts.serverDefault ?? 262144) : undefined
  state.serverDefault = opts.serverDefault ?? 262144
  state.statesMax = opts.statesMax ?? true
  state.hits.length = 0
  writeLocalWindowSetting({ id: MODEL }, opts.setting)
}
const record = (): NonNullable<ReturnType<typeof localRecordFor>> => localRecordFor(PERSISTED)!
const EST_62K = localPreComposeEstimate(paramsFor(248_000, {}) as never)
const AUTO_62K = 262144

section('1 · discovery with nothing loaded: the window is ABSENT, the trained maximum beside it, nothing invented')
{
  resetWorld({ loaded: false })
  await refreshLocalDiscovery({ force: true })
  check('the record exists with the trained maximum and no served window', record().contextWindow === undefined && record().modelMaxContext === 262144 && record().loaded === false, JSON.stringify(record().contextWindow))
  const budget = resolveContextWindow(PERSISTED)
  check('the budget is the LABELLED fallback until first send (never 4096)', budget.effectiveWindow === 200_000 && budget.source === 'fallback' && (budget.fallbackReason ?? '').includes('not loaded'), JSON.stringify(budget))
  check('no load was sent by discovery (a probe never loads a model)', !state.hits.some(h => h.url === '/api/generate' || h.url === '/api/chat'), shape(state.hits))
  check('this fixture states no KV geometry and the machine is not read, so auto is the trained max the model states: 256k for the ≈62k request (never twice the estimate — the window comes out bigger, not smaller)', record().geometry === undefined && windowModule.chooseLocalWindow(record(), EST_62K, undefined, null).window === AUTO_62K && windowModule.chooseLocalWindow(record(), EST_62K, undefined, null).reason === 'max' && autoLocalWindow(EST_62K, 262144) === 131072, `${EST_62K} → ${windowModule.chooseLocalWindow(record(), EST_62K, undefined, null).window}`)
}

section('2 · first send under the auto default (nothing set): the request rides /api/chat with the chosen num_ctx, is SENT, and /api/ps confirms the served figure')
{
  const from = state.hits.length
  const epochBefore = catalogueEpoch()
  const outcome = await send('local')
  const hits = hitsSince(from)
  const chat = hits.find(h => h.url === '/api/chat')
  const ps = hits.find(h => h.url === '/api/ps')
  check('no pre-load rode the wire (the chat request itself loads the model with its window)', !hits.some(h => h.url === '/api/generate'), shape(hits))
  check('the chat request carries options.num_ctx = the chosen window (256k, the trained max on an unread machine), num_batch 2048 and truncate:false', chat !== undefined && numCtxOf(chat) === AUTO_62K && (chat.body.options as { num_batch?: number }).num_batch === 2048 && chat.body.truncate === false && chat.body.stream === true, JSON.stringify(chat?.body.options))
  check('the ≈62k-token request was SENT — no refusal, the reply settled', outcome.error === undefined && outcome.texts.some(t => t.includes('pong')), outcome.error ?? outcome.texts.join('|'))
  check('then /api/ps confirmed the served figure (after the chat, never before)', chat !== undefined && ps !== undefined && hits.includes(chat) && hits.includes(ps) && hits.indexOf(chat) < hits.indexOf(ps), shape(hits))
  check('the record holds the SERVED figure the server stated for that load (262144, served, loaded) and the measured size /api/ps reported beside it (11.4 GB — the figure the fit trusts over the formula)', record().contextWindow?.tokens === AUTO_62K && record().contextWindow?.source === 'served' && record().loaded === true && record().servedBytes === 11400000000, JSON.stringify({ window: record().contextWindow, bytes: record().servedBytes }))
  check('the window is HELD for the session (auto → 256k)', heldLocalWindow(record())?.window === AUTO_62K && heldLocalWindow(record())?.setting === undefined)
  check('the catalogue epoch bumped (surfaces re-derive the window)', catalogueEpoch() > epochBefore)
  check('the budget now reads the served figure live-current', resolveContextWindow(PERSISTED).effectiveWindow === AUTO_62K && resolveContextWindow(PERSISTED).source === 'live-current', JSON.stringify(resolveContextWindow(PERSISTED)))
}

section('3 · the second send inside the TTL: the same held num_ctx, one chat request, no ps read')
{
  const from = state.hits.length
  const outcome = await send('local', {}, 8_000)
  const hits = hitsSince(from)
  check('only the chat request rode the wire, carrying the SAME held window (no re-decision for a smaller request)', hits.length === 1 && hits[0]!.url === '/api/chat' && numCtxOf(hits[0]) === AUTO_62K && outcome.error === undefined, shape(hits))
}

section('4 · the setting "server": the server chooses; Mercury loads with no options, reads /api/ps, then sends without num_ctx')
{
  resetWorld({ loaded: false, setting: 'server' })
  await refreshLocalDiscovery({ force: true })
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check('the send LOADED the model first: POST /api/generate {model} with no options', hits[0]?.url === '/api/generate' && hits[0].body.model === MODEL && !('options' in hits[0].body), shape(hits))
  check('then /api/ps, then the chat request WITHOUT num_ctx — in that order', hits[1]?.url === '/api/ps' && hits[2]?.url === '/api/chat' && numCtxOf(hits[2]) === undefined && outcome.error === undefined, shape(hits))
  check("the record holds the server's own figure (262144, served)", record().contextWindow?.tokens === 262144 && record().contextWindow?.source === 'served', JSON.stringify(record().contextWindow))
}

section('5 · the setting "server" on a server whose own choice is 8192: the refusal fires with 8192 · served, no request escapes')
{
  resetWorld({ loaded: false, serverDefault: 8192, setting: 'server' })
  await refreshLocalDiscovery({ force: true })
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check('the load-then-read ran before the decision', hits.some(h => h.url === '/api/generate') && hits.some(h => h.url === '/api/ps'), shape(hits))
  check('the refusal carries the SERVED figure and its source, never a guess', outcome.error !== undefined && outcome.error.includes('8192 tokens — served') && !outcome.error.includes('4096'), outcome.error ?? 'no error')
  check('the remedy names the in-app road before the server env', (outcome.error ?? '').includes('/config → Local model window') && (outcome.error ?? '').indexOf('/config → Local model window') < (outcome.error ?? '').indexOf('OLLAMA_CONTEXT_LENGTH'), outcome.error ?? '')
  check('NO chat request reached the server', !hits.some(h => h.url === '/api/chat'), shape(hits))
}

section('6 · a user setting of 8192 on a ≈62k request: refused on the setting, naming it as the source — nothing reaches the server')
{
  resetWorld({ loaded: false, setting: 8192 })
  await refreshLocalDiscovery({ force: true })
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check("the refusal names the setting as the window's source", outcome.error !== undefined && outcome.error.includes('8192 tokens — your setting — /config → Local model window'), outcome.error ?? 'no error')
  check('no load and no chat request rode the wire', !hits.some(h => h.url === '/api/chat' || h.url === '/api/generate'), shape(hits))
}

section('7 · a server that states no trained maximum and serves nothing yet: auto still chooses (2 × the request, never under 64k) and the request is SENT')
{
  resetWorld({ loaded: false, statesMax: false })
  await refreshLocalDiscovery({ force: true })
  check('discovery: no window, no trained maximum', record().contextWindow === undefined && record().modelMaxContext === undefined)
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  const chat = hits.find(h => h.url === '/api/chat')
  check('the request was SENT with num_ctx 128k', outcome.error === undefined && chat !== undefined && numCtxOf(chat) === autoLocalWindow(EST_62K), outcome.error ?? shape(hits))
  check('a tiny first request on a model that states no trained max gets the 64k floor (the arithmetic, pure — bigger, not smaller, when the machine was not read)', autoLocalWindow(1_000) === 65536)
}

section('8 · staleness under "server": a snapshot older than the TTL is re-read at send (now injected); a fresh one is not')
{
  resetWorld({ loaded: true, setting: 'server' })
  const past = Date.now() - LOCAL_DISCOVERY_TTL_MS - 60_000
  await refreshLocalDiscovery({ force: true, now: () => past })
  check('discovery saw the model loaded at 262144 (served) with its measured size', record().contextWindow?.tokens === 262144 && record().contextWindow?.source === 'served' && record().servedBytes === 11400000000)
  state.serverDefault = 131072
  state.loadedCtx = 131072
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check('the stale record was re-read at send (load, then ps) before the chat request', hits[0]?.url === '/api/generate' && hits[1]?.url === '/api/ps' && hits[2]?.url === '/api/chat' && outcome.error === undefined, shape(hits))
  check('the record follows the server: 131072 served (the server was restarted with another default outside Mercury)', record().contextWindow?.tokens === 131072, JSON.stringify(record().contextWindow))
  const fresh = state.hits.length
  await send('local')
  check('the read stamped the record fresh: the next send inside the TTL rides the chat request alone', hitsSince(fresh).every(h => h.url === '/api/chat'), shape(hitsSince(fresh)))
}

section('9 · the second face under auto: the model unloads (keep-alive expiry, eviction) — the next request loads it with the held num_ctx and ps confirms')
{
  resetWorld({ loaded: false })
  const past = Date.now() - LOCAL_DISCOVERY_TTL_MS - 60_000
  await refreshLocalDiscovery({ force: true, now: () => past })
  await send('local')
  check('after the first send the record is served 262144 (auto → the trained max on an unread machine)', record().contextWindow?.tokens === AUTO_62K)
  state.loaded = false
  state.loadedCtx = undefined
  record().servedReadAtMs = past
  const from = state.hits.length
  const outcome = await send('local', {}, 8_000)
  const hits = hitsSince(from)
  check('the chat request carried the held num_ctx and loaded the model (no pre-load); the stale record was confirmed from ps after it', hits[0]?.url === '/api/chat' && numCtxOf(hits[0]) === AUTO_62K && hits[1]?.url === '/api/ps' && !hits.some(h => h.url === '/api/generate') && outcome.error === undefined, shape(hits))
  check('the record states served 262144 and loaded again', record().contextWindow?.tokens === AUTO_62K && record().loaded === true)
  const fresh = state.hits.length
  await send('local', {}, 8_000)
  check('a current record inside the TTL rides the chat request alone (the window it carries is the one held)', hitsSince(fresh).length === 1 && hitsSince(fresh)[0]!.url === '/api/chat', shape(hitsSince(fresh)))
}

section('10 · every road in ONE process: the main thread (62k) decides, a crewmate (17k) and a workflow agent (57k) reuse the held window — all sent, none refused, no fold, no reload')
{
  resetWorld({ loaded: false })
  await refreshLocalDiscovery({ force: true })
  check('the process snapshot states no window (probed with nothing loaded)', record().contextWindow === undefined)
  const roads: Array<{ label: string; chars: number; extra: Record<string, unknown> }> = [
    { label: 'the main thread (62k tokens, repl_main_thread)', chars: 248_000, extra: { querySource: 'repl_main_thread' } },
    { label: 'a crewmate (17k tokens, Agent tool, mercury-general)', chars: 68_000, extra: { agentId: 'agent-000001', querySource: 'agent:builtin:mercury-general' } },
    { label: 'a workflow agent (57k tokens, Workflow tool agent() call)', chars: 228_000, extra: { agentId: 'agent-000002', querySource: 'agent:custom' } },
  ]
  const seen: number[] = []
  for (const road of roads) {
    const from = state.hits.length
    const outcome = await send('router', road.extra, road.chars)
    const hits = hitsSince(from)
    const chat = hits.find(h => h.url === '/api/chat')
    check(`${road.label}: the dispatch rode /api/chat with a num_ctx and was SENT — no refusal, no fold`, chat !== undefined && numCtxOf(chat) !== undefined && outcome.error === undefined && outcome.texts.some(t => t.includes('pong')) && !(outcome.error ?? '').includes('fold'), outcome.error ?? shape(hits))
    if (numCtxOf(chat) !== undefined) seen.push(numCtxOf(chat)!)
  }
  check('all three carried the SAME num_ctx (one chosen window per model per process — a sub-agent never reloads the runner)', seen.length === 3 && seen.every(n => n === seen[0]) && seen[0] === AUTO_62K, JSON.stringify(seen))
}

section("11 · one /model open shows the server's current truth: the open's forced probe repaints the rows when it lands")
{
  resetWorld({ loaded: false })
  await refreshLocalDiscovery({ force: true })
  const before = getLocalModelOptions().find(r => r.value === PERSISTED)!
  check('before the change: no column (nothing stated)', before.statedContextWindow === undefined)
  state.loaded = true
  state.loadedCtx = 262144
  const epochBefore = catalogueEpoch()
  await refreshLocalDiscovery({ force: true })
  const after = getLocalModelOptions().find(r => r.value === PERSISTED)!
  check('the FIRST open after the change shows the new window (the epoch bumped, the rows re-derive)', after.statedContextWindow === 262144 && catalogueEpoch() > epochBefore, `${after.statedContextWindow} · epoch ${epochBefore} → ${catalogueEpoch()}`)
}

ollama.server.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
