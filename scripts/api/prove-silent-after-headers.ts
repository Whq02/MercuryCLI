#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'silent-after-headers-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the silent-after-headers proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const IDLE_MS = 4_000
const FENCE_MS = 500
const MODEL_WORDS = 'Fixture Model'
const DEAD_WORDS = /answered and then sent nothing for \d+ s — not one byte after the headers on a prompt of ~\d+ tokens: a dead connection/

const fixture = await import('./patience-road-fixture.js')
const idle = await import('../../src/services/providers/streamIdleBudget.js')
const owner = idle as unknown as Record<string, unknown>
const fenceCode = typeof owner.SILENT_AFTER_HEADERS_CODE === 'string' ? (owner.SILENT_AFTER_HEADERS_CODE as string) : 'silent-after-headers'
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.js')
const { openrouterResponsesTransport } = await import('../../src/services/providers/openrouter/openrouterResponsesTransport.js')
const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.js')
const { streamZaiChat } = await import('../../src/services/providers/zai/zaiClient.js')
const { streamGeminiContent } = await import('../../src/services/providers/gemini/geminiClient.js')
const { createUserMessage } = await import('../../src/utils/messages.ts')

type Fault = { kind: string; code: string; message: string; retryable?: boolean }
type Played = { events: Array<{ type: string; fault?: Fault }>; elapsedMs: number; road: ReturnType<typeof fixture.roadFixture> }
const faultsOf = (p: Played): Fault[] => p.events.filter(e => e.type === 'stream-fault').map(e => e.fault as Fault)
const transportOptions = { idleTimeoutMs: IDLE_MS, silentAfterHeadersMs: FENCE_MS, firstByte: { cold: false, promptTokens: 12, model: MODEL_WORDS } }

async function play(events: AsyncGenerator<unknown>, road: ReturnType<typeof fixture.roadFixture>): Promise<Played> {
  const started = Date.now()
  const out: Played['events'] = []
  for await (const event of events) out.push(event as Played['events'][number])
  return { events: out, elapsedMs: Date.now() - started, road }
}

function fenced(label: string, run: Played): void {
  const faults = faultsOf(run)
  const fault = faults[0]
  check(
    `${label}: one typed fault carrying the dead-connection code and the words (the model, the wait, not one byte after the headers)`,
    faults.length === 1 && fault?.kind === 'timeout' && fault.code === fenceCode && fault.retryable === true && fault.message.startsWith(MODEL_WORDS) && DEAD_WORDS.test(fault.message),
    JSON.stringify(faults),
  )
  check(`${label}: the cut came inside the window, long before the idle budget`, run.elapsedMs >= FENCE_MS && run.elapsedMs < FENCE_MS * 4, `${run.elapsedMs} ms (window ${FENCE_MS}, idle ${IDLE_MS})`)
}

const compatRequest = { model: 'fixture-model', messages: [{ role: 'user' as const, content: 'go' }] }
const compatHead = [fixture.sse({ choices: [{ delta: { role: 'assistant' } }] })]
const compatTail = [fixture.sse({ choices: [{ delta: { content: 'the reply' } }] }), fixture.sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n']

section('L1 · the compat chat transport: headers, then not one byte — cut inside the window with its reason')
{
  const road = fixture.roadFixture({ head: [], tail: [], silence: true })
  const run = await play(streamCompatChat({ url: 'http://127.0.0.1:9/v1/chat/completions', request: compatRequest as never, fetchImpl: road.fetchImpl, ...transportOptions } as never), road)
  fenced('compat chat', run)
  await new Promise(r => setTimeout(r, 20))
  check('compat chat: the read was cancelled — no socket outlives the cut', road.cancelled())
}

section('L2 · the OpenRouter Responses transport: the same silence, the same cut')
{
  const road = fixture.roadFixture({ head: [], tail: [], silence: true })
  const transport = openrouterResponsesTransport(
    {
      url: 'http://127.0.0.1:9/openrouter/api/v1/chat/completions',
      request: { model: 'openai/gpt-5-mini', messages: [{ role: 'user', content: 'go' }] } as never,
      fetchImpl: road.fetchImpl,
      deferral: { form: 'openrouter-native', deferredNames: new Set<string>(), imagesSupported: false },
      ...transportOptions,
    } as never,
    [createUserMessage({ content: 'go' }) as never],
  )
  check('the native transport took the request', transport !== undefined)
  if (transport !== undefined) {
    const run = await play(transport.events, road)
    fenced('openrouter responses', run)
  }
}

section('L3 · the OpenAI Responses transport')
{
  const road = fixture.roadFixture({ head: [], tail: [], silence: true })
  const run = await play(
    streamOpenaiResponses({
      baseUrl: 'http://127.0.0.1:9/openai/v1',
      headers: { authorization: 'Bearer fixture' },
      request: { model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }], stream: true } as never,
      fetchImpl: road.fetchImpl,
      ...transportOptions,
    } as never),
    road,
  )
  fenced('openai responses', run)
}

