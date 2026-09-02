#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-compat-chat-transport.ts — the SHARED OpenAI-
//  compatible chat-completions transport, entirely against injected fetch
//  fixtures (no network, no key, no billables; the prove-s4-zai-stream
//  method).
//
//    1. REQUEST TRUTH: url · bearer header present (and ABSENT for a keyless
//       compat dispatch) · stream:true · lane extras merged FLAT into the
//       body · the key never rides the body.
//    2. WIRE KNOBS (compatWire, the pure builders the lanes send from):
//       kimi — reasoning_effort nearest-below on the documented low|high|max,
//       max_completion_tokens only on an explicit override, NEVER a
//       temperature key; deepseek — thinking {type, reasoning_effort} +
//       stream_options.include_usage, disabled thinking drops the effort;
//       compat — the baseline dialect only.
//    3. STREAM DECODE: happy turn (reasoning + text deltas, usage, finish,
//       [DONE]); the SAME bytes under pathological chunking; parallel
//       index-keyed tool fragments accumulated exactly once; malformed
//       arguments surface typed; content_filter and
//       insufficient_system_resource arrive as typed provider-termination
//       faults (retryable honesty: only the resource channel retries); an
//       UNKNOWN finish word settles as reason 'other' with the raw string
//       preserved — never a fake truncation; http error mapping; idle
//       timeout; cancellation; no-finish truncation.
//    4. USAGE DECODE across the three documented cached-prefix spellings
//       (DeepSeek prompt_cache_hit_tokens · Moonshot cached_tokens ·
//       standard prompt_tokens_details.cached_tokens) + reasoning_tokens +
//       the provider-STATED cost (OpenRouter usage accounting).
//    5. USAGE DELIVERY IS AN OPT-IN: the fixture server hands usage over
//       ONLY when the request carries stream_options.include_usage — kimi
//       and deepseek builders both send it; a request without it gets no
//       usage event (the documented delivery condition, never assumed).
//    6. MID-STREAM {"error": …} PAYLOADS decode as typed api-error faults
//       that WIN over a following [DONE]-synthesized clean stop; partial
//       content still settles first; no extra truncation fault stacks on
//       top of a provider-stated failure.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-compat-chat-transport.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  decodeCompatUsage,
  mapCompatHttpFailure,
  streamCompatChat,
  type CompatStreamEvent,
} from '../../src/services/providers/openaicompat/compatChatClient.ts'
import {
  buildCompatSlotExtras,
  buildDeepseekExtras,
  buildGeminiExtras,
  buildMoonshotExtras,
  buildOpenrouterExtras,
  GEMINI_REASONING_EFFORTS,
  OPENROUTER_REASONING_EFFORTS,
} from '../../src/services/providers/openaicompat/compatWire.ts'
import { mapMessagesToZai } from '../../src/services/providers/zai/zaiCodec.ts'
import type { MessageParam } from '../../src/types/wire.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// ── Fixture plumbing ────────────────────────────────────────────────────────

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
function responseFromChunks(chunks: string[], opts?: { status?: number; neverClose?: boolean }): Response {
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
/** Split a byte string into 1-byte chunks (the pathological framing). */
function byteSplit(text: string): string[] {
  return [...text]
}

interface Captured {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}
function capturingFetch(chunks: string[], captured: Captured[], opts?: { status?: number }): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    captured.push({
      url: String(url),
      headers,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    return responseFromChunks(chunks, { status: opts?.status ?? 200 })
  }) as typeof fetch
}

