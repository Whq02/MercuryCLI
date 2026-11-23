#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-thinking-off-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

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
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

const DETAILS = { parent_model: '', format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '27B', quantization_level: 'Q4_K_M' }
const OLLAMA_TAGS = {
  models: [
    { name: 'thinker:27b', model: 'thinker:27b', modified_at: '2026-01-01T00:00:00Z', size: 17_000_000_000, digest: 'aa11', details: DETAILS, capabilities: ['completion', 'vision', 'tools', 'thinking'] },
    { name: 'plain:8b', model: 'plain:8b', modified_at: '2026-01-01T00:00:00Z', size: 4_600_000_000, digest: 'bb22', details: DETAILS, capabilities: ['completion', 'tools'] },
  ],
}
const OLLAMA_PS = { models: [{ name: 'thinker:27b', model: 'thinker:27b', size: 17_000_000_000, digest: 'aa11', details: DETAILS, expires_at: '2026-01-01T00:00:00Z', size_vram: 17_000_000_000, context_length: 32768 }] }
const OLLAMA_SHOW: Record<string, unknown> = {
  'thinker:27b': { modelfile: '', parameters: 'top_k 20\ntop_p 0.95', template: '{{ .Prompt }}', details: DETAILS, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 262144 }, capabilities: ['completion', 'vision', 'tools', 'thinking'], thinking: { values: [false, true], default: true } },
  'plain:8b': { modelfile: '', parameters: '', details: DETAILS, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 }, capabilities: ['completion', 'tools'] },
}
const chatBodies: Record<string, unknown>[] = []
const ollama = await serve((req, body, res) => {
  const url = req.url ?? ''
  if (url === '/api/tags') return json(res, 200, OLLAMA_TAGS)
  if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
  if (url === '/api/ps') return json(res, 200, OLLAMA_PS)
  if (url === '/api/show' && req.method === 'POST') {
    const model = String((JSON.parse(body || '{}') as { model?: string }).model ?? '')
    return model in OLLAMA_SHOW ? json(res, 200, OLLAMA_SHOW[model]) : json(res, 404, { error: `model '${model}' not found` })
  }
  if (url === '/v1/chat/completions' && req.method === 'POST') {
    const parsed = JSON.parse(body || '{}') as Record<string, unknown>
    chatBodies.push(parsed)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }))
    res.write(sse({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: parsed.model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } }))
    res.write('data: [DONE]\n\n')
    res.end()
    return true
  }
  return false
})
const LMSTUDIO_V1 = {
  models: [
    { type: 'llm', publisher: 'google', key: 'google/gemma-4-26b-a4b', display_name: 'Gemma 4 26B A4B', architecture: 'gemma4', quantization: { name: 'Q4_K_M', bits_per_weight: 4 }, size_bytes: 17990911801, params_string: '26B-A4B', loaded_instances: [{ id: 'google/gemma-4-26b-a4b', config: { context_length: 8192 } }], max_context_length: 131072, format: 'gguf', capabilities: { vision: true, trained_for_tool_use: true }, reasoning: { allowed_options: ['off', 'on'], default: 'on' } },
  ],
}
const lmstudio = await serve((req, _body, res) => {
  if (req.url === '/api/v1/models') return json(res, 200, LMSTUDIO_V1)
  return false
})
const vllm = await serve((req, _body, res) => {
  if (req.url === '/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'Qwen/Qwen3-32B', object: 'model', created: 1, owned_by: 'vllm', root: '/models/Qwen3-32B', parent: null, max_model_len: 40960, permission: [] }] })
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = [`ollama=${ollama.root}`, `lmstudio=${lmstudio.root}`, `vllm=${vllm.root}`].join(',')

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/models/roads/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/models/roads/local/localCatalogue.ts')
const { localLaneProfileFor, localModelAcceptsEffort } = await import('../../src/models/roads/local/localCallModel.ts')
const wire = await import('../../src/models/roads/openaicompat/compatWire.ts')
const { buildZaiChatRequest } = await import('../../src/models/roads/zai/zaiCodec.ts')
const { compatChatCallModel } = await import('../../src/models/roads/openaicompat/compatChatCallModel.ts')
type WireModule = typeof wire & {
  localThinkingOff?: (args: { server: string; acceptsEffort: boolean; thinkingEnabled: boolean }) => boolean
  localThinkingOffWireEffort?: (server: string) => string | undefined
}
const w = wire as WireModule

await refreshLocalDiscovery({ force: true })
const thinker = localRecordFor('local/thinker:27b')!
const plain = localRecordFor('local/plain:8b')!
const gemma = localRecordFor('local/google/gemma-4-26b-a4b')!
const qwenVllm = localRecordFor('local/Qwen/Qwen3-32B')!
const extrasFor = (record: typeof thinker, thinkingEnabled: boolean, effortValue: string | undefined) =>
  wire.buildLocalExtras({ wireModel: record.id, effortValue, thinkingEnabled, maxOutputTokensOverride: undefined, server: record.server, acceptsEffort: localModelAcceptsEffort(record) }) as { reasoning_effort?: string }

section('1 · the records: the fixture states the boolean thinking vocabulary the live /api/show states')
{
  check('the thinking model is discovered with thinking declared (capabilities carry thinking)', thinker !== undefined && thinker.server === 'ollama' && thinker.thinkingDeclared === true, JSON.stringify(thinker) + ' | the Ollama branch of discovery in src/models/roads/local/localDiscovery.ts must set thinkingDeclared from the thinking capability')
  check('the plain model is discovered without thinking', plain !== undefined && plain.thinkingDeclared === false, 'the Ollama branch of discovery in src/models/roads/local/localDiscovery.ts must set thinkingDeclared false when capabilities lack thinking')
  check('the LM Studio reasoning row is discovered with thinking declared', gemma !== undefined && gemma.server === 'lmstudio' && gemma.thinkingDeclared === true, 'the LM Studio branch of discovery in src/models/roads/local/localDiscovery.ts must set thinkingDeclared when the row states reasoning')
  check('the vLLM row states no per-model thinking (the knob is blanket)', qwenVllm !== undefined && qwenVllm.server === 'vllm' && qwenVllm.thinkingDeclared === undefined, 'discovery in src/models/roads/local/localDiscovery.ts must leave thinkingDeclared unset for a vLLM row')
  check("the Ollama vocabulary spells 'none' (the documented off word)", (wire.LOCAL_SERVER_EFFORTS.ollama as readonly string[]).includes('none'), JSON.stringify(wire.LOCAL_SERVER_EFFORTS.ollama) + ' | LOCAL_SERVER_EFFORTS.ollama in src/models/roads/openaicompat/compatWire.ts must spell none')
}

section("2 · the builder: thinking off on a thinking-declared Ollama model says 'none'; on ⇒ the effort word; no thinking ⇒ no field")
{
  const offHigh = extrasFor(thinker, false, 'high')
  check("thinking OFF + effort high ⇒ reasoning_effort 'none' (never the effort word, never silence)", offHigh.reasoning_effort === 'none', `sent ${String(offHigh.reasoning_effort)} | buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must send none when thinking is off on a thinking-declared Ollama model`)
  const offUnset = extrasFor(thinker, false, undefined)
  check("thinking OFF + no effort asked ⇒ reasoning_effort 'none' (silence means the model's own default thinking, which is on)", offUnset.reasoning_effort === 'none', `sent ${String(offUnset.reasoning_effort)} | buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must send none when thinking is off, even with no effort asked`)
  check("thinking ON + effort high ⇒ 'high' as today", extrasFor(thinker, true, 'high').reasoning_effort === 'high', 'buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must pass the effort word when thinking is on')
  check("thinking ON + effort xhigh ⇒ 'high' (nearest-below on the ladder, as today)", extrasFor(thinker, true, 'xhigh').reasoning_effort === 'high', 'buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must step xhigh down to the nearest word of the Ollama ladder')
  check('thinking ON + no effort asked ⇒ no field (as today)', extrasFor(thinker, true, undefined).reasoning_effort === undefined, 'buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must add no reasoning_effort when thinking is on and no effort is asked')
  check('a model whose capabilities do not state thinking ⇒ no field, thinking on or off', extrasFor(plain, false, 'high').reasoning_effort === undefined && extrasFor(plain, true, 'high').reasoning_effort === undefined, 'localModelAcceptsEffort in src/models/roads/local/localCallModel.ts and buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must add no field for a model that states no thinking')
  check('LM Studio: no dial on the /v1 surface, thinking on or off (its reasoning knob is documented only on /api/v1/chat)', extrasFor(gemma, false, 'high').reasoning_effort === undefined && extrasFor(gemma, true, 'high').reasoning_effort === undefined, 'localModelAcceptsEffort in src/models/roads/local/localCallModel.ts and buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must add no reasoning_effort for an LM Studio row')
  check("vLLM: unchanged — the blanket knob rides the effort word whether thinking is on or off ('high')", extrasFor(qwenVllm, false, 'high').reasoning_effort === 'high' && extrasFor(qwenVllm, true, 'high').reasoning_effort === 'high', 'buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must send the effort word for a vLLM row whether thinking is on or off')
  check('every builder keeps include_usage and the max_tokens override', (extrasFor(thinker, false, 'high') as { stream_options?: { include_usage?: boolean } }).stream_options?.include_usage === true && (wire.buildLocalExtras({ wireModel: thinker.id, effortValue: 'high', thinkingEnabled: false, maxOutputTokensOverride: 512, server: 'ollama', acceptsEffort: true }) as { max_tokens?: number }).max_tokens === 512, 'buildLocalExtras in src/models/roads/openaicompat/compatWire.ts must keep stream_options.include_usage and the max_tokens override')
}

section('3 · one predicate for both Ollama wires (reasoning_effort none on /v1, think false on /api/chat)')
{
  const predicate = w.localThinkingOff
  check('the predicate is exported from the wire owner', typeof predicate === 'function', 'export localThinkingOff from src/models/roads/openaicompat/compatWire.ts')
  if (typeof predicate === 'function') {
    check('thinking off + a thinking-declared Ollama model ⇒ off', predicate({ server: 'ollama', acceptsEffort: true, thinkingEnabled: false }) === true, 'localThinkingOff in src/models/roads/openaicompat/compatWire.ts must be true for Ollama with thinking off and a declared model')
    check('thinking on ⇒ not off', predicate({ server: 'ollama', acceptsEffort: true, thinkingEnabled: true }) === false, 'localThinkingOff in src/models/roads/openaicompat/compatWire.ts must be false when thinking is on')
    check('a model that states no thinking ⇒ not off (nothing to switch)', predicate({ server: 'ollama', acceptsEffort: false, thinkingEnabled: false }) === false, 'localThinkingOff in src/models/roads/openaicompat/compatWire.ts must be false when the model does not accept effort')
    check('vLLM states no per-model thinking ⇒ not off; llama.cpp reads the off word (its server takes reasoning_effort none as thinking off) ⇒ off', predicate({ server: 'vllm', acceptsEffort: true, thinkingEnabled: false }) === false && predicate({ server: 'llamacpp', acceptsEffort: true, thinkingEnabled: false }) === true, 'localThinkingOff in src/models/roads/openaicompat/compatWire.ts must be false for vllm and true for llamacpp when thinking is off')
  }
  const word = w.localThinkingOffWireEffort
  check("the thinking-off word per server kind: 'none' on Ollama, none on LM Studio (no /v1 dial), none on vLLM, 'none' on llama.cpp (stated on its own: its level list does not spell it)", typeof word === 'function' && word('ollama') === 'none' && word('lmstudio') === undefined && word('vllm') === undefined && word('llamacpp') === 'none', typeof word === 'function' ? JSON.stringify(['ollama', 'lmstudio', 'vllm', 'llamacpp'].map(word)) : 'not exported: export localThinkingOffWireEffort from src/models/roads/openaicompat/compatWire.ts')
  check("the word is the shared thinking-off law over the Ollama table ('none' where the list spells it)", wire.thinkingOffWireEffort(wire.LOCAL_SERVER_EFFORTS.ollama) === 'none', 'thinkingOffWireEffort in src/models/roads/openaicompat/compatWire.ts must return none for the Ollama list')
}

section('4 · the /v1 wire: a thinking-off session carries reasoning_effort "none" in the chat-completions body')
{
  const { streamTransport: nativeRoad, ...v1Profile } = localLaneProfileFor(thinker) as ReturnType<typeof localLaneProfileFor> & { streamTransport?: unknown }
  void nativeRoad
  const profile = v1Profile as ReturnType<typeof localLaneProfileFor>
  check('the profile posts to the /v1 chat-completions route of the discovered server', profile.requestUrl() === `${ollama.root}/v1/chat/completions`, profile.requestUrl() + ' | localLaneProfileFor in src/models/roads/local/localCallModel.ts must build the /v1 chat-completions url from the discovered server')
  const drive = async (thinking: boolean): Promise<Record<string, unknown> | undefined> => {
    const before = chatBodies.length
    for await (const _item of compatChatCallModel(profile, {
      messages: [{ type: 'user', message: { role: 'user', content: 'hi' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
      systemPrompt: ['sys'] as never,
      thinkingConfig: (thinking ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }) as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: { model: 'local/thinker:27b', querySource: 'user', effortValue: 'high', getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
    })) {
      void _item
    }
    return chatBodies.length > before ? chatBodies.at(-1) : undefined
  }
  const off = await drive(false)
  check('the thinking-off request reached the fixture', off !== undefined, 'compatChatCallModel posted no chat request to the Ollama fixture: check localLaneProfileFor in src/models/roads/local/localCallModel.ts')
  check('thinking OFF ⇒ the body carries reasoning_effort "none"', off?.reasoning_effort === 'none', `body.reasoning_effort = ${JSON.stringify(off?.reasoning_effort)} | the /v1 body must carry none when thinking is off: see buildLocalExtras in src/models/roads/openaicompat/compatWire.ts`)
  const on = await drive(true)
  check('thinking ON ⇒ the body carries the effort word as today ("high")', on?.reasoning_effort === 'high', `body.reasoning_effort = ${JSON.stringify(on?.reasoning_effort)} | the /v1 body must carry the effort word when thinking is on: see buildLocalExtras in src/models/roads/openaicompat/compatWire.ts`)
  check('no think field rides the /v1 body (the native knob belongs to /api/chat)', off !== undefined && !('think' in off) && on !== undefined && !('think' in on), 'the /v1 body must not carry a think field: it belongs to the native /api/chat road, not buildLocalExtras in src/models/roads/openaicompat/compatWire.ts')
}

section('5 · the other roads are unchanged to the byte with thinking off')
{
  const off = { wireModel: 'x', effortValue: 'high', thinkingEnabled: false, maxOutputTokensOverride: undefined }
  check('moonshot', JSON.stringify(wire.buildMoonshotExtras({ ...off, wireModel: 'kimi-k3' })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"high"}', JSON.stringify(wire.buildMoonshotExtras({ ...off, wireModel: 'kimi-k3' })) + ' | buildMoonshotExtras in src/models/roads/openaicompat/compatWire.ts must keep this output byte for byte')
  check('deepseek', JSON.stringify(wire.buildDeepseekExtras({ ...off, wireModel: 'deepseek-flash' })) === '{"thinking":{"type":"disabled"},"stream_options":{"include_usage":true}}', JSON.stringify(wire.buildDeepseekExtras({ ...off, wireModel: 'deepseek-flash' })) + ' | buildDeepseekExtras in src/models/roads/openaicompat/compatWire.ts must keep this output byte for byte')
  check('openrouter policy off', JSON.stringify(wire.buildOpenrouterExtras({ ...off, vocabulary: wire.OPENROUTER_REASONING_EFFORTS, providerPolicy: undefined })) === '{"stream_options":{"include_usage":true},"reasoning":{"effort":"none"}}', JSON.stringify(wire.buildOpenrouterExtras({ ...off, vocabulary: wire.OPENROUTER_REASONING_EFFORTS })) + ' | buildOpenrouterExtras in src/models/roads/openaicompat/compatWire.ts must keep this output byte for byte')
  const { openrouterProviderObject } = await import('../../src/models/roads/openrouter/openrouterRoutingPolicy.js')
  check('openrouter policy on', JSON.stringify(wire.buildOpenrouterExtras({ ...off, vocabulary: wire.OPENROUTER_REASONING_EFFORTS, providerPolicy: openrouterProviderObject({}) })) === '{"stream_options":{"include_usage":true},"reasoning":{"effort":"none"},"provider":{"data_collection":"deny","require_parameters":true}}', 'buildOpenrouterExtras in src/models/roads/openaicompat/compatWire.ts must keep this output byte for byte with a provider policy')
  check('gemini', JSON.stringify(wire.buildGeminiExtras({ ...off, acceptsEffort: true })) === '{"stream_options":{"include_usage":true},"reasoning_effort":"low"}', JSON.stringify(wire.buildGeminiExtras({ ...off, acceptsEffort: true })) + ' | buildGeminiExtras in src/models/roads/openaicompat/compatWire.ts must keep this output byte for byte')
  check('the compat slot and Hugging Face', JSON.stringify(wire.buildCompatSlotExtras(off)) === '{"stream_options":{"include_usage":true}}' && JSON.stringify(wire.buildHuggingfaceExtras(off)) === '{"stream_options":{"include_usage":true}}', 'buildCompatSlotExtras and buildHuggingfaceExtras in src/models/roads/openaicompat/compatWire.ts must keep this output byte for byte')
  const zai = buildZaiChatRequest({ model: 'glm-5.3', system: 's', messages: [], reasoningEffort: 'high', thinkingEnabled: false })
  check('the zai request shape', JSON.stringify(zai) === '{"model":"glm-5.3","messages":[{"role":"system","content":"s"}],"reasoning_effort":"high","thinking":{"type":"disabled"}}', JSON.stringify(zai) + ' | buildZaiChatRequest in src/models/roads/zai/zaiCodec.ts must keep this request shape byte for byte')
}

for (const s of [ollama.server, lmstudio.server, vllm.server]) s.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
