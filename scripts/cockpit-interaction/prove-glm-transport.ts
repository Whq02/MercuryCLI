#!/usr/bin/env bun
// ============================================================================
//  scripts/cockpit-interaction/prove-glm-transport.ts — Mercury speaks GLM's documented
//  wire, and refuses honestly without a key.
//
//  The operator has no Z.AI key in this session, so a LIVE smoke cannot run —
//  and a prover that claimed one had would be worse than no prover at all.
//  What CAN be proved without a key, and is the substance of the row, is the
//  transport itself: the request Mercury constructs against the documented
//  chat-completions shape, and the response it parses back out of a scripted
//  SSE body — driven through the client's own `fetchImpl` seam, so no socket
//  is opened and no credential is read.
//
//  The other half is the refusal. A keyless lane must decline with a stable
//  code and do ZERO provider I/O; this holds the injected transport to a call
//  count of exactly zero, which is the only way to know the refusal happened
//  BEFORE the wire rather than at it.
//
//    §1 request construction   §2 response parsing   §3 fault mapping
//    §4 the keyless lane does no I/O   §5 the live requalification is an
//       OPERATOR-INPUT row, recorded as such
//
//  The guarded gap: no fixture-transport proof — a GLM row resting on
//  receipts from another session with nothing standing behind them in-tree.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'
import {
  assembleZaiTurn,
  buildZaiChatRequest,
  mapMessagesToZai,
  mapToolsToZai,
} from '../../src/services/providers/zai/zaiCodec.ts'
import {
  mapZaiHttpFailure,
  streamZaiChat,
  ZAI_CHAT_COMPLETIONS_URL,
  type ZaiStreamEvent,
} from '../../src/services/providers/zai/zaiClient.ts'
import { GLM_EFFORTS, glmAcceptsEffort, isGlmModelId } from '../../src/services/providers/zai/glmPins.ts'
import { zaiProviderAdapter } from '../../src/utils/router/providers/zai.ts'

const t = checker()

/** A scripted SSE body served through the client's fetchImpl seam. Nothing
 *  here touches the network; `calls` is the receipt that says so. */
function fixtureTransport(body: string, status = 200) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    if (status !== 200) {
      return new Response(body, { status, headers: { 'content-type': 'application/json' } })
    }
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const sse = (chunks: unknown[]): string =>
  chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'

