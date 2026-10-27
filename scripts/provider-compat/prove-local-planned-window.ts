#!/usr/bin/env bun
// gate-watch: src/services/providers/local/localWindow.ts src/services/providers/local/localCallModel.ts src/utils/model/capabilities.ts src/services/providers/catalogueEpoch.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-planned-window-proof-'))
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
const j = (v: unknown): string => JSON.stringify(v) ?? ''

type Hit = { method: string; url: string; body: Record<string, unknown> }
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
function serve(route: (req: IncomingMessage, body: Record<string, unknown>, res: ServerResponse) => boolean, hits: Hit[]): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        hits.push({ method: req.method ?? 'GET', url: req.url ?? '', body })
        if (!route(req, body, res)) json(res, 404, { error: 'not found' })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}

const CODER = 'qwen2.5-coder:3b'
const BARE = 'bare-no-max:latest'
const VLLM_MODEL = 'Qwen/Qwen3-32B'
const ollamaHits: Hit[] = []
const vllmHits: Hit[] = []
const loaded = new Map<string, number>([[CODER, 4096], [BARE, 4096]])
const ollama = await serve((req, body, res) => {
  const url = req.url ?? ''
  if (url === '/api/tags') return json(res, 200, { models: [CODER, BARE].map(name => ({ name, model: name, size: 1_900_000_000, details: { family: 'qwen2' } })) }), true
  if (url === '/api/version') return json(res, 200, { version: '0.34.4' }), true
  if (url === '/api/ps') return json(res, 200, { models: [...loaded.entries()].map(([name, ctx]) => ({ name, model: name, size: 1_900_000_000, context_length: ctx })) }), true
  if (url === '/api/show') {
    const id = String(body.model ?? '')
    return json(res, 200, { parameters: 'num_ctx                        4096', model_info: id === BARE ? { 'general.architecture': 'qwen2' } : { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 }, capabilities: ['completion', 'tools'] }), true
  }
  if (url === '/api/generate' && req.method === 'POST') {
    const options = body.options as { num_ctx?: number } | undefined
    loaded.set(String(body.model ?? ''), options?.num_ctx ?? 4096)
    return json(res, 200, { model: body.model, response: '', done: true, done_reason: 'load' }), true
  }
  if (url === '/api/chat' && req.method === 'POST') {
    const options = body.options as { num_ctx?: number } | undefined
    const model = String(body.model ?? '')
    loaded.set(model, options?.num_ctx ?? 4096)
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'ok.' }, done: false }) + '\n')
    res.write(JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 2 }) + '\n')
    res.end()
    return true
  }
  return false
}, ollamaHits)
const vllm = await serve((req, _body, res) => {
  if ((req.url ?? '') === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: VLLM_MODEL, object: 'model', owned_by: 'vllm', max_model_len: 40960 }] }), true
  return false
}, vllmHits)

