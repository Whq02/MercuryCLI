#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'local-window-setting-proof-'))
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

const OLLAMA_MODEL = 'qwen3.5:9b-q4_K_M'
const LM_MODEL = 'google/gemma-4-26b-a4b'
const ollamaHits: Hit[] = []
const lmHits: Hit[] = []
const ollamaState = { loadedCtx: undefined as number | undefined, errorNext: undefined as string | undefined }
const ollama = await serve((req, body, res) => {
  const url = req.url ?? ''
  if (url === '/api/tags') return json(res, 200, { models: [{ name: OLLAMA_MODEL, model: OLLAMA_MODEL, details: { family: 'qwen35' } }] }), true
  if (url === '/api/version') return json(res, 200, { version: '0.34.4' }), true
  if (url === '/api/ps') return json(res, 200, { models: ollamaState.loadedCtx !== undefined ? [{ name: OLLAMA_MODEL, model: OLLAMA_MODEL, context_length: ollamaState.loadedCtx }] : [] }), true
  if (url === '/api/show') return json(res, 200, { parameters: '', model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 }, capabilities: ['completion', 'tools', 'thinking'] }), true
  if (url === '/api/chat' && req.method === 'POST') {
    const options = body.options as { num_ctx?: number } | undefined
    ollamaState.loadedCtx = options?.num_ctx ?? 262144
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    if (ollamaState.errorNext !== undefined) {
      res.write(JSON.stringify({ error: ollamaState.errorNext }) + '\n')
      ollamaState.errorNext = undefined
      res.end()
      return true
    }
    const row = (message: Record<string, unknown>, tail: Record<string, unknown> = {}): string => JSON.stringify({ model: OLLAMA_MODEL, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '', ...message }, done: false, ...tail }) + '\n'
    res.write(row({ thinking: 'Let me look. ' }))
    res.write(row({ thinking: 'The file is small.' }))
    res.write(row({ content: 'Reading ' }))
    res.write(row({ content: 'it now.' }))
    res.write(row({ tool_calls: [{ id: 'call_7', function: { index: 0, name: 'Read', arguments: { file_path: '/tmp/a.txt' } } }] }))
    res.write(JSON.stringify({ model: OLLAMA_MODEL, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 1, load_duration: 1, prompt_eval_count: 62000, prompt_eval_cached_count: 8192, prompt_eval_duration: 1, eval_count: 30, eval_duration: 1 }) + '\n')
    res.end()
    return true
  }
  return false
}, ollamaHits)

const lmState = { instances: [{ id: 'inst-1', config: { context_length: 8192 } }] as Array<{ id: string; config: { context_length: number } }> }
const lmstudio = await serve((req, body, res) => {
  const url = req.url ?? ''
  if (url === '/api/v1/models') return json(res, 200, { models: [{ type: 'llm', key: LM_MODEL, display_name: 'Gemma 4', max_context_length: 131072, loaded_instances: lmState.instances, capabilities: { vision: false, trained_for_tool_use: true } }] }), true
  if (url === '/api/v1/models/unload' && req.method === 'POST') {
    lmState.instances = lmState.instances.filter(i => i.id !== body.instance_id)
    return json(res, 200, { instance_id: body.instance_id }), true
  }
  if (url === '/api/v1/models/load' && req.method === 'POST') {
    const ctx = typeof body.context_length === 'number' ? body.context_length : 4096
    lmState.instances = [...lmState.instances, { id: `inst-${lmState.instances.length + 2}`, config: { context_length: ctx } }]
    return json(res, 200, { type: 'llm', instance_id: lmState.instances.at(-1)!.id, load_time_seconds: 1, status: 'loaded' }), true
  }
  return false
}, lmHits)

