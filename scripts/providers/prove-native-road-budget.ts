#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'native-road-budget-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS
delete process.env.MERCURY_API_TIMEOUT_MS
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

const transport = (await import('../../src/services/providers/local/ollamaChatTransport.js')) as Record<string, unknown> & typeof import('../../src/services/providers/local/ollamaChatTransport.js')
const { streamOllamaChat } = transport
const budget = await import('../../src/services/providers/streamIdleBudget.js')
const liveness = await import('../../src/services/providers/localLiveness.js')
const proxy = await import('../../src/utils/proxy.js')

const encoder = new TextEncoder()
const row = (data: unknown): string => `${JSON.stringify(data)}\n`
const MODEL = 'qwen3.5:9b-q4_K_M'
const REPLY_ROWS = (text: string, model = MODEL): string[] => [
  row({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '', thinking: 'Let me think.' }, done: false }),
  row({ model, created_at: '2026-01-01T00:00:01Z', message: { role: 'assistant', content: text }, done: false }),
  row({ model, created_at: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 300_000_000_000, load_duration: 1_000_000, prompt_eval_count: 62_908, prompt_eval_duration: 250_000_000_000, eval_count: 5, eval_duration: 200_000_000 }),
]

interface Fixture {
  fetchImpl: typeof fetch
  posts: () => number
  probes: () => number
  probeHits: () => string[]
  aborted: () => boolean
  bodies: () => Array<Record<string, unknown>>
}

function fixture(args: { firstByteAtMs: number; body: Array<{ atMs: number; chunks: string[] }>; close: boolean; alive: () => boolean; model?: string }): Fixture {
  let posts = 0
  let probes = 0
  let aborted = false
  let ended = false
  const probeHits: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (init?.method !== 'POST') {
      if (!args.alive()) {
        probes++
        probeHits.push(url)
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })
      }
      if (url.endsWith('/api/ps')) return new Response(JSON.stringify({ models: [{ name: args.model ?? MODEL, model: args.model ?? MODEL, size: 6_000_000_000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      probes++
      probeHits.push(url)
      return new Response(JSON.stringify({ version: '0.34.4' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    posts++
    try {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    } catch {
      bodies.push({})
    }
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
                  if (chunk.includes('"done":true')) ended = true
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
        resolveResponse(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }))
      }, args.firstByteAtMs)
    })
  }) as unknown as typeof fetch
  return { fetchImpl, posts: () => posts, probes: () => probes, probeHits: () => probeHits, aborted: () => aborted, bodies: () => bodies }
}

const RECORD_9B = { id: MODEL, server: 'ollama' as const, baseUrl: 'http://127.0.0.1:11434/v1', parameterSize: '9.4B', loaded: true, contextWindow: { tokens: 262_144, source: 'served' as const } }
const REQUEST = { model: MODEL, messages: [{ role: 'user' as const, content: 'Hey say ping' }] }
const PROMPT_TOKENS = 65_000
const IDLE_MS = budget.streamIdleTimeoutMsForRoute('local')
const KNOBS = { numCtx: 131_072, numBatch: 2048, think: true }

type Played = {
  events: Array<{ type: string; text?: string; fault?: { kind: string; code: string; message: string; retryable: boolean } }>
  waits: Array<Record<string, unknown> | null>
  fixture: Fixture
  text: string
}

