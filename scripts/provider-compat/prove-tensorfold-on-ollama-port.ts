#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const childHome = process.argv[2] === '--scratch-home' ? process.argv[3] : undefined
const HOME = childHome ?? mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'tensorfold-on-ollama-port-proof-'))
if (childHome === undefined) {
  let status = 1
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scratch-home', HOME], { env: { ...process.env, HOME, USERPROFILE: HOME }, stdio: 'inherit' })
    status = child.status ?? 1
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
  process.exit(status)
}
if (realpathSync(homedir()) !== realpathSync(HOME)) throw new Error('The TensorFold proof requires its scratch HOME at process start.')
console.log('[PASS] product imports run with os.homedir() equal to the scratch home')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL
delete process.env.MERCURY_LOCAL_NEXT_TURN_PREFILL

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Row = Record<string, unknown>
type Asked = { method: string; path: string; body?: Row }
type StandIn = { root: string; asked: Asked[]; stop(): void }
function stand(route: (method: string, path: string, body: Row | undefined, request: Request) => Response): StandIn {
  const asked: Asked[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request: Request) {
      const path = new URL(request.url).pathname
      const text = request.method === 'POST' ? await request.text() : ''
      const body = text === '' ? undefined : (JSON.parse(text) as Row)
      asked.push({ method: request.method, path, ...(body !== undefined ? { body } : {}) })
      return route(request.method, path, body, request)
    },
  })
  return { root: `http://127.0.0.1:${server.port}`, asked, stop: () => server.stop(true) }
}
const paths = (server: StandIn, path: string): number => server.asked.filter(row => row.path === path).length

