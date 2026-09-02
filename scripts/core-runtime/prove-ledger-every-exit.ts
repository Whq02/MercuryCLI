#!/usr/bin/env bun
// ============================================================================
//  scripts/core-runtime/prove-ledger-every-exit.ts — THE LEDGER-EVERY-EXIT
//  LAW (FN-018 ranks 1 + 5): a request that reached message_start joins
//  the session ledger exactly once, on every exit path.
//
//  The only pricing site on the Anthropic streaming path sat inside the
//  message_delta case, so any exit that never reached that frame settled a
//  fully billed request into the ledger at ZERO:
//   · rank 1 (S1) — the operator's Esc mid-stream: the abort exit yielded
//     the partial text and returned; the real message_start counts sat in
//     the local usage variable at that moment. A 120k cache-read prefill
//     recorded as $0.0000 — invisible to /cost, the persisted cost row,
//     total_cost_usd, and the --max-budget gate (which therefore overspent
//     by the sum of a run's aborts);
//   · rank 5 (S2) — a stream that died after message_start routed to the
//     non-streaming fallback, a SECOND separately billed request, and the
//     finally computed usage as updateUsage(EMPTY_USAGE, fallbackUsage):
//     the abandoned attempt's counts were discarded, two billed requests
//     recorded as one.
//  Every exit now settles the attempt once (the message_delta path marks
//  the clean case; the finally settles the rest BEFORE the fallback fold),
//  with the streamed words estimated as output when no delta carried the
//  count.
//
//   §1 the operator aborts mid-stream (the catch-and-return road)
//   §2 the consumer returns early (the .return() road query.ts drives)
//   §3 a stream that dies after message_start falls back: BOTH requests
//   §4 control: a clean stream settles exactly once (no double count)
//   §5 the shape
//
//  The wire is a fetchOverride fixture: an SSE body scripted frame by
//  frame, held open or closed cleanly, and a JSON answer for the fallback.
//  No network, no VCR, no build.
//
//  Run:  ~/.bun/bin/bun run scripts/core-runtime/prove-ledger-every-exit.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'ledger-exit-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.ANTHROPIC_API_KEY = 'fixture-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.NODE_ENV
delete process.env.MERCURY_DISABLE_NONSTREAMING_FALLBACK
delete process.env.MERCURY_EFFORT_LEVEL
// The idle watchdog shrinks to its floor band so a fixture the stream core
// cannot end is a bounded red, never a 90s wait (the knob's own prover law).
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '5000'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const ledger = await import('../../src/cost-tracker.ts')
const { roughTokenCountEstimation } = await import('../../src/services/tokenEstimation.ts')

const MODEL = 'claude-fable-5-1'
type Usage = { input_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; output_tokens: number }
const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const startFrame = (usage: Usage): string =>
  sse('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } })
const textOpen = sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
const textDelta = (text: string): string => sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
const textClose = sse('content_block_stop', { type: 'content_block_stop', index: 0 })
const deltaFrame = (usage: Usage): string => sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })
const stopFrame = sse('message_stop', { type: 'message_stop' })

type Script = {
  /** The SSE frames, enqueued at once. */
  frames: string[]
  /** hold: keep the body open (the prover ends the request); close: end it cleanly with no more frames. */
  after: 'hold' | 'close'
  /** The JSON answer for a non-streaming (fallback) request; absent = the fixture refuses one. */
  fallback?: Record<string, unknown>
}
type Wire = { streamRequests: number; fallbackRequests: number; fallbackServed: number }
const abortError = (): Error => new DOMException('The operation was aborted.', 'AbortError')

function fixtureFetch(script: Script, wire: Wire): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as { stream?: boolean }) : {}
    const signal = init?.signal ?? null
    // A real fetch on an already-aborted signal rejects with AbortError.
    if (signal?.aborted) throw abortError()
    if (body.stream === true) {
      wire.streamRequests++
      const encoder = new TextEncoder()
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of script.frames) controller.enqueue(encoder.encode(frame))
          if (script.after === 'close') {
            controller.close()
            return
          }
          // Held open: the request ends when the signal aborts — the body
          // read then rejects exactly as a real fetch's would.
          signal?.addEventListener(
            'abort',
            () => {
              try {
                controller.error(abortError())
              } catch {
                /* already closed */
              }
            },
            { once: true },
          )
        },
      })
      return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture_stream' } })
    }
    wire.fallbackRequests++
    if (script.fallback === undefined) throw new Error(`fixture: a non-streaming request reached the wire (${String(input)}) with no fallback scripted`)
    wire.fallbackServed++
    return new Response(JSON.stringify(script.fallback), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_fixture_fallback' } })
  }) as unknown as typeof fetch
}

