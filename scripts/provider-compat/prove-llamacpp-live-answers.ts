#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'llamacpp-live-answers-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_LOCAL_API_KEY
delete process.env.MERCURY_LOCAL_BASE_URL

const FIXTURES = join(import.meta.dir, 'fixtures', 'llamacpp-single-model')
const bytes = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const MODEL = 'qwen3.5:9b'
const SERVED = 262144
const TRAINED = 262144

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

const chatRequests: Array<Record<string, unknown>> = []
const llamacpp = await serve((req, body, res) => {
  if (req.method === 'GET' && req.url === '/health') return raw(res, 'application/json; charset=utf-8', bytes('health.json'))
  if (req.method === 'GET' && req.url === '/v1/models') return raw(res, 'application/json; charset=utf-8', bytes('v1-models.json'))
  if (req.method === 'GET' && req.url === '/models') return raw(res, 'application/json; charset=utf-8', bytes('models.json'))
  if (req.method === 'GET' && req.url === '/props') return raw(res, 'application/json; charset=utf-8', bytes('props.json'))
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    const parsed = JSON.parse(body) as Record<string, unknown>
    chatRequests.push(parsed)
    const messages = parsed.messages as Array<{ role: string; content?: unknown }>
    const round = messages.some(m => m.role === 'tool') ? 'tool-round-2.sse' : messages.some(m => typeof m.content === 'string' && m.content.includes('checkpoint')) ? 'tool-round-1.sse' : 'reply.sse'
    return raw(res, 'text/event-stream', bytes(round))
  }
  return false
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = `llamacpp=${llamacpp.root}`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const discovery = await import('../../src/services/providers/local/localDiscovery.ts')
const { refreshLocalDiscovery, getCachedLocalDiscovery, readServedWindow, ensureServedWindow, __resetLocalDiscoveryForTest } = discovery
const catalogue = await import('../../src/services/providers/local/localCatalogue.ts')
const { getLocalModelOptions, localRecordFor, localWindowWords, localPickerWindowNotice } = catalogue
const { localLaneProfileFor, localGuardWindow, localModelAcceptsEffort } = await import('../../src/services/providers/local/localCallModel.ts')
const { localPaceDefaultFor, LOCAL_PACE_SMALL_TOKENS_PER_S } = await import('../../src/services/providers/localLiveness.ts')
const { buildLocalExtras } = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
type CompatStreamEvent = import('../../src/services/providers/openaicompat/compatChatClient.ts').CompatStreamEvent

section('1 · discovery on a single-model llama.cpp whose /models answers the same list as /v1/models')
{
  __resetLocalDiscoveryForTest()
  const snapshot = await refreshLocalDiscovery({ force: true })
  const server = snapshot.servers.find(s => s.kind === 'llamacpp')
  check('the server is found and its label carries the build', server?.label === 'llama.cpp b11146-7fe450e19' && server.baseUrl === `${llamacpp.root}/v1`, JSON.stringify(server?.label))
  const record = localRecordFor(`local/${MODEL}`)
  check('the model is listed once under llama.cpp', server?.models.length === 1 && record?.server === 'llamacpp' && record.id === MODEL, JSON.stringify(server?.models.map(m => m.id)))
  check('the served window is /props n_ctx, labelled served (the router-mode shape carries status; this list does not)', record?.contextWindow?.tokens === SERVED && record.contextWindow.source === 'served', JSON.stringify(record?.contextWindow))
  check('the trained maximum is meta.n_ctx_train', record?.modelMaxContext === TRAINED, String(record?.modelMaxContext))
  check('the model reads as loaded (the list states its meta)', record?.loaded === true, String(record?.loaded))
  check('vision rides from /props modalities', record?.visionDeclared === true, String(record?.visionDeclared))
  check('the weights and the parameter count ride from meta (size · n_params)', record?.weightsBytes === 5669554176 && record.parameterSize === '9.0B', `${String(record?.weightsBytes)} · ${String(record?.parameterSize)}`)
  check('the ingest-pace default keys on the stated size (≤ 10B ⇒ the small-model pace)', localPaceDefaultFor(record?.parameterSize) === LOCAL_PACE_SMALL_TOKENS_PER_S, String(localPaceDefaultFor(record?.parameterSize)))
  check('the record\'s window words read the served figure', record !== undefined && localWindowWords(record) === '262k ctx · served', record ? localWindowWords(record) : 'no record')
  check('the picker notice reads the served figure, not a toggle', localPickerWindowNotice(`local/${MODEL}`) === '262k ctx · served · not a toggle', localPickerWindowNotice(`local/${MODEL}`))
  const row = getLocalModelOptions().find(r => r.value === `local/${MODEL}`)
  check('the picker row states the window', row?.statedContextWindow === SERVED, JSON.stringify(row))
}

section('2 · the served-window road at send (readServedWindow · ensureServedWindow) and the fit guard')
{
  const record = localRecordFor(`local/${MODEL}`)!
  check('readServedWindow answers /props n_ctx for llama.cpp', (await readServedWindow(record)) === SERVED)
  const before = { ...record, contextWindow: undefined, loaded: undefined, servedReadAtMs: undefined }
  delete (before as { contextWindow?: unknown }).contextWindow
  delete (before as { loaded?: unknown }).loaded
  delete (before as { servedReadAtMs?: unknown }).servedReadAtMs
  const ensured = await ensureServedWindow(before)
  check('ensureServedWindow fills an unstated record from the server (served, loaded)', ensured.contextWindow?.tokens === SERVED && ensured.contextWindow.source === 'served' && ensured.loaded === true, JSON.stringify(ensured.contextWindow))
  const guard = localGuardWindow(record)
  check('the silent-truncation guard now has a figure for llama.cpp (served)', guard?.tokens === SERVED && guard.sourceWords === 'served', JSON.stringify(guard))
  const profile = localLaneProfileFor(record)
  check('a request inside the window is not refused; one past it is, naming the served window', profile.requestFitRefusal?.({ estTokens: 18_000, toolCount: 12 }) === undefined && (profile.requestFitRefusal?.({ estTokens: 300_000, toolCount: 12 }) ?? '').includes(`${SERVED} tokens — served`))
  check('llama.cpp keeps tool_choice and takes the effort ladder for any model', profile.omitsToolChoice !== true && localModelAcceptsEffort(record))
}

const collect = async (request: Parameters<typeof streamCompatChat>[0]['request']): Promise<CompatStreamEvent[]> => {
  const events: CompatStreamEvent[] = []
  for await (const event of streamCompatChat({ url: `${llamacpp.root}/v1/chat/completions`, request })) events.push(event)
  return events
}
const textOf = (events: CompatStreamEvent[]): string => events.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text).join('')
const reasoningOf = (events: CompatStreamEvent[]): string => events.filter(e => e.type === 'reasoning-delta').map(e => (e as { text: string }).text).join('')
const finishOf = (events: CompatStreamEvent[]) => events.find(e => e.type === 'finish') as { reason: string; toolCalls: Array<{ id: string; name: string; arguments?: unknown; argumentsRaw: string; malformed: boolean }> } | undefined
const usageOf = (events: CompatStreamEvent[]) => (events.find(e => e.type === 'usage') as { usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number } } | undefined)?.usage
const faultsOf = (events: CompatStreamEvent[]): string[] => events.filter(e => e.type === 'stream-fault').map(e => (e as { fault: { code: string } }).fault.code)

