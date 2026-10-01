#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-first-byte-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type Timer = { id: number; at: number; fn: () => void; unref(): void; ref(): void; hasRef(): boolean; refresh(): Timer; [Symbol.toPrimitive](): number }
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realDateNow = Date.now
const clock = { now: 0 }
let nextId = 1
const queue = new Map<number, Timer>()
const fakeSetTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const id = nextId++
  const timer: Timer = {
    id,
    at: clock.now + Math.max(0, Number(ms) || 0),
    fn: () => fn(...rest),
    unref: () => undefined,
    ref: () => undefined,
    hasRef: () => true,
    refresh: () => timer,
    [Symbol.toPrimitive]: () => id,
  }
  queue.set(id, timer)
  return timer
}) as unknown as typeof setTimeout
const fakeClearTimeout = ((handle: unknown) => {
  const id = typeof handle === 'number' ? handle : typeof handle === 'object' && handle !== null && 'id' in handle ? (handle as Timer).id : Number(handle)
  queue.delete(id)
}) as typeof clearTimeout
globalThis.setTimeout = fakeSetTimeout
globalThis.clearTimeout = fakeClearTimeout
Date.now = () => clock.now

const settle = (): Promise<void> => new Promise(resolve => realSetTimeout(resolve, 4))
async function advance(ms: number): Promise<void> {
  const target = clock.now + ms
  for (let guard = 0; guard < 100_000; guard++) {
    await settle()
    let due: Timer | null = null
    for (const timer of queue.values()) {
      if (timer.at <= target && (due === null || timer.at < due.at || (timer.at === due.at && timer.id < due.id))) due = timer
    }
    if (due === null) break
    queue.delete(due.id)
    clock.now = Math.max(clock.now, due.at)
    due.fn()
  }
  clock.now = target
  await settle()
}

const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.js')
const budget = await import('../../src/services/providers/streamIdleBudget.js')
let liveness: typeof import('../../src/services/providers/localLiveness.js') | null = null
try {
  liveness = await import('../../src/services/providers/localLiveness.js')
} catch {
  liveness = null
}

