#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'

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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the openrouter native deferral proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_MODEL',
  'MERCURY_TOOL_SEARCH',
  'MERCURY_TOOL_DEFER',
  'MERCURY_TOOL_DEFER_PROBE',
  'MERCURY_WIRE_DUMP',
  'MERCURY_GPT_PRUNE_PRIOR_REASONING',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openrouter-native-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'openrouter-native-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const MODEL = 'openrouter/qwen/qwen3-coder'
const WIRE_MODEL = 'qwen/qwen3-coder'
const SEARCH_TYPE = 'openrouter:tool_search'
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

type Body = Record<string, unknown>
interface Capture {
  path: string
  headers: Record<string, string>
  body: Body
  raw: string
}
const captured: Capture[] = []

const ENCRYPTED = 'gAAAAABfixture-encrypted-reasoning-bytes-0001'
const USAGE_FRESH = { input_tokens: 4174, input_tokens_details: { cached_tokens: 0 }, output_tokens: 137, output_tokens_details: { reasoning_tokens: 64 }, total_tokens: 4311, cost: 0.0002635, server_tool_use_details: { tool_calls_requested: 1, tool_calls_executed: 1 } }
const USAGE_AFTER = { input_tokens: 4310, input_tokens_details: { cached_tokens: 4096 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 4319, cost: 0.00003 }

function responsesAdmissionSse(): string {
  const reasoning = { id: 'rs_fx_1', type: 'reasoning', status: 'completed', summary: [], encrypted_content: ENCRYPTED }
  const search = { id: 'st_fx_1', type: SEARCH_TYPE, status: 'completed', query: 'fetch url' }
  const note = { id: 'msg_fx_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Fetching the page now.', annotations: [] }] }
  const call = { id: 'fc_fx_1', type: 'function_call', status: 'completed', call_id: 'call_fx_webfetch_1', name: 'WebFetch', arguments: '{"url":"https://example.test/page","count":"3"}' }
  return [
    sse({ type: 'response.created', response: { id: 'gen-fx-1', model: WIRE_MODEL, status: 'in_progress' } }),
    sse({ type: 'response.output_item.added', item: { ...reasoning, status: 'in_progress', encrypted_content: undefined } }),
    sse({ type: 'response.output_item.done', item: reasoning }),
    sse({ type: 'response.output_item.added', item: { id: 'st_fx_1', type: SEARCH_TYPE, status: 'in_progress' } }),
    sse({ type: 'response.output_item.done', item: search }),
    sse({ type: 'response.output_item.added', item: { ...note, status: 'in_progress', content: [] } }),
    sse({ type: 'response.output_text.delta', item_id: 'msg_fx_1', delta: 'Fetching the page now.' }),
    sse({ type: 'response.output_item.done', item: note }),
    sse({ type: 'response.output_item.added', item: { ...call, status: 'in_progress', arguments: '' } }),
    sse({ type: 'response.function_call_arguments.delta', item_id: 'fc_fx_1', delta: call.arguments }),
    sse({ type: 'response.function_call_arguments.done', item_id: 'fc_fx_1', arguments: call.arguments }),
    sse({ type: 'response.output_item.done', item: call }),
    sse({ type: 'response.completed', response: { id: 'gen-fx-1', model: WIRE_MODEL, status: 'completed', output: [reasoning, search, note, call], usage: USAGE_FRESH } }),
    'data: [DONE]\n\n',
  ].join('')
}
function responsesTextSse(): string {
  const message = { id: 'msg_fx_2', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'fetched and done', annotations: [] }] }
  return [
    sse({ type: 'response.created', response: { id: 'gen-fx-2', model: WIRE_MODEL, status: 'in_progress' } }),
    sse({ type: 'response.output_item.added', item: { ...message, status: 'in_progress', content: [] } }),
    sse({ type: 'response.output_text.delta', item_id: 'msg_fx_2', delta: 'fetched and done' }),
    sse({ type: 'response.output_item.done', item: message }),
    sse({ type: 'response.completed', response: { id: 'gen-fx-2', model: WIRE_MODEL, status: 'completed', output: [message], usage: USAGE_AFTER } }),
    'data: [DONE]\n\n',
  ].join('')
}
function chatSse(): string {
  return [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', model: WIRE_MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', model: WIRE_MODEL, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 } }),
    'data: [DONE]\n\n',
  ].join('')
}

