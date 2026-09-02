#!/usr/bin/env bun
// ============================================================================
//  scripts/agent-dispatch/prove-s4-zai-stream.ts
//  PROOF, entirely
//  against injected fetch fixtures — no network, no key, no billables:
//
//    1. SSE decoder: byte-at-a-time framing, CRLF, multi-`data:` join,
//       comments skipped, UTF-8 split across chunks, dangling event at EOF.
//    2. Happy turn: reasoning + text deltas, usage in the FINAL chunk,
//       `[DONE]`; assembleZaiTurn folds it exactly.
//    3. The SAME wire bytes under pathological chunking assemble identically.
//    4. PARALLEL INCREMENTAL tool calls: index-keyed fragments accumulate
//       exactly once; parsed inputs round-trip against the REAL
//       zodToJsonSchema product (schema-validated, not vibes).
//    5. Malformed tool call: unparseable arguments surface as
//       malformedToolCalls — never a silent half-call.
//    6. The documented finish_reason failure channel: network_error /
//       sensitive arrive as typed mid-stream faults (retryable honesty).
//    7. HTTP + api error mapping over the documented code table.
//    8. Idle timeout · 9. cancellation · 10. truncated stream (no finish).
//   11. Request mapping: system/history/tool_use/tool_result → the exact
//       native shapes; the key never rides the body.
//
//  Run:  ~/.bun/bin/bun run scripts/agent-dispatch/prove-s4-zai-stream.ts
// ============================================================================
// getUserAgent() reads the build-time MACRO define; bun-run proofs shim it
// (the scripts/verify/fast.ts precedent).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { z } from 'zod'
import {
  assembleZaiTurn,
  buildZaiChatRequest,
  mapToolsToZai,
} from '../../src/services/providers/zai/zaiCodec.js'
import { SseDecoder } from '../../src/services/providers/sseDecoder.js'
import {
  mapZaiHttpFailure,
  streamZaiChat,
  type ZaiStreamEvent,
} from '../../src/services/providers/zai/zaiClient.js'
import { zodToJsonSchema } from '../../src/utils/zodToJsonSchema.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── Fixture plumbing ────────────────────────────────────────────────────────

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
function responseFromChunks(chunks: string[], opts?: { neverClose?: boolean; status?: number }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      if (!opts?.neverClose) controller.close()
    },
  })
  return new Response(stream, {
    status: opts?.status ?? 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}
function fetchOf(response: Response | (() => Response)): typeof fetch {
  return (async () => (typeof response === 'function' ? response() : response)) as unknown as typeof fetch
}
async function collect(events: AsyncIterable<ZaiStreamEvent>): Promise<ZaiStreamEvent[]> {
  const out: ZaiStreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

const HAPPY_WIRE = [
  sseChunk({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'let me th' } }] }),
  sseChunk({ choices: [{ index: 0, delta: { reasoning_content: 'ink…' } }] }),
  sseChunk({ choices: [{ index: 0, delta: { content: 'The answer' } }] }),
  sseChunk({ choices: [{ index: 0, delta: { content: ' is 4.' } }] }),
  sseChunk({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 } },
  }),
  'data: [DONE]\n\n',
]

console.log('============================================================')
console.log(' S4 — Z.AI native streaming proof (fixture-driven)')
console.log('============================================================')

//
section('1 · SSE decoder — framing laws')
//
{
  const dec = new SseDecoder()
  const wire = ': comment\r\ndata: {"a":1}\r\n\r\nevent: ping\ndata: line1\ndata: line2\n\n'
  const out: unknown[] = []
  for (const ch of wire) out.push(...dec.push(ch))
  const events = out.filter(r => (r as { kind: string }).kind === 'event') as Array<{
    event: { data: string; event?: string }
  }>
  check('byte-at-a-time + CRLF: two events', events.length === 2, String(events.length))
  check('comment skipped, first payload intact', events[0]?.event.data === '{"a":1}')
  check(
    'multi-data join with \\n + event type carried',
    events[1]?.event.data === 'line1\nline2' && events[1]?.event.event === 'ping',
  )

  const dec2 = new SseDecoder()
  const buf = Buffer.from('data: héllo⚡\n\n', 'utf8')
  const r2 = [...dec2.push(buf.subarray(0, 8)), ...dec2.push(buf.subarray(8))]
  check(
    'UTF-8 split across chunks decodes intact',
    r2.length === 1 && (r2[0] as { event: { data: string } }).event.data === 'héllo⚡',
  )

  const dec3 = new SseDecoder()
  dec3.push('data: half-an-eve')
  const r3 = dec3.flush()
  check(
    'dangling event at EOF surfaces as a fault',
    r3.length === 1 && (r3[0] as { reason: string }).reason === 'dangling-event',
  )
}