const encoder = new TextEncoder()
const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`
const REPLY_CHUNKS = (text: string): string[] => [
  sse({ model: 'qwen3.5:27b', choices: [{ delta: { role: 'assistant' } }] }),
  sse({ choices: [{ delta: { content: text } }] }),
  sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 62_908, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } } }),
  'data: [DONE]\n\n',
]

interface Fixture {
  fetchImpl: typeof fetch
  posts: () => number
  probes: () => number
  probeHits: () => string[]
  aborted: () => boolean
}

function fixture(args: { firstByteAtMs: number; body: Array<{ atMs: number; chunks: string[] }>; close: boolean; alive: () => boolean }): Fixture {
  let posts = 0
  let probes = 0
  let aborted = false
  let ended = false
  const probeHits: string[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method !== 'POST') {
      if (!args.alive()) {
        probes++
        probeHits.push(url)
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })
      }
      if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [{ name: 'qwen3.5:27b', model: 'qwen3.5:27b', size: 26_500_000_000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      probes++
      probeHits.push(url)
      return new Response(JSON.stringify({ version: '0.34.4' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    posts++
    return new Promise<Response>((resolveResponse, rejectResponse) => {
      let settled = false
      init.signal?.addEventListener(
        'abort',
        () => {
          if (!ended) aborted = true
          if (!settled) {
            settled = true
            rejectResponse(new DOMException('The operation was aborted.', 'AbortError'))
          }
        },
        { once: true },
      )
      setTimeout(() => {
        if (settled) return
        settled = true
        let sink: ReadableStreamDefaultController<Uint8Array> | null = null
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            sink = controller
            const push = (text: string): void => {
              try {
                controller.enqueue(encoder.encode(text))
              } catch {
                return
              }
            }
            let last = 0
            for (const step of args.body) {
              last = Math.max(last, step.atMs)
              setTimeout(() => {
                if (init.signal?.aborted) return
                for (const chunk of step.chunks) {
                  if (chunk.includes('[DONE]')) ended = true
                  push(chunk)
                }
              }, step.atMs)
            }
            if (args.close) {
              setTimeout(() => {
                ended = true
                try {
                  controller.close()
                } catch {
                  return
                }
              }, last + 1)
            }
          },
        })
        init.signal?.addEventListener(
          'abort',
          () => {
            if (!ended) aborted = true
            try {
              sink?.error(new DOMException('The operation was aborted.', 'AbortError'))
            } catch {
              return
            }
          },
          { once: true },
        )
        resolveResponse(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      }, args.firstByteAtMs)
    })
  }) as unknown as typeof fetch
  return { fetchImpl, posts: () => posts, probes: () => probes, probeHits: () => probeHits, aborted: () => aborted }
}

const RECORD_27B = { id: 'qwen3.5:27b', server: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', parameterSize: '27B', loaded: true, contextWindow: { tokens: 262_144, source: 'served' as const } }
const RECORD_9B = { id: 'qwen3.5:9b-q4_K_M', server: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', parameterSize: '9.4B', loaded: true, contextWindow: { tokens: 262_144, source: 'served' as const } }
const REQUEST = { model: 'qwen3.5:27b', messages: [{ role: 'user' as const, content: 'Hey say ping' }], stream: true }
const PROMPT_TOKENS = 65_000
const IDLE_MS = budget.streamIdleTimeoutMsForRoute('local')

type Played = {
  events: Array<{ type: string; fault?: { kind: string; code: string; message: string; retryable: boolean } }>
  waits: Array<Record<string, unknown> | null>
  fixture: Fixture
  text: string
}

function lawFor(record: typeof RECORD_27B, fx: Fixture, cold = true): unknown {
  if (liveness === null) return { wireModel: record.id, promiseMs: 1, cold, capMs: 1, serverWords: 'none', seam: { probe: async () => true, loaded: async () => true, sizeGb: async () => undefined }, noteTurn: () => undefined }
  return liveness.localStreamLawFor({ wireModel: record.id, cold, promptTokens: PROMPT_TOKENS, record, io: { fetchImpl: fx.fetchImpl, timeoutMs: 50 } })
}

async function play(args: { record: typeof RECORD_27B; fx: Fixture; runMs: number; cold?: boolean }): Promise<Played> {
  const waits: Played['waits'] = []
  const events: Played['events'] = []
  let text = ''
  const law = lawFor(args.record, args.fx, args.cold ?? true)
  const gen = streamCompatChat({
    url: `${args.record.baseUrl}/chat/completions`,
    request: REQUEST as never,
    fetchImpl: args.fx.fetchImpl,
    idleTimeoutMs: IDLE_MS,
    firstByte: { cold: args.cold ?? true, promptTokens: PROMPT_TOKENS, model: args.record.id, onWait: wait => waits.push(wait === null ? null : { ...(wait as Record<string, unknown>) }) },
    ...({ local: law } as Record<string, unknown>),
  } as never)
  const consumed = (async () => {
    for await (const event of gen) {
      events.push(event as Played['events'][number])
      if (event.type === 'text-delta') text += event.text
    }
  })()
  await advance(args.runMs)
  await Promise.race([consumed, new Promise<void>(r => realSetTimeout(r, 2_000))])
  return { events, waits, fixture: args.fx, text }
}
const faults = (p: Played) => p.events.filter(e => e.type === 'stream-fault').map(e => e.fault!)
const lines = (p: Played) => p.waits.map(w => (w === null ? '<cleared>' : budget.requestWaitLine(budget.decodeRequestWait(w) ?? (w as never))))

console.log('============================================================')
console.log(' local first byte — a local server that answers is never cut')
console.log('============================================================')
console.log(`  the local road's idle number: ${IDLE_MS} ms`)

section('L7 · a 27B record, a 65k-token cold prompt, the first byte at 400 s of simulated clock, the server answering its probe')
{
  const fx = fixture({ firstByteAtMs: 400_000, body: [{ atMs: 10, chunks: REPLY_CHUNKS('Ping!') }], close: true, alive: () => true })
  const run = await play({ record: RECORD_27B, fx, runMs: 400_000 + 5_000 })
  const spoken = lines(run)
  check('no fault: the request was never aborted by the clock', faults(run).length === 0, JSON.stringify(faults(run)))
  check('exactly one POST: nothing was reissued', run.fixture.posts() === 1 && !run.fixture.aborted(), `posts=${run.fixture.posts()} aborted=${run.fixture.aborted()}`)
  check('one reply landed', run.text === 'Ping!' && run.events.some(e => e.type === 'finish'), JSON.stringify({ text: run.text, types: run.events.map(e => e.type) }))
  const first = run.waits[0] as Record<string, unknown> | null
  check("the row's first line carried a promise sized from the 27B's default pace (65k ÷ 100 tokens/s × 1.25 ≈ 13m 33s), not a deadline", first !== null && first.promise === true && typeof first.budgetMs === 'number' && Math.abs((first.budgetMs as number) - 812_500) <= 1_000, JSON.stringify(first))
  check('the first line reads as a promise', spoken[0]?.startsWith('ingesting a 65k-token prompt on qwen3.5:27b — first byte expected in about 13m 3') === true, spoken[0])
  check('the promise was never up before the byte landed here (400 s < 13m 33s), so the row carried the promise and then the clear', spoken.length >= 2 && spoken.at(-1) === '<cleared>' && run.fixture.probes() === 0, JSON.stringify({ spoken, probes: run.fixture.probes() }))
}

