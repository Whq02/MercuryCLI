#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'local-pace-sample-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const pace = await import('../../src/services/providers/localLiveness.ts')
const { requestWaitLine } = await import('../../src/services/providers/streamIdleBudget.ts')
type Wait = import('../../src/services/providers/streamIdleBudget.ts').RequestWaitV1
type ServerKind = import('../../src/services/providers/local/localDiscovery.ts').LocalServerKind

const realNow = Date.now.bind(Date)
const BASE = realNow()
let virtual = 0
Date.now = () => BASE + virtual
const settle = (ms = 5): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
type Due = { id: number; at: number; fn: () => void }
const queue = new Map<number, Due>()
let nextTimer = 1
const timers = {
  now: () => Date.now(),
  setTimeout: (fn: () => void, ms: number): unknown => {
    const id = nextTimer++
    queue.set(id, { id, at: virtual + Math.max(0, Number(ms) || 0), fn })
    return id
  },
  clearTimeout: (handle: unknown): void => {
    queue.delete(handle as number)
  },
}
async function advanceTo(target: number): Promise<void> {
  for (;;) {
    await settle()
    const due = [...queue.values()].filter(timer => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (due === undefined) break
    queue.delete(due.id)
    virtual = Math.max(virtual, due.at)
    due.fn()
  }
  virtual = Math.max(virtual, target)
  await settle()
}

const encoder = new TextEncoder()
const sse = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
const COMMENT_LINE = encoder.encode(':\n\n')
const chunkOf = (model: string, choices: unknown[], extra: Record<string, unknown> = {}): unknown => ({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model, choices, ...extra })
const probeFetch = (async (): Promise<Response> => Response.json({ status: 'ok', object: 'list', data: [] })) as unknown as typeof fetch

interface Asked {
  wire: string
  server: ServerKind
  cold: boolean
  estimate: number
}
interface Answered extends Asked {
  answersAt: number
  commentEvery: number | null
  firstTokenAt: number
  prompt: number
  cached: number
  written: number
}

const lawOf = (asked: Asked): NonNullable<ReturnType<typeof pace.localStreamLawFor>> =>
  pace.localStreamLawFor({ wireModel: asked.wire, cold: asked.cold, promptTokens: asked.estimate, record: { id: asked.wire, server: asked.server, baseUrl: 'http://127.0.0.1:1/v1', loaded: true } as never, io: { fetchImpl: probeFetch } })!
const rowOf = (asked: Asked): string => requestWaitLine({ kind: 'first-byte', cold: asked.cold, promptTokens: asked.estimate, model: `local/${asked.wire}`, budgetMs: lawOf(asked).promiseMs, sinceMs: 0, attempt: 1, promise: true })

async function play(request: Answered): Promise<{ row: string; ended: boolean }> {
  virtual = 0
  queue.clear()
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller
    },
  })
  let answer!: (response: Response) => void
  const answered = new Promise<Response>(resolve => {
    answer = resolve
  })
  const waits: Wait[] = []
  const events = streamCompatChat({
    url: 'http://127.0.0.1:1/v1/chat/completions',
    request: { model: request.wire, messages: [{ role: 'user', content: 'Reply with five words about rain.' }] },
    signal: new AbortController().signal,
    fetchImpl: (() => answered) as unknown as typeof fetch,
    timers,
    idleTimeoutMs: 900_000,
    silentAfterHeadersMs: null,
    firstByte: {
      cold: request.cold,
      promptTokens: request.estimate,
      model: `local/${request.wire}`,
      onWait: (wait: Wait | null) => {
        if (wait !== null) waits.push({ ...wait })
      },
    },
    local: lawOf(request),
  } as never)
  let ended = false
  const consumed = (async () => {
    for await (const event of events) void event
    ended = true
  })()
  const moments: Array<{ at: number; run: () => void }> = [{ at: request.answersAt, run: () => answer(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })) }]
  if (request.commentEvery !== null) {
    const first = request.server === 'tensorfold' ? request.answersAt : request.commentEvery
    for (let at = first; at < request.firstTokenAt; at += request.commentEvery) moments.push({ at, run: () => stream.enqueue(COMMENT_LINE) })
  }
  moments.push({
    at: request.firstTokenAt,
    run: () => {
      stream.enqueue(sse(chunkOf(request.wire, [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }])))
      stream.enqueue(sse(chunkOf(request.wire, [{ index: 0, delta: { content: 'Heavy drops wash streets clean.' }, finish_reason: null }])))
      stream.enqueue(sse(chunkOf(request.wire, [{ index: 0, delta: {}, finish_reason: 'stop' }])))
      stream.enqueue(sse(chunkOf(request.wire, [], { usage: { completion_tokens: request.written, prompt_tokens: request.prompt, total_tokens: request.prompt + request.written, prompt_tokens_details: { cached_tokens: request.cached } } })))
      stream.enqueue(encoder.encode('data: [DONE]\n\n'))
      stream.close()
    },
  })
  moments.sort((a, b) => a.at - b.at)
  for (const moment of moments) {
    await advanceTo(moment.at)
    moment.run()
  }
  await Promise.race([consumed, settle(3000)])
  return { row: waits[0] === undefined ? '' : requestWaitLine(waits[0]), ended }
}

