#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-local-discovery.ts — locally served models: the
//  bounded discovery owner, the context/capability truth per server kind,
//  the picker rows, the capability edge, and the lane's wire — against
//  FIXTURE HTTP SERVERS on ephemeral loopback ports that replay each
//  server's DOCUMENTED shapes (all fetched/read 2026-08-22; localDiscovery's
//  header cites them). No real server, nothing downloaded, nothing started.
//
//    1. Ollama: /api/tags · /api/version · /api/ps · /api/show — the served
//       context (ps) beats num_ctx beats the documented 4096 default; the
//       trained max rides beside; capabilities decide tools/thinking/vision.
//    2. LM Studio v1: loaded instance context vs max_context_length (model
//       max), trained_for_tool_use, embedding rows excluded; v0 fallback.
//    3. vLLM: max_model_len IS the served window. llama.cpp: /props n_ctx
//       is the served window, /v1/models meta.n_ctx_train the trained max.
//    4. A dead port is simply absent (no phantom); `none` disables probing;
//       MERCURY_LOCAL_BASE_URL adds a server whose kind is sniffed.
//    5. The picker: the group is absent with nothing discovered; rows carry
//       the `local · <server>` detail with the context provenance.
//    6. The capability edge: resolveContextWindow for local/<id> (served ⇒
//       live-current; server-default labelled; undiscovered ⇒ the
//       conservative default, labelled); effort caps per server kind.
//    7. The wire: the profile is keyless, omits tool_choice for Ollama only,
//       refuses tool-bearing turns on a model that declares no tools, sends
//       reasoning_effort only for thinking-capable Ollama models; a real
//       streamed turn against the fixture Ollama /v1/chat/completions; the
//       native {"error": "<text>"} 404 shape maps to its message.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-local-discovery.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-discovery-proof-'))
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

// ── Fixture servers (the documented shapes, replayed) ───────────────────────

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => boolean
function serve(route: Route): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => {
        body += String(chunk)
      })
      req.on('end', () => {
        if (!route(req, body, res)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}
function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
  return true
}

const OLLAMA_TAGS = {
  models: [
    { name: 'llama3.2:latest', model: 'llama3.2:latest', modified_at: '2025-05-04T17:37:44.706015396-07:00', size: 2019393189, digest: 'a80c4f17acd5', details: { parent_model: '', format: 'gguf', family: 'llama', families: ['llama'], parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
    { name: 'qwen3:8b', model: 'qwen3:8b', modified_at: '2025-05-10T08:06:48.639712648-07:00', size: 4683075271, digest: '0a8c26691023', details: { parent_model: '', format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '8.2B', quantization_level: 'Q4_K_M' } },
    { name: 'llava:latest', model: 'llava:latest', modified_at: '2025-05-01T00:00:00Z', size: 4000000000, digest: '200765e12836', details: { parent_model: '', format: 'gguf', family: 'llama', families: ['llama', 'clip'], parameter_size: '7B', quantization_level: 'Q4_0' } },
  ],
}
const OLLAMA_PS = { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 6000000000, digest: '0a8c26691023', details: OLLAMA_TAGS.models[1]!.details, expires_at: '2026-08-22T05:00:00Z', size_vram: 6000000000, context_length: 32768 }] }
const OLLAMA_SHOW: Record<string, unknown> = {
  'llama3.2:latest': { modelfile: '# Modelfile\nFROM /blobs/sha256:abc\nPARAMETER num_ctx 16384', parameters: 'num_ctx                        16384\nstop                           "<|eot_id|>"', details: OLLAMA_TAGS.models[0]!.details, model_info: { 'general.architecture': 'llama', 'llama.context_length': 131072, 'llama.block_count': 28 }, capabilities: ['completion', 'tools'] },
  'qwen3:8b': { modelfile: '', parameters: 'stop "<|im_end|>"', details: OLLAMA_TAGS.models[1]!.details, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools', 'thinking'] },
  'llava:latest': { modelfile: '', parameters: '', details: OLLAMA_TAGS.models[2]!.details, model_info: { 'general.architecture': 'llama', 'llama.context_length': 4096 }, capabilities: ['completion', 'vision'] },
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const ollamaChatRequests: { body: Record<string, unknown>; headers: IncomingMessage['headers'] }[] = []
const ollama = await serve((req, body, res) => {
  const url = req.url ?? ''
  if (url === '/api/tags') return json(res, 200, OLLAMA_TAGS)
  if (url === '/api/version') return json(res, 200, { version: '0.11.4' })
  if (url === '/api/ps') return json(res, 200, OLLAMA_PS)
  if (url === '/api/show' && req.method === 'POST') {
    const model = String((JSON.parse(body || '{}') as { model?: string }).model ?? '')
    return model in OLLAMA_SHOW ? json(res, 200, OLLAMA_SHOW[model]) : json(res, 404, { error: `model '${model}' not found` })
  }
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    const parsed = JSON.parse(body || '{}') as Record<string, unknown>
    ollamaChatRequests.push({ body: parsed, headers: req.headers })
    if (parsed.model === 'nobody:latest') return json(res, 404, { error: { message: "model 'nobody:latest' not found", type: 'api_error', code: null } })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi ' }, finish_reason: null }] }))
    res.write(sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { content: 'there' }, finish_reason: 'stop' }] }))
    res.write(sse({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }))
    res.write('data: [DONE]\n\n')
    res.end()
    return true
  }
  return false
})

