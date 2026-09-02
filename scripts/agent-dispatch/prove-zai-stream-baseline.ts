#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { streamZaiChat, type ZaiStreamEvent } from '../../src/services/providers/zai/zaiClient.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const enc = new TextEncoder()
const sse = (json: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(json)}\n\n`)
const DONE = enc.encode('data: [DONE]\n\n')
const textChunk = (text: string): unknown => ({ choices: [{ delta: { content: text } }] })
const finishChunk = (): unknown => ({ choices: [{ delta: {}, finish_reason: 'stop' }] })

interface FixtureWire {
  signal: AbortSignal | null
  cancelled: boolean
}

function fixtureFetch(chunks: Uint8Array[], complete: boolean): { fetchImpl: typeof fetch; wire: FixtureWire } {
  const wire: FixtureWire = { signal: null, cancelled: false }
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    wire.signal = init?.signal ?? null
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        if (complete) controller.close()
      },
      cancel() {
        wire.cancelled = true
      },
    })
    return new Response(body, { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, wire }
}

const REQUEST = { model: 'glm-5.2', messages: [{ role: 'user' as const, content: 'temper-t2' }] }

console.log('============================================================')
console.log(' TEMPER T2 — zai stream transport returns to baseline')
console.log('============================================================')

section('1 · abandoned generator tears the transport down')
{
  const { fetchImpl, wire } = fixtureFetch([sse(textChunk('hello '))], false)
  const gen = streamZaiChat({ apiKey: 'fixture-key', request: REQUEST, fetchImpl })
  const first = await gen.next()
  check(
    'the first event streamed (the connection is live mid-turn)',
    first.done === false && (first.value as ZaiStreamEvent).type === 'text-delta',
    JSON.stringify(first.value ?? null),
  )
  check('the fixture observed the transport signal', wire.signal !== null)
  await gen.return(undefined)
  check(
    'closing the generator ABORTS the transport (RED pre-TEMPER: socket leaks)',
    wire.signal?.aborted === true,
    `aborted=${String(wire.signal?.aborted)}`,
  )
}

section('2 · a consumed stream is unaffected by the baseline teardown')
{
  const { fetchImpl } = fixtureFetch([sse(textChunk('a')), sse(textChunk('b')), sse(finishChunk()), DONE], true)
  const events: ZaiStreamEvent[] = []
  for await (const e of streamZaiChat({ apiKey: 'fixture-key', request: REQUEST, fetchImpl })) {
    events.push(e)
  }
  const kinds = events.map(e => e.type).join(',')
  check(
    'full sequence: two text deltas then exactly one finish, no faults',
    kinds === 'text-delta,text-delta,finish',
    kinds,
  )
  const finish = events.find(e => e.type === 'finish')
  check('finish reason is stop', finish?.type === 'finish' && finish.reason === 'stop')
}

section('3 · the explicit cancel contract is preserved')
{
  const { fetchImpl, wire } = fixtureFetch([sse(textChunk('partial'))], false)
  const outer = new AbortController()
  const gen = streamZaiChat({ apiKey: 'fixture-key', request: REQUEST, signal: outer.signal, fetchImpl })
  const first = await gen.next()
  check('streamed before cancel', first.done === false)
  outer.abort()
  const events: ZaiStreamEvent[] = []
  for (;;) {
    const n = await gen.next()
    if (n.done) break
    events.push(n.value)
  }
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    `outer abort surfaces the typed 'cancelled' fault`,
    fault?.type === 'stream-fault' && fault.fault.kind === 'cancelled',
    JSON.stringify(fault ?? null),
  )
  check('the transport signal is aborted after cancel', wire.signal?.aborted === true)
}

console.log('')
if (failures > 0) {
  console.log(`❌ TEMPER T2 zai stream baseline: ${failures} failing`)
  process.exit(1)
}
console.log('✅ TEMPER T2 zai stream baseline GREEN')