async function collect(events: AsyncGenerator<CompatStreamEvent>): Promise<CompatStreamEvent[]> {
  const out: CompatStreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

const HAPPY = [
  sseChunk({ choices: [{ delta: { reasoning_content: 'thinking…' } }] }),
  sseChunk({ choices: [{ delta: { content: 'Hello' } }] }),
  sseChunk({ choices: [{ delta: { content: ' world' } }] }),
  sseChunk({
    choices: [{ delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, cached_tokens: 4 },
  }),
  'data: [DONE]\n\n',
]

section('1 · request truth (url · headers · flat extras · no key in body)')
{
  const captured: Captured[] = []
  const events = await collect(
    streamCompatChat({
      apiKey: 'sk-proof-secret',
      url: 'https://fixture.example/v1/chat/completions',
      request: {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
        tool_choice: 'auto',
        extra: { reasoning_effort: 'max', max_completion_tokens: 4096 },
      },
      fetchImpl: capturingFetch(HAPPY, captured),
    }),
  )
  const req = captured[0]!
  check('url honored', req.url === 'https://fixture.example/v1/chat/completions')
  check('bearer header carries the key', req.headers['authorization'] === 'Bearer sk-proof-secret')
  check('stream:true', req.body.stream === true)
  check('extras merged FLAT (reasoning_effort at top level)', req.body.reasoning_effort === 'max')
  check('extras merged FLAT (max_completion_tokens)', req.body.max_completion_tokens === 4096)
  check("no literal 'extra' key rides the wire", !('extra' in req.body))
  check('key never in body', !JSON.stringify(req.body).includes('sk-proof-secret'))
  check('tools + tool_choice ride', Array.isArray(req.body.tools) && req.body.tool_choice === 'auto')
  const finish = events.find(e => e.type === 'finish')
  check('happy turn finishes', finish !== undefined && finish.type === 'finish' && finish.reason === 'stop')
}
{
  const captured: Captured[] = []
  await collect(
    streamCompatChat({
      // keyless — the compat slot's local-server case
      url: 'http://localhost:1234/v1/chat/completions',
      request: { model: 'qwen3-32b', messages: [{ role: 'user', content: 'hi' }] },
      fetchImpl: capturingFetch(HAPPY, captured),
    }),
  )
  check('keyless dispatch sends NO authorization header', captured[0]!.headers['authorization'] === undefined)
}

section('2 · wire knobs (the pure lane builders)')
{
  const base = { thinkingEnabled: true, maxOutputTokensOverride: undefined }
  const kimiMax = buildMoonshotExtras({ ...base, wireModel: 'kimi-k3', effortValue: 'max' })
  check('kimi: documented effort passes', kimiMax.reasoning_effort === 'max')
  const kimiX = buildMoonshotExtras({ ...base, wireModel: 'kimi-k3', effortValue: 'xhigh' })
  check('kimi: xhigh resolves nearest-below → high', kimiX.reasoning_effort === 'high')
  const kimiMed = buildMoonshotExtras({ ...base, wireModel: 'kimi-k3', effortValue: 'medium' })
  check('kimi: medium resolves nearest-below → low', kimiMed.reasoning_effort === 'low')
  const kimiOther = buildMoonshotExtras({ ...base, wireModel: 'kimi-k2.6', effortValue: 'max' })
  check('kimi: no documented vocabulary ⇒ effort omitted', !('reasoning_effort' in kimiOther))
  check('kimi: never a temperature key', !('temperature' in kimiMax))
  check(
    'kimi: include_usage opt-in rides (usage arrives only when requested)',
    (kimiMax.stream_options as Record<string, unknown>).include_usage === true,
  )
  check('kimi: no override ⇒ no output knob', !('max_completion_tokens' in kimiMax))
  const kimiCap = buildMoonshotExtras({ ...base, wireModel: 'kimi-k3', effortValue: undefined, maxOutputTokensOverride: 9000 })
  check('kimi: override rides max_completion_tokens', kimiCap.max_completion_tokens === 9000)

  const dsOn = buildDeepseekExtras({ ...base, wireModel: 'deepseek-v4-pro', effortValue: 'xhigh' })
  const dsThinking = dsOn.thinking as Record<string, unknown>
  check('deepseek: thinking enabled', dsThinking.type === 'enabled')
  check('deepseek: xhigh resolves nearest-below → high INSIDE thinking', dsThinking.reasoning_effort === 'high')
  check(
    'deepseek: include_usage always',
    (dsOn.stream_options as Record<string, unknown>).include_usage === true,
  )
  const dsOff = buildDeepseekExtras({
    wireModel: 'deepseek-v4-pro',
    effortValue: 'max',
    thinkingEnabled: false,
    maxOutputTokensOverride: undefined,
  })
  const dsOffThinking = dsOff.thinking as Record<string, unknown>
  check('deepseek: disabled thinking drops the effort key', dsOffThinking.type === 'disabled' && !('reasoning_effort' in dsOffThinking))

  const slot = buildCompatSlotExtras({ ...base, wireModel: 'qwen3-32b', effortValue: 'max' })
  check('compat: baseline only (no effort/thinking keys)', !('reasoning_effort' in slot) && !('thinking' in slot))
  check(
    'compat: include_usage rides',
    (slot.stream_options as Record<string, unknown>).include_usage === true,
  )

  // OpenRouter: `reasoning.effort` from the ROW's live vocabulary (the
  // documented ladder max…none; the row's own supported_efforts when it
  // states one), nearest-below; no vocabulary ⇒ no key.
  const orRow = ['low', 'medium', 'high', 'xhigh'] as const
  const orHigh = buildOpenrouterExtras({ ...base, wireModel: 'google/gemini-fixture', effortValue: 'high', vocabulary: orRow })
  check('openrouter: a listed effort rides reasoning.effort', (orHigh.reasoning as Record<string, unknown>)?.effort === 'high')
  const orMax = buildOpenrouterExtras({ ...base, wireModel: 'google/gemini-fixture', effortValue: 'max', vocabulary: orRow })
  check('openrouter: max resolves nearest-below → xhigh when the row omits max', (orMax.reasoning as Record<string, unknown>)?.effort === 'xhigh')
  const orFull = buildOpenrouterExtras({ ...base, wireModel: 'x', effortValue: 'max', vocabulary: OPENROUTER_REASONING_EFFORTS })
  check('openrouter: the documented ladder carries max verbatim', (orFull.reasoning as Record<string, unknown>)?.effort === 'max')
  const orNone = buildOpenrouterExtras({ ...base, wireModel: 'x', effortValue: 'max', vocabulary: [] })
  check('openrouter: no row vocabulary ⇒ no reasoning key', !('reasoning' in orNone))
  const orOff = buildOpenrouterExtras({ ...base, thinkingEnabled: false, wireModel: 'x', effortValue: 'max', vocabulary: orRow })
  check('openrouter: thinking disabled ⇒ no reasoning key', !('reasoning' in orOff))
  check('openrouter: include_usage rides; max_tokens only on an override', (orHigh.stream_options as Record<string, unknown>).include_usage === true && !('max_tokens' in orHigh) && buildOpenrouterExtras({ ...base, wireModel: 'x', effortValue: undefined, vocabulary: [], maxOutputTokensOverride: 4096 }).max_tokens === 4096)
  check('openrouter: never a temperature key', !('temperature' in orHigh))

  // Gemini: reasoning_effort from the documented ladder (low · medium ·
  // high) only when the live row states a thinking model.
  const gmHigh = buildGeminiExtras({ ...base, wireModel: 'gemini-fixture-pro', effortValue: 'xhigh', acceptsEffort: true })
  check('gemini: xhigh resolves nearest-below → high', gmHigh.reasoning_effort === 'high')
  const gmMed = buildGeminiExtras({ ...base, wireModel: 'gemini-fixture-pro', effortValue: 'medium', acceptsEffort: true })
  check('gemini: medium rides verbatim', gmMed.reasoning_effort === 'medium')
  const gmNo = buildGeminiExtras({ ...base, wireModel: 'gemini-fixture-lite', effortValue: 'high', acceptsEffort: false })
  check('gemini: a non-thinking row sends no reasoning_effort', !('reasoning_effort' in gmNo))
  const gmOff = buildGeminiExtras({ ...base, thinkingEnabled: false, wireModel: 'gemini-fixture-pro', effortValue: 'high', acceptsEffort: true })
  check('gemini: thinking disabled ⇒ no reasoning_effort', !('reasoning_effort' in gmOff))
  check('gemini: include_usage rides; the ladder never names none/max', (gmHigh.stream_options as Record<string, unknown>).include_usage === true && !GEMINI_REASONING_EFFORTS.includes('none') && !GEMINI_REASONING_EFFORTS.includes('max'))
}

section('3 · stream decode')
{
  const whole = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch(HAPPY, []),
    }),
  )
  const text = whole.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text).join('')
  check('text deltas assemble', text === 'Hello world')
  check('reasoning delta seen', whole.some(e => e.type === 'reasoning-delta'))
  const usage = whole.find(e => e.type === 'usage')
  check(
    'usage decoded (moonshot cached_tokens spelling)',
    usage?.type === 'usage' && usage.usage.inputTokens === 11 && usage.usage.cachedInputTokens === 4,
  )

  const split = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch(byteSplit(HAPPY.join('')), []),
    }),
  )
  const splitText = split.filter(e => e.type === 'text-delta').map(e => (e as { text: string }).text).join('')
  check('pathological chunking assembles identically', splitText === 'Hello world')
}
{
  // Parallel incremental tool calls, exactly-once settlement.
  const chunks = [
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a1', function: { name: 'alpha', arguments: '{"x":' } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b2', function: { name: 'beta', arguments: '{"y":true}' } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]
  const events = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch(chunks, []),
    }),
  )
  const finish = events.find(e => e.type === 'finish')
  check('finish reason tool_calls', finish?.type === 'finish' && finish.reason === 'tool_calls')
  const calls = finish?.type === 'finish' ? finish.toolCalls : []
  check('two calls settle exactly once', calls.length === 2)
  check(
    'fragments accumulate per index',
    JSON.stringify(calls[0]?.arguments) === '{"x":1}' && JSON.stringify(calls[1]?.arguments) === '{"y":true}',
  )
  check('nothing malformed', calls.every(c => !c.malformed))
}
{
  // Malformed arguments surface typed.
  const chunks = [
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'gamma', arguments: '{broken' } }] } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]
  const events = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch(chunks, []),
    }),
  )
  const finish = events.find(e => e.type === 'finish')
  const calls = finish?.type === 'finish' ? finish.toolCalls : []
  check('malformed call flagged, never silent', calls.length === 1 && calls[0]!.malformed === true)
}
{
  // Provider-termination channels.
  for (const [reason, retryable] of [
    ['content_filter', false],
    ['insufficient_system_resource', true],
  ] as const) {
    const chunks = [
      sseChunk({ choices: [{ delta: { content: 'partial' } }] }),
      sseChunk({ choices: [{ delta: {}, finish_reason: reason }] }),
      'data: [DONE]\n\n',
    ]
    const events = await collect(
      streamCompatChat({
        apiKey: 'k',
        url: 'https://f/v1/chat/completions',
        request: { model: 'm', messages: [] },
        fetchImpl: capturingFetch(chunks, []),
      }),
    )
    const fault = events.find(e => e.type === 'stream-fault')
    check(
      `${reason} ⇒ typed provider-termination fault (retryable ${retryable})`,
      fault?.type === 'stream-fault' &&
        fault.fault.kind === 'provider-termination' &&
        fault.fault.code === `finish:${reason}` &&
        fault.fault.retryable === retryable,
    )
    check(`${reason} still settles the finish`, events.some(e => e.type === 'finish'))
  }
}
{
  // Unknown finish word: 'other' + raw preserved, never a truncation lie.
  const chunks = [
    sseChunk({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'brand_new_vendor_word' }] }),
    'data: [DONE]\n\n',
  ]
  const events = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch(chunks, []),
    }),
  )
  const finish = events.find(e => e.type === 'finish')
  check(
    "unknown finish ⇒ reason 'other' with rawReason preserved",
    finish?.type === 'finish' && finish.reason === 'other' && finish.rawReason === 'brand_new_vendor_word',
  )
  check('unknown finish is NOT a truncation fault', !events.some(e => e.type === 'stream-fault'))
}
{
  // HTTP error mapping.
  const events = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: 'bad key', code: 'invalid_api_key' } }), {
          status: 401,
        })) as typeof fetch,
    }),
  )
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    '401 maps to api-error, not retryable',
    fault?.type === 'stream-fault' &&
      fault.fault.kind === 'api-error' &&
      fault.fault.code === 'api-invalid_api_key' &&
      fault.fault.retryable === false,
  )
  const f500 = mapCompatHttpFailure(503, { message: 'overloaded' })
  check('5xx retryable', f500.retryable === true && f500.code === 'http-503')
}
{
  // Idle timeout (short) on a never-closing stream.
  const events = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      idleTimeoutMs: 40,
      fetchImpl: (async () => responseFromChunks([], { neverClose: true })) as typeof fetch,
    }),
  )
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    'idle timeout is a typed retryable fault',
    fault?.type === 'stream-fault' && fault.fault.kind === 'timeout' && fault.fault.retryable === true,
  )
}
{
  // Cancellation.
  const controller = new AbortController()
  const generator = streamCompatChat({
    apiKey: 'k',
    url: 'https://f/v1/chat/completions',
    request: { model: 'm', messages: [] },
    signal: controller.signal,
    idleTimeoutMs: 2_000,
    fetchImpl: (async () => responseFromChunks([sseChunk({ choices: [{ delta: { content: 'x' } }] })], { neverClose: true })) as typeof fetch,
  })
  const first = await generator.next()
  check('stream alive before abort', first.done === false)
  controller.abort()
  const rest: CompatStreamEvent[] = []
  for await (const e of generator) rest.push(e)
  const fault = rest.find(e => e.type === 'stream-fault')
  check(
    'abort ⇒ typed cancelled fault, not retryable',
    fault?.type === 'stream-fault' && fault.fault.kind === 'cancelled' && fault.fault.retryable === false,
  )
}
{
  // Stream ends with no finish and no [DONE] ⇒ truncation.
  const events = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch([sseChunk({ choices: [{ delta: { content: 'x' } }] })], []),
    }),
  )
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    'no finish ⇒ typed truncation',
    fault?.type === 'stream-fault' && fault.fault.kind === 'truncated-stream' && fault.fault.code === 'no-finish',
  )
}

