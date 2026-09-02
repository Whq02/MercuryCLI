#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-family-switch-coherence.ts — switching the
//  main model across provider families mid-session keeps ONE coherent
//  session: the same history, the same tools, the same system prompt, each
//  re-shaped for the dialect it rides, and one usage vocabulary back.
//
//  One transcript — a GLM-served turn (unsigned thinking + text + a Bash
//  tool_use), its tool_result, a transport-refused call's note, and the
//  harness's correction — is replayed through the REAL provider-routed
//  transport on every dialect Mercury speaks, against one loopback fixture
//  that captures every request body:
//
//    anthropic ......... Messages API (system blocks · tool_use/tool_result
//                        blocks · input_schema tools)
//    openai ............ Responses (instructions · function_call /
//                        function_call_output · flat `parameters`)
//    chat-completions .. zai · moonshot (kimi-k3, preserved thinking) ·
//                        deepseek · local (system message · tool_calls /
//                        role:'tool' · nested function.parameters)
//
//  Pinned per dialect: the operator's system prompt reaches the wire in the
//  family's own spelling; the ONE tool schema rides in the three spellings
//  deep-equal; the tool_use/tool_result pair keeps its id on every wire;
//  foreign unsigned thinking never reaches the Anthropic wire, never
//  round-trips to the Responses wire, and rides the chat wire ONLY on the
//  documented preserved-thinking models; the harness's correction reaches
//  every wire verbatim; every family's settled usage is the same disjoint
//  envelope; every turn settles end_turn with no error.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-family-switch-coherence.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-coherence-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Body = Record<string, unknown>
const captured: Array<{ path: string; body: Body }> = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'settled' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 4, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
const chatSse = (): string =>
  [
    sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'settled' }, finish_reason: null }] }),
    sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }),
    'data: [DONE]\n\n',
  ].join('')
const responsesSse = (): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: 'settled' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'settled' }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } }),
  ].join('')