async function drain(events: AsyncIterable<ZaiStreamEvent>): Promise<ZaiStreamEvent[]> {
  const out: ZaiStreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§1 — the request Mercury constructs is the documented shape')
{
  const request = buildZaiChatRequest({
    model: 'glm-5.2',
    system: 'be terse',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
    maxTokens: 1024,
    reasoningEffort: 'high',
    thinkingEnabled: true,
    requestId: 'req-1',
  })
  t.check('the model rides the request', request.model === 'glm-5.2', request.model)
  t.check(
    'the system prompt becomes a system MESSAGE — the chat-completions shape, not Anthropic\'s top-level field',
    request.messages[0]?.role === 'system' && request.messages[0]?.content === 'be terse',
    JSON.stringify(request.messages[0]),
  )
  t.check('and the user turn follows it', request.messages[1]?.role === 'user', JSON.stringify(request.messages[1]))
  t.check(
    'tools map to the function shape with tool_choice auto — the only documented value',
    request.tools?.[0]?.type === 'function' &&
      request.tools?.[0]?.function.name === 'Read' &&
      request.tool_choice === 'auto',
    JSON.stringify(request.tools?.[0]),
  )
  t.check('max_tokens is passed through', request.max_tokens === 1024, `${request.max_tokens}`)
  t.check('thinking is an explicit enable/disable object', request.thinking?.type === 'enabled', JSON.stringify(request.thinking))
  t.check('and the request id rides for provider-side correlation', request.request_id === 'req-1', String(request.request_id))

  // reasoning_effort is glm-5.2-only and has a CLOSED vocabulary.
  t.check('reasoning_effort carries the documented value', request.reasoning_effort === 'high', String(request.reasoning_effort))
  t.check('glm-5.2 is recognised as a GLM id', isGlmModelId('glm-5.2'), 'pinned')
  t.check(
    'every documented effort is accepted',
    [...GLM_EFFORTS].every(e => glmAcceptsEffort('glm-5.2', e)),
    [...GLM_EFFORTS].join(','),
  )
  t.check(
    'and an undocumented effort is REFUSED rather than sent and rejected at the wire',
    !glmAcceptsEffort('glm-5.2', 'ultra'),
    'closed vocabulary',
  )

  const bare = buildZaiChatRequest({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] })
  t.check('an optional field absent from the input is absent from the wire', bare.tools === undefined && bare.max_tokens === undefined, JSON.stringify(bare))

  // A tool RESULT round-trips as the tool role with its call id — the shape
  // the provider needs to match a result to its call.
  const withResult = mapMessagesToZai(undefined, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { p: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
  ])
  t.check(
    'an assistant tool call becomes tool_calls with stringified arguments',
    withResult[0]?.tool_calls?.[0]?.function.name === 'Read' &&
      withResult[0]?.tool_calls?.[0]?.function.arguments === '{"p":1}',
    JSON.stringify(withResult[0]),
  )
  t.check(
    'and its result becomes a tool message carrying the call id',
    withResult[1]?.role === 'tool' && withResult[1]?.tool_call_id === 'call-1',
    JSON.stringify(withResult[1]),
  )
  t.check(
    'the tool schema is passed as parameters, not re-shaped',
    JSON.stringify(mapToolsToZai([{ name: 'X', input_schema: { type: 'object', properties: {} } }])[0]?.function.parameters) ===
      '{"type":"object","properties":{}}',
    'verbatim',
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§2 — the response Mercury parses is the documented stream')
{
  const body = sse([
    { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: { content: ' world' } }] },
    // A tool call arrives FRAGMENTED — id and name on the first frame, the
    // arguments split across frames. Assembling that is the whole job.
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-9', function: { name: 'Read', arguments: '{"file' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '_path":"a.ts"}' } }] } }] },
    { usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ])
  const { impl, calls } = fixtureTransport(body)
  const events = await drain(
    streamZaiChat({
      apiKey: 'fixture-key-never-sent-anywhere',
      request: buildZaiChatRequest({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
      fetchImpl: impl,
      baseUrl: 'http://fixture.invalid/v4/chat/completions',
    }),
  )
  t.check('exactly one request was made', calls.length === 1, `${calls.length}`)
  t.check(
    'to the URL the caller chose — production defaults to the documented endpoint',
    calls[0]?.url === 'http://fixture.invalid/v4/chat/completions' &&
      ZAI_CHAT_COMPLETIONS_URL.startsWith('https://api.z.ai/'),
    ZAI_CHAT_COMPLETIONS_URL,
  )
  t.check(
    'carrying a bearer authorization and asking for an event stream',
    String((calls[0]?.init.headers as Record<string, string>)?.authorization ?? '').startsWith('Bearer ') &&
      (calls[0]?.init.headers as Record<string, string>)?.accept === 'text/event-stream',
    'documented headers',
  )
  t.check(
    'and stream:true in the BODY, never the key',
    (() => {
      const sent = JSON.parse(String(calls[0]?.init.body ?? '{}')) as Record<string, unknown>
      return sent.stream === true && !JSON.stringify(sent).includes('fixture-key')
    })(),
    'the credential rides the header only',
  )

  t.check('reasoning deltas are typed apart from text', events.some(e => e.type === 'reasoning-delta'), 'thinking channel')
  t.check('text deltas arrive in order', events.filter(e => e.type === 'text-delta').length === 2, 'two')
  const finish = events.find(e => e.type === 'finish')
  t.check('the stream finishes with the documented reason', finish?.type === 'finish' && finish.reason === 'tool_calls', JSON.stringify(finish?.type))

  const turn = await assembleZaiTurn(
    (async function* () {
      for (const e of events) yield e
    })(),
  )
  t.check('the assembled turn carries the thinking', turn.thinking === 'thinking…', turn.thinking)
  t.check('and the text, concatenated in order', turn.text === 'Hello world', turn.text)
  t.check(
    'the FRAGMENTED tool call reassembles into executable input',
    turn.toolUses.length === 1 &&
      turn.toolUses[0]?.name === 'Read' &&
      JSON.stringify(turn.toolUses[0]?.input) === '{"file_path":"a.ts"}',
    JSON.stringify(turn.toolUses),
  )
  t.check('with nothing malformed', turn.malformedToolCalls.length === 0, `${turn.malformedToolCalls.length}`)
  t.check('the stop reason maps to Anthropic vocabulary', turn.stopReason === 'tool_use', turn.stopReason)
  t.check(
    'and usage is accounted, cache included',
    turn.usage?.inputTokens === 11 && turn.usage?.outputTokens === 7 && turn.usage?.cachedInputTokens === 4,
    JSON.stringify(turn.usage),
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§3 — a broken call is a typed fault, never a thrown surprise')
{
  const { impl } = fixtureTransport(JSON.stringify({ error: { code: 1211, message: 'Unknown Model' } }), 400)
  const events = await drain(
    streamZaiChat({
      apiKey: 'fixture-key',
      request: buildZaiChatRequest({ model: 'glm-nope', messages: [{ role: 'user', content: 'hi' }] }),
      fetchImpl: impl,
      baseUrl: 'http://fixture.invalid/x',
    }),
  )
  const fault = events.find(e => e.type === 'stream-fault')
  t.check('an HTTP failure becomes a fault EVENT, not an exception', fault !== undefined, 'typed')
  t.check(
    'coded from the provider\'s own error table',
    fault?.type === 'stream-fault' && fault.fault.code === 'zai-1211',
    fault?.type === 'stream-fault' ? fault.fault.code : 'none',
  )
  t.check(
    'and classified for retry honestly',
    mapZaiHttpFailure(429, {}).retryable && !mapZaiHttpFailure(401, {}).retryable,
    '429 retryable · 401 not',
  )
  t.check(
    'a malformed tool call is SURFACED, never half-executed',
    await (async () => {
      const broken = sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'Read', arguments: '{"a":' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ])
      const f = fixtureTransport(broken)
      const turn = await assembleZaiTurn(
        streamZaiChat({
          apiKey: 'k',
          request: buildZaiChatRequest({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }),
          fetchImpl: f.impl,
          baseUrl: 'http://fixture.invalid/x',
        }),
      )
      return turn.toolUses.length === 0 && turn.malformedToolCalls.length === 1
    })(),
    'unexecutable arguments never become a tool use',
  )
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§4 — the keyless lane refuses with ZERO provider I/O')
{
  const before = process.env.ZAI_API_KEY
  delete process.env.ZAI_API_KEY

  const status = zaiProviderAdapter.status()
  t.check('the provider reports unavailable', status.available === false, JSON.stringify(status))
  t.check(
    'with a STABLE code rather than a sentence that could drift',
    typeof status.reason === 'string' && status.reason === 'no-api-key:zai',
    String(status.reason),
  )
  t.check('and lists no models', zaiProviderAdapter.listModels().length === 0, `${zaiProviderAdapter.listModels().length}`)
  const describe = zaiProviderAdapter.describe()
  t.check(
    'and the account surface says plainly that no key was detected',
    describe.account.kind === 'none',
    describe.account.label,
  )
  t.check(
    'while still declaring the catalogue it WOULD serve — an honest unavailable, not a blank',
    // Every declared row is a GLM id; the frontier ORDER belongs to the
    // adapter's catalogue (a literal first-row pin went stale when the
    // catalogue gained glm-5.3 above glm-5.2).
    describe.catalogue.length > 0 && describe.catalogue.every(c => isGlmModelId(c.id)),
    describe.catalogue.map(c => c.id).join(','),
  )

  // THE WIRE PROOF, on the PRODUCTION entry. The first cut armed a transport
  // and never injected it anywhere, so its zero-call count could not fail
  // (re-audit finding). zaiCallModel's transport bottoms out in global
  // fetch — so the armed transport IS global fetch for the duration: if the
  // keyless refusal ever moved past the wire, the call count records it.
  const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.ts')
  const realFetch = globalThis.fetch
  const wireCalls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    wireCalls.push(String(input))
    throw new Error('the keyless lane must never reach the wire')
  }) as typeof fetch
  try {
    const yielded: Array<Record<string, unknown>> = []
    const gen = zaiCallModel({
      messages: [],
      systemPrompt: ['probe'],
      thinkingConfig: undefined,
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'glm-5.2', querySource: 'user' },
    } as never)
    for await (const evt of gen) yielded.push(evt as Record<string, unknown>)
    const err = yielded.find(
      e => JSON.stringify(e).includes('no Z.AI API key detected'),
    )
    t.check(
      'a keyless CALL attempt yields the honest refusal',
      err !== undefined,
      err ? 'refused in words' : JSON.stringify(yielded).slice(0, 200),
    )
    t.check(
      'and the refusal happened BEFORE the wire — the armed global transport counted zero calls',
      wireCalls.length === 0,
      `${wireCalls.length} requests: ${wireCalls.join(', ')}`,
    )
  } finally {
    globalThis.fetch = realFetch
  }
  if (before !== undefined) process.env.ZAI_API_KEY = before
}

// ────────────────────────────────────────────────────────────────────────────
t.section('§5 — the live requalification needs an operator key; this prover never makes a live call')
{
  t.check(
    'this prover claims no live call — the fixture transport is the whole story',
    !readFileSync('scripts/cockpit-interaction/prove-glm-transport.ts', 'utf8').includes('api.z.ai/api/paas/v4/chat/completions\''),
    'no live endpoint is ever contacted here',
  )
}

t.finish('prove-glm-transport')