section('4 · usage decode across the documented spellings')
{
  const deepseek = decodeCompatUsage({
    prompt_tokens: 100,
    completion_tokens: 50,
    prompt_cache_hit_tokens: 60,
    prompt_cache_miss_tokens: 40,
    completion_tokens_details: { reasoning_tokens: 12 },
  })
  check(
    'deepseek spelling (prompt_cache_hit_tokens + reasoning_tokens)',
    deepseek?.inputTokens === 100 && deepseek.cachedInputTokens === 60 && deepseek.reasoningTokens === 12,
  )
  const moonshot = decodeCompatUsage({ prompt_tokens: 10, completion_tokens: 5, cached_tokens: 3 })
  check('moonshot spelling (top-level cached_tokens)', moonshot?.cachedInputTokens === 3)
  const standard = decodeCompatUsage({
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 7 },
  })
  check('standard spelling (prompt_tokens_details.cached_tokens)', standard?.cachedInputTokens === 7)
  check('no usage fields ⇒ undefined, never zeros', decodeCompatUsage({ other: 1 }) === undefined)
  const openrouter = decodeCompatUsage({
    prompt_tokens: 20,
    completion_tokens: 9,
    cost: 0.00042,
    cost_details: { upstream_inference_cost: 0.0004 },
    prompt_tokens_details: { cached_tokens: 5 },
    completion_tokens_details: { reasoning_tokens: 2 },
  })
  check(
    'openrouter stated cost decodes (billing truth, no pin arithmetic)',
    openrouter?.statedCostUSD === 0.00042 && openrouter.cachedInputTokens === 5 && openrouter.reasoningTokens === 2,
  )
  const costless = decodeCompatUsage({ prompt_tokens: 1, completion_tokens: 1 })
  check('absent cost stays ABSENT — never zero', costless !== undefined && !('statedCostUSD' in costless))
}