const OPENAI_MODELS_BODY = {
  models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 272_000, input_modalities: ['text'], supported_in_api: true }],
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
    } catch {
      body = {}
    }
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(path.startsWith('/openai/') ? OPENAI_MODELS_BODY : { object: 'list', data: [{ id: 'fixture-local', object: 'model', owned_by: 'fixture' }] }))
      return
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      captured.push({ path, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse())
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      captured.push({ path, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSse())
      return
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      captured.push({ path, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatSse())
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MOONSHOT_API_KEY: 'fixture-moonshot-key',
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  DEEPSEEK_API_KEY: 'fixture-deepseek-key',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
})

console.log('============================================================')
console.log(' family switch coherence — one history, every dialect')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { toolCallRefusalCorrection, toolCallRefusalNote } = await import('../../src/services/providers/toolCallGate.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type Message = import('../../src/types/message.ts').Message

const SYSTEM = 'fixture system prompt: answer tersely'
const BASH = BashTool.name
const refusal = { id: 'call_bad', name: BASH, argumentsRaw: '{}', code: 'schema' as const, reason: 'The Bash tool failed due to the following issue:\nThe required parameter `command` is missing' }
const glmTurn = createAssistantMessage({
  content: [
    { type: 'thinking', thinking: 'glm thought', signature: '' },
    { type: 'text', text: 'Running it.', citations: null },
    { type: 'tool_use', id: 'call_bash_1', name: BASH, input: { command: 'ls' } },
  ] as never,
})
glmTurn.message.model = 'glm-5.2'
glmTurn.message.stop_reason = 'tool_use'
const note = createAssistantMessage({ content: toolCallRefusalNote('zai', refusal) })
note.message.model = 'glm-5.2'
note.message.stop_reason = 'end_turn'
note.refusedToolCalls = [refusal]
const HISTORY: Message[] = [
  createUserMessage({ content: 'list the files' }),
  glmTurn,
  createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_bash_1', content: 'a.ts\nb.ts' }] as never }),
  note,
  createUserMessage({ content: toolCallRefusalCorrection([refusal]), isMeta: true }),
]

async function drive(model: string): Promise<{ body: Body | undefined; path: string | undefined; last: AssistantMessage | undefined; errors: AssistantMessage[]; threw: unknown }> {
  const before = captured.length
  const assistants: AssistantMessage[] = []
  let threw: unknown
  try {
    for await (const item of routedCallModel({
      messages: HISTORY as never,
      systemPrompt: [SYSTEM] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [BashTool] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model,
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'high',
      } as never,
    })) {
      if ((item as { type?: string }).type === 'assistant') assistants.push(item as AssistantMessage)
    }
  } catch (error) {
    threw = error
  }
  const request = captured.slice(before).at(-1)
  return {
    body: request?.body,
    path: request?.path,
    last: assistants.filter(a => !a.isApiErrorMessage).at(-1),
    errors: assistants.filter(a => a.isApiErrorMessage),
    threw,
  }
}

const text = (v: unknown): string => JSON.stringify(v) ?? ''
const CORRECTION_HEAD = 'One or more of your tool calls were refused by the harness'

const schemas: Record<string, unknown> = {}
const usage: Record<string, { input: number; cached: number }> = {}

section('anthropic · Messages API')
{
  const o = await drive('claude-sonnet-5')
  const body = o.body ?? {}
  check('the turn settled clean on the fixture', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn' && o.path === '/v1/messages', `threw=${String(o.threw)} errors=${o.errors.length} path=${o.path}`)
  check('the operator system prompt rides the system field', text(body.system).includes(SYSTEM))
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? []
  check('tools ride as input_schema (the Anthropic spelling)', tools[0]?.name === BASH && typeof tools[0]?.input_schema === 'object')
  schemas.anthropic = tools[0]?.input_schema
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  const toolUseMsg = messages.find(m => m.role === 'assistant' && text(m.content).includes('"call_bash_1"'))
  const toolResultMsg = messages.find(m => m.role === 'user' && text(m.content).includes('"tool_use_id":"call_bash_1"'))
  check('the tool_use block and its tool_result keep the id and the input', text(toolUseMsg?.content).includes('"input":{"command":"ls"}') && toolResultMsg !== undefined && messages.indexOf(toolResultMsg) === messages.indexOf(toolUseMsg!) + 1, `${messages.map(m => m.role).join(',')}`)
  check('no unsigned (foreign) thinking reaches the Anthropic wire', !text(body).includes('"signature":""') && !text(body).includes('glm thought'))
  check('the harness correction reaches the wire', text(body).includes(CORRECTION_HEAD))
  usage.anthropic = { input: o.last?.message.usage?.input_tokens ?? -1, cached: o.last?.message.usage?.cache_read_input_tokens ?? -1 }
}

section('openai · Responses')
{
  const o = await drive('gpt-5.6-sol')
  const body = o.body ?? {}
  check('the turn settled clean on the fixture', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn' && o.path?.endsWith('/responses') === true, `threw=${String(o.threw)} errors=${o.errors.length} path=${o.path}`)
  check('the operator system prompt rides the instructions string', typeof body.instructions === 'string' && body.instructions.includes(SYSTEM))
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? []
  check('tools ride FLAT as function/parameters (the Responses spelling)', tools[0]?.type === 'function' && tools[0]?.name === BASH && typeof tools[0]?.parameters === 'object')
  schemas.openai = tools[0]?.parameters
  const input = (body.input as Array<Record<string, unknown>> | undefined) ?? []
  const call = input.findIndex(i => i.type === 'function_call' && i.call_id === 'call_bash_1')
  const output = input.findIndex(i => i.type === 'function_call_output' && i.call_id === 'call_bash_1')
  check('function_call carries the arguments JSON and its function_call_output answers it in order', call !== -1 && input[call]?.arguments === '{"command":"ls"}' && output === call + 1 && text(input[output]?.output).includes('a.ts'), input.map(i => `${i.type}:${i.call_id ?? ''}`).join(','))
  check('a foreign turn derives from content: NO reasoning item replays cross-provider', !input.some(i => i.type === 'reasoning') && !text(body).includes('glm thought'))
  check('the harness correction reaches the wire as a user item', input.some(i => i.type === 'message' && i.role === 'user' && text(i.content).includes(CORRECTION_HEAD)))
  check('stateless replay: store:false with the encrypted-reasoning include', body.store === false && text(body.include).includes('reasoning.encrypted_content'))
  usage.openai = { input: o.last?.message.usage?.input_tokens ?? -1, cached: o.last?.message.usage?.cache_read_input_tokens ?? -1 }
}

for (const { lane, model, preservesThinking } of [
  { lane: 'zai', model: 'glm-5.2', preservesThinking: false },
  { lane: 'moonshot (kimi-k3, preserved thinking)', model: 'kimi-k3', preservesThinking: true },
  { lane: 'deepseek', model: 'deepseek-v4-pro', preservesThinking: false },
  { lane: 'local', model: 'local/fixture-local', preservesThinking: false },
]) {
  section(`${lane} · chat-completions`)
  const o = await drive(model)
  const body = o.body ?? {}
  check('the turn settled clean on the fixture', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn' && o.path?.endsWith('/chat/completions') === true, `threw=${String(o.threw)} errors=${o.errors.length} path=${o.path}`)
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  check('the operator system prompt rides the leading system message', messages[0]?.role === 'system' && String(messages[0]?.content).includes(SYSTEM))
  const tools = (body.tools as Array<Record<string, unknown>> | undefined) ?? []
  const fn = tools[0]?.function as Record<string, unknown> | undefined
  check('tools ride NESTED as function.parameters (the chat-completions spelling)', tools[0]?.type === 'function' && fn?.name === BASH && typeof fn?.parameters === 'object')
  schemas[lane] = fn?.parameters
  const callIdx = messages.findIndex(m => m.role === 'assistant' && text(m.tool_calls).includes('"call_bash_1"'))
  const toolIdx = messages.findIndex(m => m.role === 'tool' && m.tool_call_id === 'call_bash_1')
  const callMsg = messages[callIdx]
  const tc = ((callMsg?.tool_calls as Array<Record<string, unknown>> | undefined) ?? [])[0]
  check('assistant.tool_calls carries the id + arguments JSON; the role:tool answer follows it', callIdx !== -1 && (tc?.function as Record<string, unknown> | undefined)?.arguments === '{"command":"ls"}' && toolIdx === callIdx + 1 && String(messages[toolIdx]?.content).includes('a.ts'), messages.map(m => m.role).join(','))
  if (preservesThinking) {
    check('the documented preserved-thinking model gets the historical reasoning back as reasoning_content', callMsg?.reasoning_content === 'glm thought')
  } else {
    check('reasoning never rides this wire (no reasoning_content key anywhere)', !messages.some(m => 'reasoning_content' in m) && !text(body).includes('glm thought'))
  }
  check('the harness correction reaches the wire verbatim as a user message', messages.some(m => m.role === 'user' && String(m.content).includes(CORRECTION_HEAD)))
  check("a call-less assistant message never carries null content", messages.filter(m => m.role === 'assistant' && !('tool_calls' in m)).every(m => typeof m.content === 'string'))
  usage[lane] = { input: o.last?.message.usage?.input_tokens ?? -1, cached: o.last?.message.usage?.cache_read_input_tokens ?? -1 }
}

section('cross-family coherence')
{
  const spellings = Object.entries(schemas)
  const reference = text(spellings[0]?.[1])
  check(`the ONE tool schema is deep-equal across all ${spellings.length} dialect spellings`, spellings.length === 6 && spellings.every(([, s]) => text(s) === reference), spellings.map(([k, s]) => `${k}:${text(s).length}`).join(' '))
  const envelopes = Object.entries(usage)
  check('every family settles the same disjoint usage envelope (6 uncached beside 4 cached)', envelopes.length === 6 && envelopes.every(([, u]) => u.input === 6 && u.cached === 4), envelopes.map(([k, u]) => `${k}:${u.input}/${u.cached}`).join(' '))
}

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