section('L7b · the same record with the pace remembered as 200 tokens/s: the promise runs out at 406 s, the probe answers, the row extends')
{
  if (liveness !== null) {
    rmSync(liveness.localPaceStorePath(), { force: true })
    liveness.__resetLocalPaceForTest()
    liveness.recordLocalIngestPace({ wireModel: 'qwen3.5:27b', promptTokens: 62_908, cachedTokens: 0, ingestMs: 314_540, nowMs: 0 })
  }
  const fx = fixture({ firstByteAtMs: 500_000, body: [{ atMs: 10, chunks: REPLY_CHUNKS('Ping!') }], close: true, alive: () => true })
  const run = await play({ record: RECORD_27B, fx, runMs: 500_000 + 5_000 })
  const spoken = lines(run)
  check('no fault, one POST, one reply', faults(run).length === 0 && run.fixture.posts() === 1 && run.text === 'Ping!', JSON.stringify({ faults: faults(run), posts: run.fixture.posts(), text: run.text }))
  check('the promise read about 6m 46s (65k ÷ 200 × 1.25)', spoken[0] === 'ingesting a 65k-token prompt on qwen3.5:27b — first byte expected in about 6m 46s', spoken[0])
  check('the promise ran out, the server answered its liveness probe once, and the row extended with the answer named', run.fixture.probes() === 1 && spoken[1]?.startsWith('still ingesting a 65k-token prompt on qwen3.5:27b — about 3m 23s more (its server answered at 6m 46s)') === true, JSON.stringify({ probes: run.fixture.probes(), spoken }))
  check('the probe went to the cheap liveness door, never a generation', run.fixture.probeHits().every(u => u.endsWith('/api/version') || u.endsWith('/api/ps')), run.fixture.probeHits().join(' '))
  check('the line cleared at the first byte', spoken.at(-1) === '<cleared>', JSON.stringify(spoken))
  if (liveness !== null) {
    rmSync(liveness.localPaceStorePath(), { force: true })
    liveness.__resetLocalPaceForTest()
  }
}

section('L7c · the same fixture whose liveness probe stops answering: the cut names the dead server and is not retryable')
{
  let alive = true
  if (liveness !== null) {
    rmSync(liveness.localPaceStorePath(), { force: true })
    liveness.__resetLocalPaceForTest()
    liveness.recordLocalIngestPace({ wireModel: 'qwen3.5:27b', promptTokens: 62_908, cachedTokens: 0, ingestMs: 314_540, nowMs: 0 })
  }
  const fx = fixture({ firstByteAtMs: 900_000, body: [{ atMs: 10, chunks: REPLY_CHUNKS('Ping!') }], close: true, alive: () => alive })
  setTimeout(() => {
    alive = false
  }, 300_000)
  const run = await play({ record: RECORD_27B, fx, runMs: 500_000 })
  const fault = faults(run)[0]
  check('one typed fault naming the dead server, not retryable', faults(run).length === 1 && fault?.kind === 'timeout' && fault.code === 'local-server-dead' && fault.retryable === false, JSON.stringify(faults(run)))
  check('the words: no answer from the server, the local server is not responding, /model re-probes', /^no answer from Ollama at 127\.0\.0\.1:11434 for \d+ s while ingesting — the local server is not responding \(its window, its load, or a crash\); \/model re-probes$/.test(fault?.message ?? ''), fault?.message)
  check('the server was asked twice in a row before the cut', run.fixture.probes() === 2, String(run.fixture.probes()))
  check('the request was torn down once and never reissued', run.fixture.aborted() && run.fixture.posts() === 1, `posts=${run.fixture.posts()}`)
  if (liveness !== null) {
    rmSync(liveness.localPaceStorePath(), { force: true })
    liveness.__resetLocalPaceForTest()
  }
}