section('5 · usage delivery is an opt-in (the documented condition)')
{
  // The fixture server enforces the documented contract: usage rides the
  // final chunk ONLY when the request asked via stream_options.include_usage.
  const conditionalFetch: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const optedIn =
      (body.stream_options as Record<string, unknown> | undefined)?.include_usage === true
    const chunks = [
      sseChunk({ choices: [{ delta: { content: 'ok' } }] }),
      optedIn
        ? sseChunk({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          })
        : sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]
    return responseFromChunks(chunks)
  }) as unknown as typeof fetch
  const withOptIn = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: {
        model: 'kimi-k3',
        messages: [],
        extra: buildMoonshotExtras({
          wireModel: 'kimi-k3',
          effortValue: undefined,
          thinkingEnabled: true,
          maxOutputTokensOverride: undefined,
        }),
      },
      fetchImpl: conditionalFetch,
    }),
  )
  check('kimi extras opt in ⇒ usage delivered', withOptIn.some(e => e.type === 'usage'))
  const without = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'kimi-k3', messages: [] },
      fetchImpl: conditionalFetch,
    }),
  )
  check(
    'no opt-in ⇒ NO usage event (delivery follows the documented condition)',
    !without.some(e => e.type === 'usage') && without.some(e => e.type === 'finish'),
  )
}