const remembered = (wire: string): string => JSON.stringify(pace.rememberedLocalPace(wire))
const paceOf = (wire: string): number | null => pace.rememberedLocalPace(wire)?.paceTokensPerSec ?? null

const BOX = 'qwen3.5-4b'
const ENGINE = { wire: BOX, server: 'tensorfold' as const, answersAt: 30_547, commentEvery: 30_000 }

try {
  section('S0 controls: a sample whose response arrives with its first token (hold on the parent too)')
  {
    const held = await play({ wire: 'held-headers', server: 'vllm', cold: true, estimate: 60_000, answersAt: 114_000, commentEvery: null, firstTokenAt: 114_000, prompt: 60_013, cached: 8_192, written: 20 })
    check('a server that answers only with its first token: 60,013 prompt tokens less 8,192 held, over 114 s, is remembered as 454.6 tokens a second', held.ended && paceOf('held-headers') === 454.6, remembered('held-headers'))
    const quick = await play({ wire: 'engine-quick', server: 'tensorfold', cold: true, estimate: 9_000, answersAt: 20_000, commentEvery: 30_000, firstTokenAt: 20_000, prompt: 9_000, cached: 0, written: 20 })
    check('Mercury’s engine reading a prompt in 20 s, before any comment line: 9,000 tokens are remembered as 450 a second', quick.ended && paceOf('engine-quick') === 450, remembered('engine-quick'))
    const hit = await play({ wire: 'engine-hit', server: 'tensorfold', cold: true, estimate: 9_000, answersAt: 1_200, commentEvery: 30_000, firstTokenAt: 1_200, prompt: 9_000, cached: 0, written: 20 })
    check('a first token under five seconds records nothing', hit.ended && pace.rememberedLocalPace('engine-hit') === null, remembered('engine-hit'))
    check('the fixture’s first comment line is the box’s: 6,457 and 2,872 tokens over 30.547 s each blend to its stored 152.7', Math.round(((Math.round((6_457 / 30.547) * 10) / 10 + 2_872 / 30.547) / 2) * 10) / 10 === 152.7)
  }

  section('S1 the box’s first request: 6,457 tokens read in 307.6 s, a comment line from 30.5 s on')
  {
    const first = await play({ ...ENGINE, cold: true, estimate: 6_240, firstTokenAt: 307_564, prompt: 6_457, cached: 0, written: 121 })
    check('before any sample the row reads the box’s first row (holds on the parent too)', first.row === 'ingesting a 6k-token prompt on local/qwen3.5-4b — first byte expected in about 1m 18s', first.row)
    check('the pace remembered is the engine’s own, 21.0 tokens a second (its log: 20.99), not the tokens over the time to the first comment line', first.ended && paceOf(BOX) === 21 && pace.rememberedLocalPace(BOX)?.samples === 1 && pace.rememberedLocalPace(BOX)?.lastPromptTokens === 6_457, remembered(BOX))
  }

  section('S2 the box’s second request, a fold’s: 15,229 new tokens of 21,681 read in 1,012.4 s')
  {
    const fold = { ...ENGINE, cold: false, estimate: 19_000 }
    const row = rowOf(fold)
    check('its row promises from that pace: 12,543 tokens past the last prompt, about twelve and a half minutes (the box read 1m 14s and waited 16 m 53 s)', row === 'waiting for the first byte from local/qwen3.5-4b — expected in about 12m 27s', row)
    const before = paceOf(BOX)
    const played = await play({ ...fold, firstTokenAt: 1_012_413, prompt: 21_681, cached: 6_452, written: 92 })
    check('a request that is not cold leaves the pace alone and notes its prompt’s size (holds on the parent too)', played.ended && paceOf(BOX) === before && pace.rememberedLocalPace(BOX)?.samples === 1 && pace.rememberedLocalPace(BOX)?.lastPromptTokens === 21_681, remembered(BOX))
  }

  section('S3 the box’s third request, cold after the fold: 6,048 tokens of which the engine held 3,176, read in 150.4 s')
  {
    const third = { ...ENGINE, cold: true, estimate: 5_400 }
    const played = await play({ ...third, firstTokenAt: 150_401, prompt: 6_048, cached: 3_176, written: 88 })
    check('its row promises from the engine’s pace (the box read 1m and waited 2 m 30 s)', played.row === 'ingesting a 5k-token prompt on local/qwen3.5-4b — first byte expected in about 5m 21s', played.row)
    const stored = (JSON.parse(readFileSync(pace.localPaceStorePath(), 'utf8')) as { models: Record<string, { paceTokensPerSec: number; samples: number; lastPromptTokens: number }> }).models[BOX]
    check('the file then holds 20.0 tokens a second from two samples, where the box’s file held 152.7', played.ended && stored?.paceTokensPerSec === 20 && stored.samples === 2 && stored.lastPromptTokens === 6_048, JSON.stringify(stored))
    const alone = await play({ ...third, wire: 'qwen3.5-4b-alone', firstTokenAt: 150_401, prompt: 6_048, cached: 3_176, written: 88 })
    check('that request alone: the tokens the engine took in, 2,872, over the time it took them, 19.1 a second (its log: 19.10)', alone.ended && paceOf('qwen3.5-4b-alone') === 19.1, remembered('qwen3.5-4b-alone'))
  }

  section('S4 the rows the box read next')
  {
    const secondFold = rowOf({ wire: BOX, server: 'tensorfold', cold: false, estimate: 19_730 })
    check('the second fold’s request (the box read 1m 52s; its engine was still reading after 19 m 18 s)', secondFold === 'waiting for the first byte from local/qwen3.5-4b — expected in about 14m 15s', secondFold)
    const nextSession = rowOf({ wire: BOX, server: 'tensorfold', cold: true, estimate: 6_240 })
    check('a new session’s first prompt (the box read 1m and waited 5 m 42 s)', nextSession === 'ingesting a 6k-token prompt on local/qwen3.5-4b — first byte expected in about 6m 30s', nextSession)
  }

  section('S5 a llama.cpp server met directly: its headers at once, a comment line every 30 s, the first token after 120 s')
  {
    const plain = await play({ wire: 'plain-llamacpp', server: 'llamacpp', cold: true, estimate: 12_000, answersAt: 0, commentEvery: 30_000, firstTokenAt: 120_000, prompt: 12_000, cached: 0, written: 20 })
    check('its pace is remembered too: 12,000 tokens over 120 s, 100 a second', plain.ended && paceOf('plain-llamacpp') === 100 && pace.rememberedLocalPace('plain-llamacpp')?.samples === 1, remembered('plain-llamacpp'))
  }

  section('S6 a pace file written before the first token was the sample’s time')
  {
    const OLD = 'qwen3.5-4b-kept'
    const kept = { wire: OLD, server: 'tensorfold' as const, cold: true, estimate: 6_240 }
    writeFileSync(pace.localPaceStorePath(), `${JSON.stringify({ version: 1, models: { [OLD]: { paceTokensPerSec: 152.7, samples: 2, lastPromptTokens: 6_048, updatedAtMs: 1 }, 'another-model': { paceTokensPerSec: 300, samples: 9, updatedAtMs: 1 } } }, null, 2)}\n`)
    pace.__resetLocalPaceForTest()
    check('a file of the first version is not read: nothing is remembered from it', pace.rememberedLocalPace(OLD) === null && pace.rememberedLocalPace('another-model') === null, `${remembered(OLD)} ${remembered('another-model')}`)
    const row = rowOf(kept)
    check('the row then promises as on a new config folder, from the size class alone', row === 'ingesting a 6k-token prompt on local/qwen3.5-4b-kept — first byte expected in about 1m 18s', row)
    const played = await play({ ...kept, answersAt: 30_547, commentEvery: 30_000, firstTokenAt: 307_564, prompt: 6_457, cached: 0, written: 121 })
    const written = JSON.parse(readFileSync(pace.localPaceStorePath(), 'utf8')) as { version: number; models: Record<string, { paceTokensPerSec: number; samples: number }> }
    check('the first sample replaces the file: the second version, holding that sample alone', played.ended && written.version === 2 && JSON.stringify(Object.keys(written.models)) === JSON.stringify([OLD]) && written.models[OLD]?.paceTokensPerSec === 21 && written.models[OLD].samples === 1, JSON.stringify(written))
    pace.__resetLocalPaceForTest()
    check('and a file of the second version is read back', paceOf(OLD) === 21, remembered(OLD))
  }
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n${18 - failures} of 18 checks hold`)
console.log(failures === 0 ? 'prove-local-pace-sample: ALL HOLD' : `prove-local-pace-sample: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
