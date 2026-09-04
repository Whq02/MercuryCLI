#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { z } from 'zod'
import type { AssistantMessage, Message, StreamEvent } from '../../src/types/message.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' native GPT runtime proof (fake Responses wire)')
console.log('============================================================')

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'OPENAI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
]) {
  savedEnv[key] = process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(joinPath(tmpdir(), 'prove-apex-home-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'

const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.js')
const { __resetOpenaiCatalogueForTest } = await import(
  '../../src/services/providers/openai/openaiCatalogue.js'
)
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Fast responses with lighter reasoning' },
        { effort: 'medium', description: 'Balances speed and reasoning depth' },
        { effort: 'high', description: 'Greater reasoning depth' },
        { effort: 'xhigh', description: 'Extra high reasoning depth' },
        { effort: 'max', description: 'Maximum reasoning depth' },
        { effort: 'ultra', description: 'Ultra reasoning' },
      ],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      supported_reasoning_levels: ['high'],
      visibility: 'list',
      priority: 7,
    },
    {
      slug: 'codex-auto-review',
      display_name: 'Codex Auto Review',
      supported_reasoning_levels: ['low'],
      visibility: 'hide',
      priority: 43,
    },
  ],
}

const realFetch = globalThis.fetch
let lastResponsesBody: Record<string, unknown> | undefined
let lastModelsUrl: string | undefined
let responsesCalls = 0
let makeResponses: () => Response = () => sseResponse([])
function patchWire(models: unknown = MODELS_BODY): void {
  responsesCalls = 0
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url)
    if (u.includes('/models')) {
      lastModelsUrl = u
      return new Response(JSON.stringify(models), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (u.endsWith('/responses')) {
      responsesCalls++
      lastResponsesBody = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      return makeResponses()
    }
    throw new Error(`unexpected fixture URL: ${u}`)
  }) as unknown as typeof fetch
}
function restoreWire(): void {
  globalThis.fetch = realFetch
}

const echoTool = {
  name: 'EchoTool',
  inputSchema: z.object({ text: z.string() }),
  prompt: async () => 'echoes text',
  isReadOnly: () => true,
} as never

const callParams = (model: string, effort = 'high') => ({
  messages: [
    { type: 'user', message: { role: 'user', content: 'add 2+2' }, uuid: 'u1', timestamp: 't' },
  ] as unknown as Message[],
  systemPrompt: ['You are a specialist.'] as unknown as Parameters<typeof openaiCallModel>[0]['systemPrompt'],
  thinkingConfig: { type: 'enabled', budgetTokens: 4096 } as const,
  tools: [echoTool] as unknown as Parameters<typeof openaiCallModel>[0]['tools'],
  signal: new AbortController().signal,
  options: {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model,
    isNonInteractiveSession: true,
    querySource: 'agent:builtin:test' as never,
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    effortValue: effort as never,
  } as unknown as Parameters<typeof openaiCallModel>[0]['options'],
})

async function collect(model: string, effort?: string): Promise<Array<StreamEvent | AssistantMessage>> {
  const out: Array<StreamEvent | AssistantMessage> = []
  for await (const item of openaiCallModel(callParams(model, effort))) {
    out.push(item as StreamEvent | AssistantMessage)
  }
  return out
}
const isApiErrorAssistant = (m: unknown): boolean => {
  const a = m as AssistantMessage
  return a?.type === 'assistant' && JSON.stringify(a.message?.content ?? '').includes('API Error')
}

const HAPPY_STREAM = [
  sse({ type: 'response.created', response: { id: 'resp_apex_1' } }),
  sse({ type: 'response.reasoning_summary_text.delta', delta: 'thinking ' }),
  sse({ type: 'response.reasoning_summary_text.delta', delta: 'hard' }),
  sse({
    type: 'response.output_item.done',
    item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'thinking hard' }], encrypted_content: 'ENC_BLOB' },
  }),
  sse({ type: 'response.output_text.delta', delta: 'The answer' }),
  sse({ type: 'response.output_text.delta', delta: ' is 4.' }),
  sse({
    type: 'response.output_item.done',
    item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 4.' }] },
  }),
  sse({
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: 'call_1', name: 'EchoTool', arguments: '{"text":"four"}', id: 'fc_1' },
  }),
  sse({
    type: 'response.completed',
    response: {
      id: 'resp_apex_1',
      usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 50 } },
    },
  }),
]