section('6 · mid-stream {"error"} payloads are typed faults, never clean stops')
{
  // Error object then [DONE] — the exact swallow class: the fault must win
  // over the [DONE]-synthesized clean stop.
  const errorThenDone = [
    sseChunk({ error: { message: 'insufficient quota', type: 'quota', code: 'exceeded_current_quota_error' } }),
    'data: [DONE]\n\n',
  ]
  const events = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch(errorThenDone, []),
    }),
  )
  const fault = events.find(e => e.type === 'stream-fault')
  check(
    'error payload ⇒ typed api-error fault with the provider code',
    fault?.type === 'stream-fault' && fault.fault.kind === 'api-error' && fault.fault.code === 'api-exceeded_current_quota_error' && fault.fault.message === 'insufficient quota',
  )
  check('the fault WINS: no [DONE]-synthesized clean finish follows', !events.some(e => e.type === 'finish'))
  check('no truncation fault stacks on the provider-stated one', !events.some(e => e.type === 'stream-fault' && e.fault.kind === 'truncated-stream'))

  // Error after partial content, stream closed without [DONE]: content
  // settles, the fault stands, still no synthetic truncation on top.
  const partialThenError = [
    sseChunk({ choices: [{ delta: { content: 'partial ' } }] }),
    sseChunk({ error: { message: 'backend exploded' } }),
  ]
  const partial = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch(partialThenError, []),
    }),
  )
  check('partial text still streams before the fault', partial.some(e => e.type === 'text-delta'))
  const pf = partial.find(e => e.type === 'stream-fault')
  check(
    'code defaults to mid-stream-error when the provider states none',
    pf?.type === 'stream-fault' && pf.fault.kind === 'api-error' && pf.fault.code === 'mid-stream-error' && pf.fault.message === 'backend exploded',
  )
  check('closed-after-error adds NO extra no-finish truncation', !partial.some(e => e.type === 'stream-fault' && e.fault.kind === 'truncated-stream'))

  // A string-valued error member (some proxies) decodes too.
  const stringError = [sseChunk({ error: 'upstream disconnected' }), 'data: [DONE]\n\n']
  const se = await collect(
    streamCompatChat({
      apiKey: 'k',
      url: 'https://f/v1/chat/completions',
      request: { model: 'm', messages: [] },
      fetchImpl: capturingFetch(stringError, []),
    }),
  )
  const sef = se.find(e => e.type === 'stream-fault')
  check(
    'string error member decodes (message preserved)',
    sef?.type === 'stream-fault' && sef.fault.kind === 'api-error' && sef.fault.message === 'upstream disconnected',
  )
}

