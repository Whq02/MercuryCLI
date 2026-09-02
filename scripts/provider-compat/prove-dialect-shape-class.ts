#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-dialect-shape-class.ts — the "safe by
//  upstream guarantee" class beyond tool inputs: every place the decoders
//  and their consumers assumed the Anthropic shape while another dialect
//  delivers something looser. One fixture case per row, against the real
//  decoders with injected fetch (no network, no key, no billables).
//
//    §1 USAGE — every chat-completions vendor counts the cached prefix
//       INSIDE prompt_tokens; the canonical envelope is DISJOINT. The compat
//       and Z.AI runtimes mapped the inclusive total through (the cached
//       prefix billed twice); now total − cached, clamped at zero.
//    §2 Z.AI FINISH WORDS — a finish_reason outside the documented table
//       settles as 'other' with the raw word preserved; a stream that then
//       closes without [DONE] is NOT reported as truncated.
//    §3 INDEX-LESS TOOL-CALL DELTAS — servers that omit `index` no longer
//       merge parallel calls into one accumulator: ids open their own slot,
//       bare fragments continue the latest, a name change opens a new one.
//    §4 REASONING SPELLINGS — `reasoning_content`, `reasoning`, and
//       OpenRouter's structured `reasoning_details[]` all surface as
//       reasoning deltas; a chunk carrying both spellings emits once.
//    §5 ERROR ENVELOPES → TYPED CLASSES — Google's numeric code + status
//       word + details reason (an invalid Gemini key is HTTP 400 +
//       API_KEY_INVALID), OpenRouter's numeric code (402 = credits),
//       DeepSeek's documented 401/402, Hugging Face's string error,
//       Moonshot's type word, Z.AI's numeric table, and the OpenAI lane's
//       404 — each lands in the right AssistantMessage error class
//       (authentication_failed · billing_error · rate_limit ·
//       invalid_request · server_error), never a generic server_error for a
//       fixable state. OpenRouter's mid-stream error chunk (finish_reason
//       'error') is a fault, never a settled finish.
//    §6 ASSISTANT NULL CONTENT — a thinking-only assistant turn replays as
//       empty text on the chat-completions wire; null stays only beside
//       tool_calls.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-dialect-shape-class.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  mapCompatHttpFailure,
  streamCompatChat,
  type CompatStreamEvent,
} from '../../src/services/providers/openaicompat/compatChatClient.ts'
import {
  compatFaultToTypedError,
  compatTerminalFaultText,
  mapCompatUsageToAnthropic,
} from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import { mapZaiUsageToAnthropic } from '../../src/services/providers/zai/zaiCallModel.ts'
import { mapZaiHttpFailure, streamZaiChat, type ZaiStreamEvent } from '../../src/services/providers/zai/zaiClient.ts'
import { mapMessagesToZai } from '../../src/services/providers/zai/zaiCodec.ts'
import { mapOpenaiHttpFailure } from '../../src/services/providers/openai/openaiWire.ts'
import { openaiFaultToTypedError } from '../../src/services/providers/openai/openaiCallModel.ts'
import type { MessageParam } from '../../src/types/wire.ts'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// ── fixture plumbing (the compat-transport prover's) ────────────────────────
const sseChunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function responseFromChunks(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } })
}
const fetchOf = (chunks: string[]): typeof fetch => (async () => responseFromChunks(chunks)) as typeof fetch
async function compat(chunks: string[]): Promise<CompatStreamEvent[]> {
  const out: CompatStreamEvent[] = []
  for await (const e of streamCompatChat({ apiKey: 'k', url: 'https://f/v1/chat/completions', request: { model: 'm', messages: [] }, fetchImpl: fetchOf(chunks) })) out.push(e)
  return out
}
async function zai(chunks: string[]): Promise<ZaiStreamEvent[]> {
  const out: ZaiStreamEvent[] = []
  for await (const e of streamZaiChat({ apiKey: 'k', request: { model: 'm', messages: [] }, fetchImpl: fetchOf(chunks), baseUrl: 'https://f/v4/chat/completions' })) out.push(e)
  return out
}
const finishOf = <E extends { type: string }>(events: E[]): Extract<E, { type: 'finish' }> | undefined =>
  events.find(e => e.type === 'finish') as Extract<E, { type: 'finish' }> | undefined