section('1 · the yield contract + the turn record')
{
  process.env.OPENAI_API_KEY = 'sk-apex-proof-fake'
  __resetOpenaiCatalogueForTest()
  patchWire()
  makeResponses = () => sseResponse(HAPPY_STREAM)
  const yielded = await collect('gpt-5.6-sol')
  restoreWire()

  const streamEvents = yielded.filter(y => y.type === 'stream_event') as StreamEvent[]
  const assistants = yielded.filter(y => y.type === 'assistant') as AssistantMessage[]
  const eventTypes = streamEvents.map(e => (e.event as { type: string }).type)

  check('first stream event is message_start', eventTypes[0] === 'message_start', eventTypes.join(','))
  check(
    'thinking + text deltas stream live',
    eventTypes.filter(t => t === 'content_block_delta').length >= 4,
  )
  check(
    'stream closes with message_delta then message_stop',
    eventTypes.at(-2) === 'message_delta' && eventTypes.at(-1) === 'message_stop',
    eventTypes.slice(-3).join(','),
  )
  check('THREE per-block AssistantMessages (thinking · text · tool_use)', assistants.length === 3, String(assistants.length))
  const blockTypes = assistants.map(a => (a.message.content[0] as { type: string })?.type)
  check('block order thinking → text → tool_use', blockTypes.join(',') === 'thinking,text,tool_use', blockTypes.join(','))
  const thinking = assistants[0]?.message.content[0] as { thinking?: string }
  check('thinking accumulated from reasoning-summary deltas', thinking?.thinking === 'thinking hard')
  const toolBlock = assistants[2]?.message.content[0] as { id?: string; name?: string; input?: { text?: string } }
  check(
    'tool_use settled EXACTLY ONCE under the PROVIDER call id',
    toolBlock?.id === 'call_1' && toolBlock?.name === 'EchoTool' && toolBlock?.input?.text === 'four',
    JSON.stringify(toolBlock),
  )
  const last = assistants.at(-1)!
  check(
    'final usage written back onto the LAST message in the CANONICAL disjoint spelling',
    last.message.usage?.input_tokens === 70 &&
      last.message.usage?.output_tokens === 30 &&
      last.message.usage?.cache_read_input_tokens === 50,
    JSON.stringify(last.message.usage),
  )
  check("final stop_reason 'tool_use'", last.message.stop_reason === 'tool_use')
  const record = last.apexProviderTurn
  check(
    'apexProviderTurn: provider + responseId on the LAST message',
    record?.provider === 'openai' && record.responseId === 'resp_apex_1',
    JSON.stringify(record)?.slice(0, 120),
  )
  const recordKinds = (record?.items ?? []).map(i => (i as { type?: string }).type)
  check(
    'turn-record items: reasoning → message → function_call (replay order)',
    JSON.stringify(recordKinds) === JSON.stringify(['reasoning', 'message', 'function_call']),
    recordKinds.join(','),
  )
  check(
    'encrypted reasoning content persisted for stateless replay',
    JSON.stringify(record?.items).includes('ENC_BLOB'),
  )
  check('earlier minted messages carry NO record (one per turn)', assistants[0]!.apexProviderTurn === undefined)

  const body = lastResponsesBody as {
    model?: string
    store?: boolean
    stream?: boolean
    include?: string[]
    instructions?: string
    tools?: Array<{ type?: string; name?: string }>
    tool_choice?: string
    parallel_tool_calls?: boolean
    reasoning?: { effort?: string; summary?: string }
    prompt_cache_key?: string
    max_output_tokens?: number
  }
  check('request model is the exact qualified id', body?.model === 'gpt-5.6-sol')
  check('stateless replay: store:false + encrypted include', body?.store === false && JSON.stringify(body?.include) === JSON.stringify(['reasoning.encrypted_content']))
  check('flat function tools through the one schema truth', body?.tools?.[0]?.type === 'function' && body?.tools?.[0]?.name === 'EchoTool')
  check("tool_choice 'auto' + parallel tool calls", body?.tool_choice === 'auto' && body?.parallel_tool_calls === true)
  check("live-resolved reasoning effort 'high' + summary auto", body?.reasoning?.effort === 'high' && body?.reasoning?.summary === 'auto')
  check('instructions carry the system prompt', body?.instructions === 'You are a specialist.')
  check('mercury prompt_cache_key rides as the STABLE domain digest', typeof body?.prompt_cache_key === 'string' && body.prompt_cache_key.startsWith('mercury-domain:'))
  check('max_output_tokens is NOT sent (live-proved unsupported)', body?.max_output_tokens === undefined)
  check('the key never rides the body', !JSON.stringify(body).includes('sk-apex-proof-fake'))
  check(
    '/models carries the REQUIRED client_version query param',
    typeof lastModelsUrl === 'string' && lastModelsUrl.includes('client_version='),
    lastModelsUrl,
  )
}