section('L6 · the 9B case: the first byte at 114 s lands unchanged')
{
  const fx = fixture({ firstByteAtMs: 114_000, body: [{ atMs: 10, chunks: REPLY_CHUNKS('pong') }], close: true, alive: () => true })
  const run = await play({ record: RECORD_9B, fx, runMs: 120_000 })
  check('no fault, one POST, the reply', faults(run).length === 0 && run.fixture.posts() === 1 && run.text === 'pong', JSON.stringify({ faults: faults(run), text: run.text }))
  check('the 9B promise reads from the small-class default (65k ÷ 300 × 1.25 ≈ 4m 31s)', lines(run)[0] === 'ingesting a 65k-token prompt on qwen3.5:9b-q4_K_M — first byte expected in about 4m 31s', lines(run)[0])
}

section('L8 · a stream silent for 20 minutes after the first byte whose probe answers: no cut, the warning on the row, the reply lands when the bytes resume')
{
  const fx = fixture({
    firstByteAtMs: 1_000,
    body: [
      { atMs: 10, chunks: [sse({ model: 'qwen3.5:27b', choices: [{ delta: { role: 'assistant' } }] }), sse({ choices: [{ delta: { content: "I'll build you a playable RPG game" } }] })] },
      { atMs: 20 * 60_000, chunks: [sse({ choices: [{ delta: { content: ' — done.' } }] }), sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 61_496, completion_tokens: 1_421 } }), 'data: [DONE]\n\n'] },
    ],
    close: true,
    alive: () => true,
  })
  const run = await play({ record: RECORD_27B, fx, runMs: 1_000 + 20 * 60_000 + 5_000 })
  const spoken = lines(run)
  check('no fault: the silence was not a death', faults(run).length === 0, JSON.stringify(faults(run)))
  check('the whole reply landed once the bytes resumed', run.text === "I'll build you a playable RPG game — done." && run.events.some(e => e.type === 'finish'), JSON.stringify({ text: run.text }))
  const warning = spoken.find(l => l.startsWith('no bytes for') && l.includes('is asked at'))
  const answered = spoken.filter(l => l.startsWith('no bytes for') && l.endsWith("qwen3.5:27b's server still answers"))
  check("the row warned before the idle number (the server is asked at 15m) — the watchdog's warning point, 7.5 minutes in", warning === 'no bytes for 7m 30s — qwen3.5:27b\'s server is asked at 15m', warning)
  check('at the idle number the server answered and the row said so, then kept saying so each minute', answered.length >= 5 && answered[0] === 'no bytes for 15m — qwen3.5:27b\'s server still answers' && answered[1] === 'no bytes for 16m — qwen3.5:27b\'s server still answers', JSON.stringify(answered.slice(0, 3)))
  check('the row cleared when the bytes resumed', spoken.at(-1) === '<cleared>', JSON.stringify(spoken.slice(-2)))
  check('the probes were cheap liveness reads', run.fixture.probes() >= 5 && run.fixture.probeHits().every(u => u.endsWith('/api/version')), run.fixture.probeHits().slice(0, 3).join(' '))
}

section('L8b · the same silence whose probe stops answering: the cut names the dead server, the partial reply is kept as a fault after content')
{
  let alive = true
  const fx = fixture({
    firstByteAtMs: 1_000,
    body: [{ atMs: 10, chunks: [sse({ choices: [{ delta: { content: 'partial' } }] })] }],
    close: false,
    alive: () => alive,
  })
  setTimeout(() => {
    alive = false
  }, 14 * 60_000)
  const run = await play({ record: RECORD_27B, fx, runMs: 16 * 60_000 })
  const fault = faults(run)[0]
  check('one dead-server fault after the partial content, not retryable', faults(run).length === 1 && fault?.code === 'local-server-dead' && fault.retryable === false && run.text === 'partial', JSON.stringify(faults(run)))
  check('the words name the writing phase', /while writing — the local server is not responding/.test(fault?.message ?? ''), fault?.message)
  check('two probes in a row went unanswered', run.fixture.probes() === 2, String(run.fixture.probes()))
}