let responsesServed = 0
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const raw = Buffer.concat(chunks).toString('utf8')
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (path === '/api/v1/models') {
        res.end(JSON.stringify({ data: [{ id: WIRE_MODEL, name: 'Qwen3 Coder', context_length: 262144, supported_parameters: ['tools', 'reasoning'] }] }))
        return
      }
      res.end(JSON.stringify({ data: {} }))
      return
    }
    let body: Body = {}
    try {
      body = JSON.parse(raw) as Body
    } catch {
      body = {}
    }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k.toLowerCase()] = v
    captured.push({ path, headers, body, raw })
    if (path === '/api/v1/responses') {
      responsesServed++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesServed === 1 ? responsesAdmissionSse() : responsesTextSse())
      return
    }
    if (path === '/api/v1/chat/completions') {
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
process.env.MERCURY_OPENROUTER_API_BASE = `${base}/api/v1`
process.env.MERCURY_OPENROUTER_AUTH_BASE = `${base}/auth`
process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key'
process.env.MERCURY_MODEL = MODEL

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
updateSettingsForSource('userSettings', { openrouterRouting: {} })
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const wire = await import('../../src/services/providers/deferralWire.ts')
const { planToolPayload, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const deltas = await import('../../src/utils/attachments/deltas.ts')
const { getDeferredToolsDeltaAttachment } = deltas
const SERVER_SEARCH_ANNOUNCEMENT_HEAD: string = (deltas as { SERVER_SEARCH_ANNOUNCEMENT_HEAD?: string }).SERVER_SEARCH_ANNOUNCEMENT_HEAD ?? 'The following tools are available in this session but their definitions are not loaded yet.'
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

const serverSide = (form: string): boolean => {
  const fn = (wire as unknown as { deferralSearchIsServerSide?: (f: string) => boolean }).deferralSearchIsServerSide
  return typeof fn === 'function' ? fn(form) : false
}

function fixtureTool(name: string, opts: { defer?: boolean; mcp?: string; params?: string[] } = {}): Tool {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of opts.params ?? ['path']) shape[p] = z.string()
  const inputSchema = z.object(shape)
  return {
    name: opts.mcp ? `mcp__${opts.mcp}__${name}` : name,
    ...(opts.mcp ? { isMcp: true, mcpInfo: { serverName: opts.mcp, toolName: name } } : {}),
    ...(opts.defer ? { shouldDefer: true } : {}),
    prompt: async () => `${name}: a fixture tool with ${Object.keys(shape).join(', ')}`,
    description: async () => `${name} fixture`,
    inputSchema,
    ...(opts.mcp ? { inputJSONSchema: { type: 'object', properties: Object.fromEntries(Object.keys(shape).map(k => [k, { type: 'string' }])), required: Object.keys(shape) } } : {}),
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    userFacingName: () => name,
    call: async () => ({ data: 'fixture' }),
  } as unknown as Tool
}
const NON_DEFERRED = ['Read', 'Edit', 'Bash', 'Glob'].map(n => fixtureTool(n))
const DEFERRED_BUILTINS = ['WebFetch', 'NotebookEdit', 'Browser', 'Blender', 'Debug'].map(n => fixtureTool(n, { defer: true, params: ['url', 'count'] }))
const MCP_A = ['read_file', 'write_file', 'list_directory', 'search_files'].map(n => fixtureTool(n, { mcp: 'filesys', params: ['path', 'pattern'] }))
const MCP_B = ['create_issue', 'list_issues', 'get_issue'].map(n => fixtureTool(n, { mcp: 'github', params: ['owner', 'repo'] }))
const POOL: Tool[] = [...NON_DEFERRED, ToolSearchTool as never, ...DEFERRED_BUILTINS, ...MCP_A, ...MCP_B]
const DEFERRED_NAMES = [...DEFERRED_BUILTINS, ...MCP_A, ...MCP_B].map(t => t.name)
const EXPECTED_ORDER = POOL.filter(t => t.name !== TOOL_SEARCH_TOOL_NAME).map(t => t.name)
const permissionContext = getEmptyToolPermissionContext()
const SYSTEM_PROMPT = ['You are a fixture assistant working in a scratch workspace. Reply briefly.']

async function drive(messages: Message[], model = MODEL): Promise<{ assistant: AssistantMessage[]; errors: string[]; captures: Capture[] }> {
  const before = captured.length
  const assistant: AssistantMessage[] = []
  const errors: string[] = []
  try {
    const stream = routedCallModel({
      messages,
      systemPrompt: SYSTEM_PROMPT as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: POOL as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model,
        isNonInteractiveSession: true,
        querySource: 'repl_main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
      } as never,
    })
    for await (const item of stream) {
      const m = item as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
      if (m.type !== 'assistant') continue
      if (m.isApiErrorMessage) errors.push(JSON.stringify(m.message?.content).slice(0, 300))
      else assistant.push(item as AssistantMessage)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  return { assistant, errors, captures: captured.slice(before) }
}

const toolsOf = (body: Body): Array<Record<string, unknown>> => (Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [])
const digestOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16)
const bodyText = (c: Capture): string => c.raw

section('§1 THE RULE — the openrouter row reads the native form; the plan defers server-side, admits nothing client-side, announces nothing')
{
  const verdict = wire.deferralWireFormFor(MODEL)
  check(`the table: ${MODEL} → openrouter-native (route-table)`, verdict.form === 'openrouter-native' && verdict.why === 'route-table', `${verdict.form}/${verdict.why}`)
  check('the capability row is the native form', (wire.DEFERRAL_WIRE_CAPABILITY as Record<string, string>).openrouter === 'openrouter-native', String((wire.DEFERRAL_WIRE_CAPABILITY as Record<string, string>).openrouter))
  check('the route defers (supportsToolDeferral)', wire.supportsToolDeferral(MODEL) === true)
  check('the search is the server\'s on this form (deferralSearchIsServerSide)', serverSide('openrouter-native') === true && serverSide('text') === false && serverSide('block') === false)
  for (const id of ['openrouter/openai/gpt-5-mini', 'openrouter/anthropic/claude-sonnet-4.5', 'openrouter/google/gemini-2.5-flash', 'openrouter/deepseek/deepseek-v3.2', 'openrouter/moonshotai/kimi-k2.5']) {
    check(`the docs exclude no model: ${id} reads the native form`, wire.deferralWireFormFor(id).form === 'openrouter-native', wire.deferralWireFormFor(id).form)
  }
  clearToolRosterLatches()
  const plan = await planToolPayload({ model: MODEL, tools: POOL as never, messages: [createUserMessage({ content: 'begin' }) as Message], getToolPermissionContext: async () => permissionContext, agents: [], hasPendingMcpServers: false, source: 'proof', latchKey: 'proof' })
  check('deferral is ON for the conversation', plan.enabled === true, `enabled=${plan.enabled} wire=${plan.wireForm}/${plan.wireWhy}`)
  check('the roster is every pool tool in pool order minus Mercury\'s ToolSearch (the server searches)', plan.roster.map(t => t.name).join(',') === EXPECTED_ORDER.join(','), plan.roster.map(t => t.name).join(','))
  check('the deferred marks are the deferrable set', [...plan.deferredNames].sort().join(',') === [...DEFERRED_NAMES].sort().join(','), [...plan.deferredNames].sort().join(','))
  check('nothing is admitted client-side and no deferred tool reads as unadmitted (the server reveals; Mercury refuses nothing for it)', plan.admittedNames.size === 0 && DEFERRED_NAMES.every(n => plan.isDeferredUnadmitted(n) === false))
  check('no per-request announcement rides', plan.announcement === null)
  const row = getDeferredToolsDeltaAttachment(POOL as never, MODEL, [createUserMessage({ content: 'begin' }) as Message])[0]
  check('the persisted name row (once per transcript, never in the tools array) names the SERVER\'s search as the loading road — the model is told what exists and how to load it', row !== undefined && row.type === 'deferred_tools_delta' && typeof row.body === 'string' && row.body.startsWith(SERVER_SEARCH_ANNOUNCEMENT_HEAD) && row.addedNames.join(',') === [...DEFERRED_NAMES].sort().join(',') && !row.body.includes('ToolSearch'), JSON.stringify(row ?? null).slice(0, 160))
  clearToolRosterLatches()
}

section('§2 THE WIRE — the fresh request rides OpenRouter\'s Responses API with the server search tool first and every deferred definition marked')
const fresh = [createUserMessage({ content: 'Fetch https://example.test/page and tell me its title.' }) as Message]
const first = await drive(fresh)
const firstResponses = first.captures.find(c => c.path === '/api/v1/responses')
const firstChat = first.captures.find(c => c.path === '/api/v1/chat/completions')
{
  check('the request landed on /api/v1/responses, not /chat/completions (the docs: Chat Completions returns 400 for tool search)', firstResponses !== undefined && firstChat === undefined, `${first.captures.map(c => c.path).join(',')} ${first.errors.join(' | ')}`)
  const body = firstResponses?.body ?? {}
  check('the native road carries the same routing policy as chat', JSON.stringify(body.provider) === '{"data_collection":"deny","require_parameters":true}')
  const tools = toolsOf(body)
  check('tools[0] is { type: "openrouter:tool_search" }', tools[0] !== undefined && tools[0].type === SEARCH_TYPE && Object.keys(tools[0]).join(',') === 'type', JSON.stringify(tools[0] ?? null))
  const rest = tools.slice(1)
  check('then every pool tool in first-sent order, flat Responses function shape', rest.map(t => String(t.name)).join(',') === EXPECTED_ORDER.join(',') && rest.every(t => t.type === 'function' && t.parameters !== undefined && !('function' in t)), rest.map(t => String(t.name)).join(','))
  check('every deferred definition carries defer_loading: true', DEFERRED_NAMES.every(n => rest.find(t => t.name === n)?.defer_loading === true))
  check('no loaded definition carries the mark', NON_DEFERRED.every(t => !('defer_loading' in (rest.find(r => r.name === t.name) ?? {}))))
  check('Mercury\'s own ToolSearch tool is not in the array', !rest.some(t => t.name === TOOL_SEARCH_TOOL_NAME))
  check('no tool_choice (the docs: omitted or allowed_tools, anything else is a 400)', !('tool_choice' in body))
  check('instructions carry the system prompt; input opens with the user message item', typeof body.instructions === 'string' && (body.instructions as string).includes(SYSTEM_PROMPT[0]!) && Array.isArray(body.input) && (body.input as Array<Record<string, unknown>>)[0]?.type === 'message' && (body.input as Array<Record<string, unknown>>)[0]?.role === 'user')
  check('stream: true and a prompt_cache_key for sticky routing', body.stream === true && typeof body.prompt_cache_key === 'string' && (body.prompt_cache_key as string).startsWith('mercury-'))
  const text = firstResponses ? bodyText(firstResponses) : ''
  check('no per-request announcement rides the body (the retired prepend tag; no Mercury ToolSearch words)', text !== '' && !text.includes('<available-deferred-tools>') && !text.includes('via ToolSearch') && !text.includes(`"name":"${TOOL_SEARCH_TOOL_NAME}"`))
  check('the bearer and the product user-agent ride the request', firstResponses?.headers.authorization === 'Bearer fixture-openrouter-key' && typeof firstResponses?.headers['user-agent'] === 'string')
}

section('§3 THE ADMISSION — the server searched and the model used the tool in the same step; Mercury settles the call, records the turn, and the next request replays it with the array byte-identical')
const admissionTurn = first.assistant
const toolUse = admissionTurn.flatMap(m => m.message.content).find(b => b.type === 'tool_use') as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | undefined
{
  check('the deferred tool the server revealed settled as a tool_use block (WebFetch, the arguments parsed)', toolUse !== undefined && toolUse.name === 'WebFetch' && toolUse.id === 'call_fx_webfetch_1' && toolUse.input.url === 'https://example.test/page', JSON.stringify(toolUse ?? first.errors))
  const last = admissionTurn.at(-1)
  check('the turn settled as tool_use', last?.message.stop_reason === 'tool_use', String(last?.message.stop_reason))
  check('the turn is TWO minted rows (the working note, then the call) sharing one message id', admissionTurn.length === 2 && admissionTurn[0]?.message.content[0]?.type === 'text' && admissionTurn[0]?.message.id === admissionTurn[1]?.message.id, String(admissionTurn.length))
  const record = (last as unknown as { openrouterProviderTurn?: { model: string; items: unknown[] } } | undefined)?.openrouterProviderTurn
  check('the last minted message carries the turn record: the reasoning item, the openrouter:tool_search item verbatim, the note, the function call', record !== undefined && record.model === WIRE_MODEL && record.items.length === 4 && (record.items as Array<Record<string, unknown>>).map(i => i.type).join(',') === `reasoning,${SEARCH_TYPE},message,function_call` && (record.items as Array<Record<string, unknown>>)[1]?.query === 'fetch url', JSON.stringify(record ?? null).slice(0, 200))
  const usage = last?.message.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number } | undefined
  check('usage decodes from the Responses envelope: input_tokens_details.cached_tokens → cache_read_input_tokens, the uncached remainder as input_tokens', usage !== undefined && usage.cache_read_input_tokens === 0 && usage.input_tokens === 4174 && usage.output_tokens === 137, JSON.stringify(usage ?? null))
}
const toolResult = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: toolUse?.id ?? 'call_fx_webfetch_1', content: '<title>Example Domain</title>' }] as never }) as Message
const second = await drive([...fresh, ...(admissionTurn as unknown as Message[]), toolResult])
const secondResponses = second.captures.find(c => c.path === '/api/v1/responses')
{
  check('the request after the admission rides /api/v1/responses too', secondResponses !== undefined && !second.captures.some(c => c.path === '/api/v1/chat/completions'), `${second.captures.map(c => c.path).join(',')} ${second.errors.join(' | ')}`)
  const before = toolsOf(firstResponses?.body ?? {})
  const after = toolsOf(secondResponses?.body ?? {})
  check('the tools array is BYTE-IDENTICAL to the first request\'s (the admission moved nothing at the front; the prefix cache holds)', before.length > 0 && JSON.stringify(before) === JSON.stringify(after), `${digestOf(before)} vs ${digestOf(after)}`)
  check('still no tool_choice after the admission (no client-side allowed_tools — the live probe showed it kills the cache)', !('tool_choice' in (secondResponses?.body ?? {})))
  const input = Array.isArray(secondResponses?.body.input) ? (secondResponses!.body.input as Array<Record<string, unknown>>) : []
  const types = input.map(i => `${i.type}${i.type === 'message' ? `/${i.role}` : ''}`).join(',')
  check('the input replays the turn record verbatim (the two-row turn folded to one, its record kept), then the tool output: user, reasoning, openrouter:tool_search, note, function_call, function_call_output', types === `message/user,reasoning,${SEARCH_TYPE},message/assistant,function_call,function_call_output`, types)
  const reasoning = input.find(i => i.type === 'reasoning')
  const search = input.find(i => i.type === SEARCH_TYPE)
  const call = input.find(i => i.type === 'function_call')
  const output = input.find(i => i.type === 'function_call_output')
  check('the reasoning item replays with its encrypted content; the search item keeps its id and query', reasoning?.encrypted_content === ENCRYPTED && search?.id === 'st_fx_1' && search?.query === 'fetch url')
  check('the function_call and its function_call_output share the call id (the pairing law)', call?.call_id === 'call_fx_webfetch_1' && output?.call_id === 'call_fx_webfetch_1' && typeof output?.output === 'string' && (output.output as string).includes('Example Domain'))
  const last = second.assistant.at(-1)
  const usage = last?.message.usage as { input_tokens: number; cache_read_input_tokens?: number } | undefined
  check('the next request\'s cached prefix is read off input_tokens_details.cached_tokens (fixture: 4096 of 4310)', usage?.cache_read_input_tokens === 4096 && usage?.input_tokens === 4310 - 4096, JSON.stringify(usage ?? null))
  check('the reply text settled', second.assistant.some(m => m.message.content.some(b => b.type === 'text' && (b as { text: string }).text === 'fetched and done')))
}