//
section('2 · happy turn — deltas, final-chunk usage, [DONE], assembly')
//
{
  const events = await collect(
    streamZaiChat({
      apiKey: 'test-key-never-logged',
      request: { model: 'glm-5.2', messages: [{ role: 'user', content: '2+2?' }] },
      fetchImpl: fetchOf(responseFromChunks(HAPPY_WIRE)),
    }),
  )
  const turn = await assembleZaiTurn(
    (async function* () {
      yield* events
    })(),
  )
  check('no faults', !events.some(e => e.type === 'stream-fault'))
  check('thinking assembled', turn.thinking === 'let me think…', turn.thinking)
  check('text assembled', turn.text === 'The answer is 4.', turn.text)
  check(
    'usage from the FINAL chunk (100/20, cached 60)',
    turn.usage?.inputTokens === 100 && turn.usage.outputTokens === 20 && turn.usage.cachedInputTokens === 60,
  )
  check("stop reason 'end_turn'", turn.stopReason === 'end_turn')
  check('no tool calls', turn.toolUses.length === 0 && turn.malformedToolCalls.length === 0)
}

//
section('3 · identical assembly under pathological chunking')
//
{
  const wire = HAPPY_WIRE.join('')
  const ragged: string[] = []
  let i = 0
  while (i < wire.length) {
    const step = ((i * 5) % 13) + 1
    ragged.push(wire.slice(i, i + step))
    i += step
  }
  const events = await collect(
    streamZaiChat({
      apiKey: 'k',
      request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
      fetchImpl: fetchOf(responseFromChunks(ragged)),
    }),
  )
  const turn = await assembleZaiTurn(
    (async function* () {
      yield* events
    })(),
  )
  check(
    'ragged chunking: identical thinking/text/usage',
    turn.thinking === 'let me think…' && turn.text === 'The answer is 4.' && turn.usage?.inputTokens === 100,
  )
}

//
section('4 · parallel incremental tool calls — exactly once, schema-validated')
//
{
  const searchSchema = z.object({ query: z.string(), limit: z.number().int().min(1) })
  const readSchema = z.object({ path: z.string() })
  const wire = [
    sseChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"que' } },
            ],
          },
        },
      ],
    }),
    // interleaved: call 1 opens before call 0 finishes its arguments
    sseChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, id: 'call_b', type: 'function', function: { name: 'read', arguments: '{"pa' } },
            ],
          },
        },
      ],
    }),
    sseChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: 'ry":"glm","limit":3}' } },
              { index: 1, function: { arguments: 'th":"/tmp/a.txt"}' } },
            ],
          },
        },
      ],
    }),
    sseChunk({
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    'data: [DONE]\n\n',
  ]
  const events = await collect(
    streamZaiChat({
      apiKey: 'k',
      request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
      fetchImpl: fetchOf(responseFromChunks(wire)),
    }),
  )
  const fragments = events.filter(e => e.type === 'tool-call-fragment')
  const finish = events.find(e => e.type === 'finish')
  check('fragments streamed incrementally (4)', fragments.length === 4, String(fragments.length))
  check(
    'EXACTLY-ONCE completion: finish carries both calls, complete',
    finish?.type === 'finish' &&
      finish.toolCalls.length === 2 &&
      finish.toolCalls.every(c => !c.malformed),
  )
  const turn = await assembleZaiTurn(
    (async function* () {
      yield* events
    })(),
  )
  check("stop reason 'tool_use'", turn.stopReason === 'tool_use')
  check(
    'interleaved arguments accumulated per index',
    JSON.stringify(turn.toolUses.map(t => t.input)) ===
      JSON.stringify([{ query: 'glm', limit: 3 }, { path: '/tmp/a.txt' }]),
    JSON.stringify(turn.toolUses),
  )
  // Validated vs the REAL schema machinery: the wire parameters came from
  // zodToJsonSchema, and the accumulated inputs satisfy the source zod.
  const wireTools = mapToolsToZai([
    { name: 'search', input_schema: zodToJsonSchema(searchSchema) },
    { name: 'read', input_schema: zodToJsonSchema(readSchema) },
  ])
  check(
    'tool params on the wire are the zodToJsonSchema product',
    (wireTools[0]!.function.parameters as { type?: string }).type === 'object',
  )
  check(
    'accumulated inputs VALIDATE against the source zod schemas',
    searchSchema.safeParse(turn.toolUses[0]!.input).success &&
      readSchema.safeParse(turn.toolUses[1]!.input).success,
  )
  check(
    'wrong-shape input REFUSES against the schema (the validator is real)',
    !searchSchema.safeParse(turn.toolUses[1]!.input).success,
  )
}