section('2 · honest refusals + the §10 effort-adjustment note')
{
  delete process.env.OPENAI_API_KEY
  const noAccount = await collect('gpt-5.6-sol')
  check(
    'no-account: ONE API-error steering to /logins (never an env flag)',
    noAccount.length === 1 && isApiErrorAssistant(noAccount[0]) && JSON.stringify(noAccount[0]).includes('/logins'),
  )

  process.env.OPENAI_API_KEY = 'sk-apex-proof-fake'
  __resetOpenaiCatalogueForTest()
  patchWire()
  makeResponses = () => sseResponse(HAPPY_STREAM)
  const servedPrevGen = await collect('gpt-5.5')
  check(
    'live-served gpt-5.5 dispatches (one wire call, the exact id, no refusal)',
    responsesCalls === 1 &&
      lastResponsesBody?.model === 'gpt-5.5' &&
      servedPrevGen.some(m => m.type === 'assistant') &&
      !servedPrevGen.some(isApiErrorAssistant),
    JSON.stringify(servedPrevGen[0]).slice(0, 160),
  )

  __resetOpenaiCatalogueForTest()
  patchWire({
    data: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        supported_reasoning_levels: ['low', 'medium', 'high'],
        default_reasoning_level: 'medium',
      },
    ],
  })
  makeResponses = () => sseResponse(HAPPY_STREAM)
  const adjusted = await collect('gpt-5.6-sol', 'xhigh')
  const adjustedBody = lastResponsesBody as { reasoning?: { effort?: string } }
  check("unsupported 'xhigh' adjusts to the NEAREST supported 'high' on the wire", adjustedBody?.reasoning?.effort === 'high')
  const stampOf = (items: Array<StreamEvent | AssistantMessage>): AssistantMessage['effortAdjusted'] | undefined =>
    items.map(m => (m as AssistantMessage).effortAdjusted).find(s => s !== undefined)
  const xhighStamp = stampOf(adjusted)
  check(
    'the adjustment is RECEIPTED — the settled message carries the typed stamp (asked xhigh, sent high, the row named) and the reply text carries no note',
    xhighStamp !== undefined && xhighStamp.model === 'gpt-5.6-sol' && xhighStamp.asked === 'xhigh' && xhighStamp.sent === 'high' && xhighStamp.name.length > 0 && !JSON.stringify(adjusted).includes('requested reasoning effort'),
    JSON.stringify(xhighStamp),
  )

  __resetOpenaiCatalogueForTest()
  patchWire({
    data: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
        default_reasoning_level: 'medium',
      },
    ],
  })
  makeResponses = () => sseResponse(HAPPY_STREAM)
  const maxAdjusted = await collect('gpt-5.6-sol', 'max')
  const maxBody = lastResponsesBody as { reasoning?: { effort?: string } }
  check("unsupported 'max' adjusts to the deepest supported 'xhigh' on the wire", maxBody?.reasoning?.effort === 'xhigh')
  const maxStamp = stampOf(maxAdjusted)
  check(
    'the max→xhigh adjustment is RECEIPTED on the settled message (asked max, sent xhigh)',
    maxStamp !== undefined && maxStamp.asked === 'max' && maxStamp.sent === 'xhigh',
    JSON.stringify(maxStamp),
  )

  __resetOpenaiCatalogueForTest()
  patchWire({
    data: [
      {
        slug: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        supported_reasoning_levels: ['low', 'medium', 'high'],
        default_reasoning_level: 'medium',
      },
    ],
  })
  makeResponses = () => sseResponse(HAPPY_STREAM)
  await collect('gpt-5.6-sol', '7')
  restoreWire()
  const unrankableBody = lastResponsesBody as { reasoning?: { effort?: string } }
  check("an unrankable request falls to the live default 'medium'", unrankableBody?.reasoning?.effort === 'medium')

  __resetOpenaiCatalogueForTest()
  patchWire()
  makeResponses = () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 })
  const retried = await collect('gpt-5.6-sol')
  restoreWire()
  check('retryable pre-content fault: exactly two attempts (bounded)', responsesCalls === 2, String(responsesCalls))
  check('…then ONE API-error assistant message', retried.length === 1 && isApiErrorAssistant(retried[0]))
}