section('§4 THE OFF ARM — a conversation whose latch does not defer keeps the chat-completions road, every schema in full')
{
  clearToolRosterLatches()
  process.env.MERCURY_TOOL_DEFER = '0'
  const off = await drive([createUserMessage({ content: 'begin again' }) as Message])
  delete process.env.MERCURY_TOOL_DEFER
  const chat = off.captures.find(c => c.path === '/api/v1/chat/completions')
  check('MERCURY_TOOL_DEFER=0 ⇒ the request rides /api/v1/chat/completions', chat !== undefined && !off.captures.some(c => c.path === '/api/v1/responses'), `${off.captures.map(c => c.path).join(',')} ${off.errors.join(' | ')}`)
  const tools = toolsOf(chat?.body ?? {})
  check('…with every tool in full in the nested chat shape, no search entry, no defer_loading', tools.length === EXPECTED_ORDER.length && tools.every(t => t.type === 'function' && typeof (t.function as Record<string, unknown> | undefined)?.name === 'string' && !('defer_loading' in t)) && !tools.some(t => t.type === SEARCH_TYPE), String(tools.length))
  clearToolRosterLatches()
}

section('§5 THE CENSUS — the road is wired where the lane profile says')
{
  const lane = readFileSync(join(ROOT, 'src/services/providers/openrouter/openrouterCallModel.ts'), 'utf8')
  check('the OpenRouter profile hands its transport seam to the Responses road', /streamTransport: \(options, messages\) => openrouterResponsesTransport\(options, messages\)/.test(lane))
  let transport = ''
  try {
    transport = readFileSync(join(ROOT, 'src/services/providers/openrouter/openrouterResponsesTransport.ts'), 'utf8')
  } catch {
    transport = ''
  }
  check('the transport puts the server search tool first and marks the plan\'s deferred names', /type: OPENROUTER_TOOL_SEARCH_TYPE \}/.test(transport) && /defer_loading: true/.test(transport) && /openrouterResponsesUrl/.test(transport))
  const runtime = readFileSync(join(ROOT, 'src/services/providers/openaicompat/compatChatCallModel.ts'), 'utf8')
  check('the compat runtime hands the plan\'s deferral facts to the transport', /deferral: ctx\.deferral/.test(runtime) && /deferredNames: plan\.deferredNames/.test(runtime))
}

server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} OPENROUTER NATIVE DEFERRAL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL OPENROUTER NATIVE DEFERRAL PROOFS PASS')
process.exit(0)