process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root},lmstudio=${lmstudio.root}`
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const w = await import('../../src/services/providers/local/localWindow.ts')
const { refreshLocalDiscovery, ensureServedWindow, __resetLocalDiscoveryForTest } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localLaneProfileFor, localGuardWindow } = await import('../../src/services/providers/local/localCallModel.ts')
const { streamOllamaChat, ollamaChatBody, ollamaMessagesOf } = await import('../../src/services/providers/local/ollamaChatTransport.ts')
const { localModelWindowRow } = await import('../../src/components/Settings/Config.tsx')
type CompatStreamEvent = import('../../src/services/providers/openaicompat/compatChatClient.ts').CompatStreamEvent
await refreshLocalDiscovery({ force: true })
const qwen = localRecordFor(`local/${OLLAMA_MODEL}`)!
const gemma = localRecordFor(`local/${LM_MODEL}`)!

section('1 · the fallback arithmetic (no KV geometry read for this fixture model, no memory truth): the trained maximum when the model states one; the doubling rule (twice the request rounded up to 16k, never under 64k) only when it states none')
{
  check('a 62k request ⇒ 128k', w.doubledRequestWindow(62_000, 262144) === 131072, String(w.doubledRequestWindow(62_000, 262144)))
  check('a 20k request ⇒ the 64k floor (48k rounded up is under it)', w.doubledRequestWindow(20_000, 262144) === 65536, String(w.doubledRequestWindow(20_000, 262144)))
  check('a trained max of 32k ⇒ 32k', w.doubledRequestWindow(62_000, 32768) === 32768)
  check('a tiny request ⇒ the 64k floor — bigger, not smaller, when the machine was not read', w.doubledRequestWindow(1_000, 262144) === 65536)
  check('no trained max stated ⇒ the 2× rule alone (62k ⇒ 128k)', w.doubledRequestWindow(62_000) === 131072)
  check('exactly 8k ⇒ 64k (16k rounded up, floored)', w.doubledRequestWindow(8_000, 262144) === 65536)
  check('the fixture states no geometry and the trained max, so auto is the trained max (256k, reason max) and the words say the machine was not read', qwen.geometry === undefined && w.chooseLocalWindow(qwen, 62_000, undefined).window === 262144 && w.chooseLocalWindow(qwen, 62_000, undefined).reason === 'max' && w.chooseLocalWindow(qwen, 62_000, undefined).words.includes('no KV geometry read') && w.chooseLocalWindow(qwen, 62_000, undefined).words.includes('bigger, not smaller'), w.chooseLocalWindow(qwen, 62_000, undefined).words)
  const bare = { id: qwen.id, server: qwen.server, modelMaxContext: undefined }
  check('a model that states no trained max and has no served window falls to the doubling rule (62k ⇒ 128k, reason req)', w.chooseLocalWindow(bare, 62_000, undefined, null).window === 131072 && w.chooseLocalWindow(bare, 62_000, undefined, null).reason === 'req', w.chooseLocalWindow(bare, 62_000, undefined, null).words)
}

section('2 · the setting grammar and the ladder')
{
  check("'server' and 'max' parse; '64k' is 65536; a bare number stands; junk and tiny values are undefined", w.parseLocalWindowSetting('server') === 'server' && w.parseLocalWindowSetting('max') === 'max' && w.parseLocalWindowSetting('64k') === 65536 && w.parseLocalWindowSetting(200000) === 200000 && w.parseLocalWindowSetting('nonsense') === undefined && w.parseLocalWindowSetting(512) === undefined)
  check("chooseLocalWindow: 'server' ⇒ none; 'max' ⇒ the trained max; a number clamps to the trained max; unset ⇒ auto (the trained max here: no geometry, no truth)", w.chooseLocalWindow(qwen, 62_000, 'server').window === undefined && w.chooseLocalWindow(qwen, 62_000, 'max').window === 262144 && w.chooseLocalWindow(qwen, 62_000, 200_000).window === 200_000 && w.chooseLocalWindow(qwen, 62_000, 400_000).window === 262144 && w.chooseLocalWindow(qwen, 62_000, undefined).window === 262144)
  const ladder: Array<unknown> = [undefined]
  for (let i = 0; i < 6; i++) ladder.push(w.nextLocalWindowSetting(ladder.at(-1) as never, 1))
  check('←/→ walk auto → server default → 32k → 64k → 128k → trained max → auto', j(ladder) === j([undefined, 'server', 32768, 65536, 131072, 'max', undefined]), j(ladder))
  check('the words: auto · server default · 32k · trained max', w.localWindowSettingWords(undefined) === 'auto' && w.localWindowSettingWords('server') === 'server default' && w.localWindowSettingWords(32768) === '32k' && w.localWindowSettingWords('max') === 'trained max')
  w.writeLocalWindowSetting(qwen, 65536)
  check('the setting persists in the global config under local/<id> and reads back', w.localWindowSettingOf(qwen) === 65536)
  w.writeLocalWindowSetting(qwen, undefined)
  check('clearing it returns to auto', w.localWindowSettingOf(qwen) === undefined)
}

section('3 · the hold: one chosen window per model per process; a changed setting re-decides; server-start kinds hold nothing')
{
  w.__resetLocalWindowsForTest()
  const first = w.decideLocalWindow(qwen, 62_000, undefined)
  const second = w.decideLocalWindow(qwen, 17_000, undefined)
  check('the first dispatch decides (auto 256k here — the trained max on an unread machine, reason max); a smaller second dispatch on the same model reuses it', first.window === 262144 && first.reason === 'max' && second === first)
  const changed = w.decideLocalWindow(qwen, 17_000, 65536)
  check('a changed setting re-decides (64k)', changed.window === 65536 && changed !== first)
  const vllm = { id: 'Qwen/Qwen3-32B', server: 'vllm' as const, modelMaxContext: 40960, baseUrl: 'x', contextWindow: { tokens: 40960, source: 'served' as const } }
  check('a vLLM model holds no window (set at server start) and its words say so', w.decideLocalWindow(vllm, 62_000, undefined).window === undefined && w.localWindowValueWords(vllm, undefined).includes('set at server start') && w.localWindowValueWords(vllm, undefined).includes('n/a'), w.localWindowValueWords(vllm, undefined))
  w.__resetLocalWindowsForTest()
  const guardAuto = w.decideLocalWindow(qwen, 62_000, undefined)
  const guard = localGuardWindow(qwen, guardAuto)
  check('the guard reads the chosen window as the served figure until ps confirms, naming auto', guard?.tokens === 262144 && (guard?.sourceWords ?? '').includes('auto'), j(guard))
  const set = localGuardWindow(qwen, w.decideLocalWindow(qwen, 62_000, 8192))
  check('a user setting is the guard\'s window, named as the setting', set?.tokens === 8192 && (set?.sourceWords ?? '').includes('your setting'), j(set))
  const profile = localLaneProfileFor(qwen)
  const refusal = profile.requestFitRefusal?.({ requestBytes: 248_000, estTokens: 62_000, toolCount: 63, wireModel: OLLAMA_MODEL })
  check('the fit refusal on that setting names it and the in-app road', (refusal ?? '').includes('8192 tokens — your setting — /config → Local model window'), String(refusal))
  w.__resetLocalWindowsForTest()
}

section('4 · the native /api/chat body: the OpenAI-shaped history mapped to Ollama\'s own message shape, tools passed, num_ctx · think · truncate:false')
{
  const request = {
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system' as const, content: 'You are terse.' },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'what is in this picture?' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant' as const, content: null, tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'Read', arguments: '{"file_path":"/tmp/a.txt"}' } }] },
      { role: 'tool' as const, content: 'the file says hello', tool_call_id: 'call_1' },
    ],
    tools: [{ type: 'function' as const, function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } } }],
    extra: { stream_options: { include_usage: true }, reasoning_effort: 'high', max_tokens: 2048 },
  }
  const body = ollamaChatBody(request, { numCtx: 131072, numBatch: 2048, think: true })
  const messages = body.messages as Array<Record<string, unknown>>
  check('system and user text ride as content; the image rides Ollama\'s images[] as bare base64', messages[0]?.content === 'You are terse.' && messages[1]?.content === 'what is in this picture?' && j(messages[1]?.images) === j(['AAAA']), j(messages.slice(0, 2)))
  check('the assistant tool call carries arguments as an OBJECT with its id', j((messages[2]?.tool_calls as Array<Record<string, unknown>>)[0]) === j({ id: 'call_1', function: { name: 'Read', arguments: { file_path: '/tmp/a.txt' } } }), j(messages[2]))
  check('the tool result carries tool_call_id and the call\'s name as tool_name', messages[3]?.role === 'tool' && messages[3]?.tool_call_id === 'call_1' && messages[3]?.tool_name === 'Read' && messages[3]?.content === 'the file says hello', j(messages[3]))
  check('tools pass through in the function shape Ollama documents', j(body.tools) === j(request.tools))
  check('stream:true, truncate:false, think:true, options.num_ctx 131072 · num_batch 2048 · num_predict from max_tokens; no OpenAI-only field', body.stream === true && body.truncate === false && body.think === true && j(body.options) === j({ num_ctx: 131072, num_batch: 2048, num_predict: 2048 }) && !('stream_options' in body) && !('reasoning_effort' in body) && !('keep_alive' in body), j(body))
  check('the batch: 2048 by default, a setting names another value, never above the window', w.chooseLocalBatch(undefined, 131072) === 2048 && w.chooseLocalBatch(1024, 131072) === 1024 && w.chooseLocalBatch(undefined, 512) === 512 && w.localBatchSettingOf(qwen, { localModelBatch: { [`local/${OLLAMA_MODEL}`]: 1024 } }) === 1024 && w.localBatchSettingOf(qwen, {}) === undefined)
  const plain = ollamaChatBody({ model: OLLAMA_MODEL, messages: [{ role: 'user', content: 'hi' }] }, {})
  check('with nothing chosen and no thinking: no options, no think', !('options' in plain) && !('think' in plain), j(plain))
  check('a bad arguments string in history degrades to an empty object, never a crash', j(ollamaMessagesOf([{ role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'X', arguments: '{oops' } }] }])[0]?.tool_calls?.[0]?.function.arguments) === '{}')
}

section('5 · the NDJSON stream decodes to the compat events: served model, thinking, text, a tool call with its arguments, the done row\'s counts')
{
  const events: CompatStreamEvent[] = []
  for await (const event of streamOllamaChat({ url: `${ollama.root}/api/chat`, request: { model: OLLAMA_MODEL, messages: [{ role: 'user', content: 'read /tmp/a.txt' }] } }, { numCtx: 131072, think: true })) events.push(event)
  const kinds = events.map(e => e.type)
  check('the served model rides first, once', kinds[0] === 'served-model' && kinds.filter(k => k === 'served-model').length === 1, j(kinds))
  check('thinking rows become reasoning deltas in order', events.filter(e => e.type === 'reasoning-delta').map(e => (e as { text: string }).text).join('') === 'Let me look. The file is small.')
  check('content rows become text deltas', events.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text).join('') === 'Reading it now.')
  const finish = events.find(e => e.type === 'finish') as { reason: string; toolCalls: Array<{ id: string; name: string; arguments?: unknown; malformed: boolean }> } | undefined
  check('the tool call settles at finish with its id, name and PARSED arguments; the finish reason is tool_calls', finish?.reason === 'tool_calls' && finish.toolCalls.length === 1 && finish.toolCalls[0]!.id === 'call_7' && finish.toolCalls[0]!.name === 'Read' && j(finish.toolCalls[0]!.arguments) === j({ file_path: '/tmp/a.txt' }) && finish.toolCalls[0]!.malformed === false, j(finish))
  const usage = events.find(e => e.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } } | undefined
  check('the done row\'s counts ride the usage event (prompt_eval_count · eval_count · prompt_eval_cached_count)', usage?.usage.inputTokens === 62000 && usage.usage.outputTokens === 30 && usage.usage.cachedInputTokens === 8192, j(usage))
  check('the usage precedes the finish, and nothing follows the finish', kinds.includes('usage') && kinds.includes('finish') && kinds.indexOf('usage') < kinds.indexOf('finish') && kinds.at(-1) === 'finish', j(kinds))
  check('the request the fixture saw carried num_ctx and think', j((ollamaHits.at(-1)?.body.options as Record<string, unknown>)?.num_ctx) === '131072' && ollamaHits.at(-1)?.body.think === true)
  ollamaState.errorNext = 'the prompt is longer than the context length currently available to the model; shorten the prompt, adjust the context length in settings, or use a model with a longer context length'
  const faults: CompatStreamEvent[] = []
  for await (const event of streamOllamaChat({ url: `${ollama.root}/api/chat`, request: { model: OLLAMA_MODEL, messages: [{ role: 'user', content: 'x' }] } }, {})) faults.push(event)
  const fault = faults.find(e => e.type === 'stream-fault') as { fault: { kind: string; message: string } } | undefined
  check('an error row is a typed api-error fault carrying the server\'s own words (truncate:false makes it refuse, never truncate)', fault?.fault.kind === 'api-error' && fault.fault.message.includes('longer than the context length'), j(faults.map(e => e.type)))
}

section('6 · the runtime road: the Ollama profile streams /api/chat through the shared compat runtime — the settlement is byte-identical downstream')
{
  const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
  w.__resetLocalWindowsForTest()
  w.decideLocalWindow(qwen, 5_000, undefined)
  const before = ollamaHits.length
  const yielded: Array<{ type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown; thinking?: string }> } }> = []
  for await (const item of compatChatCallModel(localLaneProfileFor(qwen), {
    messages: [{ type: 'user', message: { role: 'user', content: 'read /tmp/a.txt' }, uuid: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString() }] as never,
    systemPrompt: [] as never,
    thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model: `local/${OLLAMA_MODEL}`, querySource: 'user', getToolPermissionContext: async () => ({ mode: 'default' }) as never } as never,
  })) yielded.push(item as never)
  const hits = ollamaHits.slice(before)
  const chats = hits.filter(h => h.method === 'POST')
  check('exactly one chat request, on /api/chat, never /v1/chat/completions; the only other traffic is the local law\'s cheap reads (/api/ps · /api/tags · /api/version)', chats.length === 1 && chats[0]!.url === '/api/chat' && hits.every(h => h.method === 'POST' || ['/api/ps', '/api/tags', '/api/version'].includes(h.url)), hits.map(h => `${h.method} ${h.url}`).join(','))
  check('it carried the held num_ctx (256k: the trained max, the machine unread, whatever the first request\'s size), num_batch 2048 and think:true for a thinking model', (chats[0]!.body.options as { num_ctx?: number; num_batch?: number })?.num_ctx === 262144 && (chats[0]!.body.options as { num_batch?: number })?.num_batch === 2048 && chats[0]!.body.think === true, j(chats[0]!.body.options))
  const blocks = yielded.filter(m => m.type === 'assistant').flatMap(m => m.message?.content ?? [])
  check('the settlement carries the thinking block, the text block and the refused-or-settled tool call, no api error', blocks.some(b => b.type === 'thinking' && (b.thinking ?? '').includes('Let me look')) && blocks.some(b => b.type === 'text' && (b.text ?? '').includes('Reading it now')) && !yielded.some(m => m.isApiErrorMessage === true), j(blocks.map(b => b.type)))
}

section('7 · LM Studio: the setting applies through the documented load road — unload the instance, load with context_length, the served window follows')
{
  w.__resetLocalWindowsForTest()
  check('discovery states the loaded instance (8192 served)', gemma.contextWindow?.tokens === 8192 && gemma.contextWindow.source === 'served')
  const before = lmHits.length
  await ensureServedWindow(gemma, {}, { numCtx: 65536 })
  const hits = lmHits.slice(before)
  const unload = hits.find(h => h.url === '/api/v1/models/unload')
  const load = hits.find(h => h.url === '/api/v1/models/load')
  check('the old instance was unloaded by id, then the model loaded with context_length 65536', unload !== undefined && load !== undefined && hits.includes(unload) && hits.includes(load) && unload.body.instance_id === 'inst-1' && load.body.model === LM_MODEL && load.body.context_length === 65536 && hits.indexOf(unload) < hits.indexOf(load), hits.map(h => `${h.url} ${j(h.body)}`).join(' | '))
  check('the record now states served 65536', gemma.contextWindow?.tokens === 65536 && gemma.contextWindow.source === 'served', j(gemma.contextWindow))
  const again = lmHits.length
  await ensureServedWindow(gemma, {}, { numCtx: 65536 })
  check('the same window asked again is a no-op (current and equal)', lmHits.length === again)
  check('the words: 64k · served 64k · applied at load', w.localWindowValueWords(gemma, 65536).includes('64k') && w.localWindowValueWords(gemma, 65536).includes('applied at load'), w.localWindowValueWords(gemma, 65536))
}

section('8 · the /config row (pure): the value words per kind and the n/a outside the local lane')
{
  __resetLocalDiscoveryForTest()
  await refreshLocalDiscovery({ force: true })
  w.__resetLocalWindowsForTest()
  const q = localRecordFor(`local/${OLLAMA_MODEL}`)!
  const row = localModelWindowRow(q, 'local')
  check('an Ollama model under auto: "auto … num_ctx on every request · <id>", applies, not set by you', row.applies && row.valueText.startsWith('auto') && row.valueText.includes('num_ctx on every request') && row.valueText.endsWith(q.id) && row.setByYou === false, row.valueText)
  w.writeLocalWindowSetting(q, 131072)
  const set = localModelWindowRow(q, 'local')
  check('with 128k set: the value names it and setByYou is true', set.valueText.startsWith('128k') && set.setByYou === true, set.valueText)
  w.writeLocalWindowSetting(q, undefined)
  const na = localModelWindowRow(undefined, 'anthropic')
  check('outside the local lane the row is n/a and names the active lane', !na.applies && na.valueText.includes('n/a — applies to local models (Anthropic is active)'), na.valueText)
  const vllm = { id: 'Qwen/Qwen3-32B', server: 'vllm' as const, modelMaxContext: 40960, baseUrl: 'x', contextWindow: { tokens: 40960, source: 'served' as const } }
  const fixed = localModelWindowRow(vllm as never, 'local')
  check('a vLLM model: not applicable, the note says the server fixes its window at start', !fixed.applies && fixed.valueText.includes('set at server start') && fixed.note.includes('fixes its window when it starts'), fixed.valueText)
}

section("9 · the small-machine warning on the two pick surfaces (red on the base): on an 8 GiB darwin box a pick that fits but leaves little room is said once, in the picker's bracket and the /config row's note, with the smaller rung; auto, server, a roomy pick and a refused pick read as before")
{
  const memory = await import('../../src/services/localServer/localServerMemory.ts')
  const truthModule = await import('../../src/services/localServer/localServerTruth.ts')
  const GIB = 1024 ** 3
  const kvHeads = (blocks: number): number[] => Array.from({ length: blocks }, (_, i) => ((i + 1) % 4 === 0 ? 4 : 0))
  const geometry = memory.kvGeometryOf({ 'general.architecture': 'qwen35', 'qwen35.attention.head_count': 16, 'qwen35.attention.head_count_kv': kvHeads(32), 'qwen35.attention.key_length': 256, 'qwen35.attention.value_length': 256, 'qwen35.block_count': 32, 'qwen35.context_length': 262144, 'qwen35.embedding_length': 4096, 'qwen35.full_attention_interval': 4 })!
  const truthOn = (totalBytes: number, usableBytes?: number) => ({ server: { kind: 'ollama' as const, root: ollama.root, version: '0.34.4', label: 'Ollama 0.34.4' }, loaded: [], listed: [], runners: [], launchForm: { kind: 'unknown' as const, note: 'fixture' }, machine: usableBytes === undefined ? truthModule.defaultMachineTruth('darwin', totalBytes) : { platform: 'darwin' as const, totalMemoryBytes: totalBytes, usableMemoryBytes: usableBytes, usableSource: "the server's own gpu memory line in /fixture/ollama.log (Metal)" }, readAtMs: Date.now() })
  const EIGHT = truthOn(8 * GIB)
  const q = localRecordFor(`local/${OLLAMA_MODEL}`)!
  const small = { ...q, id: 'qwen3.5:4b', modelMaxContext: 262144, weightsBytes: Math.round(3.8 * GIB), geometry, contextWindow: undefined, servedBytes: undefined, loaded: false }
  const TIGHT = '64k leaves 0.2 GiB of 6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB'
  check('the truth: an 8 GiB darwin box reads 6.0 GiB usable by the Metal fraction, and the record carries the 4B weights and geometry', memory.gibWords(EIGHT.machine.usableMemoryBytes) === '6.0 GiB' && small.weightsBytes === Math.round(3.8 * GIB) && small.geometry.kvHeads === 32, j(EIGHT.machine))
  check(`the one source of the words: localWindowRoomWords on a 64k pick — ${TIGHT}; 32k, auto and server say nothing; a refused 128k says nothing here (the refusal speaks)`, w.localWindowRoomWords(small, 65536, EIGHT) === TIGHT && w.localWindowRoomWords(small, 32768, EIGHT) === undefined && w.localWindowRoomWords(small, undefined, EIGHT) === undefined && w.localWindowRoomWords(small, 'server', EIGHT) === undefined && w.localWindowRoomWords(small, 131072, EIGHT) === undefined && w.localWindowRefusalWords(small, 131072, EIGHT) === '7.8 GiB does not fit 6.0 GiB usable · 64k fits' && w.localWindowRoomWords(small, 65536, null) === undefined, j([w.localWindowRoomWords(small, 65536, EIGHT), w.localWindowRoomWords(small, 131072, EIGHT)]))
  w.__resetLocalWindowsForTest()
  const wide = w.localWindowChoiceLine(small, { wide: true, setting: 65536, truth: EIGHT })
  check(`the picker's wide row on a 64k pick: window · not loaded · max 256k · auto → 64k fit · server · 32k · [64k — ${TIGHT}] · 128k · max · number · w cycles`, wide === `window · not loaded · max 256k · auto → 64k fit · server · 32k · [64k — ${TIGHT}] · 128k · max · number · w cycles`, wide)
  const narrow = w.localWindowChoiceLine(small, { wide: false, setting: 65536, truth: EIGHT })
  check('the narrow row (80 columns) carries the same bracket', narrow === `window · not loaded auto → 64k fit · server · 32k · [64k — ${TIGHT}] · 128k · max · w cycles`, narrow)
  check('a 32k pick reads [32k] plain; auto reads [auto → 64k fit] with no warning though 64k is tight — the default is untouched; server reads [server]', w.localWindowChoiceLine(small, { wide: true, setting: 32768, truth: EIGHT }).includes(' · [32k] · ') && w.localWindowChoiceLine(small, { wide: true, setting: undefined, truth: EIGHT }).includes(' · [auto → 64k fit] · ') && w.localWindowChoiceLine(small, { wide: true, setting: 'server', truth: EIGHT }).includes(' · [server] · '), w.localWindowChoiceLine(small, { wide: true, setting: undefined, truth: EIGHT }))
  const refused = w.localWindowChoiceLine(small, { wide: true, setting: 131072, truth: EIGHT })
  check('a 128k pick keeps the refusal, never a warning beside it: [128k — 7.8 GiB does not fit 6.0 GiB usable · 64k fits]', refused.includes(' · [128k — 7.8 GiB does not fit 6.0 GiB usable · 64k fits] · ') && !refused.includes('leaves'), refused)
  check('a typed 48k: [48k — 48k leaves 0.7 GiB of 6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB]', w.localWindowChoiceLine(small, { wide: true, setting: 49152, truth: EIGHT }).includes('[48k — 48k leaves 0.7 GiB of 6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB]'), w.localWindowChoiceLine(small, { wide: true, setting: 49152, truth: EIGHT }))
  check('the same pick on a 16 GiB box with the same 6.0 GiB usable reads [64k] plain — the warning is for boxes under 16 GiB', w.localWindowChoiceLine(small, { wide: true, setting: 65536, truth: truthOn(16 * GIB, 6 * GIB) }).includes(' · [64k] · ') && w.localWindowChoiceLine(small, { wide: true, setting: 65536, truth: truthOn(16 * GIB - 1, 6 * GIB) }).includes('[64k — 64k leaves 0.2 GiB of 6.0 GiB usable (16.0 GiB box) · 32k leaves 1.2 GiB]'), w.localWindowChoiceLine(small, { wide: true, setting: 65536, truth: truthOn(16 * GIB, 6 * GIB) }))
  const span = (line: string) => {
    const s = w.localWindowRefusalSpan(line)
    return s === undefined ? undefined : line.slice(s.start, s.end)
  }
  check('the span finder paints the whole bracket, a wrapped head to the line end and a wrapped tail to the closing bracket, for the warning as for the refusal', span(wide) === `[64k — ${TIGHT}]` && span('window · not loaded auto → 64k fit · server · 32k · [64k — 64k leaves 0.2 GiB of') === '[64k — 64k leaves 0.2 GiB of' && span('6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB] · max · w cycles') === '6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB]' && span('(8.0 GiB box) · no smaller rung leaves room] · 128k') === '(8.0 GiB box) · no smaller rung leaves room]' && span(refused) === '[128k — 7.8 GiB does not fit 6.0 GiB usable · 64k fits]' && span('window · not loaded · max 256k · auto → 64k fit · server · [32k] · 64k') === undefined, j([span(wide), span('6.0 GiB usable (8.0 GiB box) · 32k leaves 1.2 GiB] · max · w cycles')]))
  check("the notice kind the picker paints by: warning ink for the room line, failure ink for the refusal, none for a plain row", w.localWindowNoticeKind(wide) === 'warning' && w.localWindowNoticeKind(narrow) === 'warning' && w.localWindowNoticeKind(refused) === 'refusal' && w.localWindowNoticeKind(w.localWindowChoiceLine(small, { wide: true, setting: 32768, truth: EIGHT })) === undefined, j([w.localWindowNoticeKind(wide), w.localWindowNoticeKind(refused)]))
  truthModule.__pinLocalServerTruthForTest(EIGHT)
  w.writeLocalWindowSetting(small, 65536)
  const tight = localModelWindowRow(small as never, 'local')
  check(`the /config row on a 64k pick: the value stays 64k · num_ctx on every request · qwen3.5:4b (not over the fit), tight marks the warning ink, and the note says: The setting fits this small box but leaves little room: ${TIGHT}.`, tight.applies && tight.setByYou && !tight.overFit && tight.tight && tight.valueText === '64k · num_ctx on every request · qwen3.5:4b' && tight.note.includes(`The setting fits this small box but leaves little room: ${TIGHT}.`) && !tight.note.includes('does not fit'), `${tight.valueText} || ${tight.note}`)
  w.writeLocalWindowSetting(small, 32768)
  const roomy = localModelWindowRow(small as never, 'local')
  check('on a 32k pick the row is not tight and the note carries no room sentence', !roomy.tight && !roomy.overFit && roomy.valueText.startsWith('32k') && !roomy.note.includes('leaves little room'), roomy.note)
  w.writeLocalWindowSetting(small, 131072)
  const over = localModelWindowRow(small as never, 'local')
  check('on a 128k pick the refusal stands alone: overFit, not tight, the value and the note carry the refusal', over.overFit && !over.tight && over.valueText.startsWith('128k — 7.8 GiB does not fit 6.0 GiB usable · 64k fits') && over.note.includes('The setting is saved but does not fit: 7.8 GiB does not fit 6.0 GiB usable · 64k fits.') && !over.note.includes('leaves little room'), over.valueText)
  w.writeLocalWindowSetting(small, undefined)
  const auto = localModelWindowRow(small as never, 'local')
  check('under auto the row predicts 64k (the biggest rung that fits) and is neither tight nor over the fit', !auto.tight && !auto.overFit && auto.valueText.startsWith('auto → 64k (the biggest rung that fits)'), auto.valueText)
  truthModule.__pinLocalServerTruthForTest(null)
  truthModule.__resetLocalServerTruthForTest()
  w.__resetLocalWindowsForTest()
}

ollama.server.close()
lmstudio.server.close()
console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
