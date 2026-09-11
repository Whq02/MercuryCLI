#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dir, '..', '..')
process.chdir(ROOT)

const idle = await import('../../src/services/providers/streamIdleBudget.js')
const { Stream } = (await import(pathToFileURL(join(ROOT, 'node_modules/@anthropic-ai/sdk/core/streaming.mjs')).href)) as {
  Stream: { fromSSEResponse(response: Response, controller: AbortController): AsyncIterable<{ type?: string }> }
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const BUDGET_MS = 600
const PING_EVERY_MS = 20
const PINGS = 60

type Run = { sentPings: number; yielded: number; terminal: boolean; fire: ReturnType<ReturnType<typeof idle.createStreamIdleWatchdog>['fired']>; noted: number }

async function play(args: { tap: boolean; heartbeats: boolean; abortAfterPings?: number }): Promise<Run> {
  const controller = new AbortController()
  const encoder = new TextEncoder()
  let interval: ReturnType<typeof setInterval> | undefined
  let sentPings = 0
  let noted = 0
  let yielded = 0
  let terminal = false
  const body = new ReadableStream<Uint8Array>({
    start(sink) {
      const send = (event: string, data: unknown): void => sink.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      controller.signal.addEventListener(
        'abort',
        () => {
          clearInterval(interval)
          try {
            sink.error(new DOMException('fixture abort', 'AbortError'))
          } catch {
          }
        },
        { once: true },
      )
      send('message_start', { type: 'message_start', message: { id: 'synthetic', role: 'assistant', content: [] } })
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      if (!args.heartbeats) return
      interval = setInterval(() => {
        if (controller.signal.aborted) return
        sentPings++
        send('ping', { type: 'ping' })
        if (args.abortAfterPings !== undefined && sentPings === args.abortAfterPings) {
          clearInterval(interval)
          controller.abort()
          return
        }
        if (sentPings === PINGS) {
          clearInterval(interval)
          send('content_block_stop', { type: 'content_block_stop', index: 0 })
          send('message_stop', { type: 'message_stop' })
          sink.close()
        }
      }, PING_EVERY_MS)
    },
    cancel() {
      clearInterval(interval)
    },
  })
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const watchdog = idle.createStreamIdleWatchdog({ timeoutMs: BUDGET_MS, onFire: () => controller.abort() })
  const read = args.tap
    ? idle.observeStreamActivity(response, () => {
        noted++
        watchdog.noteActivity()
      })
    : response
  try {
    for await (const part of Stream.fromSSEResponse(read, controller)) {
      watchdog.noteActivity()
      yielded++
      terminal ||= part.type === 'message_stop'
    }
  } finally {
    watchdog.stop()
    clearInterval(interval)
  }
  return { sentPings, yielded, terminal, fire: watchdog.fired(), noted }
}

section('L1 — the parser alone: heartbeats flow, the watchdog fires after two yielded events')
{
  const run = await play({ tap: false, heartbeats: true })
  check('the parser yielded exactly the two events and never the pings', run.yielded === 2 && run.sentPings >= 3, JSON.stringify(run))
  check('the watchdog fired with two activities though heartbeats were arriving', run.fire !== null && run.fire.activity === 2 && !run.terminal, JSON.stringify(run))
}

section('L2 — the tap: every chunk notes the watchdog before the parser')
{
  const run = await play({ tap: true, heartbeats: true })
  check('the stream lived to its terminal event with no fire', run.terminal && run.fire === null, JSON.stringify(run))
  check('the transport noted at least every heartbeat', run.noted >= run.sentPings && run.sentPings === PINGS, JSON.stringify(run))
  check('the parser still yielded only its events: assembly untouched', run.yielded === 4, JSON.stringify(run))
}

section('L3 — genuine silence still times out through the tap')
{
  const run = await play({ tap: true, heartbeats: false })
  check('two events then nothing: the budget fires at its number', run.fire !== null && run.fire.silentMs >= BUDGET_MS && run.yielded === 2 && !run.terminal, JSON.stringify(run))
}

section('L4 — the option helpers and the observed answer')
{
  const note = (): void => {}
  const options = idle.streamActivityFetchOptions(note)
  check('the note rides one fetch option and reads back off the init', idle.streamActivityNoteOf({ method: 'POST', ...options }) === note && idle.streamActivityNoteOf({ method: 'POST' }) === null && idle.streamActivityNoteOf(undefined) === null && idle.STREAM_ACTIVITY_OPTION in options)
  const bodyless = new Response(null, { status: 204 })
  check('a body-less answer passes through untouched', idle.observeStreamActivity(bodyless, note) === bodyless)
  const answered = new Response('{"ok":true}', { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'request-id': 'req_1' } })
  const observed = idle.observeStreamActivity(answered, note)
  check('the observed answer keeps its status and headers and yields the same bytes', observed !== answered && observed.status === 200 && observed.headers.get('request-id') === 'req_1' && (await observed.text()) === '{"ok":true}')
}

section('L5 — cancellation mid-heartbeats stays clean')
{
  let threw = ''
  let run: Run | null = null
  try {
    run = await play({ tap: true, heartbeats: true, abortAfterPings: 4 })
  } catch (e) {
    threw = String(e)
  }
  check('the abort ended the iteration without a fire and without a throw', threw === '' && run !== null && run.fire === null && !run.terminal, `${threw} ${JSON.stringify(run)}`)
}

section('L6 — the relay: a heartbeat with no event forwarded for the gap reaches the seat, once per gap')
{
  const pause = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const relayed: number[] = []
  const relay = idle.createStreamActivityRelay(atMs => relayed.push(atMs), 50)
  relay.noteChunk()
  check('a chunk right after the stream opened relays nothing (no gap yet)', relayed.length === 0, JSON.stringify(relayed))
  await pause(70)
  relay.noteChunk()
  check('a chunk after the gap with no event forwarded relays once, stamped with its own clock', relayed.length === 1 && typeof relayed[0] === 'number' && relayed[0] > 0, JSON.stringify(relayed))
  relay.noteChunk()
  check('a second chunk inside the gap relays nothing more', relayed.length === 1, JSON.stringify(relayed))
  await pause(70)
  relay.noteEvent()
  relay.noteChunk()
  check('a chunk right after a forwarded event relays nothing (the event frame carried the liveness)', relayed.length === 1, JSON.stringify(relayed))
  await pause(70)
  relay.noteChunk()
  check('…until the gap passes again in silence: one more', relayed.length === 2, JSON.stringify(relayed))
  check("the product's gap is one second — the seat's own liveness cadence", idle.STREAM_ACTIVITY_RELAY_GAP_MS === 1_000)
}

console.log(failures === 0 ? '\nprove-stream-liveness-tap: all green' : `\nprove-stream-liveness-tap: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
