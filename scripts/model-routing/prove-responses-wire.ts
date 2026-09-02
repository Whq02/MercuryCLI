#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-responses-wire.ts
//  PROOF.
//  Entirely fixture-driven, pure — no network, no billables:
//
//    1. The SSE fold: documented events → typed events; text/reasoning/refusal
//       deltas stream; tool calls settle EXACTLY ONCE from item.done (deltas
//       are progress-only); malformed calls are typed, never half-calls;
//       unknown item types are RECORDED; usage rides the terminal event; a
//       stream without a terminal event is a typed truncation.
//    2. ORDERED REPLAY ITEMS (decision #4): the finish event carries the
//       settled output sequence in exact arrival order — reasoning (with
//       encrypted content) · well-formed function calls · assistant message
//       items; malformed calls are EXCLUDED (the call/output pairing law).
//    3. The request bridge: stateless-replay shape (store:false + encrypted
//       include), FLAT function tools, instructions, prompt_cache_key; a
//       recorded turn replays its items VERBATIM (one truth per turn — its
//       content blocks are NOT re-derived); recordless turns derive from
//       blocks; tool_use ⇄ function_call/function_call_output correlation;
//       defensive decode (junk records fall back to derivation).
//    4. Error mapping: 429 ⇒ usage-limit (retryable) · body-coded API errors
//       · 5xx retryable · plain HTTP.
//
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-responses-wire.ts
// ============================================================================
import {
  mapOpenaiHttpFailure,
  ResponsesStreamFold,
  type OpenaiStreamEvent,
} from '../../src/services/providers/openai/openaiWire.js'
import {
  buildOpenaiResponsesRequest,
  decodeOpenaiTurnRecord,
  mapMessagesToOpenaiInput,
  mapToolsToOpenai,
  type BridgeMessage,
} from '../../src/services/providers/openai/responsesBridge.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Responses wire + request bridge proof (pure)')
console.log('============================================================')

function foldAll(payloads: unknown[]): OpenaiStreamEvent[] {
  const fold = new ResponsesStreamFold()
  const out: OpenaiStreamEvent[] = []
  for (const p of payloads) out.push(...fold.fold(p))
  return out
}

//
section('1 · the SSE fold — typed events, exactly-once settlement')
//
{
  const events = foldAll([
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.in_progress', response: {} }, // progress-only
    { type: 'response.output_item.added', item: { type: 'reasoning' } }, // progress-only
    { type: 'response.reasoning_summary_text.delta', delta: 'thinking ' },
    { type: 'response.reasoning_summary_text.delta', delta: 'hard' },
    {
      type: 'response.output_item.done',
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'thinking hard' }],
        encrypted_content: 'ENC_BLOB',
      },
    },
    { type: 'response.output_text.delta', delta: 'The answer' },
    { type: 'response.output_text.delta', delta: ' is 4.' },
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'The answer is 4.' }],
      },
    },
    { type: 'response.function_call_arguments.delta', delta: '{"te' }, // progress-only
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_1', name: 'EchoTool', arguments: '{"text":"four"}', id: 'fc_1' },
    },
    {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'call_2', name: 'BadTool', arguments: '{"broken' },
    },
    { type: 'response.output_item.done', item: { type: 'image_generation_call', id: 'ig_1' } },
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          input_tokens_details: { cached_tokens: 50 },
          output_tokens_details: { reasoning_tokens: 10 },
        },
      },
    },
  ])
  check("first event is response-id 'resp_1'", events[0]?.type === 'response-id' && events[0].id === 'resp_1')
  const reasoningDeltas = events.filter(e => e.type === 'reasoning-delta')
  const textDeltas = events.filter(e => e.type === 'text-delta')
  check('reasoning deltas stream (2)', reasoningDeltas.length === 2)
  check('text deltas stream (2)', textDeltas.length === 2)
  const usage = events.find(e => e.type === 'usage')
  check(
    'usage rides the terminal event (in/out/cached/reasoning)',
    usage?.type === 'usage' &&
      usage.usage.inputTokens === 120 &&
      usage.usage.outputTokens === 30 &&
      usage.usage.cachedInputTokens === 50 &&
      usage.usage.reasoningOutputTokens === 10,
  )
  const finish = events.find(e => e.type === 'finish')
  check('exactly one finish', events.filter(e => e.type === 'finish').length === 1)
  if (finish?.type !== 'finish') throw new Error('no finish event')
  check("reason 'tool_calls' (calls settled)", finish.reason === 'tool_calls')
  check(
    'TWO settled calls: one well-formed (parsed), one malformed (typed, never silent)',
    finish.toolCalls.length === 2 &&
      finish.toolCalls[0]!.malformed === false &&
      (finish.toolCalls[0]!.arguments as { text?: string }).text === 'four' &&
      finish.toolCalls[1]!.malformed === true,
  )
  check('final text settles from the message item', finish.finalText === 'The answer is 4.')
  check('unknown item types RECORDED', JSON.stringify(finish.unknownItemTypes) === JSON.stringify(['image_generation_call']))
  check(
    'reasoning item settles with summary + encrypted content',
    finish.reasoningItems.length === 1 && finish.reasoningItems[0]!.encrypted_content === 'ENC_BLOB',
  )
  // §2 — the ordered replay record.
  const kinds = finish.orderedItems.map(i => i.type)
  check(
    'orderedItems = reasoning → message → function_call (EXACT arrival order)',
    JSON.stringify(kinds) === JSON.stringify(['reasoning', 'message', 'function_call']),
    kinds.join(','),
  )
  check(
    'the malformed call is EXCLUDED from replay (call/output pairing law)',
    !finish.orderedItems.some(i => i.type === 'function_call' && i.call_id === 'call_2'),
  )
  check(
    'the well-formed call replays verbatim (raw arguments string + ids)',
    finish.orderedItems.some(
      i => i.type === 'function_call' && i.call_id === 'call_1' && i.arguments === '{"text":"four"}' && i.id === 'fc_1',
    ),
  )
}