const MODEL = 'qwen3.5-2b'
const WINDOW = 65536
const KEY = 'fixture-key-0123456789abcdef0123456789abcdef'
const OLLAMA_OPTIONS = ['num_predict', 'temperature', 'top_k', 'top_p', 'min_p', 'stop', 'seed', 'presence_penalty', 'frequency_penalty']
function replyTo(rows: Row[]): { reasoning: string; text?: string; call?: Row } {
  return rows.at(-1)?.role === 'tool' ? { reasoning: 'Line 41 states the number.', text: 'The number is 42.' } : { reasoning: 'I should read the file first.', call: { file_path: '/work/alpha.txt' } }
}
function engine(key?: string): StandIn {
  const headers = { server: 'TensorFold' }
  const refuse = (message: string): Response => Response.json({ error: { message, type: 'invalid_request_error', param: 'messages', code: null } }, { status: 400, headers })
  return stand((method, path, body, request) => {
    if (method === 'GET' && path === '/health') {
      return Response.json(key !== undefined ? { status: 'ok' } : { status: 'ok', model: MODEL, model_ids: [MODEL], max_batch_size: 8, warming: false, memory: { active: 3167980568, cache: 0, peak: 3279555608 }, version: '1.2.9', backend: 'metal', device: 'Apple M5 Pro' }, { headers })
    }
    if (key !== undefined && request.headers.get('authorization') !== `Bearer ${key}`) {
      return Response.json({ error: { message: 'A valid API key is required', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } }, { status: 401, headers: { ...headers, 'www-authenticate': 'Bearer' } })
    }
    if (method === 'GET' && (path === '/api/tags' || path === '/api/ps')) return Response.json({ models: [{ name: MODEL, model: MODEL }] }, { headers })
    if (path === '/api/show') return Response.json({ modelfile: '', parameters: '', template: '', details: {} }, { headers })
    if (method === 'GET' && path === '/api/version') return Response.json({ version: '1.2.9' }, { headers })
    if (method === 'GET' && path === '/v1/models') {
      return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model', created: 1794700000, owned_by: 'tensorfold', capabilities: { reasoning: true, thinking_budget: true, prompt_cache: true, warm_turns: false, vision: false, thinking_switch: true }, context_length: WINDOW, max_model_len: WINDOW, reasoning: { default_enabled: true }, input_types: ['text'] }] }, { headers })
    }
    if (method === 'POST' && path === '/api/chat') {
      const options = (body?.options ?? {}) as Row
      const unknown = Object.keys(options).find(name => name !== 'num_ctx' && !OLLAMA_OPTIONS.includes(name))
      if (unknown !== undefined) return refuse(`option ${unknown} is not supported by this engine`)
      if (typeof options.num_ctx === 'number' && options.num_ctx > WINDOW) return refuse("num_ctx is above this model's context window")
      if (body?.think !== undefined && typeof body.think !== 'boolean') return refuse('think must be a boolean')
      const reply = replyTo((body?.messages ?? []) as Row[])
      const row = (extra: Row): string => JSON.stringify({ model: MODEL, created_at: '2026-11-15T00:00:00Z', ...extra })
      const rows = [...(reply.text !== undefined ? [row({ message: { role: 'assistant', content: reply.text }, done: false })] : []), row({ message: { role: 'assistant', content: '' }, prompt_eval_count: 10, eval_count: 5, done_reason: reply.call !== undefined ? 'tool_calls' : 'stop', done: true })]
      return new Response(rows.join('\n') + '\n', { headers: { ...headers, 'content-type': 'application/x-ndjson' } })
    }
    if (method === 'POST' && path === '/v1/chat/completions') {
      const rows = (body?.messages ?? []) as Row[]
      const reply = replyTo(rows)
      const chunk = (delta: Row, finish: string | null = null, extra: Row = {}): string => `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`
      const stream = [
        chunk({ role: 'assistant' }),
        chunk({ reasoning_content: reply.reasoning }),
        ...(reply.text !== undefined ? [chunk({ content: reply.text })] : []),
        ...(reply.call !== undefined ? [chunk({ tool_calls: [{ index: 0, id: 'call_000000000000000000000001', type: 'function', function: { name: READ, arguments: JSON.stringify(reply.call) } }] })] : []),
        chunk({}, reply.call !== undefined ? 'tool_calls' : 'stop', { tensorfold: { enable_thinking: true, reasoning_effort: 'high', engine: 'lanes', tokens_per_second: 100, seconds: 0.01, prefill_seconds: 0.01, time_to_first_token: 0.01 } }),
        `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: MODEL, choices: [], usage: { prompt_tokens: rows.length * 10, completion_tokens: 5, total_tokens: rows.length * 10 + 5, prompt_tokens_details: { cached_tokens: (rows.length - 1) * 10 }, completion_tokens_details: { reasoning_tokens: 2 } } })}\n\n`,
        'data: [DONE]\n\n',
      ]
      return new Response(stream.join(''), { headers: { ...headers, 'content-type': 'text/event-stream' } })
    }
    return Response.json({ error: { message: `unknown path ${path}` } }, { status: 404, headers })
  })
}
const TAG = 'qwen3.5:9b'
function ollama(headers: Record<string, string> = {}): StandIn {
  return stand((method, path) => {
    if (method === 'GET' && path === '/api/tags') return Response.json({ models: [{ name: TAG, model: TAG, size: 6600000000, details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' } }] }, { headers })
    if (method === 'GET' && path === '/api/version') return Response.json({ version: '0.12.6' }, { headers })
    if (method === 'GET' && path === '/api/ps') return Response.json({ models: [{ name: TAG, model: TAG, context_length: 32768, size: 7000000000 }] }, { headers })
    if (method === 'POST' && path === '/api/show') return Response.json({ capabilities: ['completion', 'tools', 'thinking'], parameters: '', model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262144 } }, { headers })
    if (method === 'GET' && path === '/v1/models') return Response.json({ object: 'list', data: [{ id: TAG, object: 'model', created: 1, owned_by: 'library' }] }, { headers })
    return Response.json({ error: 'not found' }, { status: 404, headers })
  })
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { discoverLocalServers, refreshLocalDiscovery, __resetLocalDiscoveryForTest } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
const { setEngineModelOverride } = await import('../../src/bootstrap/state.ts')
const { runCleanupFunctions } = await import('../../src/utils/cleanupRegistry.ts')
const { lastTensorFoldTurn, __resetTensorFoldUsageForTest } = await import('../../src/services/providers/local/tensorfoldUsage.ts')
const { __resetNextTurnPrefillForTest } = await import('../../src/services/providers/local/tensorfoldPrefill.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type Block = { type: string; id?: string; name?: string; text?: string; input?: Row }
const READ = FileReadTool.name

async function ask(messages: unknown[]): Promise<{ minted: AssistantMessage[]; errors: string[] }> {
  const minted: AssistantMessage[] = []
  const errors: string[] = []
  for await (const item of localCallModel({
    messages: messages as never,
    systemPrompt: ['You are a careful assistant in a terminal. A file is read before it is described.'] as never,
    thinkingConfig: { type: 'enabled', budget_tokens: 1024 } as never,
    tools: [FileReadTool] as never,
    signal: new AbortController().signal,
    options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model: `local/${MODEL}`, isNonInteractiveSession: true, querySource: 'sdk', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' } as never,
  })) {
    const row = item as AssistantMessage & { isApiErrorMessage?: boolean }
    if (row.type !== 'assistant') continue
    if (row.isApiErrorMessage === true) errors.push(JSON.stringify(row.message.content))
    else minted.push(row)
  }
  return { minted, errors }
}
const blocks = (rows: AssistantMessage[]): Block[] => rows.flatMap(row => row.message.content as Block[])

section('1 · an engine that answers Ollama\'s API beside its own, as TensorFold does from 1.2.9, is found by the ollama target and recorded as TensorFold')
const tensorfold = engine()
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${tensorfold.root}`
__resetLocalDiscoveryForTest()
{
  const snapshot = await refreshLocalDiscovery({ force: true, timeoutMs: 3000 })
  const server = snapshot.servers.find(found => found.root === tensorfold.root)
  const row = server?.models[0]
  check('the stand-in answers /api/tags, so the ollama probe finds it', paths(tensorfold, '/api/tags') === 1 && server !== undefined, JSON.stringify(tensorfold.asked.map(asked => asked.path)))
  check('kind tensorfold', server?.kind === 'tensorfold', `${server?.kind} · ${server?.label}`)
  check('label TensorFold 1.2.9', server?.label === 'TensorFold 1.2.9', server?.label)
  check(`${MODEL} is listed with its ${WINDOW} window as served`, row?.id === MODEL && row.server === 'tensorfold' && row.contextWindow?.tokens === WINDOW && row.contextWindow.source === 'served', JSON.stringify(row))
  check('the record holds what the engine says it can do: it keeps prompt states, does not read the next turn ahead, has a thinking switch', row?.promptCache === true && row.warmTurns === false && row.thinkingSwitch === true && row.thinkingDeclared === true, JSON.stringify(row))
  check('the open /health fills backend, device, in-use bytes and streams', server?.engine?.keyed === false && server.engine.backend === 'metal' && server.engine.device === 'Apple M5 Pro' && server.engine.inUseBytes === 3167980568 && server.engine.streams === 8, JSON.stringify(server?.engine))
  check('the root is listed once', snapshot.servers.length === 1, JSON.stringify(snapshot.servers.map(found => `${found.kind} ${found.root}`)))
  check('it is asked /api/tags, then its own /v1/models and /health, and none of Ollama\'s other routes', JSON.stringify(tensorfold.asked.map(asked => asked.path)) === JSON.stringify(['/api/tags', '/v1/models', '/health']), JSON.stringify(tensorfold.asked.map(asked => asked.path)))
}

section('2 · a conversation on it runs on the engine\'s own chat route: the tool call arrives, its result goes back, and the engine\'s numbers are read')
{
  __resetTensorFoldUsageForTest()
  setEngineModelOverride(`local/${MODEL}`)
  const record = localRecordFor(`local/${MODEL}`)
  check('the model resolves to the discovered record', record?.id === MODEL, JSON.stringify(record))
  let history: unknown[] = [createUserMessage({ content: 'Read /work/alpha.txt and tell me the number it holds.' })]
  const first = await ask(history)
  const call = blocks(first.minted).find(block => block.type === 'tool_use')
  check('the turn is refused by nothing', first.errors.length === 0, first.errors.join(' | '))
  check('the turn goes to /v1/chat/completions and not to /api/chat', paths(tensorfold, '/v1/chat/completions') === 1 && paths(tensorfold, '/api/chat') === 0, JSON.stringify(tensorfold.asked.filter(asked => asked.method === 'POST').map(asked => asked.path)))
  check('the tool call arrives', call?.name === READ && call.input?.file_path === '/work/alpha.txt', JSON.stringify(blocks(first.minted)))
  history = [...history, ...first.minted, createUserMessage({ content: [{ type: 'tool_result', tool_use_id: call?.id, content: '41\tThe number is 42.' }] as never })]
  const second = call === undefined ? { minted: [], errors: ['no call to answer'] } : await ask(history)
  check('the result goes back and the answer arrives', second.errors.length === 0 && blocks(second.minted).some(block => block.type === 'text' && block.text === 'The number is 42.'), second.errors.join(' | ') || JSON.stringify(blocks(second.minted)))
  const usage = second.minted.at(-1)?.message.usage as { cache_read_input_tokens?: number } | undefined
  check('the reply carries the tokens the engine resumed', usage?.cache_read_input_tokens === 30, JSON.stringify(usage))
  check('the turn is kept as a TensorFold reading for the card', lastTensorFoldTurn()?.model === MODEL, JSON.stringify(lastTensorFoldTurn()))
}

section('3 · a keyed engine: recorded as TensorFold under the key Mercury holds, and not listed without it')
{
  const keyed = engine(KEY)
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${keyed.root}`
  const without = await discoverLocalServers({ timeoutMs: 3000 })
  check('without the key nothing is listed', without.servers.length === 0, JSON.stringify(without.servers.map(found => found.label)))
  const held = await discoverLocalServers({ timeoutMs: 3000, env: { ...process.env, MERCURY_LOCAL_API_KEY: KEY } })
  const server = held.servers[0]
  check('with the key it is TensorFold, keyed, with its model and window', server?.kind === 'tensorfold' && server.engine?.keyed === true && server.models[0]?.id === MODEL && server.models[0].contextWindow?.tokens === WINDOW, `${server?.kind} · ${server?.label} · ${JSON.stringify(server?.models[0])}`)
  keyed.stop()
}

section('4 · an Ollama server stays Ollama and is asked what it was asked before; a Server header alone makes no TensorFold')
{
  const plain = ollama()
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${plain.root}`
  const snapshot = await discoverLocalServers({ timeoutMs: 3000 })
  const server = snapshot.servers[0]
  const row = server?.models[0]
  check('kind ollama, label Ollama 0.12.6', server?.kind === 'ollama' && server.label === 'Ollama 0.12.6', `${server?.kind} · ${server?.label}`)
  check('its model keeps the window /api/ps serves and the tools /api/show declares', row?.id === TAG && row.server === 'ollama' && row.contextWindow?.tokens === 32768 && row.contextWindow.source === 'served' && row.toolsDeclared === true, JSON.stringify(row))
  check('one probe asks /api/tags, /api/version, /api/ps and /api/show once each, and nothing else', JSON.stringify(plain.asked.map(asked => asked.path).sort()) === JSON.stringify(['/api/ps', '/api/show', '/api/tags', '/api/version']), JSON.stringify(plain.asked.map(asked => asked.path)))
  plain.stop()
  const named = ollama({ server: 'TensorFold' })
  process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${named.root}`
  const other = (await discoverLocalServers({ timeoutMs: 3000 })).servers[0]
  check('a server that answers Ollama\'s API under the header Server: TensorFold and lists no TensorFold model stays Ollama', other?.kind === 'ollama' && other.models[0]?.id === TAG && paths(named, '/v1/models') === 1, `${other?.kind} · ${other?.label} · ${JSON.stringify(named.asked.map(asked => asked.path))}`)
  named.stop()
}

await runCleanupFunctions().catch(() => undefined)
__resetNextTurnPrefillForTest()
tensorfold.stop()
console.log(`\nprove-tensorfold-on-ollama-port: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