section('3 · the streamed reply as the server answered it (reasoning_content deltas · content · stop · usage with timings)')
{
  const record = localRecordFor(`local/${MODEL}`)!
  const extras = buildLocalExtras({ wireModel: MODEL, effortValue: undefined, thinkingEnabled: true, maxOutputTokensOverride: undefined, server: 'llamacpp', acceptsEffort: localModelAcceptsEffort(record) })
  const events = await collect({ model: MODEL, messages: [{ role: 'user', content: 'reply with pong' }], tools: [], extra: extras })
  check('the reasoning block streams from reasoning_content deltas', reasoningOf(events) === "The user asked for a simple pong reply, so I'll respond directly.\n", JSON.stringify(reasoningOf(events)))
  check('the text streams from content deltas', textOf(events) === 'Pong', JSON.stringify(textOf(events)))
  check('the finish is a stop with no tool calls', finishOf(events)?.reason === 'stop' && finishOf(events)?.toolCalls.length === 0)
  check('the usage chunk (with llama.cpp timings beside it) reads prompt · completion · cached', usageOf(events)?.inputTokens === 17935 && usageOf(events)?.outputTokens === 21 && (usageOf(events)?.cachedInputTokens ?? 0) === 0, JSON.stringify(usageOf(events)))
  check('no fault on the stream', faultsOf(events).length === 0, faultsOf(events).join(','))
  const sent = chatRequests.at(-1)!
  check('the request carried stream_options.include_usage and no reasoning_effort without a session effort', (sent.stream_options as { include_usage: boolean }).include_usage === true && sent.reasoning_effort === undefined && sent.stream === true)
}