//
section('1c · the NULL-OPTIONAL law (the field class)')
//
// OpenAI models serialize omitted optionals as `"param": null`; our zod
// `.optional()` schemas and `!== undefined` presence checks read null as
// PRESENT — a win32 GPT session errored on EVERY file mutation
// ("Error editing file" + ChangeSet's EXACTLY-ONE refusal). The wire strips
// TOP-LEVEL nulls at the decode seam; nested payload nulls survive; the raw
// replay string stays verbatim.
{
  const events = foldAll([
    { type: 'response.created', response: { id: 'resp_null' } },
    {
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: 'call_n',
        name: 'ChangeSet',
        arguments: '{"op":"apply","plan_id":null,"changes":[{"nested":null}],"note":null}',
        id: 'fc_n',
      },
    },
    { type: 'response.completed', response: { id: 'resp_null', usage: {} } },
  ])
  const finish = events.find(e => e.type === 'finish')
  if (finish?.type !== 'finish') throw new Error('no finish event (null-law leg)')
  const args = finish.toolCalls[0]!.arguments as Record<string, unknown>
  check('top-level null optionals are STRIPPED (plan_id, note absent)', !('plan_id' in args) && !('note' in args))
  check('real params survive', args.op === 'apply' && Array.isArray(args.changes))
  check(
    'nested nulls are payload, not presence — untouched',
    (args.changes as Array<Record<string, unknown>>)[0]!.nested === null,
  )
  check(
    'the raw replay string stays VERBATIM (stateless replay is byte-exact)',
    finish.toolCalls[0]!.argumentsRaw === '{"op":"apply","plan_id":null,"changes":[{"nested":null}],"note":null}',
  )
}

//
section('1b · terminal honesty — failed / incomplete / refusal')
//
{
  const failed = foldAll([
    {
      type: 'response.failed',
      response: { id: 'r', error: { code: 'server_error', message: 'boom' } },
    },
  ])
  const fault = failed.find(e => e.type === 'stream-fault')
  check(
    'response.failed → typed response-failed fault (retryable server_error)',
    fault?.type === 'stream-fault' && fault.fault.kind === 'response-failed' && fault.fault.retryable === true,
  )
  check('…and a finish still settles (honest partials)', failed.some(e => e.type === 'finish'))

  const incomplete = foldAll([
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ])
  const incFinish = incomplete.find(e => e.type === 'finish')
  check("incomplete(max_output_tokens) → finish reason 'max_output_tokens'", incFinish?.type === 'finish' && incFinish.reason === 'max_output_tokens')

  const refusal = foldAll([
    { type: 'response.refusal.delta', delta: 'I cannot ' },
    { type: 'response.refusal.delta', delta: 'help with that.' },
    {
      type: 'response.output_item.done',
      item: { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] },
    },
    { type: 'response.completed', response: {} },
  ])
  const refusalFinish = refusal.find(e => e.type === 'finish')
  check(
    'refusal deltas stream + refusal text settles (not a fault)',
    refusal.filter(e => e.type === 'refusal-delta').length === 2 &&
      refusalFinish?.type === 'finish' &&
      refusalFinish.refusalText === 'I cannot help with that.',
  )
  check(
    'refusal content never enters the replay record (no output_text to replay)',
    refusalFinish?.type === 'finish' && refusalFinish.orderedItems.length === 0,
  )

  const fold = new ResponsesStreamFold()
  fold.fold({ type: 'response.output_text.delta', delta: 'partial' })
  check('no terminal event ⇒ finished stays false (the client mints the truncation fault)', fold.finished === false)
}

//
section('2 · error mapping (documented table)')
//
{
  const limit = mapOpenaiHttpFailure(429, { error: { code: 'rate_limit_exceeded', message: 'slow down' } })
  check('429 ⇒ usage-limit, retryable, coded', limit.kind === 'usage-limit' && limit.retryable && limit.code === 'openai-rate_limit_exceeded')
  const auth = mapOpenaiHttpFailure(401, { error: { code: 'invalid_api_key', message: 'bad key' } })
  check('401 invalid_api_key ⇒ api-error, NOT retryable', auth.kind === 'api-error' && !auth.retryable)
  const server = mapOpenaiHttpFailure(500, { error: { type: 'server_error', message: 'oops' } })
  check('5xx ⇒ retryable', server.retryable === true)
  const plain = mapOpenaiHttpFailure(503, undefined)
  check('bare 5xx ⇒ http-error retryable', plain.kind === 'http-error' && plain.retryable && plain.code === 'http-503')
}