async function play(args: { fx: Fixture; runMs: number; local?: boolean; idleMs?: number }): Promise<Played> {
  const waits: Played['waits'] = []
  const events: Played['events'] = []
  let text = ''
  const law = args.local === false ? undefined : liveness.localStreamLawFor({ wireModel: MODEL, cold: true, promptTokens: PROMPT_TOKENS, record: RECORD_9B, io: { fetchImpl: args.fx.fetchImpl, timeoutMs: 50 } })
  const gen = streamOllamaChat(
    {
      url: 'http://127.0.0.1:11434/api/chat',
      request: REQUEST,
      fetchImpl: args.fx.fetchImpl,
      idleTimeoutMs: args.idleMs ?? IDLE_MS,
      firstByte: { cold: true, promptTokens: PROMPT_TOKENS, model: MODEL, onWait: wait => waits.push(wait === null ? null : { ...(wait as Record<string, unknown>) }) },
      ...(law !== undefined ? { local: law } : {}),
    },
    KNOBS,
  )
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
console.log(' native road — the /api/chat road under the local budget law')
console.log('============================================================')
console.log(`  the local road's idle number: ${IDLE_MS} ms`)

section('N1 · a 9B record, a 65k-token cold prompt, the headers held for 11 minutes while the server answers its probe: no cut, one POST, the reply lands')
{
  const fx = fixture({ firstByteAtMs: 11 * 60_000, body: [{ atMs: 10, chunks: REPLY_ROWS('Ping!') }], close: true, alive: () => true })
  const run = await play({ fx, runMs: 11 * 60_000 + 5_000 })
  const spoken = lines(run)
  const first = run.waits[0] as Record<string, unknown> | null
  check('no fault: the request was never cut by any clock', faults(run).length === 0, JSON.stringify(faults(run)))
  check('exactly one POST, never torn down, never reissued', run.fixture.posts() === 1 && !run.fixture.aborted(), `posts=${run.fixture.posts()} aborted=${run.fixture.aborted()}`)
  check('the reply landed: the thinking, then the text, then the finish', run.text === 'Ping!' && run.events.some(e => e.type === 'reasoning-delta') && run.events.some(e => e.type === 'finish'), JSON.stringify({ text: run.text, types: run.events.map(e => e.type) }))
  check("the row's first line is a PROMISE sized from the 9B class pace (65k ÷ 300 tokens/s × 1.25 ≈ 4m 31s), not a fixed deadline", first !== null && first.promise === true && typeof first.budgetMs === 'number' && Math.abs((first.budgetMs as number) - 270_833) <= 1_000, JSON.stringify(first))
  check('the first line reads as a promise', spoken[0] === `ingesting a 65k-token prompt on ${MODEL} — first byte expected in about 4m 31s`, spoken[0])
  check('the promise ran out at 4m 31s, the server answered its liveness probe, and the row EXTENDED with the answer named', run.fixture.probes() >= 1 && spoken[1]?.startsWith(`still ingesting a 65k-token prompt on ${MODEL} — about 2m 15s more (its server answered at 4m 31s)`) === true, JSON.stringify({ probes: run.fixture.probes(), spoken }))
  check('the promise kept extending through the deadline while the server answered (three asks before the headers at 11 min)', run.fixture.probes() === 3, String(run.fixture.probes()))
  check('the probes went to the cheap liveness door, never a generation', run.fixture.probeHits().every(u => u.endsWith('/api/version')), run.fixture.probeHits().join(' '))
  check('the line cleared at the first byte', spoken.at(-1) === '<cleared>', JSON.stringify(spoken))
  check('the body the fixture saw is the native /api/chat body: stream:true · truncate:false · think:true · options.num_ctx', run.fixture.bodies()[0]?.stream === true && run.fixture.bodies()[0]?.truncate === false && run.fixture.bodies()[0]?.think === true && (run.fixture.bodies()[0]?.options as Record<string, unknown> | undefined)?.num_ctx === 131_072, JSON.stringify(run.fixture.bodies()[0]))
}

section('N2 · the same fixture whose liveness probe stops answering at 5 minutes: the cut names the dead server, is not retryable, and is one POST')
{
  let alive = true
  const fx = fixture({ firstByteAtMs: 11 * 60_000, body: [{ atMs: 10, chunks: REPLY_ROWS('Ping!') }], close: true, alive: () => alive })
  setTimeout(() => {
    alive = false
  }, 5 * 60_000)
  const run = await play({ fx, runMs: 8 * 60_000 })
  const fault = faults(run)[0]
  check('one typed fault naming the dead server, not retryable', faults(run).length === 1 && fault?.kind === 'timeout' && fault.code === 'local-server-dead' && fault.retryable === false, JSON.stringify(faults(run)))
  check('the words: no answer from the server while ingesting, the local server is not responding, /model re-probes', /^no answer from Ollama at 127\.0\.0\.1:11434 for \d+ s while ingesting — the local server is not responding \(its window, its load, or a crash\); \/model re-probes$/.test(fault?.message ?? ''), fault?.message)
  check('the server was asked twice in a row (the gap between) before the cut', run.fixture.probes() === 2, String(run.fixture.probes()))
  check('the request was torn down once and never reissued', run.fixture.aborted() && run.fixture.posts() === 1, `posts=${run.fixture.posts()} aborted=${run.fixture.aborted()}`)
}

section('N3 · a stream silent for 20 minutes after the first byte whose probe answers: no cut, the warning on the row, the reply lands when the bytes resume')
{
  const fx = fixture({
    firstByteAtMs: 1_000,
    body: [
      { atMs: 10, chunks: [row({ model: MODEL, message: { role: 'assistant', content: '', thinking: 'Planning the file.' }, done: false }), row({ model: MODEL, message: { role: 'assistant', content: "I'll build you a playable RPG game" }, done: false })] },
      { atMs: 20 * 60_000, chunks: [row({ model: MODEL, message: { role: 'assistant', content: ' — done.' }, done: false }), row({ model: MODEL, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 61_496, prompt_eval_duration: 100_000_000_000, eval_count: 1_421, eval_duration: 1_200_000_000_000 })] },
    ],
    close: true,
    alive: () => true,
  })
  const run = await play({ fx, runMs: 1_000 + 20 * 60_000 + 5_000 })
  const spoken = lines(run)
  check('no fault: the silence was not a death', faults(run).length === 0, JSON.stringify(faults(run)))
  check('the whole reply landed once the bytes resumed', run.text === "I'll build you a playable RPG game — done." && run.events.some(e => e.type === 'finish'), JSON.stringify({ text: run.text }))
  const warning = spoken.find(l => l.startsWith('no bytes for') && l.includes('is asked at'))
  const answered = spoken.filter(l => l.startsWith('no bytes for') && l.endsWith(`${MODEL}'s server still answers`))
  check("the row warned at the watchdog's warning point (7m 30s: the server is asked at 15m)", warning === `no bytes for 7m 30s — ${MODEL}'s server is asked at 15m`, warning)
  check('at the 15-minute quiet number the server answered and the row said so, then each minute after', answered.length >= 5 && answered[0] === `no bytes for 15m — ${MODEL}'s server still answers` && answered[1] === `no bytes for 16m — ${MODEL}'s server still answers`, JSON.stringify(answered.slice(0, 3)))
  check('the row cleared when the bytes resumed', spoken.at(-1) === '<cleared>', JSON.stringify(spoken.slice(-2)))
  check('the probes were cheap liveness reads', run.fixture.probes() >= 5 && run.fixture.probeHits().every(u => u.endsWith('/api/version')), run.fixture.probeHits().slice(0, 3).join(' '))
}

section('N3b · the same silence whose probe stops answering at 14 minutes: the dead-server cut after the partial content, never an idle-timeout reissue')
{
  let alive = true
  const fx = fixture({
    firstByteAtMs: 1_000,
    body: [{ atMs: 10, chunks: [row({ model: MODEL, message: { role: 'assistant', content: 'partial' }, done: false })] }],
    close: false,
    alive: () => alive,
  })
  setTimeout(() => {
    alive = false
  }, 14 * 60_000)
  const run = await play({ fx, runMs: 16 * 60_000 })
  const fault = faults(run)[0]
  check('one dead-server fault after the partial content, not retryable', faults(run).length === 1 && fault?.code === 'local-server-dead' && fault.retryable === false && run.text === 'partial', JSON.stringify(faults(run)))
  check('the words name the writing phase', /while writing — the local server is not responding/.test(fault?.message ?? ''), fault?.message)
  check('two probes in a row went unanswered', run.fixture.probes() === 2, String(run.fixture.probes()))
}

section('N4 · the hard cap: the headers held for three hours with the server answering — the two-hour cap cuts with its own words, not retryable')
{
  const fx = fixture({ firstByteAtMs: 3 * 60 * 60_000, body: [], close: true, alive: () => true })
  const run = await play({ fx, runMs: 2 * 60 * 60_000 + 60_000 })
  const fault = faults(run)[0]
  check('the two-hour cap cut the request as local-cap', faults(run).length === 1 && fault?.code === 'local-cap' && fault.retryable === false && /after 2h — the 2h cap on a local request is reached/.test(fault.message), JSON.stringify(faults(run)))
  check('one POST, torn down at the cap', run.fixture.posts() === 1 && run.fixture.aborted(), `posts=${run.fixture.posts()}`)
}

section('N5 · without the local law (the setup prover\'s road) the transport keeps its old timers to the byte')
{
  const fx = fixture({ firstByteAtMs: 400_000, body: [{ atMs: 10, chunks: REPLY_ROWS('late') }], close: true, alive: () => true })
  const run = await play({ fx, runMs: 200_000, local: false, idleMs: 120_000 })
  const fault = faults(run)[0]
  check('the generic first-byte budget (198 s for 65k on a 2-minute idle) fired as the typed first-byte fault, retryable', fault?.code === 'first-byte-timeout' && fault.retryable === true && fault.message === `no first byte from ${MODEL} after 3m 18s (a 65k-token prompt ingesting uncached)`, JSON.stringify(fault))
  check('the row carried a deadline, never a promise', run.waits[0] !== null && (run.waits[0] as Record<string, unknown>).promise === undefined && lines(run)[0] === `ingesting a 65k-token prompt on ${MODEL} — first byte expected within 3m 18s`, lines(run)[0])
  const quiet = fixture({ firstByteAtMs: 1_000, body: [{ atMs: 10, chunks: [row({ model: MODEL, message: { role: 'assistant', content: 'partial' }, done: false })] }], close: false, alive: () => true })
  const silent = await play({ fx: quiet, runMs: 200_000, local: false, idleMs: 120_000 })
  const cut = faults(silent)[0]
  check('the idle watchdog still cuts a 2-minute silence with the idle-timeout words, retryable', cut?.code === 'idle-timeout' && cut.retryable === true && cut.message === 'no bytes for 2m — the stream went quiet (no keep-alive arrived) and the watchdog cut it' && quiet.probes() === 0, JSON.stringify(cut))
}

section('N6 · the undici dispatcher the native road hands its fetch: headers/body timeouts at the two-hour cap, every other knob the API dispatcher\'s')
{
  const localApiAgentOptions = transport.localApiAgentOptions as (() => Record<string, unknown>) | undefined
  const withLocalDispatcher = transport.withLocalDispatcher as ((o: Record<string, unknown>, api: unknown, build: () => unknown) => Record<string, unknown>) | undefined
  const api = proxy.buildApiAgentOptions() as unknown as Record<string, unknown>
  check('the API dispatcher itself still budgets headers and body at 600 s (the number the transcripts died on)', api.headersTimeout === 600_000 && api.bodyTimeout === 600_000, JSON.stringify(api))
  const local = localApiAgentOptions?.()
  check('localApiAgentOptions is exported by the native road', local !== undefined)
  check('its headersTimeout and bodyTimeout are the two-hour cap (7 200 000 ms)', local?.headersTimeout === 7_200_000 && local?.bodyTimeout === 7_200_000, JSON.stringify(local))
  check('connect · connections · keep-alive · pipelining are the API dispatcher\'s own', local !== undefined && JSON.stringify(local.connect) === JSON.stringify(api.connect) && local.connections === api.connections && local.keepAliveTimeout === api.keepAliveTimeout && local.pipelining === api.pipelining, JSON.stringify({ local, api }))
  const apiDispatcher = { name: 'api' }
  const proxyDispatcher = { name: 'proxy' }
  let built = 0
  const localDispatcher = { name: 'local' }
  const swapped = withLocalDispatcher?.({ keepalive: false, dispatcher: apiDispatcher }, apiDispatcher, () => {
    built++
    return localDispatcher
  })
  const again = withLocalDispatcher?.({ dispatcher: apiDispatcher }, apiDispatcher, () => {
    built++
    return { name: 'second' }
  })
  const proxied = withLocalDispatcher?.({ dispatcher: proxyDispatcher }, apiDispatcher, () => {
    built++
    return localDispatcher
  })
  const bare = withLocalDispatcher?.({ keepalive: false }, apiDispatcher, () => {
    built++
    return localDispatcher
  })
  check('the bare API dispatcher is replaced by the local one; the other fetch options ride unchanged', swapped?.dispatcher === localDispatcher && swapped?.keepalive === false, JSON.stringify(swapped))
  check('the local dispatcher is built once per API dispatcher (the pool reset that mints a new API agent mints a new local one)', again?.dispatcher === localDispatcher && built === 1, `built=${built}`)
  check('a proxy dispatcher (an operator proxy in front of the server) is left alone', proxied?.dispatcher === proxyDispatcher, JSON.stringify(proxied))
  check('no dispatcher (the Bun runtime, whose fetch ignores dispatchers) adds none', bare !== undefined && !('dispatcher' in bare), JSON.stringify(bare))
}

globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout
Date.now = realDateNow

section('N7 · the product\'s runtime (node + the bundled undici): the API dispatcher at 1/600 scale cuts the headers wait; the native road lands the reply')
{
  const repo = process.cwd()
  const outDir = join(repo, 'node_modules', '.cache', 'mercury-native-road-node')
  mkdirSync(outDir, { recursive: true })
  const entry = join(outDir, 'entry.ts')
  writeFileSync(entry, `export * from '${join(repo, 'src/services/providers/local/ollamaChatTransport.ts')}'\nexport { REAL_STREAM_TIMERS } from '${join(repo, 'src/services/providers/streamIdleBudget.ts')}'\n`)
  const build = await Bun.build({
    entrypoints: [entry],
    target: 'node',
    format: 'esm',
    outdir: outDir,
    naming: 'native-road.node.mjs',
    external: ['undici', 'axios', 'https-proxy-agent'],
    plugins: [
      {
        name: 'jsonc-parser-esm-as-dist',
        setup(b) {
          b.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: join(repo, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js') }))
        },
      },
    ],
  })
  check('the transport bundles for node (undici external, one library instance)', build.success, build.logs.map(String).join('\n').slice(0, 600))
  const bundle = build.outputs[0]?.path
  if (build.success && bundle !== undefined) {
    const nodeBin = process.env.MERCURY_NODE_BIN ?? 'node'
    const env: Record<string, string> = { ...(process.env as Record<string, string>), MERCURY_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'native-road-node-home-')), MERCURY_API_TIMEOUT_MS: '1000', MERCURY_LOCAL_PROBE_TARGETS: 'none' }
    for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key]
    const result = spawnSync(nodeBin, [join(repo, 'scripts/providers/lib/native-road-node-lane.mjs'), bundle], { cwd: repo, encoding: 'utf8', env, timeout: 60_000 })
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
    for (const line of out.split('\n')) if (line.trim() !== '') console.log(`    node · ${line}`)
    check('the node lane ran to a verdict', result.status === 0 || result.status === 1, `status=${String(result.status)} signal=${String(result.signal)}`)
    check('the node lane is green: the headers held past the 1 s API budget land on the native road, and the reply follows (red on the base with UND_ERR_HEADERS_TIMEOUT)', result.status === 0)
  }
}

console.log(failures === 0 ? '\nprove-native-road-budget: all green' : `\nprove-native-road-budget: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