const LMSTUDIO_V1 = {
  models: [
    { type: 'llm', publisher: 'google', key: 'google/gemma-4-26b-a4b', display_name: 'Gemma 4 26B A4B', architecture: 'gemma4', quantization: { name: 'Q4_K_M', bits_per_weight: 4 }, size_bytes: 17990911801, params_string: '26B-A4B', loaded_instances: [{ id: 'google/gemma-4-26b-a4b', config: { context_length: 8192, eval_batch_size: 512, parallel: 4 } }], max_context_length: 131072, format: 'gguf', capabilities: { vision: true, trained_for_tool_use: true }, reasoning: { allowed_options: ['off', 'on'], default: 'on' } },
    { type: 'llm', publisher: 'lmstudio-community', key: 'meta-llama-3.1-8b-instruct', display_name: 'Llama 3.1 8B Instruct', architecture: 'llama', quantization: { name: 'Q4_K_M', bits_per_weight: 4 }, size_bytes: 4920000000, params_string: '8B', loaded_instances: [], max_context_length: 131072, format: 'gguf', capabilities: { vision: false, trained_for_tool_use: false } },
    { type: 'embedding', publisher: 'nomic-ai', key: 'text-embedding-nomic-embed-text-v1.5', display_name: 'Nomic Embed', quantization: null, size_bytes: 100, params_string: null, loaded_instances: [], max_context_length: 2048, format: 'gguf' },
  ],
}
const lmstudio = await serve((req, _body, res) => {
  if (req.url === '/api/v1/models') return json(res, 200, LMSTUDIO_V1)
  return false
})
const LMSTUDIO_V0 = { object: 'list', data: [{ id: 'qwen2-vl-7b-instruct', object: 'model', type: 'vlm', publisher: 'mlx-community', arch: 'qwen2_vl', compatibility_type: 'mlx', quantization: '4bit', state: 'not-loaded', max_context_length: 32768 }, { id: 'text-embedding-nomic-embed-text-v1.5', object: 'model', type: 'embeddings', publisher: 'nomic-ai', arch: 'nomic-bert', compatibility_type: 'gguf', quantization: 'Q4_0', state: 'not-loaded', max_context_length: 2048 }] }
const lmstudioOld = await serve((req, _body, res) => {
  if (req.url === '/api/v0/models') return json(res, 200, LMSTUDIO_V0)
  return false
})

const vllm = await serve((req, _body, res) => {
  if (req.url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'Qwen/Qwen3-32B', object: 'model', created: 1, owned_by: 'vllm', root: '/models/Qwen3-32B', parent: null, max_model_len: 40960, permission: [] }] })
  return false
})