section('4 · the tool loop as the server answered it (streamed tool_calls deltas · finish tool_calls · the second round on the cache)')
{
  const first = await collect({ model: MODEL, messages: [{ role: 'user', content: 'Find which file states the context checkpoint size.' }], tools: [{ type: 'function', function: { name: 'Grep', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } } }], extra: { stream_options: { include_usage: true } } })
  const finish = finishOf(first)
  const call = finish?.toolCalls[0]
  check('round 1 finishes on tool_calls with exactly one settled call', finish?.reason === 'tool_calls' && finish.toolCalls.length === 1, JSON.stringify(finish))
  check('the call carries the server\'s id and name and its argument fragments settle to the JSON the model wrote', call?.id === '9vAStwXpyYaRMqsqfbjFemMsxDN2v8K0' && call.name === 'Grep' && call.malformed === false && JSON.stringify(call.arguments) === JSON.stringify({ pattern: 'context.*checkpoint.*size', path: '.', glob: 'notes-*.txt', output_mode: 'content' }), JSON.stringify(call))
  check('round 1 also streamed its reasoning and its lead-in text before the call', reasoningOf(first).startsWith('I need to search') && textOf(first).startsWith("I'll search"), `${JSON.stringify(reasoningOf(first).slice(0, 40))} · ${JSON.stringify(textOf(first).slice(0, 40))}`)
  check('round 1 usage: the whole prompt ingested (nothing cached)', usageOf(first)?.inputTokens === 18117 && usageOf(first)?.outputTokens === 109 && (usageOf(first)?.cachedInputTokens ?? 0) === 0, JSON.stringify(usageOf(first)))
  const second = await collect({
    model: MODEL,
    messages: [
      { role: 'user', content: 'Find which file states the context checkpoint size.' },
      { role: 'assistant', content: "I'll search for the context checkpoint size across all five notes files.\n\n", tool_calls: [{ id: call!.id, type: 'function', function: { name: 'Grep', arguments: call!.argumentsRaw } }] },
      { role: 'tool', tool_call_id: call!.id, content: 'notes-04.txt:3:The context checkpoint size is 149.626 MiB.' },
    ] as never,
    tools: [{ type: 'function', function: { name: 'Grep', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } } }],
    extra: { stream_options: { include_usage: true } },
  })
  check('round 2 (the assistant tool_calls + the tool result carried back) finishes on stop with the answer', finishOf(second)?.reason === 'stop' && textOf(second).includes('notes-04.txt') && textOf(second).includes('149.626 MiB'), JSON.stringify(textOf(second)))
  check('round 2 usage reads the prefix cache the server reported (cached_tokens)', usageOf(second)?.inputTokens === 18240 && usageOf(second)?.cachedInputTokens === 18113, JSON.stringify(usageOf(second)))
  check('no fault on either round', faultsOf(first).length === 0 && faultsOf(second).length === 0, `${faultsOf(first).join(',')} · ${faultsOf(second).join(',')}`)
}

llamacpp.server.close()
console.log(failures === 0 ? '\n✅ llama.cpp — discovery, the streamed reply and the tool loop settle as the live server answered' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