section('cap · the hard cap on the local road is two hours, and only there')
{
  const fx = fixture({ firstByteAtMs: 3 * 60 * 60_000, body: [], close: true, alive: () => true })
  const run = await play({ record: RECORD_27B, fx, runMs: 2 * 60 * 60_000 + 60_000 })
  const fault = faults(run)[0]
  check('the two-hour cap cut the request with its own words, not retryable', faults(run).length === 1 && fault?.code === 'local-cap' && fault.retryable === false && /after 2h — the 2h cap on a local request is reached/.test(fault.message), JSON.stringify(faults(run)))
  check('the constants', liveness !== null && liveness.LOCAL_FIRST_BYTE_CAP_MS === 7_200_000 && liveness.LOCAL_REQUEST_CAP_MS === 7_200_000, String(liveness?.LOCAL_FIRST_BYTE_CAP_MS))
}

section('the other roads take their normal patience numbers')
{
  check('openai and moonshot: the quiet number (15 min); zai, anthropic, openai-compat: the fed number (6 min); no route: the shared 2 min', budget.streamIdleTimeoutMsForRoute('openai') === 900_000 && budget.streamIdleTimeoutMsForRoute('zai') === 360_000 && budget.streamIdleTimeoutMsForRoute('anthropic') === 360_000 && budget.streamIdleTimeoutMsForRoute('openai-compat') === 360_000 && budget.streamIdleTimeoutMsForRoute('moonshot') === 900_000 && budget.streamIdleTimeoutMsForRoute(null) === 120_000)
  check('the local road takes the quiet number, never the fed number', IDLE_MS === 900_000, String(IDLE_MS))
  check('the first-byte budget arithmetic on the other roads is untouched: 1,200 ms per 1k, a 300 s floor, twice the idle budget', budget.COLD_INGEST_MS_PER_1K_TOKENS === 1_200 && budget.FIRST_BYTE_BUDGET_CEILING_MS === 300_000 && budget.FIRST_BYTE_BUDGET_CEILING_FACTOR === 2 && budget.firstByteBudgetMs({ cold: true, promptTokens: 65_000, idleMs: 120_000 }) === 198_000 && budget.firstByteBudgetMs({ cold: true, promptTokens: 65_000, idleMs: 900_000 }) === 978_000)
  check('the shared default and the warning floor stand', budget.STREAM_IDLE_DEFAULT_MS === 120_000 && budget.STREAM_IDLE_WARNING_FLOOR_MS === 300_000)
  const zaiSrc = await Bun.file(join(process.cwd(), 'src/services/providers/zai/zaiClient.ts')).text()
  const openaiSrc = await Bun.file(join(process.cwd(), 'src/services/providers/openai/openaiClient.ts')).text()
  check('the zai and openai clients still fire their first-byte timers and their idle watchdogs as before', /firstByteTimeoutLine\(wait\), retryable: true/.test(zaiSrc) && /firstByteTimeoutLine\(wait\), retryable: true/.test(openaiSrc) && /createStreamIdleWatchdog\(/.test(zaiSrc) && /createStreamIdleWatchdog\(/.test(openaiSrc))
  const compatSrc = await Bun.file(join(process.cwd(), 'src/services/providers/openaicompat/compatChatClient.ts')).text()
  check('the compat client keeps the 50-minute ceiling for the other roads', /const TOTAL_TIMEOUT_MS = 50 \* 60_000/.test(compatSrc))
}

section('a generic compat road under the same clock still cuts at its first-byte budget (the law is the local road\'s alone)')
{
  const fx = fixture({ firstByteAtMs: 400_000, body: [{ atMs: 10, chunks: REPLY_CHUNKS('late') }], close: true, alive: () => true })
  const events: Played['events'] = []
  const gen = streamCompatChat({
    url: 'http://127.0.0.1:9/v1/chat/completions',
    request: REQUEST as never,
    fetchImpl: fx.fetchImpl,
    idleTimeoutMs: 120_000,
    firstByte: { cold: true, promptTokens: PROMPT_TOKENS, model: 'kimi' },
  })
  const consumed = (async () => {
    for await (const event of gen) events.push(event as Played['events'][number])
  })()
  await advance(200_000)
  await Promise.race([consumed, new Promise<void>(r => realSetTimeout(r, 2_000))])
  const fault = events.find(e => e.type === 'stream-fault')?.fault
  check('the generic road fired its 198 s budget as the typed first-byte fault, retryable', fault?.code === 'first-byte-timeout' && fault.retryable === true && fault.message === 'no first byte from kimi after 3m 18s (a 65k-token prompt ingesting uncached)', JSON.stringify(fault))
}

section('the runtime: the road feeds the transport the local law, and a dead-server cut is never reissued')
{
  const discovery = await import('../../src/services/providers/local/localDiscovery.js')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const { createUserMessage } = await import('../../src/utils/messages.ts')
  const discoveryFetch = (async (input: unknown) => {
    const url = String(input)
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/api/tags')) return json({ models: [{ name: 'qwen3.5:27b', model: 'qwen3.5:27b', size: 17_200_000_000, details: { family: 'qwen35', parameter_size: '27B', quantization_level: 'Q4_K_M' } }] })
    if (url.endsWith('/api/version')) return json({ version: '0.34.4' })
    if (url.endsWith('/api/ps')) return json({ models: [{ name: 'qwen3.5:27b', model: 'qwen3.5:27b', context_length: 262_144 }] })
    if (url.endsWith('/api/show')) return json({ capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': 262_144 } })
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  discovery.__resetLocalDiscoveryForTest()
  await discovery.refreshLocalDiscovery({ force: true, env: { MERCURY_LOCAL_PROBE_TARGETS: 'ollama=http://127.0.0.1:11434' } as NodeJS.ProcessEnv, fetchImpl: discoveryFetch, timeoutMs: 500 })
  const record = discovery.localModelRecord('qwen3.5:27b')
  check('the fixture discovery seeded a 27B record, loaded, on the Ollama base', record?.parameterSize === '27B' && record.loaded === true && record.baseUrl === 'http://127.0.0.1:11434/v1', JSON.stringify(record))
  const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.js')
  const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.js')
  async function driveWithTransport(fault: { kind: string; code: string; message: string; retryable: boolean }): Promise<{ transports: number; seen: Array<Record<string, unknown>>; errors: string[] }> {
    let transports = 0
    const seen: Array<Record<string, unknown>> = []
    const errors: string[] = []
    const profile = {
      ...localLaneProfileFor(record!),
      streamTransport(streamOptions: Record<string, unknown>) {
        transports++
        seen.push(streamOptions)
        return {
          events: (async function* () {
            yield { type: 'stream-fault', fault }
          })(),
        }
      },
    }
    const gen = compatChatCallModel(profile as never, {
      messages: [createUserMessage({ content: 'Hey say ping' })] as never,
      systemPrompt: ['fixture system prompt'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'local/qwen3.5:27b',
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
      } as never,
    })
    const consumed = (async () => {
      for await (const item of gen) {
        const m = item as { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ text?: string }> } }
        if (m.type === 'assistant' && m.isApiErrorMessage) errors.push(String(m.message?.content?.[0]?.text ?? ''))
      }
    })()
    await advance(30_000)
    await Promise.race([consumed, new Promise<void>(r => realSetTimeout(r, 3_000))])
    return { transports, seen, errors }
  }
  const dead = await driveWithTransport({ kind: 'timeout', code: 'local-server-dead', message: 'no answer from Ollama at 127.0.0.1:11434 for 10 s while ingesting — the local server is not responding (its window, its load, or a crash); /model re-probes', retryable: false })
  const options = dead.seen[0] ?? {}
  const law = options.local as { promiseMs?: number; paceTokensPerSec?: number; serverWords?: string; capMs?: number; loadedAtSend?: boolean } | undefined
  check('the road hands the transport the local law: the 27B class pace (100 tokens/s), a tiny prompt at the one-minute floor, the server words, the two-hour cap, the loaded state', law !== undefined && law.paceTokensPerSec === 100 && law.promiseMs === 60_000 && law.serverWords === 'Ollama at 127.0.0.1:11434' && law.capMs === 7_200_000 && law.loadedAtSend === true, JSON.stringify(law))
  check("the road feeds the transport the local road's idle number (the quiet 15 minutes)", options.idleTimeoutMs === 900_000, String(options.idleTimeoutMs))
  check('a dead-server cut before any content is NOT reissued: one transport attempt', dead.transports === 1, String(dead.transports))
  check('the turn ends on the typed error row carrying the dead-server words', dead.errors.length === 1 && dead.errors[0]!.includes('local-server-dead') && dead.errors[0]!.includes('the local server is not responding (its window, its load, or a crash); /model re-probes'), JSON.stringify(dead.errors))
  const retryable = await driveWithTransport({ kind: 'transport-error', code: 'fetch-failed', message: 'connect ECONNRESET', retryable: true })
  check('a retryable transport fault on the same lane still takes its one reissue (the bounded recovery is untouched)', retryable.transports === 2, String(retryable.transports))
  discovery.__resetLocalDiscoveryForTest()
}

globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout
Date.now = realDateNow
console.log(failures === 0 ? '\nprove-local-first-byte: all green' : `\nprove-local-first-byte: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
