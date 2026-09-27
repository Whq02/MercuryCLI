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
  servedAfterLoad: number | undefined
  statesMax: boolean
  hits: Hit[]
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

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
        if (url === '/api/tags') return json(res, 200, { models: [{ name: MODEL, model: MODEL, size: 6594474711, details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' } }] })
        if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
        if (url === '/api/ps') {
          return json(res, 200, {
            models: state.loaded && state.servedAfterLoad !== undefined ? [{ name: MODEL, model: MODEL, size: 11400000000, size_vram: 11400000000, context_length: state.servedAfterLoad, expires_at: '2026-01-01T00:00:00Z' }] : [],
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
          state.loaded = true
          return json(res, 200, { model: body.model, created_at: '2026-01-01T00:00:00Z', response: '', done: true, done_reason: 'load' })
        }
        if (url === '/v1/chat/completions' && req.method === 'POST') {
          state.loaded = true
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }] }))
          res.write(sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 62000, completion_tokens: 1, total_tokens: 62001 } }))
          res.write('data: [DONE]\n\n')
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

const state: FixtureState = { loaded: false, servedAfterLoad: 262144, statesMax: true, hits: [] }
const ollama = await ollamaFixture(state)
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest, LOCAL_DISCOVERY_TTL_MS } = discovery
const { localRecordFor, getLocalModelOptions } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')

const PERSISTED = `local/${MODEL}`