//
section('5 · malformed tool call — surfaced, never silent')
//
{
  const wire = [
    sseChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: 'call_x', type: 'function', function: { name: 'search', arguments: '{"broken' } },
            ],
          },
        },
      ],
    }),
    sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]
  const turn = await assembleZaiTurn(
    streamZaiChat({
      apiKey: 'k',
      request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
      fetchImpl: fetchOf(responseFromChunks(wire)),
    }),
  )
  check('no executable toolUses', turn.toolUses.length === 0)
  check(
    'the malformed call is SURFACED with its raw arguments',
    turn.malformedToolCalls.length === 1 && turn.malformedToolCalls[0]!.argumentsRaw === '{"broken',
  )
}

//
section('6 · the finish_reason failure channel (documented SSE rule)')
//
{
  for (const [reason, retryable] of [
    ['network_error', true],
    ['sensitive', false],
    ['model_context_window_exceeded', false],
  ] as const) {
    const wire = [
      sseChunk({ choices: [{ index: 0, delta: { content: 'partial' } }] }),
      sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }),
      'data: [DONE]\n\n',
    ]
    const events = await collect(
      streamZaiChat({
        apiKey: 'k',
        request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
        fetchImpl: fetchOf(responseFromChunks(wire)),
      }),
    )
    const fault = events.find(e => e.type === 'stream-fault')
    check(
      `finish:${reason} → typed mid-stream fault (retryable=${retryable})`,
      fault?.type === 'stream-fault' &&
        fault.fault.kind === 'mid-stream-failure' &&
        fault.fault.code === `finish:${reason}` &&
        fault.fault.retryable === retryable,
    )
  }
}

