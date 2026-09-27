#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'lmstudio-live-answers-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

const FIXTURES = join(import.meta.dir, 'fixtures', 'lmstudio-single-model')
const bytes = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const MODEL = 'qwen3.5-9b'
const SERVED = 147456
const TRAINED = 262144
const INSTANCE = 'qwen3.5-9b'

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
function raw(res: ServerResponse, contentType: string, body: string): true {
  res.writeHead(200, { 'content-type': contentType })
  res.end(body)
  return true
}

const instance: { loaded: boolean; contextLength: number } = { loaded: true, contextLength: SERVED }
const loads: Array<{ path: string; body: Record<string, unknown> }> = []
const chatRequests: Array<Record<string, unknown>> = []
function modelsBody(): string {
  const listing = JSON.parse(bytes('api-v1-models.json')) as { models: Array<Record<string, unknown>> }
  const model = listing.models.find(m => m.key === MODEL)!
  model.loaded_instances = instance.loaded ? [{ id: INSTANCE, config: { ...((model.loaded_instances as Array<{ config: Record<string, unknown> }>)[0]?.config ?? {}), context_length: instance.contextLength } }] : []
  return JSON.stringify(listing)
}
const lmstudio = await serve((req, body, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') return raw(res, 'application/json; charset=utf-8', bytes('v1-models.json'))
  if (req.method === 'GET' && req.url === '/api/v1/models') return raw(res, 'application/json; charset=utf-8', instance.loaded && instance.contextLength === SERVED ? bytes('api-v1-models.json') : modelsBody())
  if (req.method === 'POST' && (req.url === '/api/v1/models/unload' || req.url === '/api/v1/models/load')) {
    const parsed = JSON.parse(body) as Record<string, unknown>
    loads.push({ path: req.url, body: parsed })
    if (req.url === '/api/v1/models/unload') instance.loaded = false
    else {
      instance.loaded = true
      instance.contextLength = typeof parsed.context_length === 'number' ? parsed.context_length : SERVED
    }
    return raw(res, 'application/json; charset=utf-8', JSON.stringify({ ok: true }))
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const parsed = JSON.parse(body) as Record<string, unknown>
    chatRequests.push(parsed)
    const messages = parsed.messages as Array<{ role: string; content?: unknown }>
    const round = messages.some(m => m.role === 'tool') ? 'tool-round-2.sse' : messages.some(m => typeof m.content === 'string' && m.content.includes('checkpoint')) ? 'tool-round-1.sse' : 'reply.sse'
    return raw(res, 'text/event-stream', bytes(round))
  }
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `lmstudio=${lmstudio.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { refreshLocalDiscovery, readServedWindow, ensureServedWindow, __resetLocalDiscoveryForTest } = discovery
const catalogue = await import('../../src/services/providers/local/localCatalogue.ts')
const { getLocalModelOptions, localRecordFor, localWindowWords } = catalogue
const { localLaneProfileFor, localGuardWindow, localModelAcceptsEffort } = await import('../../src/services/providers/local/localCallModel.ts')
const { localWindowApplication, localWindowValueWords, __resetLocalWindowsForTest } = await import('../../src/services/providers/local/localWindow.ts')
const { buildLocalExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
type CompatStreamEvent = import('../../src/services/providers/openaicompat/compatChatClient.ts').CompatStreamEvent

section('1 · discovery on a single-model LM Studio: /api/v1/models states the loaded instance, its window, the trained maximum and the capabilities')
{
  __resetLocalDiscoveryForTest()
  __resetLocalWindowsForTest()
  const snapshot = await refreshLocalDiscovery({ force: true })
  const server = snapshot.servers.find(s => s.kind === 'lmstudio')
  check('the server is found under its label with the /v1 base', server?.label === 'LM Studio' && server.baseUrl === `${lmstudio.root}/v1`, JSON.stringify(server?.label))
  const record = localRecordFor(`local/${MODEL}`)
  check('the llm is listed once under LM Studio by its key; the embedding model in the same listing is not a chat model and is skipped', server?.models.length === 1 && record?.server === 'lmstudio' && record.id === MODEL && record.displayName === 'Qwen3.5 9B', JSON.stringify(server?.models.map(m => m.id)))
  check('the served window is the loaded instance\'s context_length (147456), labelled served', record?.contextWindow?.tokens === SERVED && record.contextWindow.source === 'served', JSON.stringify(record?.contextWindow))
  check('the trained maximum is max_context_length (262144)', record?.modelMaxContext === TRAINED, String(record?.modelMaxContext))
  check('the model reads as loaded (one loaded instance)', record?.loaded === true, String(record?.loaded))
  check('tools ride from capabilities.trained_for_tool_use, vision from capabilities.vision, thinking from capabilities.reasoning (allowed on/off, default on)', record?.toolsDeclared === true && record.visionDeclared === false && record.thinkingDeclared === true, JSON.stringify({ tools: record?.toolsDeclared, vision: record?.visionDeclared, thinking: record?.thinkingDeclared }))
  check('the weights, the family, the parameter count and the quantisation ride from the listing (size_bytes · architecture · params_string · quantization.name)', record?.weightsBytes === 5680522464 && record.family === 'qwen35' && record.parameterSize === '9B' && record.quantization === 'Q4_K_M', `${String(record?.weightsBytes)} · ${String(record?.family)} · ${String(record?.parameterSize)} · ${String(record?.quantization)}`)
  check('the record\'s window words read the served figure (the catalogue\'s /1000 spelling)', record !== undefined && localWindowWords(record) === '147k ctx · served', record ? localWindowWords(record) : 'no record')
  const row = getLocalModelOptions().find(r => r.value === `local/${MODEL}`)
  check('the picker row states the window', row?.statedContextWindow === SERVED, JSON.stringify(row))
}

section('2 · the window law on LM Studio is `load`: the served-window road reads the instance, a first send whose chosen window differs reloads the instance through the documented road (unload, then load with context_length), the same window is a no-op')
{
  const record = localRecordFor(`local/${MODEL}`)!
  check('the window applies at load, and the /config value words say so', localWindowApplication(record) === 'load' && localWindowValueWords(record).includes('applied at load'), localWindowValueWords(record))
  check('readServedWindow answers the loaded instance\'s context_length without touching it', (await readServedWindow(record)) === SERVED && loads.length === 0)
  const same = await ensureServedWindow(record, {}, { numCtx: SERVED })
  check('the same window asked at send is a no-op (current and equal): no unload, no load', same.contextWindow?.tokens === SERVED && loads.length === 0, JSON.stringify(loads))
  const before = loads.length
  const changed = await ensureServedWindow(record, {}, { numCtx: 131072 })
  const unload = loads[before]
  const load = loads[before + 1]
  check('another window at send: the instance is unloaded by id, then the model is loaded with context_length — the reload the docs name', unload?.path === '/api/v1/models/unload' && unload.body.instance_id === INSTANCE && load?.path === '/api/v1/models/load' && load.body.model === MODEL && load.body.context_length === 131072, JSON.stringify(loads.slice(before)))
  check('the record follows the reloaded instance (131072, served, loaded)', changed.contextWindow?.tokens === 131072 && changed.contextWindow.source === 'served' && changed.loaded === true, JSON.stringify(changed.contextWindow))
  await ensureServedWindow(record, {}, { numCtx: SERVED })
  check('the silent-truncation guard reads the served figure and the source words', localGuardWindow(record)?.tokens === SERVED && localGuardWindow(record)?.sourceWords === 'served', JSON.stringify(localGuardWindow(record)))
  const profile = localLaneProfileFor(record)
  check('a request inside the window is not refused; one past it is, naming the served window', profile.requestFitRefusal?.({ estTokens: 18_000, toolCount: 12 }) === undefined && (profile.requestFitRefusal?.({ estTokens: 200_000, toolCount: 12 }) ?? '').includes(`${SERVED} tokens — served`))
  check('LM Studio keeps tool_choice and takes the effort ladder for a model that declares reasoning', profile.omitsToolChoice !== true && localModelAcceptsEffort(record))
}

const collect = async (request: Parameters<typeof streamCompatChat>[0]['request']): Promise<CompatStreamEvent[]> => {
  const events: CompatStreamEvent[] = []
  for await (const event of streamCompatChat({ url: `${lmstudio.root}/v1/chat/completions`, request })) events.push(event)
  return events
}
const textOf = (events: CompatStreamEvent[]): string => events.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text).join('')
const reasoningOf = (events: CompatStreamEvent[]): string => events.filter(e => e.type === 'reasoning-delta').map(e => (e as { text: string }).text).join('')
const finishOf = (events: CompatStreamEvent[]) => events.find(e => e.type === 'finish') as { reason: string; toolCalls: Array<{ id: string; name: string; arguments?: unknown; argumentsRaw: string; malformed: boolean }> } | undefined
const usageOf = (events: CompatStreamEvent[]) => (events.find(e => e.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } } | undefined)?.usage
const faultsOf = (events: CompatStreamEvent[]): string[] => events.filter(e => e.type === 'stream-fault').map(e => (e as { fault: { code: string } }).fault.code)

section('3 · the streamed reply as the server answered it (reasoning_content deltas · content · stop · usage with reasoning_tokens beside it)')
{
  const record = localRecordFor(`local/${MODEL}`)!
  const extras = buildLocalExtras({ wireModel: MODEL, effortValue: undefined, thinkingEnabled: true, maxOutputTokensOverride: undefined, server: 'lmstudio', acceptsEffort: localModelAcceptsEffort(record) })
  const events = await collect({ model: MODEL, messages: [{ role: 'user', content: 'report the file and the line' }], tools: [], extra: extras })
  check('the reasoning block streams from reasoning_content deltas', reasoningOf(events).startsWith('Found the answer via Grep: notes-04.txt line 3 contains') && reasoningOf(events).length === 120, JSON.stringify(reasoningOf(events)))
  check('the text streams from content deltas', textOf(events) === 'Found it in **notes-04.txt**, exact line:\n\n```\nThe context checkpoint size is 149.626 MiB.\n```\n\nThis appears at line 3 of the file.', JSON.stringify(textOf(events)))
  check('the finish is a stop with no tool calls', finishOf(events)?.reason === 'stop' && finishOf(events)?.toolCalls.length === 0)
  check('the usage chunk reads prompt · completion; LM Studio states no cached count', usageOf(events)?.inputTokens === 18649 && usageOf(events)?.outputTokens === 86 && (usageOf(events)?.cachedInputTokens ?? 0) === 0, JSON.stringify(usageOf(events)))
  check('no fault on the stream', faultsOf(events).length === 0, faultsOf(events).join(','))
  const sent = chatRequests.at(-1)!
  check('the request carried stream_options.include_usage, stream:true and no reasoning_effort without a session effort', (sent.stream_options as { include_usage: boolean }).include_usage === true && sent.reasoning_effort === undefined && sent.stream === true)
}

section('4 · the tool loop as the server answered it (two parallel tool_calls streamed by index · finish tool_calls · the answer on the second round)')
{
  const tools = [
    { type: 'function', function: { name: 'Glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } } },
    { type: 'function', function: { name: 'Grep', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } } },
  ]
  const first = await collect({ model: MODEL, messages: [{ role: 'user', content: 'Find which file states the context checkpoint size.' }], tools, extra: { stream_options: { include_usage: true } } })
  const finish = finishOf(first)
  const glob = finish?.toolCalls[0]
  const grep = finish?.toolCalls[1]
  check('round 1 finishes on tool_calls with two settled calls, in the order the server streamed them', finish?.reason === 'tool_calls' && finish.toolCalls.length === 2 && glob?.name === 'Glob' && grep?.name === 'Grep', JSON.stringify(finish))
  check('each call carries the server\'s id and its argument fragments settle to the JSON the model wrote', glob?.id === 'obga4OXOev1mhvNiYQPfdFlkg56vZ9Vc' && glob.malformed === false && JSON.stringify(glob.arguments) === JSON.stringify({ pattern: 'notes-*.txt' }) && grep?.id === '3LBFkhHNLXMarWHSK8KZppl1HEwHWplw' && grep.malformed === false && JSON.stringify(grep.arguments) === JSON.stringify({ pattern: 'checkpoint.*size|context.*checkpoint', glob: 'notes-*.txt', output_mode: 'content', '-i': true }), JSON.stringify(finish?.toolCalls))
  check('round 1 also streamed its reasoning and its lead-in text before the calls', reasoningOf(first).startsWith('The user wants me to find which of the five') && textOf(first).startsWith("I'll search through these five text files"), `${JSON.stringify(reasoningOf(first).slice(0, 44))} · ${JSON.stringify(textOf(first).slice(0, 40))}`)
  check('round 1 usage: prompt 10279 · completion 215 (92 of them reasoning), nothing cached stated', usageOf(first)?.inputTokens === 10279 && usageOf(first)?.outputTokens === 215 && (usageOf(first)?.cachedInputTokens ?? 0) === 0, JSON.stringify(usageOf(first)))
  const second = await collect({
    model: MODEL,
    messages: [
      { role: 'user', content: 'Find which file states the context checkpoint size.' },
      { role: 'assistant', content: "I'll search through these five text files to find which one contains information about the context checkpoint size.\n\n", tool_calls: [{ id: glob!.id, type: 'function', function: { name: 'Glob', arguments: glob!.argumentsRaw } }, { id: grep!.id, type: 'function', function: { name: 'Grep', arguments: grep!.argumentsRaw } }] },
      { role: 'tool', tool_call_id: glob!.id, content: 'notes-01.txt\nnotes-02.txt\nnotes-03.txt\nnotes-04.txt\nnotes-05.txt' },
      { role: 'tool', tool_call_id: grep!.id, content: 'notes-04.txt:3:The context checkpoint size is 149.626 MiB.' },
    ] as never,
    tools,
    extra: { stream_options: { include_usage: true } },
  })
  check('round 2 (the assistant tool_calls + both tool results carried back) finishes on stop with the answer', finishOf(second)?.reason === 'stop' && textOf(second).includes('notes-04.txt') && textOf(second).includes('149.626 MiB'), JSON.stringify(textOf(second)))
  check('round 2 usage: prompt 11507 · completion 122', usageOf(second)?.inputTokens === 11507 && usageOf(second)?.outputTokens === 122, JSON.stringify(usageOf(second)))
  check('no fault on either round', faultsOf(first).length === 0 && faultsOf(second).length === 0, `${faultsOf(first).join(',')} · ${faultsOf(second).join(',')}`)
}

lmstudio.server.close()
console.log(failures === 0 ? '\n✅ LM Studio — discovery, the load-road window law, the streamed reply and the tool loop settle as the live server answered' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