type Yielded = { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ text?: string }> | string } }
function textOf(m: Yielded | undefined): string {
  const content = m?.message?.content
  if (typeof content === 'string') return content
  return (content ?? []).map(b => b.text ?? '').join('')
}
async function send(road: 'local' | 'router', extra: Record<string, unknown> = {}, chars = 248_000): Promise<{ error: string | undefined; texts: string[] }> {
  const params = {
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
  const yielded: Yielded[] = []
  for await (const item of road === 'local' ? localCallModel(params) : routedCallModel(params as never)) yielded.push(item as never)
  const error = yielded.find(m => m.type === 'assistant' && m.isApiErrorMessage === true)
  return { error: error ? textOf(error) : undefined, texts: yielded.filter(m => m.type === 'assistant' && m.isApiErrorMessage !== true).map(textOf) }
}
const hitsSince = (from: number): Hit[] => state.hits.slice(from)
const shape = (hits: Hit[]): string => hits.map(h => `${h.method} ${h.url}`).join(' → ')

section('1 · discovery with nothing loaded: the window is ABSENT, the trained maximum beside it, nothing invented')
{
  await refreshLocalDiscovery({ force: true })
  const record = localRecordFor(PERSISTED)!
  check('the record exists with the trained maximum and no served window', record !== undefined && record.contextWindow === undefined && record.modelMaxContext === 262144 && record.loaded === false, JSON.stringify(record?.contextWindow))
  const budget = resolveContextWindow(PERSISTED)
  check('the budget is the LABELLED fallback until first send (never 4096)', budget.effectiveWindow === 200_000 && budget.source === 'fallback' && (budget.fallbackReason ?? '').includes('not loaded'), JSON.stringify(budget))
  check('no load was sent by discovery (a probe never loads a model)', !state.hits.some(h => h.url === '/api/generate' || h.url === '/v1/chat/completions'), shape(state.hits))
}

section('2 · first send, the model unloaded: load-then-read, the 62k request is SENT (no refusal, no fold)')
{
  const from = state.hits.length
  const epochBefore = catalogueEpoch()
  const outcome = await send('local')
  const hits = hitsSince(from)
  const load = hits.find(h => h.url === '/api/generate')
  const ps = hits.find(h => h.url === '/api/ps')
  const chat = hits.find(h => h.url === '/v1/chat/completions')
  check('the send LOADED the model first: POST /api/generate {model} with no prompt and no options', load !== undefined && load.method === 'POST' && load.body.model === MODEL && !('prompt' in load.body) && !('options' in load.body), JSON.stringify(load?.body))
  check('then read /api/ps, then the chat request — in that order', load !== undefined && ps !== undefined && chat !== undefined && hits.indexOf(load) < hits.indexOf(ps) && hits.indexOf(ps) < hits.indexOf(chat), shape(hits))
  check('the ≈62k-token request was SENT — no refusal, the reply settled', outcome.error === undefined && outcome.texts.some(t => t.includes('pong')), outcome.error ?? outcome.texts.join('|'))
  const record = localRecordFor(PERSISTED)!
  check('the record now holds the SERVED figure the server stated (262144, served, loaded)', record.contextWindow?.tokens === 262144 && record.contextWindow.source === 'served' && record.loaded === true, JSON.stringify(record.contextWindow))
  check('the catalogue epoch bumped (surfaces re-derive the window)', catalogueEpoch() > epochBefore)
  check('the budget now reads the served figure live-current', resolveContextWindow(PERSISTED).effectiveWindow === 262144 && resolveContextWindow(PERSISTED).source === 'live-current', JSON.stringify(resolveContextWindow(PERSISTED)))
}

section('3 · the second send inside the TTL: no load, no ps read — the record is current')
{
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check('only the chat request rode the wire', hits.length === 1 && hits[0]!.url === '/v1/chat/completions' && outcome.error === undefined, shape(hits))
}

section('4 · the same fixture serving 8192 after the load: the refusal fires with 8192 · served, and NO chat request escapes')
{
  __resetLocalDiscoveryForTest()
  state.loaded = false
  state.servedAfterLoad = 8192
  state.hits.length = 0
  await refreshLocalDiscovery({ force: true })
  check('discovery again states no window', localRecordFor(PERSISTED)!.contextWindow === undefined)
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check('the load-then-read ran before the decision', hits.some(h => h.url === '/api/generate') && hits.some(h => h.url === '/api/ps'), shape(hits))
  check('the refusal carries the SERVED figure and its source, never a guess', outcome.error !== undefined && outcome.error.includes('8192 tokens — served') && !outcome.error.includes('4096'), outcome.error ?? 'no error')
  check('the remedy names the in-app road before the server env', (outcome.error ?? '').includes('/config → Local model window') && (outcome.error ?? '').indexOf('/config → Local model window') < (outcome.error ?? '').indexOf('OLLAMA_CONTEXT_LENGTH'), outcome.error ?? '')
  check('NO chat request reached the server', !hits.some(h => h.url === '/v1/chat/completions'), shape(hits))
}

section('5 · a server that states nothing (ps stays empty, show carries no max): the request is SENT — an unstated window is the server\'s business')
{
  __resetLocalDiscoveryForTest()
  state.loaded = false
  state.servedAfterLoad = undefined
  state.statesMax = false
  state.hits.length = 0
  await refreshLocalDiscovery({ force: true })
  const record = localRecordFor(PERSISTED)!
  check('discovery: no window, no trained maximum', record.contextWindow === undefined && record.modelMaxContext === undefined)
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check('the load-then-read ran and learned nothing', hits.some(h => h.url === '/api/generate') && hits.some(h => h.url === '/api/ps') && localRecordFor(PERSISTED)!.contextWindow === undefined, shape(hits))
  check('the request was SENT (no refusal)', outcome.error === undefined && hits.some(h => h.url === '/v1/chat/completions'), outcome.error ?? shape(hits))
}

section('6 · staleness: a snapshot older than the TTL is re-read at send (now injected); a fresh one is not')
{
  __resetLocalDiscoveryForTest()
  state.loaded = true
  state.servedAfterLoad = 262144
  state.statesMax = true
  state.hits.length = 0
  const past = Date.now() - LOCAL_DISCOVERY_TTL_MS - 60_000
  await refreshLocalDiscovery({ force: true, now: () => past })
  const record = localRecordFor(PERSISTED)!
  check('discovery saw the model loaded at 262144 (served)', record.contextWindow?.tokens === 262144 && record.contextWindow.source === 'served')
  state.servedAfterLoad = 131072
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check('the stale record was re-read at send (load, then ps) before the chat request', hits.some(h => h.url === '/api/generate') && hits.some(h => h.url === '/api/ps') && outcome.error === undefined, shape(hits))
  check('the record follows the server: 131072 served (the runner was reloaded outside Mercury)', localRecordFor(PERSISTED)!.contextWindow?.tokens === 131072, JSON.stringify(localRecordFor(PERSISTED)!.contextWindow))
  const fresh = state.hits.length
  await send('local')
  check('the read stamped the record fresh: the next send inside the TTL rides the chat request alone', hitsSince(fresh).every(h => h.url === '/v1/chat/completions'), shape(hitsSince(fresh)))
}

section('7 · the second face: the model unloads (keep-alive expiry, eviction) — the next send past the TTL loads it again and reads the window')
{
  __resetLocalDiscoveryForTest()
  state.loaded = true
  state.servedAfterLoad = 262144
  state.hits.length = 0
  const past = Date.now() - LOCAL_DISCOVERY_TTL_MS - 60_000
  await refreshLocalDiscovery({ force: true, now: () => past })
  state.loaded = false
  const from = state.hits.length
  const outcome = await send('local')
  const hits = hitsSince(from)
  check('the send loaded the unloaded model (POST /api/generate) and read ps before the chat request', hits[0]?.url === '/api/generate' && hits[1]?.url === '/api/ps' && hits[2]?.url === '/v1/chat/completions' && outcome.error === undefined, shape(hits))
  check('the record states served 262144 and loaded again', localRecordFor(PERSISTED)!.contextWindow?.tokens === 262144 && localRecordFor(PERSISTED)!.loaded === true)
}

section('8 · every road: the main thread (62k), a crewmate (17k) and a workflow agent (57k) — each from a snapshot probed with nothing loaded — are SENT, none refused, no fold')
{
  const roads: Array<{ label: string; chars: number; extra: Record<string, unknown> }> = [
    { label: 'the main thread (62k tokens, repl_main_thread)', chars: 248_000, extra: { querySource: 'repl_main_thread' } },
    { label: 'a crewmate (17k tokens, Agent tool, mercury-general)', chars: 68_000, extra: { agentId: 'agent-000001', querySource: 'agent:builtin:mercury-general' } },
    { label: 'a workflow agent (57k tokens, Workflow tool agent() call)', chars: 228_000, extra: { agentId: 'agent-000002', querySource: 'agent:custom' } },
  ]
  for (const road of roads) {
    __resetLocalDiscoveryForTest()
    state.loaded = false
    state.servedAfterLoad = 262144
    state.statesMax = true
    state.hits.length = 0
    await refreshLocalDiscovery({ force: true })
    check(`${road.label}: the process snapshot states no window (probed with nothing loaded)`, localRecordFor(PERSISTED)!.contextWindow === undefined)
    const from = state.hits.length
    const outcome = await send('router', road.extra, road.chars)
    const hits = hitsSince(from)
    check(`${road.label}: the dispatch loaded, read ps, then was SENT — no refusal, no fold`, hits[0]?.url === '/api/generate' && hits[1]?.url === '/api/ps' && hits.some(h => h.url === '/v1/chat/completions') && outcome.error === undefined && outcome.texts.some(t => t.includes('pong')), outcome.error ?? shape(hits))
  }
}

section('9 · one /model open shows the server\'s current truth: the open\'s forced probe repaints the rows when it lands')
{
  __resetLocalDiscoveryForTest()
  state.loaded = false
  state.servedAfterLoad = 262144
  state.hits.length = 0
  await refreshLocalDiscovery({ force: true })
  const before = getLocalModelOptions().find(r => r.value === PERSISTED)!
  check('before the change: no column (nothing stated)', before.statedContextWindow === undefined)
  state.loaded = true
  const epochBefore = catalogueEpoch()
  await refreshLocalDiscovery({ force: true })
  const after = getLocalModelOptions().find(r => r.value === PERSISTED)!
  check('the FIRST open after the change shows the new window (the epoch bumped, the rows re-derive)', after.statedContextWindow === 262144 && catalogueEpoch() > epochBefore, `${after.statedContextWindow} · epoch ${epochBefore} → ${catalogueEpoch()}`)
}

ollama.server.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