//
section('7 · HTTP + api error mapping (documented code table)')
//
{
  const auth = mapZaiHttpFailure(401, { error: { code: 1000, message: 'Authentication Failed' } })
  check('1000/401 → zai-1000, not retryable', auth.code === 'zai-1000' && !auth.retryable)
  const rate = mapZaiHttpFailure(429, { error: { code: 1302, message: 'Rate limit reached for requests' } })
  check('1302/429 → retryable', rate.code === 'zai-1302' && rate.retryable)
  const balance = mapZaiHttpFailure(429, { error: { code: 1113, message: 'Insufficient balance' } })
  check('1113/429 → retryable (balance can be topped up)', balance.code === 'zai-1113' && balance.retryable)
  const unknownModel = mapZaiHttpFailure(400, { error: { code: 1211, message: 'Unknown Model' } })
  check('1211/400 → zai-1211, not retryable', unknownModel.code === 'zai-1211' && !unknownModel.retryable)
  const bare = mapZaiHttpFailure(503, 'not json')
  check('unmapped 5xx → http-503, retryable', bare.code === 'http-503' && bare.retryable)

  const events = await collect(
    streamZaiChat({
      apiKey: 'secret-key-abc',
      request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
      fetchImpl: fetchOf(
        () =>
          new Response(JSON.stringify({ error: { code: 1211, message: 'Unknown Model' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    }),
  )
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    'HTTP-level failure yields ONE typed fault and ends the stream',
    events.length === 1 && fault?.type === 'stream-fault' && fault.fault.code === 'zai-1211',
  )
  check(
    'the key never appears in fault text',
    fault?.type === 'stream-fault' && !JSON.stringify(fault).includes('secret-key-abc'),
  )
}

//
section('8 · idle timeout — a silent stream faults, bounded')
//
{
  const events = await collect(
    streamZaiChat({
      apiKey: 'k',
      request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
      fetchImpl: fetchOf(
        responseFromChunks([sseChunk({ choices: [{ index: 0, delta: { content: 'then silence' } }] })], {
          neverClose: true,
        }),
      ),
      idleTimeoutMs: 120,
    }),
  )
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    'idle timeout fault fired (retryable)',
    fault?.type === 'stream-fault' && fault.fault.code === 'idle-timeout' && fault.fault.retryable,
  )
  check('the pre-silence delta still arrived', events.some(e => e.type === 'text-delta'))
}

//
section('9 · cancellation — abort mid-stream is a typed cancel')
//
{
  const controller = new AbortController()
  const events: ZaiStreamEvent[] = []
  for await (const event of streamZaiChat({
    apiKey: 'k',
    request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
    fetchImpl: fetchOf(
      responseFromChunks([sseChunk({ choices: [{ index: 0, delta: { content: 'start…' } }] })], {
        neverClose: true,
      }),
    ),
    signal: controller.signal,
    idleTimeoutMs: 5_000,
  })) {
    events.push(event)
    if (event.type === 'text-delta') controller.abort()
  }
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    'abort → cancelled fault (not timeout, not retryable)',
    fault?.type === 'stream-fault' && fault.fault.kind === 'cancelled' && !fault.fault.retryable,
  )
}

//
section('10 · truncated stream — EOF without finish/[DONE] is a typed fault')
//
{
  const events = await collect(
    streamZaiChat({
      apiKey: 'k',
      request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'x' }] },
      fetchImpl: fetchOf(responseFromChunks([sseChunk({ choices: [{ index: 0, delta: { content: 'cut of' } }] })])),
    }),
  )
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    'no-finish fault fired (retryable)',
    fault?.type === 'stream-fault' && fault.fault.code === 'no-finish' && fault.fault.retryable,
  )
}

//
section('11 · request mapping — native shapes, one schema truth, no key leak')
//
{
  const request = buildZaiChatRequest({
    model: 'glm-5.2',
    system: 'You are a reviewer.',
    messages: [
      { role: 'user', content: 'Review this.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/x' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file body here' },
          { type: 'text', text: 'continue' },
        ],
      },
    ],
    tools: [{ name: 'read', input_schema: zodToJsonSchema(z.object({ path: z.string() })) }],
    maxTokens: 4096,
    reasoningEffort: 'high',
    thinkingEnabled: true,
  })
  check('system first', request.messages[0]?.role === 'system' && request.messages[0].content === 'You are a reviewer.')
  check('user text plain', request.messages[1]?.role === 'user' && request.messages[1].content === 'Review this.')
  const assistant = request.messages[2]
  check(
    'assistant tool_use → tool_calls with stringified arguments',
    assistant?.role === 'assistant' &&
      assistant.content === 'Let me look.' &&
      assistant.tool_calls?.[0]?.id === 'call_1' &&
      assistant.tool_calls[0].function.arguments === '{"path":"/x"}',
  )
  const toolMsg = request.messages[3]
  check(
    "tool_result → role:'tool' with tool_call_id",
    toolMsg?.role === 'tool' && toolMsg.tool_call_id === 'call_1' && toolMsg.content === 'file body here',
  )
  check('trailing user text preserved after the tool message', request.messages[4]?.content === 'continue')
  check(
    "tools + tool_choice:'auto' + thinking + reasoning_effort ride",
    request.tools?.length === 1 &&
      request.tool_choice === 'auto' &&
      request.thinking?.type === 'enabled' &&
      request.reasoning_effort === 'high' &&
      request.max_tokens === 4096,
  )
  check('no key-shaped field in the body', !JSON.stringify(request).toLowerCase().includes('authorization'))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL S4 ZAI-STREAM PROOFS PASS')
else console.log(`${failures} S4 ZAI-STREAM PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