const llamacpp = await serve((req, _body, res) => {
  if (req.url === '/health') return json(res, 200, { status: 'ok' })
  if (req.url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', object: 'model', created: 1735142223, owned_by: 'llamacpp', meta: { vocab_type: 2, n_vocab: 128256, n_ctx_train: 131072, n_embd: 4096, n_params: 8030261312, size: 4912898304 } }] })
  if (req.url === '/props') return json(res, 200, { default_generation_settings: { id: 0, n_ctx: 8192, params: {} }, total_slots: 1, model_path: '/models/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', chat_template: '...', modalities: { vision: false }, build_info: 'b6012-abc1234', is_sleeping: false })
  return false
})

// A port nothing listens on (claimed then released).
const dead = await serve(() => false)
const deadRoot = dead.root
await new Promise<void>(resolve => dead.server.close(() => resolve()))

process.env.MERCURY_LOCAL_PROBE_TARGETS = [
  `ollama=${ollama.root}`,
  `lmstudio=${lmstudio.root}`,
  `lmstudio=${lmstudioOld.root}`,
  `vllm=${vllm.root}`,
  `llamacpp=${llamacpp.root}`,
  `ollama=${deadRoot}`,
].join(',')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { refreshLocalDiscovery, getCachedLocalDiscovery, localModelRecord, localProbeTargets, cachedLocalModels, __resetLocalDiscoveryForTest, OLLAMA_DEFAULT_CONTEXT } = discovery
const { getLocalModelOptions, localRecordFor, localWireId, LOCAL_MODEL_GROUP } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localLaneProfileFor, localModelAcceptsEffort } = await import('../../src/services/providers/local/localCallModel.ts')
const { resolveLocalAccount } = await import('../../src/services/providers/local/localAccounts.ts')
const { resolveContextWindow, modelSupportsEffort, modelSupportsMaxEffort, modelSupportsXHighEffort } = await import('../../src/utils/model/capabilities.ts')
const { buildLocalExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { streamCompatChat, mapCompatHttpFailure } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
type CompatStreamEvent = import('../../src/services/providers/openaicompat/compatChatClient.ts').CompatStreamEvent
const { activeSourceUsage } = await import('../../src/services/providers/providerUsage.ts')
const { resolveEngineDispatch } = await import('../../src/utils/swarm/engineDispatch.ts')

section('1 · the probe set + one bounded discovery pass')
{
  const targets = localProbeTargets()
  check('the pinned probe set parses kind=root pairs', targets.length === 6 && targets[0]?.kind === 'ollama' && targets[0].root === ollama.root)
  const started = Date.now()
  const snapshot = await refreshLocalDiscovery({ force: true })
  const elapsed = Date.now() - started
  check('discovery answers within the bounded window (parallel probes)', elapsed < 5_000, `${elapsed}ms`)
  check('five servers answered, the dead port is ABSENT (no phantom)', snapshot.servers.length === 5 && snapshot.targetCount === 6 && !snapshot.servers.some(s => s.root === deadRoot))
  check('the cache serves the same snapshot synchronously', getCachedLocalDiscovery() === snapshot)
}

section('2 · Ollama truth')
{
  const server = getCachedLocalDiscovery()!.servers.find(s => s.kind === 'ollama')!
  check('the server label carries the version', server.label === 'Ollama 0.11.4' && server.baseUrl === `${ollama.root}/v1`)
  const llama = localModelRecord('llama3.2:latest')!
  const qwen = localModelRecord('qwen3:8b')!
  const llava = localModelRecord('llava:latest')!
  check('a LOADED model states its served context (/api/ps)', qwen.contextWindow?.tokens === 32768 && qwen.contextWindow.source === 'served' && qwen.loaded === true)
  check('a Modelfile num_ctx states the window when not loaded', llama.contextWindow?.tokens === 16384 && llama.contextWindow.source === 'modelfile' && llama.modelMaxContext === 131072)
  check('no override ⇒ the documented 4096 server default, labelled', llava.contextWindow?.tokens === OLLAMA_DEFAULT_CONTEXT && llava.contextWindow.source === 'server-default')
  check('capabilities decide tools/thinking/vision', llama.toolsDeclared === true && llama.thinkingDeclared === false && qwen.thinkingDeclared === true && llava.toolsDeclared === false && llava.visionDeclared === true)
  check('details ride along (family · size · quantization)', llama.family === 'llama' && llama.parameterSize === '3.2B' && llama.quantization === 'Q4_K_M')
}

section('3 · LM Studio · vLLM · llama.cpp truth')
{
  const gemma = localModelRecord('google/gemma-4-26b-a4b')!
  const llama31 = localModelRecord('meta-llama-3.1-8b-instruct')!
  check('LM Studio v1: the loaded instance states the SERVED context; display name kept', gemma.contextWindow?.tokens === 8192 && gemma.contextWindow.source === 'served' && gemma.displayName === 'Gemma 4 26B A4B' && gemma.loaded === true)
  check('LM Studio v1: an unloaded model states its model max, labelled as such', llama31.contextWindow?.tokens === 131072 && llama31.contextWindow.source === 'model-max' && llama31.loaded === false)
  check('LM Studio v1: trained_for_tool_use decides tools; reasoning marks thinking', gemma.toolsDeclared === true && gemma.thinkingDeclared === true && llama31.toolsDeclared === false)
  check('LM Studio v1: embedding rows are excluded', localModelRecord('text-embedding-nomic-embed-text-v1.5') === undefined)
  const vl = localModelRecord('qwen2-vl-7b-instruct')!
  check('LM Studio v0 fallback: max_context_length as model max, state as load', vl.contextWindow?.source === 'model-max' && vl.contextWindow.tokens === 32768 && vl.loaded === false && vl.server === 'lmstudio')
  const qwen32 = localModelRecord('Qwen/Qwen3-32B')!
  check('vLLM: max_model_len is the served window', qwen32.server === 'vllm' && qwen32.contextWindow?.tokens === 40960 && qwen32.contextWindow.source === 'served' && qwen32.toolsDeclared === undefined)
  const gguf = localModelRecord('Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf')!
  check('llama.cpp: /props n_ctx is the served window; meta.n_ctx_train the model max', gguf.server === 'llamacpp' && gguf.contextWindow?.tokens === 8192 && gguf.contextWindow.source === 'served' && gguf.modelMaxContext === 131072 && gguf.visionDeclared === false)
  check('llama.cpp: the build rides the label', getCachedLocalDiscovery()!.servers.find(s => s.kind === 'llamacpp')?.label === 'llama.cpp b6012-abc1234')
  const account = resolveLocalAccount()
  check('the family account view is keyless with the server roll-up', account?.kind === 'keyless' && account.serverCount === 5 && account.modelCount === cachedLocalModels().length && account.label.includes('Ollama 0.11.4 (3)'))
}

section('4 · probe-set grammar: none · the operator base URL (kind sniffed)')
{
  __resetLocalDiscoveryForTest()
  const none = await refreshLocalDiscovery({ force: true, env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' } as NodeJS.ProcessEnv })
  check("'none' disables probing (zero targets, zero servers)", none.targetCount === 0 && none.servers.length === 0)
  check('with nothing discovered the picker group is ABSENT and the account undefined', getLocalModelOptions().length === 0 && resolveLocalAccount() === undefined)
  __resetLocalDiscoveryForTest()
  const sniffed = await refreshLocalDiscovery({ force: true, env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_LOCAL_BASE_URL: `${llamacpp.root}/v1` } as NodeJS.ProcessEnv })
  check('MERCURY_LOCAL_BASE_URL (with or without /v1) is probed and its kind sniffed', sniffed.targetCount === 1 && sniffed.servers[0]?.kind === 'llamacpp')
  __resetLocalDiscoveryForTest()
  const sniffedOllama = await refreshLocalDiscovery({ force: true, env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_LOCAL_BASE_URL: ollama.root } as NodeJS.ProcessEnv })
  check('an Ollama root under the override sniffs as Ollama', sniffedOllama.servers[0]?.kind === 'ollama')
  __resetLocalDiscoveryForTest()
  await refreshLocalDiscovery({ force: true })
}

section('5 · the picker rows')
{
  const rows = getLocalModelOptions()
  check('one row per discovered model, all in the local group', rows.length === cachedLocalModels().length && rows.every(r => r.group === LOCAL_MODEL_GROUP && r.value?.startsWith('local/')))
  // The neutrality ruling: model rows carry NO description —
  // the window fact rides the typed statedContextWindow instead (the ctx
  // column), and the resolver section below still proves the budget truth.
  const qwenRow = rows.find(r => r.value === 'local/qwen3:8b')!
  check('model rows carry no description (the neutral grammar)', rows.every(r => r.description === ''), JSON.stringify(rows.map(r => [r.value, r.description])))
  check('the served window rides the typed statedContextWindow', qwenRow.statedContextWindow === 32768, String(qwenRow.statedContextWindow))
  const llavaRow = rows.find(r => r.value === 'local/llava:latest')!
  check('the server-default window rides the typed statedContextWindow', llavaRow.statedContextWindow === 4096, String(llavaRow.statedContextWindow))
  const llama31Row = rows.find(r => r.value === 'local/meta-llama-3.1-8b-instruct')!
  check('a model-max window rides the typed statedContextWindow', llama31Row.statedContextWindow === 131072, String(llama31Row.statedContextWindow))
  check('every row is selectable (the dispatch refuses typed)', rows.every(r => r.unavailable === undefined))
}

section('6 · the capability edge')
{
  const served = resolveContextWindow('local/qwen3:8b')
  check('a served window budgets live-current without a fallback note', served.effectiveWindow === 32768 && served.source === 'live-current' && served.fallbackReason === undefined)
  const dflt = resolveContextWindow('local/llava:latest')
  check('the server-default window budgets 4096 and names its provenance', dflt.effectiveWindow === 4096 && (dflt.fallbackReason ?? '').includes('server default'))
  const modelMax = resolveContextWindow('local/meta-llama-3.1-8b-instruct')
  check('a model-max window is labelled as the server-set size', modelMax.effectiveWindow === 131072 && (modelMax.fallbackReason ?? '').includes('model max'))
  const unknown = resolveContextWindow('local/nobody:latest')
  check('an undiscovered local id falls to the conservative default, labelled', unknown.effectiveWindow === 200_000 && unknown.source === 'fallback' && (unknown.fallbackReason ?? '').includes('not discovered'))
  check('effort: an Ollama thinking model takes the documented ladder (max yes, xhigh no)', modelSupportsEffort('local/qwen3:8b') && modelSupportsMaxEffort('local/qwen3:8b') && !modelSupportsXHighEffort('local/qwen3:8b'))
  check('effort: a non-thinking Ollama model offers no dial', !modelSupportsEffort('local/llama3.2:latest'))
  check('effort: vLLM takes the knob for any model (xhigh + max documented)', modelSupportsEffort('local/Qwen/Qwen3-32B') && modelSupportsXHighEffort('local/Qwen/Qwen3-32B'))
  check('effort: LM Studio offers no dial on the /v1 surface', !modelSupportsEffort('local/google/gemma-4-26b-a4b'))
  const usage = activeSourceUsage({ model: 'local/qwen3:8b', reads: { localAccount: () => resolveLocalAccount(), spend: () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 }) } })
  check('usage: keyless source, none shape, the no-metering line', usage.sourceKind === 'keyless' && usage.shape === 'none' && usage.absence === 'local · no metering' && usage.tier === 'local · no metering')
}