const reasoningText = (events: CompatStreamEvent[]): string =>
  events.filter(e => e.type === 'reasoning-delta').map(e => (e as { text: string }).text).join('|')

section('§1 · usage: the inclusive wire total becomes the disjoint canonical envelope')
{
  const compatUsage = mapCompatUsageToAnthropic({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 50 })
  check('compat: input_tokens = total − cached (70), cache_read = 50', compatUsage.input_tokens === 70 && compatUsage.cache_read_input_tokens === 50 && compatUsage.output_tokens === 30, JSON.stringify(compatUsage))
  const zaiUsage = mapZaiUsageToAnthropic({ inputTokens: 120, outputTokens: 30, cachedInputTokens: 50 })
  check('zai: the same law', zaiUsage.input_tokens === 70 && zaiUsage.cache_read_input_tokens === 50, JSON.stringify(zaiUsage))
  const anomaly = mapCompatUsageToAnthropic({ inputTokens: 10, outputTokens: 1, cachedInputTokens: 25 })
  check('cached > total clamps uncached to zero, never negative', anomaly.input_tokens === 0 && anomaly.cache_read_input_tokens === 25)
  const plain = mapCompatUsageToAnthropic({ inputTokens: 9, outputTokens: 2 })
  check('no cached field ⇒ the total is the uncached count, cache_read 0', plain.input_tokens === 9 && plain.cache_read_input_tokens === 0)
  check('absent usage ⇒ the zero envelope', mapCompatUsageToAnthropic(undefined).input_tokens === 0)
}

section("§2 · Z.AI: an undocumented finish word settles as 'other' (raw kept), never a truncation")
{
  const withDone = await zai([
    sseChunk({ choices: [{ delta: { content: 'x' } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'brand_new_vendor_word' }] }),
    'data: [DONE]\n\n',
  ])
  const f = finishOf(withDone)
  check("unknown finish ⇒ reason 'other' with rawReason preserved", f?.reason === 'other' && f.rawReason === 'brand_new_vendor_word', JSON.stringify(f))
  check('no truncation fault stacks on it', !withDone.some(e => e.type === 'stream-fault'))
  const noDone = await zai([
    sseChunk({ choices: [{ delta: { content: 'x' } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'brand_new_vendor_word' }] }),
  ])
  check("a stream that closes WITHOUT [DONE] after the unknown word is still not 'no-finish' truncated", finishOf(noDone)?.reason === 'other' && !noDone.some(e => e.type === 'stream-fault'), JSON.stringify(noDone.map(e => e.type)))
  const known = await zai([sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])
  check('a documented word keeps its reason and its raw spelling', finishOf(known)?.reason === 'stop' && finishOf(known)?.rawReason === 'stop')
}