type Yielded = { type?: string; event?: { type?: string }; message?: { content?: unknown } }
type Drive = { yielded: Yielded[]; thrown: string | null; usage: ReturnType<typeof ledger.getUsageForModel>; cost: number; wire: Wire; apiMs: number }

/** One request through the streaming core against the scripted wire.
 *  `stop`: how the consumer ends it — 'abort' the signal at the first text
 *  delta (the operator's Esc), 'return' from the loop at the first text
 *  delta (query.ts's .return() road), or drain to the end. */
async function drive(script: Script, stop: 'abort' | 'return' | 'drain'): Promise<Drive> {
  ledger.resetCostState()
  const wire: Wire = { streamRequests: 0, fallbackRequests: 0, fallbackServed: 0 }
  const controller = new AbortController()
  const yielded: Yielded[] = []
  let thrown: string | null = null
  // Bounded: a request the fixture cannot end is a red, never a hang.
  const deadline = setTimeout(() => controller.abort(), 30_000)
  const gen = queryModelWithStreaming({
    messages: [createUserMessage({ content: 'ledger fixture prompt' })],
    systemPrompt: asSystemPrompt(['You are the ledger fixture.']),
    thinkingConfig: { type: 'disabled' } as never,
    tools: [],
    signal: controller.signal,
    options: {
      model: MODEL,
      querySource: 'sdk',
      isNonInteractiveSession: true,
      fetchOverride: fixtureFetch(script, wire) as never,
      maxRetries: 0,
      getToolPermissionContext: async () =>
        ({ mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {} }) as never,
    } as never,
  })
  try {
    for await (const ev of gen) {
      const item = ev as Yielded
      yielded.push(item)
      if (item.type === 'stream_event' && item.event?.type === 'content_block_delta') {
        if (stop === 'abort') controller.abort()
        if (stop === 'return') break
      }
    }
  } catch (e) {
    thrown = String(e)
  }
  clearTimeout(deadline)
  return { yielded, thrown, usage: ledger.getUsageForModel(MODEL), cost: ledger.getTotalCost(), wire, apiMs: ledger.getTotalAPIDuration() }
}
const assistantText = (d: Drive): string =>
  d.yielded
    .filter(m => m.type === 'assistant')
    .map(m => JSON.stringify(m.message?.content ?? ''))
    .join(' ')

console.log('============================================================')
console.log(' the ledger on every exit — a billed request is never a $0 row')
console.log('============================================================')

// ── §1 the abort exit ────────────────────────────────────────────────────────
section('§1 the operator aborts mid-stream: the billed prefill and the streamed words join the ledger')
{
  const usage: Usage = { input_tokens: 900, cache_creation_input_tokens: 8000, cache_read_input_tokens: 120000, output_tokens: 1 }
  const words = 'The operator watched these words stream in before pressing escape. '.repeat(6)
  const d = await drive({ frames: [startFrame(usage), textOpen, textDelta(words)], after: 'hold' }, 'abort')
  check('the stream request reached the wire once', d.wire.streamRequests === 1, JSON.stringify(d.wire))
  check('the request ended without a thrown error at the consumer (the abort ends quietly)', d.thrown === null, d.thrown ?? '')
  check('THE LEDGER HOLDS THE ABORTED REQUEST (the base recorded nothing)', d.usage !== undefined, JSON.stringify(d.usage))
  check('…with the prefill the provider billed: 900 uncached + 120000 cache-read + 8000 cache-write', d.usage?.inputTokens === 900 && d.usage?.cacheReadInputTokens === 120000 && d.usage?.cacheCreationInputTokens === 8000, JSON.stringify(d.usage))
  check('…and the streamed words as output (the character estimate — no delta ever carried the count)', (d.usage?.outputTokens ?? 0) >= roughTokenCountEstimation(words), String(d.usage?.outputTokens))
  check('…priced: the session cost is not zero', d.cost > 0, String(d.cost))
  check('the partial text still reaches the transcript (the abort-partial law stands)', assistantText(d).includes('pressing escape'))
  check('no second request was served on the aborted signal', d.wire.fallbackServed === 0, JSON.stringify(d.wire))
  check("the API-duration ledger holds the aborted request's provider time (FN-018 rank 11; the base wrote 0)", d.apiMs > 0, String(d.apiMs))
}

// ── §2 the early-return exit ────────────────────────────────────────────────
section('§2 the consumer returns early (the .return() road): the finally settles the attempt')
{
  const usage: Usage = { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 60000, output_tokens: 1 }
  const words = 'Words that streamed before the consumer stopped listening. '.repeat(3)
  const d = await drive({ frames: [startFrame(usage), textOpen, textDelta(words)], after: 'hold' }, 'return')
  check('THE LEDGER HOLDS THE REQUEST the consumer walked away from (the base recorded nothing)', d.usage?.inputTokens === 400 && d.usage?.cacheReadInputTokens === 60000, JSON.stringify(d.usage))
  check('…with the streamed words as output', (d.usage?.outputTokens ?? 0) >= roughTokenCountEstimation(words), String(d.usage?.outputTokens))
  check('…priced', d.cost > 0)
  check('…and its API duration written (the .return() road reaches the finally)', d.apiMs > 0, String(d.apiMs))
}