section('7 · reasoning history: per-lane round-trip through the shared codec')
{
  // History with thinking + text + a tool call in one assistant turn, and a
  // second thinking-only assistant message (the minted-per-block shape).
  const history = [
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'step one', signature: '' },
        { type: 'text', text: 'answer', citations: null },
        { type: 'tool_use', id: 't1', name: 'f', input: { x: 1 } },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'later thought', signature: '' }],
    },
  ] as unknown as readonly MessageParam[]

  const kept = mapMessagesToZai('sys', history, { keepReasoningHistory: true })
  const keptAssistants = kept.filter(m => m.role === 'assistant')
  check(
    'opt-in: historical thinking rides reasoning_content beside content + tool_calls',
    keptAssistants[0]?.reasoning_content === 'step one' &&
      keptAssistants[0].content === 'answer' &&
      keptAssistants[0].tool_calls?.length === 1,
  )
  // content is '' (not null) on a call-less assistant message: the wire
  // documents null ONLY beside tool_calls, and strict servers reject it.
  check(
    'opt-in: a thinking-only assistant message carries its reasoning (no longer an empty shell)',
    keptAssistants[1]?.reasoning_content === 'later thought' && keptAssistants[1].content === '',
  )

  const omitted = mapMessagesToZai('sys', history)
  check(
    "default: NO reasoning_content key anywhere (DeepSeek's documented rejection — absence, not empty string)",
    omitted.every(m => !('reasoning_content' in m)),
  )
  const explicit = mapMessagesToZai('sys', history, { keepReasoningHistory: false })
  check('explicit false matches the default', explicit.every(m => !('reasoning_content' in m)))
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