section('§3 · index-less tool_call deltas never merge parallel calls')
{
  const chunks = [
    sseChunk({ choices: [{ delta: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'alpha', arguments: '{"x":' } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ id: 'b', type: 'function', function: { name: 'beta', arguments: '{"y":true}' } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { arguments: '1}' } }] } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ]
  for (const [lane, run] of [['compat', compat], ['zai', zai]] as const) {
    const events = await run(chunks)
    const calls = (finishOf(events as never[]) as { toolCalls?: Array<{ id: string; arguments?: unknown; malformed: boolean }> } | undefined)?.toolCalls ?? []
    check(
      `${lane}: two id-bearing calls without index settle as TWO calls, fragments joined by id`,
      calls.length === 2 && calls.every(c => !c.malformed) && JSON.stringify(calls.find(c => c.id === 'a')?.arguments) === '{"x":1}' && JSON.stringify(calls.find(c => c.id === 'b')?.arguments) === '{"y":true}',
      JSON.stringify(calls),
    )
  }
  const bare = await compat([
    sseChunk({ choices: [{ delta: { tool_calls: [{ id: 'c', type: 'function', function: { name: 'gamma', arguments: '{"z":' } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"q"}' } }] } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ])
  const bareCalls = finishOf(bare)?.toolCalls ?? []
  check('a bare arguments fragment (no index, no id, no name) continues the latest call', bareCalls.length === 1 && JSON.stringify(bareCalls[0]?.arguments) === '{"z":"q"}', JSON.stringify(bareCalls))
  const renamed = await compat([
    sseChunk({ choices: [{ delta: { tool_calls: [{ function: { name: 'one', arguments: '{}' } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ function: { name: 'one', arguments: '' } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ function: { name: 'two', arguments: '{}' } }] } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ])
  const renamedCalls = finishOf(renamed)?.toolCalls ?? []
  check('a repeated name continues its call; a NEW name opens a new one (two calls, no ids)', renamedCalls.length === 2 && renamedCalls[0]?.name === 'one' && renamedCalls[1]?.name === 'two', JSON.stringify(renamedCalls.map(c => c.name)))
  const indexed = await compat([
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'i0', function: { name: 'f', arguments: '{' } }, { index: 1, id: 'i1', function: { name: 'g', arguments: '{}' } }] } }] }),
    sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    'data: [DONE]\n\n',
  ])
  check("the wire's own index still wins when stated", (finishOf(indexed)?.toolCalls ?? []).length === 2 && finishOf(indexed)?.toolCalls.every(c => !c.malformed) === true)
}

section('§4 · reasoning spellings across the family')
{
  const content = await compat([sseChunk({ choices: [{ delta: { reasoning_content: 'rc' } }] }), sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])
  check('reasoning_content (DeepSeek · Moonshot · vLLM)', reasoningText(content) === 'rc')
  const plain = await compat([sseChunk({ choices: [{ delta: { reasoning: 'r' } }] }), sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'])
  check("the `reasoning` string spelling", reasoningText(plain) === 'r')
  const details = await compat([
    sseChunk({ choices: [{ delta: { reasoning_details: [
      { type: 'reasoning.summary', summary: 'sum', id: 'd1', format: 'x', index: 0 },
      { type: 'reasoning.encrypted', data: 'ENC', id: 'd2', format: 'x', index: 1 },
      { type: 'reasoning.text', text: 'txt', id: 'd3', format: 'x', index: 2 },
    ] } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ])
  check('OpenRouter reasoning_details: text + summary items surface, encrypted items carry nothing readable', reasoningText(details) === 'sum|txt', reasoningText(details))
  const both = await compat([
    sseChunk({ choices: [{ delta: { reasoning: 'same', reasoning_details: [{ type: 'reasoning.text', text: 'same' }] } }] }),
    sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ])
  check('a chunk carrying BOTH spellings emits the text once', reasoningText(both) === 'same', reasoningText(both))
}

section('§5 · error envelopes → code words → typed classes')
{
  const cls = (status: number, body: unknown) => {
    const fault = mapCompatHttpFailure(status, body)
    return { fault, typed: compatFaultToTypedError(fault) }
  }
  const gemini400 = cls(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } })
  check('Google: 400 + API_KEY_INVALID ⇒ api-API_KEY_INVALID, authentication_failed (the details reason outranks the status word)', gemini400.fault.code === 'api-API_KEY_INVALID' && gemini400.typed === 'authentication_failed' && gemini400.fault.status === 400, `${gemini400.fault.code} ${gemini400.typed}`)
  const gemini403 = cls(403, { error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } })
  check('Google: 403 PERMISSION_DENIED ⇒ authentication_failed', gemini403.fault.code === 'api-PERMISSION_DENIED' && gemini403.typed === 'authentication_failed')
  const gemini429 = cls(429, { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } })
  check('Google: 429 RESOURCE_EXHAUSTED ⇒ rate_limit, retryable', gemini429.typed === 'rate_limit' && gemini429.fault.retryable)
  const gemini503 = cls(503, { error: { code: 503, message: 'busy', status: 'UNAVAILABLE' } })
  check('Google: 503 UNAVAILABLE ⇒ server_error, retryable', gemini503.typed === 'server_error' && gemini503.fault.retryable)
  const or402 = cls(402, { error: { code: 402, message: 'Insufficient credits', metadata: { provider_code: 'x' } } })
  check('OpenRouter: numeric 402 ⇒ http-402, billing_error', or402.fault.code === 'http-402' && or402.typed === 'billing_error' && or402.fault.kind === 'http-error', `${or402.fault.code} ${or402.typed}`)
  const or401 = cls(401, { error: { code: 401, message: 'No auth credentials found' } })
  check('OpenRouter: numeric 401 ⇒ authentication_failed', or401.typed === 'authentication_failed')
  const or408 = cls(408, { error: { code: 408, message: 'timeout' } })
  check('OpenRouter: 408 ⇒ retryable server_error', or408.typed === 'server_error' && or408.fault.retryable)
  const ds402 = cls(402, { error: { message: 'Insufficient Balance', type: 'invalid_request_error', code: 'invalid_request_error' } })
  check("DeepSeek: documented 402 'Insufficient Balance' ⇒ billing_error even though the body word says invalid_request", ds402.typed === 'billing_error', `${ds402.fault.code} ${ds402.typed}`)
  const ds401 = cls(401, { error: { message: 'Authentication Fails', type: 'authentication_error', code: 'invalid_request_error' } })
  check('DeepSeek: documented 401 ⇒ authentication_failed', ds401.typed === 'authentication_failed')
  const ds422 = cls(422, { error: { message: 'Invalid Parameters', type: 'invalid_request_error' } })
  check('DeepSeek: 422 ⇒ invalid_request', ds422.typed === 'invalid_request')
  const hf401 = cls(401, { error: 'Invalid username or password.' })
  check('Hugging Face: string error 401 ⇒ authentication_failed, message preserved', hf401.typed === 'authentication_failed' && hf401.fault.message === 'Invalid username or password.')
  const hf402 = cls(402, { error: 'You have exceeded your monthly included credits for Inference Providers.' })
  check('Hugging Face: string error 402 ⇒ billing_error', hf402.typed === 'billing_error')
  const ms401 = cls(401, { error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } })
  check('Moonshot: 401 + type word ⇒ api-invalid_authentication_error, authentication_failed', ms401.fault.code === 'api-invalid_authentication_error' && ms401.typed === 'authentication_failed')
  const nf404 = cls(404, { error: { message: 'model not found', type: 'invalid_request_error', code: 'model_not_found' } })
  check('404 model_not_found ⇒ invalid_request (a bad request, not a server fault)', nf404.typed === 'invalid_request')
  const legacy = compatFaultToTypedError({ kind: 'http-error', code: 'http-402' })
  check('a status-less legacy http-402 spelling still reads billing_error', legacy === 'billing_error')

  const z = (status: number, code: number) => compatFaultToTypedError(mapZaiHttpFailure(status, { error: { code, message: 'm' } }))
  check('Z.AI numeric table: 1001 auth · 1113 billing · 1302 rate · 1211 invalid', z(401, 1001) === 'authentication_failed' && z(200, 1113) === 'billing_error' && z(429, 1302) === 'rate_limit' && z(400, 1211) === 'invalid_request')

  const oa = (status: number, body: unknown) => openaiFaultToTypedError(mapOpenaiHttpFailure(status, body))
  check('OpenAI lane: 404 model_not_found ⇒ invalid_request', oa(404, { error: { message: 'nope', type: 'invalid_request_error', code: 'model_not_found' } }) === 'invalid_request')
  check('OpenAI lane: 401 invalid_api_key ⇒ authentication_failed · 402 ⇒ billing_error · 403 ⇒ authentication_failed', oa(401, { error: { message: 'bad', code: 'invalid_api_key' } }) === 'authentication_failed' && oa(402, { error: { message: 'pay' } }) === 'billing_error' && oa(403, { error: { message: 'no' } }) === 'authentication_failed')

  // The class-aware refusal text: provider-named, remedy carried.
  const profile = { providerLabel: 'DeepSeek', credentialHint: 'hint', authRemedy: 'set a valid DEEPSEEK_API_KEY', billingRemedy: 'top up the DeepSeek balance' }
  const authText = compatTerminalFaultText(profile, ds401.fault, 'authentication_failed')
  check('auth refusal text names the provider, the wire words, and the exact remedy', authText.includes('DeepSeek rejected the credential') && authText.includes('Authentication Fails') && authText.includes('set a valid DEEPSEEK_API_KEY'), authText)
  const billText = compatTerminalFaultText(profile, ds402.fault, 'billing_error')
  check('billing refusal text names the provider and the top-up remedy', billText.includes('DeepSeek reports the account out of credit') && billText.includes('top up the DeepSeek balance'), billText)
  const recoveredText = compatTerminalFaultText(profile, ds401.fault, 'authentication_failed', { recovery: 'retried' })
  check('after a forced refresh + retry the text says so', recoveredText.includes('refreshed and the call retried once'))
  const attemptedText = compatTerminalFaultText(profile, ds401.fault, 'authentication_failed', { recovery: 'no-new-credential' })
  check('after a refresh that produced nothing the text says THAT — never a claimed retry', attemptedText.includes('refresh was attempted') && !attemptedText.includes('retried once'))
  const plainText = compatTerminalFaultText(profile, { code: 'idle-timeout', message: 'no bytes for 90000ms' }, 'server_error')
  check("other classes keep the 'stream failed' spelling", plainText.includes('DeepSeek stream failed (idle-timeout)'))

  // OpenRouter's mid-stream error chunk: a fault, never a settled finish.
  const mid = await compat([
    sseChunk({ id: 'x', object: 'chat.completion.chunk', error: { code: 402, message: 'Insufficient credits', metadata: {} }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }),
  ])
  const midFault = mid.find(e => e.type === 'stream-fault')
  check("mid-stream error + finish_reason 'error' ⇒ ONE typed fault with the numeric status, NO finish event", midFault?.type === 'stream-fault' && midFault.fault.status === 402 && compatFaultToTypedError(midFault.fault) === 'billing_error' && !mid.some(e => e.type === 'finish') && !mid.some(e => e.type === 'stream-fault' && e.fault.kind === 'truncated-stream'), JSON.stringify(mid))
  const bareError = await compat([sseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'error' }] })])
  check("a bare finish_reason 'error' (no error object) is a provider-termination fault", bareError.some(e => e.type === 'stream-fault' && e.fault.code === 'finish:error') && !bareError.some(e => e.type === 'finish'))
}

section('§6 · assistant null content replays as empty text unless tool_calls ride')
{
  const history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thought', signature: '' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'f', input: { x: 1 } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'said', citations: null }] },
  ] as unknown as readonly MessageParam[]
  const mapped = mapMessagesToZai('sys', history)
  const assistants = mapped.filter(m => m.role === 'assistant')
  check("thinking-only turn ⇒ content '' (never null without tool_calls)", assistants[0]?.content === '' && !('tool_calls' in assistants[0]!))
  check('tool-call turn keeps the documented null beside tool_calls', assistants[1]?.content === null && assistants[1]?.tool_calls?.length === 1)
  check('text turn carries its text', assistants[2]?.content === 'said')
}

console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