//
section('3 · the request bridge — stateless replay')
//
{
  const tools = mapToolsToOpenai([
    { name: 'EchoTool', description: 'echoes', input_schema: { type: 'object' } },
  ])
  check(
    'tools are FLAT function tools (name at top level)',
    tools[0]!.type === 'function' && tools[0]!.name === 'EchoTool' && !('function' in tools[0]!),
  )

  // A recorded GPT turn (three per-block rows sharing turnId, record on the
  // last) + its tool answer + a follow-up prompt.
  const record = decodeOpenaiTurnRecord({
    provider: 'openai',
    responseId: 'resp_1',
    items: [
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thinking hard' }], encrypted_content: 'ENC_BLOB' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 4.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'EchoTool', arguments: '{"text":"four"}', id: 'fc_1' },
      { type: 'not-a-thing', junk: true },
    ],
  })
  check('decode: known items decode, junk items DROP (never a crash)', record !== undefined && record.items.length === 3)
  check('decode: junk record ⇒ undefined (falls back to derivation)', decodeOpenaiTurnRecord({ provider: 'other' }) === undefined && decodeOpenaiTurnRecord('nope') === undefined)

  const messages: BridgeMessage[] = [
    { role: 'user', content: 'add 2+2' },
    { role: 'assistant', content: [{ type: 'text', text: 'thinking hard' }], turnId: 't1' },
    { role: 'assistant', content: [{ type: 'text', text: 'The answer is 4.' }], turnId: 't1' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'EchoTool', input: { text: 'four' } }],
      turnId: 't1',
      turnRecord: record!,
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'four' }] },
    { role: 'user', content: 'thanks — now 3+3' },
  ]
  const input = mapMessagesToOpenaiInput(messages)
  const kinds = input.map(i => (i.type === 'message' ? `message:${i.role}` : i.type))
  check(
    'recorded turn replays VERBATIM (record items, blocks NOT re-derived) in true positions',
    JSON.stringify(kinds) ===
      JSON.stringify(['message:user', 'reasoning', 'message:assistant', 'function_call', 'function_call_output', 'message:user']),
    kinds.join(','),
  )
  const reasoning = input.find(i => i.type === 'reasoning')
  check('encrypted content rides the replayed reasoning item', reasoning?.type === 'reasoning' && reasoning.encrypted_content === 'ENC_BLOB')
  const output = input.find(i => i.type === 'function_call_output')
  check('tool_result → function_call_output with the call_id correlation', output?.type === 'function_call_output' && output.call_id === 'call_1' && output.output === 'four')

  // Recordless (mixed-transcript) turns derive from blocks; thinking never
  // round-trips.
  const derived = mapMessagesToOpenaiInput([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private', signature: 'sig' },
        { type: 'text', text: 'hello!' },
        { type: 'tool_use', id: 'toolu_9', name: 'EchoTool', input: {} },
      ],
      turnId: 'anthropic_turn',
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok', is_error: true }] },
  ])
  const derivedKinds = derived.map(i => (i.type === 'message' ? `message:${i.role}` : i.type))
  check(
    'recordless turn derives: text + function_call (thinking NEVER round-trips)',
    JSON.stringify(derivedKinds) === JSON.stringify(['message:user', 'message:assistant', 'function_call', 'function_call_output']),
    derivedKinds.join(','),
  )
  check(
    'error tool_results carry the visible [tool error] prefix',
    derived.some(i => i.type === 'function_call_output' && i.output === '[tool error] ok'),
  )

  const request = buildOpenaiResponsesRequest({
    model: 'gpt-5.6-sol',
    instructions: 'You are a specialist.',
    messages,
    tools: [{ name: 'EchoTool', input_schema: {} }],
    reasoningEffort: 'high',
    promptCacheKey: 'mercury:s:main',
  })
  check('stateless replay: store:false + encrypted include', request.store === false && JSON.stringify(request.include) === JSON.stringify(['reasoning.encrypted_content']))
  check('stream:true · tool_choice auto · parallel tool calls', request.stream === true && request.tool_choice === 'auto' && request.parallel_tool_calls === true)
  check("reasoning {effort:'high', summary:'auto'}", request.reasoning?.effort === 'high' && request.reasoning.summary === 'auto')
  // Live-proved: max_output_tokens is UNSUPPORTED on the
  // subscription route — the request must never carry it.
  check('instructions + prompt_cache_key carried · NO max_output_tokens', request.instructions === 'You are a specialist.' && request.prompt_cache_key === 'mercury:s:main' && !('max_output_tokens' in request))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL RESPONSES-WIRE PROOFS PASS')
else console.log(`${failures} RESPONSES-WIRE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