section('7 · the wire')
{
  const qwen = localRecordFor('local/qwen3:8b')!
  const profile = localLaneProfileFor(qwen)
  check('the profile is keyless (a present record with no key) and omits tool_choice for Ollama', JSON.stringify(await profile.resolveCredential()) === '{}' && profile.omitsToolChoice === true && profile.requestUrl() === `${ollama.root}/v1/chat/completions`)
  check('a vLLM profile keeps tool_choice', localLaneProfileFor(localRecordFor('local/Qwen/Qwen3-32B')!).omitsToolChoice !== true)
  check('the wire id is the server model name', profile.wireModelId('local/qwen3:8b') === 'qwen3:8b')
  check('reasoning_effort rides for a thinking-capable Ollama model (nearest-below on its ladder)', buildLocalExtras({ wireModel: 'qwen3:8b', effortValue: 'xhigh', thinkingEnabled: true, maxOutputTokensOverride: undefined, server: 'ollama', acceptsEffort: localModelAcceptsEffort(qwen) }).reasoning_effort === 'high')
  check('no reasoning_effort for a non-thinking model', buildLocalExtras({ wireModel: 'llama3.2:latest', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: undefined, server: 'ollama', acceptsEffort: localModelAcceptsEffort(localRecordFor('local/llama3.2:latest')!) }).reasoning_effort === undefined)
  const llavaProfile = localLaneProfileFor(localRecordFor('local/llava:latest')!)
  check('a model declaring no tools refuses a tool-bearing turn, typed', (llavaProfile.toolCapabilityRefusal?.('llava:latest') ?? '').includes('without tool support'))
  check('a tool-capable model proceeds', profile.toolCapabilityRefusal?.('qwen3:8b') === undefined)
  const lmProfile = localLaneProfileFor(localRecordFor('local/meta-llama-3.1-8b-instruct')!)
  check('LM Studio trained_for_tool_use:false refuses too', (lmProfile.toolCapabilityRefusal?.('meta-llama-3.1-8b-instruct') ?? '').includes('without tool support'))
  const events: CompatStreamEvent[] = []
  for await (const event of streamCompatChat({
    url: profile.requestUrl(),
    request: { model: profile.wireModelId('local/qwen3:8b'), messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'Read', parameters: {} } }], extra: buildLocalExtras({ wireModel: 'qwen3:8b', effortValue: 'high', thinkingEnabled: true, maxOutputTokensOverride: undefined, server: 'ollama', acceptsEffort: true }) },
  })) {
    events.push(event)
  }
  const text = events.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text).join('')
  const finish = events.find(e => e.type === 'finish') as { reason: string } | undefined
  const usage = events.find(e => e.type === 'usage') as { usage: { inputTokens: number; outputTokens: number } } | undefined
  check('a real loopback stream settles: text, stop, usage before [DONE]', text === 'Hi there' && finish?.reason === 'stop' && usage?.usage.inputTokens === 9 && usage.usage.outputTokens === 3)
  const seen = ollamaChatRequests.at(-1)!
  check('request truth on the wire: no bearer, no tool_choice, tools present, include_usage, reasoning_effort high', seen.headers.authorization === undefined && !('tool_choice' in seen.body) && Array.isArray(seen.body.tools) && (seen.body.stream_options as { include_usage: boolean }).include_usage === true && seen.body.reasoning_effort === 'high' && seen.body.stream === true)
  const fault = mapCompatHttpFailure(404, { error: "model 'nobody:latest' not found" })
  check("the native {\"error\": \"<text>\"} shape maps to its message", fault.message === "model 'nobody:latest' not found" && fault.code === 'http-404')
  const dispatch = await resolveEngineDispatch('local')
  check("the 'local' class alias resolves the first discovered model", dispatch?.backend === 'local' && dispatch.model === 'local/llama3.2:latest')
  const exact = await resolveEngineDispatch('local/qwen3:8b')
  check('an exact local id dispatches by its discovered record', exact?.backend === 'local' && exact.model === 'local/qwen3:8b')
  let refused = ''
  try {
    await resolveEngineDispatch('local/nobody:latest')
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  check('an undiscovered exact id refuses, listing what IS discovered', refused.includes("No local server lists 'local/nobody:latest'") && refused.includes('qwen3:8b'))
}