section('3 · stateless replay round-trip (the transcript is canonical)')
{
  __resetOpenaiCatalogueForTest()
  patchWire()
  makeResponses = () => sseResponse(HAPPY_STREAM)
  const first = await collect('gpt-5.6-sol')
  const firstAssistants = first.filter(y => y.type === 'assistant') as AssistantMessage[]
  const followUp = callParams('gpt-5.6-sol')
  followUp.messages = [
    ...followUp.messages,
    ...firstAssistants,
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'four' }],
      },
      uuid: 'u2',
      timestamp: 't2',
    } as unknown as Message,
    { type: 'user', message: { role: 'user', content: 'now 3+3' }, uuid: 'u3', timestamp: 't3' } as unknown as Message,
  ]
  makeResponses = () => sseResponse(HAPPY_STREAM)
  const followUpYields: unknown[] = []
  for await (const y of openaiCallModel(followUp)) {
    followUpYields.push(y)
  }
  restoreWire()
  check(
    'a RECORDED settled turn never fires the reconstruction receipt (per-TURN accounting — its text rows are not "recordless")',
    !JSON.stringify(followUpYields).includes('reconstructed continuation'),
  )
  const body = lastResponsesBody as { input?: Array<Record<string, unknown>> }
  const kinds = (body?.input ?? []).map(i =>
    i.type === 'message' ? `message:${String(i.role)}` : String(i.type),
  )
  check(
    'the follow-up request replays the RECORDED turn verbatim in position',
    JSON.stringify(kinds) ===
      JSON.stringify(['message:user', 'reasoning', 'message:assistant', 'function_call', 'function_call_output', 'message:user']),
    kinds.join(','),
  )
  check(
    'encrypted reasoning content replays on the wire',
    JSON.stringify(body?.input).includes('ENC_BLOB'),
  )
  const output = (body?.input ?? []).find(i => i.type === 'function_call_output')
  check('the tool answer correlates by the provider call id', output?.call_id === 'call_1')
}