section('L4 · the Z.AI transport')
{
  const road = fixture.roadFixture({ head: [], tail: [], silence: true })
  const run = await play(streamZaiChat({ apiKey: 'fixture-key', request: { model: 'glm-5.2', messages: [{ role: 'user' as const, content: 'go' }] }, fetchImpl: road.fetchImpl, ...transportOptions } as never), road)
  fenced('zai', run)
}

section('L5 · the native Gemini transport')
{
  const road = fixture.roadFixture({ head: [], tail: [], silence: true })
  const run = await play(streamGeminiContent({ url: 'http://127.0.0.1:9/models/fixture:streamGenerateContent?alt=sse', apiKey: 'fixture', request: compatRequest, messages: [createUserMessage({ content: 'go' })], onTurn: () => {}, fetchImpl: road.fetchImpl, ...transportOptions } as never), road)
  fenced('gemini', run)
}

section('G1 · one keep-alive comment, then silence: the fence never fires — the idle budget cuts with its own words')
{
  const road = fixture.roadFixture({ head: [': keep-alive\n\n'], tail: [], silence: true })
  const run = await play(streamCompatChat({ url: 'http://127.0.0.1:9/v1/chat/completions', request: compatRequest as never, fetchImpl: road.fetchImpl, ...transportOptions } as never), road)
  const faults = faultsOf(run)
  check('one idle fault with the idle words, never the dead-connection code', faults.length === 1 && faults[0]?.code === 'idle-timeout' && faults[0].message === fixture.idleFaultWords(IDLE_MS), JSON.stringify(faults))
  check('the cut came at the idle budget, not at the window', run.elapsedMs >= IDLE_MS && run.elapsedMs < IDLE_MS * 4, `${run.elapsedMs} ms`)
}