section('8 · identity collision across servers (the namespace law)')
{
  // Two servers listing the SAME wire id: without the server namespace one
  // persisted id named two models and the first server silently won every
  // resolution — the other server's model was unreachable by any spelling.
  const vllmTwin = await serve((req, _body, res) => {
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'qwen3:8b', owned_by: 'vllm', max_model_len: 32768, root: 'qwen3:8b' }] })
    return false
  })
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root},vllm=${vllmTwin.root}`
  await refreshLocalDiscovery({ force: true })
  const rows = getLocalModelOptions()
  const colliding = rows.filter(r => r.value?.endsWith('qwen3:8b'))
  check('colliding ids persist server-qualified — one row per MODEL, distinct ids', colliding.length === 2 && new Set(colliding.map(r => r.value)).size === 2, JSON.stringify(colliding.map(r => r.value)))
  check('each qualified id resolves to ITS server', localRecordFor('local/ollama/qwen3:8b')?.server === 'ollama' && localRecordFor('local/vllm/qwen3:8b')?.server === 'vllm')
  check('the wire hears the server\'s own bare name (qualifier stripped)', localWireId('local/vllm/qwen3:8b') === 'qwen3:8b')
  check('the qualified profile routes to the qualified server', localLaneProfileFor(localRecordFor('local/vllm/qwen3:8b')!).requestUrl() === `${vllmTwin.root}/v1/chat/completions`)
  check('the legacy bare spelling still resolves (first-listed, no compat break)', localRecordFor('local/qwen3:8b')?.server === 'ollama')
  check('a non-colliding id keeps its bare persisted spelling', rows.some(r => r.value === 'local/llava:latest'))
  await new Promise<void>(resolve => vllmTwin.server.close(() => resolve()))
}

section('9 · the cockpit gauge on a local main (the model line is the served truth)')
{
  const g = await import('../../src/utils/cockpit/modelGauge.ts')
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`
  await refreshLocalDiscovery({ force: true })
  const live = g.modelGauge('local/qwen3:8b')
  check('a discovered local main paints live', live.state === 'live', live.state)
  if (live.state === 'live') {
    check('the window is the SERVED truth (32768, live-current — no fallback note)', live.data.window === 32768 && live.data.windowSource === 'live-current' && live.data.windowReason === undefined, `${live.data.window} · ${live.data.windowSource}`)
    check("the provider is routeLaw's 'local'", live.data.provider === 'local', String(live.data.provider))
    check('the provider is USABLE with the keyless credential word (discovery is presence)', live.data.usability?.usable === true && live.data.usability.credential === 'keyless', JSON.stringify(live.data.usability))
  }
  // The absent arm: nothing discovered ⇒ the conservative default LABELLED,
  // and the usability blocker names the probe route — never a sign-in word.
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  await refreshLocalDiscovery({ force: true })
  const dark = g.modelGauge('local/qwen3:8b')
  check('an undiscovered local main still paints (labelled fallback, never a crash)', dark.state === 'live' && dark.data.window === 200_000 && dark.data.windowSource === 'fallback' && (dark.data.windowReason ?? '').includes('not discovered'), `${dark.state} · ${dark.data.window} · ${dark.data.windowReason ?? ''}`)
  if (dark.state === 'live') {
    const blocker = dark.data.usability?.blockers[0] ?? ''
    check('the blocker is the probe route (start a server / MERCURY_LOCAL_BASE_URL)', blocker.includes('no local server discovered') && blocker.includes('MERCURY_LOCAL_BASE_URL'), blocker)
    check('no borrowed credential words on the account-less family', !blocker.includes('/logins') && !blocker.toLowerCase().includes('sign in'), blocker)
  }
  // Restore the fixture set for any section after this one.
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`
  await refreshLocalDiscovery({ force: true })
}

section('10 · the cloud-needed census on a local main (named degrades, never silence)')
{
  // The 1M opt-in is first-party capability — the carrier guard keeps the
  // toggle dark on every local id (no invented context ride).
  const { modelSupports1M } = await import('../../src/utils/model/capabilities.ts')
  check('the 1M toggle never lights on a local id', !modelSupports1M('local/qwen3:8b') && !modelSupports1M('local/hf.co/org/model:tag'))
  // The chat-completions wire is text+tools: a non-text block degrades to a
  // NAMED placeholder on the one codec the local lane rides — the model
  // reads that something stood there; silence would strand it.
  const { mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
  const rows = mapMessagesToZai(undefined, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this picture?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    } as never,
  ])
  const userRow = rows.find(r => r.role === 'user')
  check('an image block rides as the loud [image] placeholder (never dropped silently)', typeof userRow?.content === 'string' && userRow.content.includes('[image]') && !userRow.content.includes('AAAA'), String(userRow?.content))
  const toolRows = mapMessagesToZai(undefined, [
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }] },
      ],
    } as never,
  ])
  const toolRow = toolRows.find(r => r.role === 'tool')
  check('an image tool result degrades loudly too ([image] in the tool row)', typeof toolRow?.content === 'string' && toolRow.content.includes('[image]'), String(toolRow?.content))
}

section('11 · the silent-truncation guard (proven live: Ollama truncates /v1 prompts to the served window with no signal)')
{
  __resetLocalDiscoveryForTest()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`
  await refreshLocalDiscovery({ force: true })
  // llava carries the SERVER-DEFAULT window (4096) — the live class's shape.
  const llava = localRecordFor('local/llava:latest')!
  const profile = localLaneProfileFor(llava)
  const refusal = profile.requestFitRefusal?.({ requestBytes: 80_000, estTokens: 20_000, toolCount: 55, wireModel: 'llava:latest' })
  check('an over-window request refuses typed with the numbers', (refusal ?? '').includes('20k tokens') && (refusal ?? '').includes('4096'), String(refusal))
  check('the sentence names the silent-truncation reason and the remedy ladder', (refusal ?? '').includes('silently truncate') && (refusal ?? '').includes('OLLAMA_CONTEXT_LENGTH') && (refusal ?? '').includes('--strict-mcp-config'), String(refusal))
  check('no borrowed doors (the ladder is windows/catalogs/models, never /logins)', !(refusal ?? '').includes('/logins'), String(refusal))
  check('a fitting request passes silent', profile.requestFitRefusal?.({ requestBytes: 2_000, estTokens: 500, toolCount: 2, wireModel: 'llava:latest' }) === undefined)
  check('the window source rides the sentence (server default words)', (refusal ?? '').includes('server default'), String(refusal))
  // No STATED window ⇒ no check (the server owns its own business).
  const windowless = { ...llava }
  delete (windowless as { contextWindow?: unknown }).contextWindow
  check('an unstated window never refuses', localLaneProfileFor(windowless).requestFitRefusal?.({ requestBytes: 800_000, estTokens: 200_000, toolCount: 202, wireModel: 'x' }) === undefined)

  // The RUNTIME wires the guard BEFORE dispatch: an over-window turn yields
  // one typed api-error message and the fixture sees NO chat request.
  const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
  const chatCountBefore = ollamaChatRequests.length
  const fat = 'x'.repeat(30_000)
  const yielded: Array<{ type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }> = []
  for await (const item of compatChatCallModel(profile, {
    messages: [{ type: 'user', message: { role: 'user', content: fat }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: [] as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    // The plan reads the permission mode before the deferral decision (the
    // roster latch keys on it), so the fixture carries the context every
    // product caller passes — the Options type requires it.
    options: {
      model: 'local/llava:latest',
      querySource: 'user',
      getToolPermissionContext: async () => ({ mode: 'default' }) as never,
    } as never,
  })) {
    yielded.push(item as never)
  }
  const errorMessage = yielded.find(m => m.type === 'assistant' && m.isApiErrorMessage === true) as { message?: { content?: Array<{ text?: string }> | string } } | undefined
  const errorText = ((): string => {
    const content = errorMessage?.message?.content
    if (typeof content === 'string') return content
    return (content ?? []).map(b => b.text ?? '').join('')
  })()
  check('the runtime refuses BEFORE dispatch (one typed api-error yielded)', errorMessage !== undefined && errorText.includes('cannot fit') && errorText.includes('silently truncate'), errorText.slice(0, 160))
  check('NO chat request reached the server', ollamaChatRequests.length === chatCountBefore, `${ollamaChatRequests.length - chatCountBefore} escaped`)
}

for (const s of [ollama.server, lmstudio.server, lmstudioOld.server, vllm.server, llamacpp.server]) s.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