section('3b · reconstruction classes + the cross-model replay guard')
{
  const RECONSTRUCTION_MARK = 'reconstructed continuation'
  const gptAssistantRow = (opts: {
    id: string
    uuid: string
    model?: string
    stopReason?: string | null
    record?: unknown
  }): Message =>
    ({
      type: 'assistant',
      message: {
        id: opts.id,
        role: 'assistant',
        model: opts.model ?? 'gpt-5.6-sol',
        content: [{ type: 'text', text: 'earlier partial answer' }],
        stop_reason: opts.stopReason ?? null,
        stop_sequence: null,
        usage: {},
      },
      ...(opts.record !== undefined ? { apexProviderTurn: opts.record } : {}),
      uuid: opts.uuid,
      timestamp: 't',
    }) as unknown as Message

  __resetOpenaiCatalogueForTest()
  patchWire()
  makeResponses = () => sseResponse(HAPPY_STREAM)
  const interrupted = callParams('gpt-5.6-sol')
  interrupted.messages = [
    ...interrupted.messages,
    gptAssistantRow({ id: 'turn_int', uuid: 'ai1', stopReason: null }),
    { type: 'user', message: { role: 'user', content: 'continue' }, uuid: 'ui1', timestamp: 't' } as unknown as Message,
  ]
  const afterInterrupt: unknown[] = []
  for await (const y of openaiCallModel(interrupted)) afterInterrupt.push(y)
  check(
    'an interrupted recordless partial derives with NO reconstruction note',
    !JSON.stringify(afterInterrupt).includes(RECONSTRUCTION_MARK),
  )
  const interruptedInput = (lastResponsesBody as { input?: Array<Record<string, unknown>> })?.input ?? []
  check(
    "…and its content still replays as a derived assistant message",
    interruptedInput.some(i => i.type === 'message' && i.role === 'assistant'),
  )

  const preCapture = callParams('gpt-5.6-sol')
  preCapture.messages = [
    ...preCapture.messages,
    gptAssistantRow({ id: 'turn_old', uuid: 'ao1', stopReason: 'end_turn' }),
    { type: 'user', message: { role: 'user', content: 'continue' }, uuid: 'uo1', timestamp: 't' } as unknown as Message,
  ]
  const afterPreCapture: unknown[] = []
  for await (const y of openaiCallModel(preCapture)) afterPreCapture.push(y)
  check(
    'a settled pre-capture turn fires the reconstruction receipt',
    JSON.stringify(afterPreCapture).includes(RECONSTRUCTION_MARK),
  )

  const crossModel = callParams('gpt-5.6-sol')
  ;(crossModel.options as { agentId?: string }).agentId = 'xmodel-thread'
  crossModel.messages = [
    ...crossModel.messages,
    gptAssistantRow({
      id: 'turn_luna',
      uuid: 'al1',
      model: 'gpt-5.6-luna',
      stopReason: 'end_turn',
      record: {
        provider: 'openai',
        responseId: 'resp_luna_1',
        items: [
          { type: 'reasoning', id: 'rs_luna', summary: [], encrypted_content: 'LUNA_ENC_BLOB' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'earlier partial answer' }] },
        ],
      },
    }),
    { type: 'user', message: { role: 'user', content: 'continue' }, uuid: 'ul1', timestamp: 't' } as unknown as Message,
  ]
  const afterSwitch: unknown[] = []
  for await (const y of openaiCallModel(crossModel)) afterSwitch.push(y)
  restoreWire()
  const switchInput = JSON.stringify((lastResponsesBody as { input?: unknown })?.input ?? [])
  check(
    "another model's encrypted reasoning NEVER replays across a switch",
    !switchInput.includes('LUNA_ENC_BLOB'),
  )
  check(
    '…the switched turn derives from content instead',
    switchInput.includes('earlier partial answer'),
  )
  check(
    '…and a deliberate model switch is NOT a reconstruction event',
    !JSON.stringify(afterSwitch).includes(RECONSTRUCTION_MARK),
  )
}

restoreWire()
for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
__resetOpenaiCatalogueForTest()

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL CALLMODEL PROOFS PASS')
else console.log(`${failures} CALLMODEL PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