section('G2 · one keep-alive comment, then a think longer than the window, then the reply: nothing is cut')
{
  const encoder = new TextEncoder()
  let cancelled = false
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(sink) {
        sink.enqueue(encoder.encode(': keep-alive\n\n'))
        const later = setTimeout(() => {
          if (init?.signal?.aborted) return
          for (const chunk of compatTail) sink.enqueue(encoder.encode(chunk))
          sink.close()
        }, FENCE_MS * 3)
        init?.signal?.addEventListener('abort', () => clearTimeout(later), { once: true })
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  const road = { fetchImpl, sent: () => 0, cancelled: () => cancelled }
  const run = await play(streamCompatChat({ url: 'http://127.0.0.1:9/v1/chat/completions', request: compatRequest as never, fetchImpl, ...transportOptions } as never), road)
  check('no fault at all: the keep-alive was life and the thinking silence stayed unguarded', faultsOf(run).length === 0 && run.events.some(e => e.type === 'text-delta') && run.events.some(e => e.type === 'finish'), JSON.stringify(run.events.map(e => e.type)))
  check('the reply landed after three windows of silence', run.elapsedMs >= FENCE_MS * 3 && !cancelled, `${run.elapsedMs} ms`)
}

section('G3 · a role chunk, then keep-alives for longer than the window, then the reply: nothing is cut')
{
  const road = fixture.roadFixture({ head: compatHead, tail: compatTail, silence: false })
  const run = await play(streamCompatChat({ url: 'http://127.0.0.1:9/v1/chat/completions', request: compatRequest as never, fetchImpl: road.fetchImpl, ...transportOptions } as never), road)
  check('every keep-alive was sent and the stream reached its finish with no fault', road.sent() === fixture.KEEP_ALIVES && faultsOf(run).length === 0 && run.events.some(e => e.type === 'finish'), JSON.stringify(run.events.map(e => e.type)))
  check('the stream outlived the window by the keep-alives\' whole span', run.elapsedMs >= fixture.KEEP_ALIVE_EVERY_MS * fixture.KEEP_ALIVES && run.elapsedMs > FENCE_MS * 2, `${run.elapsedMs} ms`)
}

section('G4 · the owner: which roads carry the fence, the number, the pin, the cold-prefix allowance')
{
  const forRoute = owner.silentAfterHeadersMsForRoute as ((route: string | null) => number | null) | undefined
  const windowOf = owner.silentAfterHeadersWindowMs as ((args: { route: string | null; cold: boolean; promptTokens: number; idleMs: number }) => number | null) | undefined
  check('the owner has the fence (silentAfterHeadersMsForRoute, silentAfterHeadersWindowMs, the fault words)', typeof forRoute === 'function' && typeof windowOf === 'function' && typeof owner.silentAfterHeadersFaultWords === 'function')
  if (forRoute !== undefined && windowOf !== undefined) {
    const fencedRoads = ['anthropic', 'openai', 'zai', 'moonshot', 'deepseek', 'openrouter', 'gemini', 'huggingface', 'openai-compat']
    const bareRoads = ['local', null]
    check('every hosted route, including custom endpoints, carries the 30 s base window', fencedRoads.every(r => forRoute(r) === 30_000), fencedRoads.map(r => `${r}=${forRoute(r)}`).join(' '))
    check('the local and absent routes carry no new fence', bareRoads.every(r => forRoute(r) === null), bareRoads.map(r => `${r}=${forRoute(r)}`).join(' '))
    check('a warm prefix lives under the flat 30 s', windowOf({ route: 'moonshot', cold: false, promptTokens: 200_000, idleMs: 120_000 }) === 30_000)
    check('a cold prefix adds the first-byte budget\'s ingest allowance (1.2 s per 1k tokens): 20k tokens → 54 s', windowOf({ route: 'moonshot', cold: true, promptTokens: 20_000, idleMs: 120_000 }) === 54_000, String(windowOf({ route: 'moonshot', cold: true, promptTokens: 20_000, idleMs: 120_000 })))
    check('a cold prefix whose allowance reaches the idle budget has no fence: the idle budget fires first with its own words', windowOf({ route: 'moonshot', cold: true, promptTokens: 100_000, idleMs: 120_000 }) === null)
    check('the openai road\'s quiet 15 m idle budget leaves the warm fence at 30 s', windowOf({ route: 'openai', cold: false, promptTokens: 50_000, idleMs: 900_000 }) === 30_000)
    check('a bare road answers null whatever the prefix', windowOf({ route: 'local', cold: false, promptTokens: 10, idleMs: 120_000 }) === null && windowOf({ route: null, cold: true, promptTokens: 10, idleMs: 120_000 }) === null)
    process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '700'
    check('the env pin is absolute on the fenced roads (no allowance) and never enables a bare road', forRoute('anthropic') === 700 && windowOf({ route: 'zai', cold: true, promptTokens: 200_000, idleMs: 120_000 }) === 700 && forRoute('local') === null)
    process.env.MERCURY_SILENT_AFTER_HEADERS_MS = '5'
    check('a pin below the 100 ms floor falls through to the number', forRoute('anthropic') === 30_000)
    delete process.env.MERCURY_SILENT_AFTER_HEADERS_MS
    const reason = idle.retryReasonWords(undefined, (owner.silentAfterHeadersFaultWords as (m: string, ms: number) => string)('Kimi', 30_000))
    check('the retry row names the cause: "a dead connection"', reason === 'a dead connection', reason)
  }
}

type StreamPlan = 'silent' | 'full'
const plans: Record<string, StreamPlan[]> = { anthropic: [], moonshot: [] }
const seen: Record<string, string[]> = { anthropic: [], moonshot: [] }
const holds = new Set<ServerResponse>()
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicFull = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recovered' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
const moonshotFull = (): string =>
  [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', model: 'kimi-k3', choices: [{ index: 0, delta: { role: 'assistant', content: 'recovered' } }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 } }),
    'data: [DONE]\n\n',
  ].join('')
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path === '/moonshot/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'moonshot', context_length: 262144 }] }))
      return
    }
    const road = path.endsWith('/v1/messages') ? 'anthropic' : path.endsWith('/chat/completions') ? 'moonshot' : null
    if (req.method !== 'POST' || road === null) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      body = {}
    }
    if (road === 'anthropic' && body.stream !== true) {
      seen.anthropic!.push('non-streaming')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_ns', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'recovered without streaming' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 6, output_tokens: 2 } }))
      return
    }
    const plan = plans[road]!
    const step = plan.shift() ?? 'full'
    seen[road]!.push(step)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (step === 'full') {
      res.end(road === 'anthropic' ? anthropicFull() : moonshotFull())
      return
    }
    res.flushHeaders()
    holds.add(res)
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MOONSHOT_API_KEY: 'fixture-moonshot-key',
  MERCURY_STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS),
  MERCURY_SILENT_AFTER_HEADERS_MS: String(FENCE_MS),
  MERCURY_MAX_RETRIES: '1',
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
await (await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')).refreshMoonshotCatalogue({ force: true })
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type SystemAPIErrorMessage = import('../../src/types/message.ts').SystemAPIErrorMessage

async function drive(model: string): Promise<{ last: AssistantMessage | undefined; notices: SystemAPIErrorMessage[]; errors: string[]; threw: unknown; wallMs: number }> {
  const assistants: AssistantMessage[] = []
  const notices: SystemAPIErrorMessage[] = []
  const errors: string[] = []
  let threw: unknown
  const t0 = performance.now()
  try {
    for await (const item of routedCallModel({
      messages: [createUserMessage({ content: 'go' })] as never,
      systemPrompt: ['fixture'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model,
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'high',
      } as never,
    })) {
      const typed = item as { type?: string; subtype?: string }
      if (typed.type === 'assistant') {
        const a = item as AssistantMessage
        if (a.isApiErrorMessage) errors.push(JSON.stringify(a.message.content))
        else assistants.push(a)
      }
      if (typed.type === 'system' && typed.subtype === 'api_error') notices.push(item as SystemAPIErrorMessage)
    }
  } catch (error) {
    threw = error
  }
  return { last: assistants.at(-1), notices, errors, threw, wallMs: performance.now() - t0 }
}
const noticeWords = (notices: SystemAPIErrorMessage[]): string => notices.map(n => n.error?.message ?? '').join(' | ')

section('L6 · the Moonshot road end to end: headers then nothing → one retry row naming a dead connection, the reissue answers, all inside the idle budget')
{
  plans.moonshot = ['silent', 'full']
  seen.moonshot = []
  const o = await drive('kimi-k3')
  check('the turn settled end_turn on the reissued request', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)} errors=${o.errors.join('|').slice(0, 300)}`)
  check('two requests: the silent one, then the answer', seen.moonshot!.join(',') === 'silent,full', seen.moonshot!.join(','))
  check('exactly one retry notice, carrying the dead-connection words with the model and the wait', o.notices.length === 1 && DEAD_WORDS.test(noticeWords(o.notices)), noticeWords(o.notices).slice(0, 300))
  const wait = o.notices[0] !== undefined ? idle.retryNoticeWait(o.notices[0]) : null
  check('the status row reads "retrying — attempt 1 of 1 after a dead connection"', wait !== null && idle.requestWaitLine(wait).startsWith('retrying — attempt 1 of 1 after a dead connection'), wait !== null ? idle.requestWaitLine(wait) : 'no notice')
  check('the whole turn took less than the idle budget (the base waits the budget out before its retry)', o.wallMs < IDLE_MS, `${o.wallMs.toFixed(0)} ms`)
}

section('L7 · the Anthropic road end to end: headers then nothing → the streaming reissue inside the idle budget, the notice naming a dead connection')
{
  plans.anthropic = ['silent', 'full']
  seen.anthropic = []
  const o = await drive('claude-sonnet-5')
  check('the turn settled end_turn after the reissue', o.threw === undefined && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)}`)
  check('exactly two streaming requests, no non-streaming request', seen.anthropic!.join(',') === 'silent,full', seen.anthropic!.join(','))
  check('the reissue notice carries the dead-connection words and the action', DEAD_WORDS.test(noticeWords(o.notices)) && noticeWords(o.notices).includes('reissuing the stream'), noticeWords(o.notices).slice(0, 300))
  check('the reissue came inside the idle budget (the base waits the budget out first)', o.wallMs < IDLE_MS, `${o.wallMs.toFixed(0)} ms`)
}

section('L8 · the Anthropic road, a keep-alive ping then thinking past the window: never cut')
{
  const holdMs = FENCE_MS * 3
  const previous = server.listeners('request')
  let pinged = 0
  const pingedThenFull = (res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`event: ping\n${sse({ type: 'ping' })}`)
    pinged++
    setTimeout(() => res.end(anthropicFull()), holdMs)
  }
  server.removeAllListeners('request')
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    req.on('data', () => undefined)
    req.on('end', () => pingedThenFull(res))
  })
  const o = await drive('claude-sonnet-5')
  server.removeAllListeners('request')
  for (const listener of previous) server.on('request', listener as (...args: unknown[]) => void)
  check('one ping, then three windows of silence, then the reply: the turn settled with no notice and no reissue', pinged === 1 && o.threw === undefined && o.notices.length === 0 && o.last?.message.stop_reason === 'end_turn', `pinged=${pinged} notices=${noticeWords(o.notices).slice(0, 200)} threw=${String(o.threw)}`)
  check('the reply arrived after the hold, uncut', o.wallMs >= holdMs, `${o.wallMs.toFixed(0)} ms`)
}

for (const r of holds) r.end()
server.close()
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