process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root},vllm=${vllm.root}`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const w = await import('../../src/services/providers/local/localWindow.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localGuardWindow, localPromptFitRefusal, localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { resolveContextWindow, getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const userMessage = (content: string): unknown => ({ type: 'user', message: { role: 'user', content }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() })
await refreshLocalDiscovery({ force: true })
const coder = localRecordFor(`local/${CODER}`)!
const bare = localRecordFor(`local/${BARE}`)!
const qwenVllm = localRecordFor(`local/${VLLM_MODEL}`)!
const plan = (record: typeof coder, setting: Parameters<typeof w.localPlannedWindow>[1]) => w.localPlannedWindow(record, setting, null)

section('1 · the planned window (pure): what Mercury will send — a setting clamps to the trained max, max is the trained max, server is the served figure, auto on an unread machine is the trained max; a model stating no trained max follows the request, so it plans nothing')
{
  w.__resetLocalWindowsForTest()
  check('the fixture: served 4,096 (num_ctx 4096 in the Modelfile too), trained max 32,768; the bare model states no trained max', coder.contextWindow?.tokens === 4096 && coder.contextWindow.source === 'served' && coder.modelMaxContext === 32768 && bare.modelMaxContext === undefined && bare.contextWindow?.tokens === 4096, j({ coder: coder.contextWindow, bare: bare.contextWindow }))
  check('32k set ⇒ 32,768 · setting · your setting — /config → Local model window', j(plan(coder, 32768)) === j({ tokens: 32768, source: 'setting', reason: 'set', sourceWords: w.LOCAL_WINDOW_SETTING_WORDS }), j(plan(coder, 32768)))
  check('64k set on a 32k-max model ⇒ 32,768 (the setting clamps to the trained max, as the request does)', plan(coder, 65536)?.tokens === 32768 && plan(coder, 65536)?.reason === 'set', j(plan(coder, 65536)))
  check("'max' ⇒ the trained max 32,768 · reason max", plan(coder, 'max')?.tokens === 32768 && plan(coder, 'max')?.reason === 'max', j(plan(coder, 'max')))
  check("'server' ⇒ the served 4,096 · served · srv", j(plan(coder, 'server')) === j({ tokens: 4096, source: 'served', reason: 'srv', sourceWords: 'served' }), j(plan(coder, 'server')))
  check('auto on an unread machine ⇒ the trained max 32,768 · auto · chosen by Mercury', j(plan(coder, undefined)) === j({ tokens: 32768, source: 'auto', reason: 'max', sourceWords: w.LOCAL_WINDOW_HELD_WORDS }), j(plan(coder, undefined)))
  check('auto on a model stating no trained max: the window follows the request (twice its size, never under 64k) — nothing is planned, the served 4,096 is NOT read', plan(bare, undefined) === undefined, j(plan(bare, undefined)))
  check("'server' on that model still reads its served 4,096; a number still stands", plan(bare, 'server')?.tokens === 4096 && plan(bare, 49152)?.tokens === 49152, j([plan(bare, 'server'), plan(bare, 49152)]))
  check("'max' on a model stating no trained max falls to the served figure", plan(bare, 'max')?.tokens === 4096 && plan(bare, 'max')?.source === 'served', j(plan(bare, 'max')))
}

section('2 · the hold wins while its setting is the current one; a hold left by a previous setting is stale and the new setting is planned instead (no restart to take effect)')
{
  w.__resetLocalWindowsForTest()
  const decided = w.decideLocalWindow(coder, 5_000, 32768, null)
  check('a 32k hold under a 32k setting is the plan: 32,768 · held · set', decided.window === 32768 && j(plan(coder, 32768)) === j({ tokens: 32768, source: 'held', reason: 'set', sourceWords: w.LOCAL_WINDOW_SETTING_WORDS }), j(plan(coder, 32768)))
  check('the setting moves to 16k: the 32k hold is stale, the plan is 16,384 from the setting', plan(coder, 16384)?.tokens === 16384 && plan(coder, 16384)?.source === 'setting', j(plan(coder, 16384)))
  check("the setting moves to 'server': the plan is the served 4,096", plan(coder, 'server')?.tokens === 4096 && plan(coder, 'server')?.source === 'served', j(plan(coder, 'server')))
  const adopted = w.adoptLocalWindow(coder, w.decideLocalWindow(coder, 5_000, undefined, null), 8192)
  check('an adopted window (the server already held the model at 8,192, auto) is the plan: 8,192 · held · srv', adopted.adopted === true && j(plan(coder, undefined)) === j({ tokens: 8192, source: 'held', reason: 'srv', sourceWords: w.LOCAL_WINDOW_HELD_WORDS }), j(plan(coder, undefined)))
  check('the request outgrows the adopted window: it is released and the plan is the auto decision again (32,768)', w.releaseOutgrownLocalWindow(coder, 20_000) === true && plan(coder, undefined)?.tokens === 32768 && plan(coder, undefined)?.source === 'auto', j(plan(coder, undefined)))
  w.__resetLocalWindowsForTest()
}

section('3 · one window serves the guard, the context window and the request: before any request the guard reads the plan (red on the base: the served 4,096), the request carries it, and the hold then agrees')
{
  w.__resetLocalWindowsForTest()
  w.writeLocalWindowSetting(coder, 32768)
  const guard = localGuardWindow(coder)
  check('the guard reads 32,768 — your setting (no hold yet)', guard?.tokens === 32768 && guard?.sourceWords === w.LOCAL_WINDOW_SETTING_WORDS, j(guard))
  check('the context window is 32,768 for the same id', getContextWindowForModel(`local/${CODER}`) === 32768 && resolveContextWindow(`local/${CODER}`).source === 'live-current', j(resolveContextWindow(`local/${CODER}`)))
  const before = ollamaHits.length
  const errors: string[] = []
  for await (const item of localCallModel({
    messages: [userMessage('hello')] as never,
    systemPrompt: ['fixture'] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: `local/${CODER}`, querySource: 'user', getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  })) {
    const row = item as { isApiErrorMessage?: boolean }
    if (row.isApiErrorMessage === true) errors.push(j(item))
  }
  const chat = ollamaHits.slice(before).find(h => h.url === '/api/chat')
  check('the request carried num_ctx 32768 (the guard\'s and the window\'s figure) and settled', (chat?.body.options as { num_ctx?: number } | undefined)?.num_ctx === 32768 && errors.length === 0, j({ options: chat?.body.options, errors }))
  check('the hold now says 32,768 · set and the plan reads it as held', w.heldLocalWindow(coder)?.window === 32768 && w.localPlannedWindow(coder)?.source === 'held' && localGuardWindow(coder)?.tokens === 32768, j(w.localPlannedWindow(coder)))
  check('the server now serves the model at 32,768 and server default would read that', coder.contextWindow?.tokens === 32768 && plan(coder, 'server')?.tokens === 32768, j(coder.contextWindow))
  const explicit = localGuardWindow(coder, w.decideLocalWindow(coder, 5_000, 8192, null))
  check('a hold passed explicitly still rules the guard (8,192 · your setting)', explicit?.tokens === 8192 && explicit?.sourceWords === w.LOCAL_WINDOW_SETTING_WORDS, j(explicit))
  w.__resetLocalWindowsForTest()
}

section('4 · a change repaints: the setting write and every change of the held window bump the catalogue epoch (the gauge and the picker re-derive); the deck\'s reason tag follows the plan')
{
  w.__resetLocalWindowsForTest()
  let epoch = catalogueEpoch()
  w.writeLocalWindowSetting(coder, 65536)
  check('a setting write bumps the epoch', catalogueEpoch() === epoch + 1, `${epoch} → ${catalogueEpoch()}`)
  epoch = catalogueEpoch()
  w.decideLocalWindow(coder, 5_000, 65536, null)
  check('a new hold bumps the epoch once', catalogueEpoch() === epoch + 1, `${epoch} → ${catalogueEpoch()}`)
  epoch = catalogueEpoch()
  w.decideLocalWindow(coder, 9_000, 65536, null)
  check('the same hold reused bumps nothing', catalogueEpoch() === epoch, `${epoch} → ${catalogueEpoch()}`)
  check('the reason tag on the planned figure is the hold\'s reason (set), and nothing for another figure', w.localWindowReasonTag(`local/${CODER}`, 32768) === 'set' && w.localWindowReasonTag(`local/${CODER}`, 4096) === undefined, j([w.localWindowReasonTag(`local/${CODER}`, 32768), w.localWindowReasonTag(`local/${CODER}`, 4096)]))
  w.writeLocalWindowSetting(coder, undefined)
  check('under auto with the stale hold, the tag reads the planned auto decision (max) on its figure', w.localWindowReasonTag(`local/${CODER}`, 32768) === 'max', String(w.localWindowReasonTag(`local/${CODER}`, 32768)))
  w.__resetLocalWindowsForTest()
}

section('5 · a server that cannot be told a window (vLLM, set at server start) reads its stated window whatever the setting; the guard too')
{
  w.__resetLocalWindowsForTest()
  check('the vLLM record states served 40,960', qwenVllm.server === 'vllm' && qwenVllm.contextWindow?.tokens === 40960 && qwenVllm.contextWindow.source === 'served', j(qwenVllm.contextWindow))
  for (const setting of [undefined, 'server', 'max', 131072] as const) {
    check(`setting ${j(setting) || 'auto'} ⇒ the plan is the served 40,960`, j(plan(qwenVllm, setting)) === j({ tokens: 40960, source: 'served', reason: 'srv', sourceWords: 'served' }), j(plan(qwenVllm, setting)))
  }
  w.writeLocalWindowSetting(qwenVllm, 131072)
  check('the context window and the guard read 40,960 with 128k set', getContextWindowForModel(`local/${VLLM_MODEL}`) === 40960 && localGuardWindow(qwenVllm)?.tokens === 40960, j([getContextWindowForModel(`local/${VLLM_MODEL}`), localGuardWindow(qwenVllm)]))
  w.writeLocalWindowSetting(qwenVllm, undefined)
}

section('6 · the pre-flight seam: a prompt the chosen window cannot hold refuses with the real numbers before any ladder; a prompt that fits refuses nothing; a model following the request refuses nothing')
{
  w.__resetLocalWindowsForTest()
  w.writeLocalWindowSetting(coder, 4096)
  const bigSystem = ['the system prompt of this session. '.repeat(1_573)]
  const params = { messages: [userMessage('hello')] as never, systemPrompt: bigSystem as never, tools: [] as never }
  const refusal = localPromptFitRefusal(`local/${CODER}`, params)
  check('a 13.7k-token system prompt against a 4k window: the sentence names ≈14k tokens, 0 tool schemas, the 4096-token window and the setting words', /^the composed request \(≈14k tokens, 0 tool schemas included\) cannot fit 'qwen2\.5-coder:3b's served context window \(4096 tokens — your setting — \/config → Local model window\) and the server would silently truncate it\./.test(refusal ?? ''), refusal ?? 'undefined')
  w.writeLocalWindowSetting(coder, 32768)
  check('the same prompt with 32k set refuses nothing (it fits)', localPromptFitRefusal(`local/${CODER}`, params) === undefined, localPromptFitRefusal(`local/${CODER}`, params) ?? 'undefined')
  w.writeLocalWindowSetting(bare, 'server')
  check("with server default on a model served at 4,096 it refuses against the served window, named served", (localPromptFitRefusal(`local/${BARE}`, params) ?? '').includes("'bare-no-max:latest's served context window (4096 tokens — served)"), localPromptFitRefusal(`local/${BARE}`, params) ?? 'undefined')
  w.writeLocalWindowSetting(bare, undefined)
  check('a model following the request (auto, no trained max) refuses nothing at the pre-flight — the request road decides', localPromptFitRefusal(`local/${BARE}`, params) === undefined, localPromptFitRefusal(`local/${BARE}`, params) ?? 'undefined')
  const small = { ...params, systemPrompt: ['fixture'] as never }
  w.writeLocalWindowSetting(coder, 4096)
  check('a prompt whose fixed part fits the window refuses nothing here, whatever the history (the fold may still help)', localPromptFitRefusal(`local/${CODER}`, { ...small, messages: [userMessage('x'.repeat(40_000))] as never }) === undefined)
  check('an undiscovered local id refuses nothing', localPromptFitRefusal('local/nobody:latest', params) === undefined)
  w.writeLocalWindowSetting(coder, undefined)
  w.__resetLocalWindowsForTest()
}

ollama.server.close()
vllm.server.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