// ── §3 the fallback ─────────────────────────────────────────────────────────
section('§3 a stream that dies after message_start falls back: BOTH billed requests join the ledger')
{
  const usage: Usage = { input_tokens: 700, cache_creation_input_tokens: 0, cache_read_input_tokens: 150000, output_tokens: 1 }
  const died = 'A few words arrived before the connection died. '
  const fallbackUsage: Usage = { input_tokens: 700, cache_creation_input_tokens: 0, cache_read_input_tokens: 150000, output_tokens: 9 }
  const fallback = { id: 'msg_fallback', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'the fallback answer' }], stop_reason: 'end_turn', stop_sequence: null, usage: fallbackUsage }
  const d = await drive({ frames: [startFrame(usage), textOpen, textDelta(died)], after: 'close', fallback }, 'drain')
  check('the recovery road ran: one non-streaming request was served', d.wire.fallbackServed === 1, JSON.stringify(d.wire))
  check('the fallback answer reached the consumer', assistantText(d).includes('the fallback answer'), assistantText(d).slice(0, 120))
  check('THE LEDGER HOLDS BOTH REQUESTS (the base kept the fallback alone): input 700 + 700', d.usage?.inputTokens === 1400, JSON.stringify(d.usage))
  check('…cache-read 150000 + 150000 (the abandoned attempt\'s prefill was not replaced)', d.usage?.cacheReadInputTokens === 300000, String(d.usage?.cacheReadInputTokens))
  check('…output = the fallback\'s 9 plus the abandoned attempt\'s streamed estimate', (d.usage?.outputTokens ?? 0) >= 9 + roughTokenCountEstimation(died), String(d.usage?.outputTokens))
  check('…priced for both', d.cost > 0)
  check("the API-duration ledger holds the recovery's provider time", d.apiMs > 0, String(d.apiMs))
}

// ── §4 the control ──────────────────────────────────────────────────────────
section('§4 control: a clean stream settles exactly once (the exit settlement never double-counts)')
{
  const usage: Usage = { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  const d = await drive({ frames: [startFrame(usage), textOpen, textDelta('a clean answer'), textClose, deltaFrame({ ...usage, output_tokens: 40 }), stopFrame], after: 'close' }, 'drain')
  check('no fallback ran', d.wire.fallbackRequests === 0, JSON.stringify(d.wire))
  check('input counted once', d.usage?.inputTokens === 500, JSON.stringify(d.usage))
  check('output is the wire\'s own count, once (never the estimate on top)', d.usage?.outputTokens === 40, String(d.usage?.outputTokens))
  check('exactly one assistant message', d.yielded.filter(m => m.type === 'assistant').length === 1)
  check('the API duration is written once by the success tail (never doubled by the exit write)', d.apiMs > 0 && d.apiMs < 5_000, String(d.apiMs))
}

// ── §5 the shape ────────────────────────────────────────────────────────────
section('§5 the shape')
{
  const src = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
  check('the message_delta pricing marks the attempt settled (priced at the served model — main\'s pricingModel law)', /addToTotalSessionCost\(costUSDForPart, usage, pricingModel\(\)\)\s*\n\s*ledgerSettled = true/.test(src))
  const fin = src.slice(src.indexOf('} finally {\n    stopSessionActivity'), src.indexOf('if (fallbackMessage) {', src.indexOf('} finally {\n    stopSessionActivity')))
  check('the finally settles the attempt BEFORE the fallback fold', fin.length > 0 && /settleUnpricedAttempt\(\)/.test(fin), fin.slice(-120))
  check('the settlement is exactly-once (guarded by the flag) and only for a request that reached message_start', /if \(ledgerSettled \|\| partialMessage === undefined\) return/.test(src))
  check('the retried attempt settles the abandoned one before it starts clean', /settleUnpricedAttempt\(\)\s*\n\s*newMessages\.length = 0/.test(src))
  check('the streamed words ride the one character-ratio estimator', /roughTokenCountEstimation\(streamedText\)/.test(src))
  check('every non-settled exit writes the API duration from the finally (rank 11)', /if \(!settledNormally\) logAPIDuration\(\{ start, startIncludingRetries \}\)/.test(src))
  const logging = readFileSync(join(ROOT, 'src/services/api/logging.ts'), 'utf8')
  check('the duration write is ONE owner the success path rides too', /export function logAPIDuration\(/.test(logging) && /logAPIDuration\(\{ start, startIncludingRetries \}\)\s*\n\s*consumePostCompactionMarker\(\)/.test(logging))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-ledger-every-exit${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
