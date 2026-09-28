#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
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
const attempt = (label: string, fn: () => boolean, detail: () => string = () => ''): void => {
  try {
    check(label, fn(), detail())
  } catch (error) {
    check(label, false, error instanceof Error ? error.message : String(error))
  }
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the native-deferral prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

delete process.env.NODE_ENV
for (const k of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_TOOL_SEARCH',
  'MERCURY_TOOL_DEFER',
  'MERCURY_TOOL_DEFER_PROBE',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_MODEL',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_WIRE_DUMP',
]) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openai-native-deferral-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'openai-native-deferral-daemon-'))
process.env.OPENAI_API_KEY = 'fixture-openai-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Body = Record<string, unknown>
interface Capture {
  server: string
  path: string
  body: Body
  raw: string
}
const captured: Capture[] = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

const MODELS_BODY = {
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 1_050_000, input_modalities: ['text', 'image'], supported_in_api: true },
    { slug: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 9, context_window: 272_000, input_modalities: ['text'], supported_in_api: true },
  ],
}

const WEBFETCH_DEFINITION = {
  type: 'function',
  name: 'WebFetch',
  description: 'WebFetch fixture',
  parameters: { type: 'object', properties: { url: { type: 'string' }, count: { type: 'string' } }, required: ['url', 'count'], additionalProperties: false },
  defer_loading: true,
}
const TOOL_SEARCH_CALL = { type: 'tool_search_call', id: 'tsc_1', execution: 'server', call_id: null, status: 'completed', arguments: { paths: ['WebFetch'] } }
const TOOL_SEARCH_OUTPUT = { type: 'tool_search_output', id: 'tso_1', execution: 'server', call_id: null, status: 'completed', tools: [WEBFETCH_DEFINITION] }
const WEBFETCH_CALL = { type: 'function_call', id: 'fc_1', call_id: 'call_webfetch_1', name: 'WebFetch', arguments: '{"url":"https://example.test/","count":"1"}' }
const WEBFETCH_CALL_REPLAY = { type: 'function_call', call_id: 'call_webfetch_1', name: 'WebFetch', arguments: WEBFETCH_CALL.arguments, id: 'fc_1' }

function searchAndCallStream(id: string): string {
  return [
    sse({ type: 'response.created', response: { id } }),
    sse({ type: 'response.output_item.added', item: { type: 'tool_search_call', id: 'tsc_1', status: 'in_progress' } }),
    sse({ type: 'response.output_item.done', item: TOOL_SEARCH_CALL }),
    sse({ type: 'response.output_item.done', item: TOOL_SEARCH_OUTPUT }),
    sse({ type: 'response.output_item.added', item: { ...WEBFETCH_CALL, arguments: '' } }),
    sse({ type: 'response.output_item.done', item: WEBFETCH_CALL }),
    sse({ type: 'response.completed', response: { id, usage: { input_tokens: 2400, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function textStream(id: string, text: string, cached: number): string {
  return [
    sse({ type: 'response.created', response: { id } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id, usage: { input_tokens: 2600, output_tokens: 4, input_tokens_details: { cached_tokens: cached } } } }),
  ].join('')
}

function carriesNativeShape(body: Body): boolean {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return tools.some(t => t.type === 'tool_search' || t.defer_loading === true)
}
function isProbeBody(body: Body): boolean {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return tools.some(t => t.name === 'deferral_probe') && tools.some(t => t.type === 'tool_search')
}

type Answer = (body: Body, count: number) => { status: number; contentType: string; text: string }
async function fixture(name: string, answer: Answer): Promise<{ server: Server; base: string; host: string }> {
  let count = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? ''
      if (req.method === 'GET' && path.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(MODELS_BODY))
        return
      }
      if (req.method === 'POST' && path.endsWith('/responses')) {
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Body = {}
        try {
          body = JSON.parse(raw) as Body
        } catch {
          body = {}
        }
        captured.push({ server: name, path, body, raw })
        count += 1
        const reply = answer(body, count)
        res.writeHead(reply.status, { 'content-type': reply.contentType })
        res.end(reply.text)
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, base: `http://127.0.0.1:${port}/v1`, host: `127.0.0.1:${port}` }
}

const REFUSAL = JSON.stringify({ error: { message: "Unknown parameter: 'tools[4].defer_loading'.", type: 'invalid_request_error', param: 'tools[4].defer_loading', code: 'unknown_parameter' } })

const passing = await fixture('passing', (body, count) => {
  if (isProbeBody(body)) return { status: 200, contentType: 'text/event-stream', text: textStream('resp_probe', 'ok', 0) }
  const sessionCount = captured.filter(c => c.server === 'passing' && !isProbeBody(c.body)).length
  void count
  if (sessionCount === 1) return { status: 200, contentType: 'text/event-stream', text: searchAndCallStream('resp_1') }
  return { status: 200, contentType: 'text/event-stream', text: textStream(`resp_${sessionCount}`, 'Fetched.', 2400) }
})
const refusing = await fixture('refusing', body => {
  if (carriesNativeShape(body)) return { status: 400, contentType: 'application/json', text: REFUSAL }
  return { status: 200, contentType: 'text/event-stream', text: textStream('resp_text', 'ok', 0) }
})
const armed = await fixture('armed', body => {
  if (isProbeBody(body)) return { status: 200, contentType: 'text/event-stream', text: textStream('resp_probe', 'ok', 0) }
  return { status: 200, contentType: 'text/event-stream', text: textStream('resp_armed', 'ok', 0) }
})
const lying = await fixture('lying', body => {
  if (carriesNativeShape(body)) return { status: 400, contentType: 'application/json', text: REFUSAL }
  return { status: 200, contentType: 'text/event-stream', text: textStream('resp_lying', 'ok', 0) }
})

function pointAt(target: { base: string }): void {
  process.env.MERCURY_OPENAI_API_BASE = target.base
  process.env.MERCURY_OPENAI_CHATGPT_BASE = target.base
  process.env.MERCURY_OPENAI_AUTH_BASE = target.base
}
pointAt(passing)

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const wire = await import('../../src/services/providers/deferralWire.ts')
const probe = await import('../../src/services/providers/deferralProbe.ts')
const { planToolPayload, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { gateToolCall } = await import('../../src/services/providers/toolCallGate.ts')
const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { __resetOpenaiCatalogueForTest } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const { decodeOpenaiTurnRecord, mapToolsToOpenai, buildOpenaiResponsesRequest } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getPrompt, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
const probeKeyOf = (host: string): string => (typeof probe.openaiGatewayProbeKey === 'function' ? probe.openaiGatewayProbeKey(host) : `openai:${host}`)

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
const DEFERRED_BUILTINS = ['WebFetch', 'NotebookEdit', 'Browser'].map(n => fixtureTool(n, { defer: true, params: ['url', 'count'] }))
const MCP_A = ['read_file', 'write_file'].map(n => fixtureTool(n, { mcp: 'filesys', params: ['path', 'pattern'] }))
const POOL: Tool[] = [...NON_DEFERRED, ToolSearchTool as never, ...DEFERRED_BUILTINS, ...MCP_A]
const DEFERRED_NAMES = [...DEFERRED_BUILTINS, ...MCP_A].map(t => t.name)
const permissionContext = getEmptyToolPermissionContext()

section('§1 THE TABLE AND THE LADDER — the openai row is the native capability; the model floor and the endpoint decide the form')
{
  check("the openai row reads 'openai-native'", wire.DEFERRAL_WIRE_CAPABILITY.openai === 'openai-native')
  check('the home lane is still the only gateway-evidence row', Object.entries(wire.DEFERRAL_WIRE_CAPABILITY).filter(([, c]) => c === 'gateway-evidence').map(([r]) => r).join(',') === 'anthropic')
  const firstParty = { env: {} as Record<string, string | undefined> }
  for (const model of ['gpt-6-astra', 'gpt-6', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
    const v = wire.deferralWireFormFor(model, firstParty)
    check(`${model} on first-party OpenAI ⇒ openai-native / first-party-contract`, v.form === 'openai-native' && v.why === 'first-party-contract', `${v.form}/${v.why}`)
    check(`${model}: supportsToolDeferral`, wire.supportsToolDeferral(model, v.form) === true)
  }
  for (const model of ['gpt-5.3-codex', 'gpt-5.3', 'gpt-5.2', 'gpt-5', 'gpt-4.1']) {
    const v = wire.deferralWireFormFor(model, firstParty)
    check(`${model} (older than 5.4) ⇒ text / model-below-native-floor`, v.form === 'text' && v.why === 'model-below-native-floor', `${v.form}/${v.why}`)
    check(`${model}: the text form still defers on the openai route`, wire.supportsToolDeferral(model, v.form) === true)
  }
  attempt('the floor is 5.4 (pure)', () => wire.gptModelCarriesNativeDeferral('gpt-5.4') && !wire.gptModelCarriesNativeDeferral('gpt-5.3') && wire.gptModelCarriesNativeDeferral('gpt-6') && !wire.gptModelCarriesNativeDeferral('gpt') && !wire.gptModelCarriesNativeDeferral('claude-sonnet-5'))
  attempt('api.openai.com and chatgpt.com are first-party hosts', () => wire.openaiGatewayHost({ MERCURY_OPENAI_API_BASE: 'https://api.openai.com/v1' }).firstParty && wire.openaiGatewayHost({ MERCURY_OPENAI_CHATGPT_BASE: 'https://chatgpt.com/backend-api/codex' }).firstParty && wire.openaiGatewayHost({}).firstParty)
  const gw = { env: { MERCURY_OPENAI_API_BASE: 'https://gw.corp.example/v1' } }
  attempt('a custom base keys a gateway host', () => JSON.stringify(wire.openaiGatewayHost(gw.env)) === JSON.stringify({ firstParty: false, host: 'gw.corp.example' }))
  const unprobed = wire.deferralWireFormFor('gpt-6-astra', { ...gw, probeVerdict: () => undefined })
  check('gateway + no verdict ⇒ text / gateway-unprobed (the form that cannot fail)', unprobed.form === 'text' && unprobed.why === 'gateway-unprobed', `${unprobed.form}/${unprobed.why}`)
  const native = wire.deferralWireFormFor('gpt-6-astra', { ...gw, probeVerdict: key => (key === probeKeyOf('gw.corp.example') ? 'openai-native' : undefined) })
  check('gateway + a recorded native verdict (keyed openai:<host>) ⇒ openai-native / gateway-probed-native', native.form === 'openai-native' && native.why === 'gateway-probed-native', `${native.form}/${native.why}`)
  const text = wire.deferralWireFormFor('gpt-6-astra', { ...gw, probeVerdict: () => 'text' })
  check('gateway + a recorded text verdict ⇒ text / gateway-probed-text', text.form === 'text' && text.why === 'gateway-probed-text')
  const older = wire.deferralWireFormFor('gpt-5.3-codex', { ...gw, probeVerdict: () => 'openai-native' })
  check('an older model on a native-probed gateway still reads text (the model floor comes first)', older.form === 'text' && older.why === 'model-below-native-floor')
  const unparseable = wire.deferralWireFormFor('gpt-6-astra', { env: { MERCURY_OPENAI_API_BASE: 'not a url' }, probeVerdict: () => 'openai-native' })
  check('an unparseable base keys no host ⇒ text / gateway-unprobed', unparseable.form === 'text' && unparseable.why === 'gateway-unprobed')
  const refused = wire.deferralWireFormFor('gpt-6-astra', { env: {}, probeVerdict: key => (key === 'openai:first-party' ? 'text' : undefined) })
  check("first-party + a recorded refusal (the endpoint 400'd the shape once) ⇒ text / first-party-refused", refused.form === 'text' && refused.why === 'first-party-refused', `${refused.form}/${refused.why}`)
  const home = wire.deferralWireFormFor('claude-sonnet-5', { firstPartyBaseUrl: () => true, env: {} })
  check('the home lane is untouched (block by contract)', home.form === 'block' && home.why === 'first-party-contract')
  check('the ToolSearch description renders the text-form text for the native form (the tool is not offered there)', getPrompt('openai-native') === getPrompt('text') && getPrompt('block') !== getPrompt('text'))
}

section('§2 THE PROBE — the OpenAI shape, the classifier, the store key')
{
  attempt('the probe body carries one deferred function and the tool_search tool, store:false, stream:true', () => {
    const body = probe.openaiGatewayProbeBody('gpt-6-astra')
    const tools = body.tools as Array<Record<string, unknown>>
    return tools.length === 2 && tools[0]!.name === 'deferral_probe' && tools[0]!.defer_loading === true && tools[1]!.type === 'tool_search' && body.store === false && body.stream === true && body.model === 'gpt-6-astra'
  })
  const cases: Array<{ label: string; status: number | null; body: string; expect: string }> = [
    { label: '2xx ⇒ openai-native', status: 200, body: '', expect: 'verdict:openai-native' },
    { label: "400 naming defer_loading ⇒ text", status: 400, body: REFUSAL, expect: 'verdict:text' },
    { label: '400 naming tool_search ⇒ text', status: 400, body: "Invalid value: 'tool_search'. Supported values are: 'function', 'web_search'.", expect: 'verdict:text' },
    { label: '400 about something else ⇒ indeterminate', status: 400, body: 'model not found', expect: 'indeterminate:other-status' },
    { label: '401 ⇒ indeterminate (auth refused the probe)', status: 401, body: 'unauthorized', expect: 'indeterminate:auth-refused' },
    { label: 'no reply ⇒ indeterminate (unreachable)', status: null, body: 'ECONNREFUSED', expect: 'indeterminate:unreachable' },
    { label: '429 ⇒ indeterminate', status: 429, body: 'slow down', expect: 'indeterminate:other-status' },
  ]
  for (const c of cases) {
    attempt(c.label, () => {
      const v = probe.classifyOpenaiGatewayProbe({ status: c.status, bodyText: c.body })
      const got = v.kind === 'verdict' ? `verdict:${v.verdict}` : `indeterminate:${v.reason}`
      if (got !== c.expect) throw new Error(got)
      return true
    })
  }
  attempt('the store key is namespaced so an OpenAI gateway never reads an Anthropic verdict for the same host', () => probe.openaiGatewayProbeKey('gw.example') === 'openai:gw.example' && probe.readGatewayProbeVerdict('gw.example') === undefined)
  const marked = mapToolsToOpenai([{ name: 'A', input_schema: {} }, { name: 'B', input_schema: {} }], new Set(['B']))
  check('the codec marks only the named tools (unmarked by default)', marked[0]!.defer_loading === undefined && marked[1]!.defer_loading === true && mapToolsToOpenai([{ name: 'B', input_schema: {} }])[0]!.defer_loading === undefined)
  const request = buildOpenaiResponsesRequest({ model: 'gpt-6-astra', messages: [], tools: [{ name: 'A', input_schema: {} }], deferredToolNames: new Set(['A']), toolSearch: true })
  check('the request builder appends {type:"tool_search"} after the function tools', JSON.stringify(request.tools) === JSON.stringify([{ type: 'function', name: 'A', parameters: {}, defer_loading: true }, { type: 'tool_search' }]), JSON.stringify(request.tools))
  const plain = buildOpenaiResponsesRequest({ model: 'gpt-5.3-codex', messages: [], tools: [{ name: 'A', input_schema: {} }] })
  check('without the native form nothing changes on the wire (no mark, no tool_search)', JSON.stringify(plain.tools) === JSON.stringify([{ type: 'function', name: 'A', parameters: {} }]))
}

const SYSTEM_PROMPT = ['You are a fixture assistant.']
function callParams(model: string, messages: Message[], ownerKey: string) {
  return {
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
      ownerKey,
    } as never,
  }
}
async function drive(model: string, messages: Message[], ownerKey: string, server: string): Promise<{ replies: AssistantMessage[]; capture: Capture | undefined; errors: string[] }> {
  const before = captured.length
  const replies: AssistantMessage[] = []
  const errors: string[] = []
  try {
    for await (const item of openaiCallModel(callParams(model, messages, ownerKey) as never)) {
      if (item.type === 'assistant') {
        replies.push(item as AssistantMessage)
        if ((item as { isApiErrorMessage?: boolean }).isApiErrorMessage) errors.push(JSON.stringify((item as AssistantMessage).message.content).slice(0, 300))
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const capture = captured.slice(before).find(c => c.server === server && !isProbeBody(c.body))
  return { replies, capture, errors }
}
async function settleProbeVerdict(key: string): Promise<void> {
  const file = join(process.env.MERCURY_CONFIG_DIR ?? '', 'tool-deferral-probe.json')
  for (let i = 0; i < 80; i++) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hosts?: Record<string, unknown> }
        if (parsed.hosts && parsed.hosts[key] !== undefined) return
      } catch {
        void 0
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const toolsOf = (body: Body | undefined): Array<Record<string, unknown>> => (Array.isArray(body?.tools) ? (body!.tools as Array<Record<string, unknown>>) : [])
const inputOf = (body: Body | undefined): Array<Record<string, unknown>> => (Array.isArray(body?.input) ? (body!.input as Array<Record<string, unknown>>) : [])
const textsOf = (body: Body | undefined): string => JSON.stringify(inputOf(body).map(item => item.content ?? ''))

section('§3 THE WIRE ON A PASS-THROUGH ENDPOINT — GPT-6 rides the native array; an admission changes no byte of the prefix')
{
  probe.recordGatewayProbe(probeKeyOf(passing.host), { verdict: 'openai-native', evidence: 'http 200: fixture pass-through', status: 200, probedAt: new Date().toISOString() })
  const form = wire.deferralWireFormFor('gpt-6-astra')
  check('the fixture endpoint reads openai-native / gateway-probed-native', form.form === 'openai-native' && form.why === 'gateway-probed-native', `${form.form}/${form.why}`)
  clearToolRosterLatches()
  __resetOpenaiCatalogueForTest()
  const convo: Message[] = [createUserMessage({ content: 'Fetch https://example.test/ and report the title.' }) as Message]
  const plan = await planToolPayload({ model: 'gpt-6-astra', tools: POOL, messages: convo, getToolPermissionContext: async () => permissionContext, agents: [], hasPendingMcpServers: false, source: 'proof' })
  check('the plan: deferral on, the native form, every deferred tool marked', plan.enabled && plan.wireForm === 'openai-native' && [...plan.deferredNames].sort().join(',') === [...DEFERRED_NAMES].sort().join(','))
  check("the plan's roster is every pool tool in pool order minus Mercury's own ToolSearch", plan.roster.map(t => t.name).join(',') === POOL.filter(t => t.name !== TOOL_SEARCH_TOOL_NAME).map(t => t.name).join(','), plan.roster.map(t => t.name).join(','))
  check('no announcement rides and no tool is "unadmitted" (the server is the admission road)', plan.announcement === null && plan.admittedNames.size === 0 && plan.isDeferredUnadmitted('WebFetch') === false)
  const miss = gateToolCall(POOL as never, { id: 'c1', name: 'WebFetch', argumentsRaw: '{"url":"https://x"}', malformed: false }, { deferredUnadmitted: plan.isDeferredUnadmitted })
  check('a schema miss on a deferred tool refuses without naming the ToolSearch road', !miss.ok && miss.refusal.code === 'schema' && !miss.refusal.reason.includes('select:WebFetch'))

  const first = await drive('gpt-6-astra', convo, 'native-proof', 'passing')
  check('request 1 reached the fixture endpoint', first.capture !== undefined && first.errors.length === 0, first.errors.join(' | '))
  const tools1 = toolsOf(first.capture?.body)
  const functions1 = tools1.filter(t => t.type === 'function')
  check('request 1: the tools array is every pool tool in pool order (flat function tools), then exactly one {type:"tool_search"} at the END', functions1.map(t => t.name).join(',') === POOL.filter(t => t.name !== TOOL_SEARCH_TOOL_NAME).map(t => t.name).join(',') && tools1.filter(t => t.type === 'tool_search').length === 1 && tools1[tools1.length - 1]!.type === 'tool_search', tools1.map(t => `${String(t.type)}:${String(t.name ?? '')}`).join(','))
  check('request 1: every deferred tool carries defer_loading: true; every other function tool carries no mark', DEFERRED_NAMES.every(n => functions1.find(t => t.name === n)?.defer_loading === true) && NON_DEFERRED.every(t => functions1.find(x => x.name === t.name)?.defer_loading === undefined), JSON.stringify(functions1.map(t => [t.name, t.defer_loading ?? null])))
  check("request 1: Mercury's own ToolSearch function is NOT in the array and no text announcement rides the input", !functions1.some(t => t.name === TOOL_SEARCH_TOOL_NAME) && !textsOf(first.capture?.body).includes('<available-deferred-tools>') && !textsOf(first.capture?.body).includes('Tool loaded.'))
  check('request 1: the request is otherwise the stateless-replay shape (store:false, encrypted reasoning include, the cache key)', first.capture?.body.store === false && JSON.stringify(first.capture?.body.include) === JSON.stringify(['reasoning.encrypted_content']) && typeof first.capture?.body.prompt_cache_key === 'string')
  const toolUse = first.replies.flatMap(r => r.message.content).find(b => b.type === 'tool_use') as { id?: string; name?: string; input?: unknown } | undefined
  check('the deferred tool the server loaded is USED in the same step: WebFetch mints a tool_use under the provider call id', toolUse !== undefined && toolUse.name === 'WebFetch' && toolUse.id === 'call_webfetch_1' && JSON.stringify(toolUse.input) === JSON.stringify({ url: 'https://example.test/', count: '1' }), JSON.stringify(toolUse))
  check('no "does not decode yet" note and no refusal note settled', !JSON.stringify(first.replies.map(r => r.message.content)).includes('does not decode yet') && !first.replies.some(r => (r as { refusedToolCalls?: unknown[] }).refusedToolCalls !== undefined))
  const record = first.replies.at(-1)?.apexProviderTurn as { items?: unknown[] } | undefined
  check('the replay record carries the tool_search_call and the tool_search_output VERBATIM, then the function call in the fold\'s spelling, in order', JSON.stringify(record?.items) === JSON.stringify([TOOL_SEARCH_CALL, TOOL_SEARCH_OUTPUT, WEBFETCH_CALL_REPLAY]), JSON.stringify(record?.items).slice(0, 400))
  const decoded = decodeOpenaiTurnRecord(JSON.parse(JSON.stringify({ provider: 'openai', items: record?.items ?? [] })))
  check('the record decodes from disk with the tool_search items intact (a resume replays them)', JSON.stringify(decoded?.items) === JSON.stringify([TOOL_SEARCH_CALL, TOOL_SEARCH_OUTPUT, WEBFETCH_CALL_REPLAY]))

  const toolResult = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_webfetch_1', content: 'Example Domain' }] as never }) as Message
  const convo2: Message[] = [...convo, ...first.replies, toolResult]
  const second = await drive('gpt-6-astra', convo2, 'native-proof', 'passing')
  check('request 2 reached the fixture endpoint', second.capture !== undefined && second.errors.length === 0, second.errors.join(' | '))
  const tools2 = toolsOf(second.capture?.body)
  check('request 2: the tools array is BYTE-IDENTICAL to request 1 (the admission changed nothing in the prefix)', JSON.stringify(tools2) === JSON.stringify(tools1))
  check('request 2: instructions and the cache key are byte-identical', second.capture?.body.instructions === first.capture?.body.instructions && second.capture?.body.prompt_cache_key === first.capture?.body.prompt_cache_key)
  const input1 = inputOf(first.capture?.body)
  const input2 = inputOf(second.capture?.body)
  check("request 2: request 1's input items are the prefix, byte-identical", JSON.stringify(input2.slice(0, input1.length)) === JSON.stringify(input1))
  const appended = input2.slice(input1.length)
  check('request 2: the loaded definition rides at the END of the input — tool_search_call, tool_search_output (the found tool), the call and its output', JSON.stringify(appended.map(i => i.type)) === JSON.stringify(['tool_search_call', 'tool_search_output', 'function_call', 'function_call_output']) && JSON.stringify(appended[0]) === JSON.stringify(TOOL_SEARCH_CALL) && JSON.stringify(appended[1]) === JSON.stringify(TOOL_SEARCH_OUTPUT) && JSON.stringify(appended[2]) === JSON.stringify(WEBFETCH_CALL_REPLAY) && appended[3]!.call_id === 'call_webfetch_1', JSON.stringify(appended.map(i => i.type)))
  check('request 2: the usage row maps the cached prefix (cache_read 2400 of 2600)', second.replies.at(-1)?.message.usage.cache_read_input_tokens === 2400 && second.replies.at(-1)?.message.usage.input_tokens === 200)

  clearToolRosterLatches()
  const resumed = JSON.parse(JSON.stringify(convo2)) as Message[]
  const third = await drive('gpt-6-astra', [...resumed, ...second.replies, createUserMessage({ content: 'Thanks.' }) as Message], 'native-proof', 'passing')
  const tools3 = toolsOf(third.capture?.body)
  const input3 = inputOf(third.capture?.body)
  check('a resumed transcript (JSON round trip, latches cleared) re-sends the same tools array and the same input prefix', JSON.stringify(tools3) === JSON.stringify(tools1) && JSON.stringify(input3.slice(0, input2.length)) === JSON.stringify(input2) && third.capture?.body.prompt_cache_key === first.capture?.body.prompt_cache_key, third.errors.join(' | '))
}

section('§4 THE OLDER MODEL — GPT-5.3 keeps the text form on the same endpoint')
{
  clearToolRosterLatches()
  const form = wire.deferralWireFormFor('gpt-5.3-codex')
  check('gpt-5.3-codex reads text / model-below-native-floor', form.form === 'text' && form.why === 'model-below-native-floor', `${form.form}/${form.why}`)
  const convo: Message[] = [createUserMessage({ content: 'Plan the fixture task.' }) as Message]
  const older = await drive('gpt-5.3-codex', convo, 'older-proof', 'passing')
  check('the older model reached the fixture endpoint', older.capture !== undefined && older.errors.length === 0, older.errors.join(' | '))
  const tools = toolsOf(older.capture?.body)
  check("the text form: the non-deferred tools plus Mercury's ToolSearch, no deferred schema, no mark, no tool_search", tools.map(t => t.name).join(',') === [...NON_DEFERRED.map(t => t.name), TOOL_SEARCH_TOOL_NAME].join(',') && tools.every(t => t.defer_loading === undefined && t.type === 'function'), tools.map(t => `${String(t.type)}:${String(t.name ?? '')}`).join(','))
}

section('§5 THE GATEWAY WITHOUT PASS-THROUGH — the armed probe records text; the native shape never rides')
{
  clearToolRosterLatches()
  __resetOpenaiCatalogueForTest()
  probe._resetGatewayProbeFlightsForTesting()
  pointAt(refusing)
  process.env.MERCURY_TOOL_DEFER_PROBE = '1'
  const before = wire.deferralWireFormFor('gpt-6-astra')
  check('unprobed: text / gateway-unprobed', before.form === 'text' && before.why === 'gateway-unprobed', `${before.form}/${before.why}`)
  const convo: Message[] = [createUserMessage({ content: 'Plan the fixture task.' }) as Message]
  const first = await drive('gpt-6-astra', convo, 'refusing-proof', 'refusing')
  check('the session request rode the text form (no native shape on an unprobed gateway)', first.capture !== undefined && !carriesNativeShape(first.capture.body) && first.errors.length === 0, first.errors.join(' | '))
  await settleProbeVerdict(probeKeyOf(refusing.host))
  const probeRequest = captured.find(c => c.server === 'refusing' && isProbeBody(c.body))
  check('exactly one probe request rode the gateway, in the OpenAI shape (deferral_probe marked, tool_search present)', captured.filter(c => c.server === 'refusing' && isProbeBody(c.body)).length === 1 && probeRequest !== undefined && (probeRequest.body.tools as Array<Record<string, unknown>>)[0]!.defer_loading === true)
  probe._resetGatewayProbeStoreForTesting()
  const record = probe.readGatewayProbeRecord(probeKeyOf(refusing.host))
  check("the 400 naming defer_loading recorded a durable 'text' verdict with its evidence", record?.verdict === 'text' && record.status === 400 && record.evidence.includes('defer_loading'), JSON.stringify(record))
  const after = wire.deferralWireFormFor('gpt-6-astra')
  check('after the verdict: text / gateway-probed-text', after.form === 'text' && after.why === 'gateway-probed-text', `${after.form}/${after.why}`)
  const second = await drive('gpt-6-astra', [...convo, ...first.replies, createUserMessage({ content: 'Go on.' }) as Message], 'refusing-proof', 'refusing')
  check('the next request still rides the text form and no second probe fires', second.capture !== undefined && !carriesNativeShape(second.capture.body) && captured.filter(c => c.server === 'refusing' && isProbeBody(c.body)).length === 1)
  delete process.env.MERCURY_TOOL_DEFER_PROBE
}

section('§6 THE GATEWAY WITH PASS-THROUGH — the armed probe upgrades the endpoint to the native form')
{
  clearToolRosterLatches()
  __resetOpenaiCatalogueForTest()
  probe._resetGatewayProbeFlightsForTesting()
  pointAt(armed)
  const convo: Message[] = [createUserMessage({ content: 'Plan the fixture task.' }) as Message]
  const unarmed = await drive('gpt-6-astra', convo, 'armed-proof-0', 'armed')
  check('unarmed (MERCURY_TOOL_DEFER_PROBE unset): the text form rides and NO probe request leaves', unarmed.capture !== undefined && !carriesNativeShape(unarmed.capture.body) && captured.filter(c => c.server === 'armed' && isProbeBody(c.body)).length === 0)
  process.env.MERCURY_TOOL_DEFER_PROBE = '1'
  const first = await drive('gpt-6-astra', convo, 'armed-proof-1', 'armed')
  check('armed: the first request rides the text form while the probe fires', first.capture !== undefined && !carriesNativeShape(first.capture.body))
  await settleProbeVerdict(probeKeyOf(armed.host))
  probe._resetGatewayProbeStoreForTesting()
  const record = probe.readGatewayProbeRecord(probeKeyOf(armed.host))
  check("the 2xx recorded a durable 'openai-native' verdict", record?.verdict === 'openai-native' && record.status === 200, JSON.stringify(record))
  const after = wire.deferralWireFormFor('gpt-6-astra')
  check('after the verdict: openai-native / gateway-probed-native', after.form === 'openai-native' && after.why === 'gateway-probed-native', `${after.form}/${after.why}`)
  clearToolRosterLatches()
  const second = await drive('gpt-6-astra', [createUserMessage({ content: 'A new conversation.' }) as Message], 'armed-proof-2', 'armed')
  const tools = toolsOf(second.capture?.body)
  check('a new conversation on the upgraded endpoint rides the native array (marks + tool_search, no ToolSearch function)', second.capture !== undefined && tools.some(t => t.type === 'tool_search') && DEFERRED_NAMES.every(n => tools.find(t => t.name === n)?.defer_loading === true) && !tools.some(t => t.name === TOOL_SEARCH_TOOL_NAME), tools.map(t => `${String(t.type)}:${String(t.name ?? '')}`).join(','))
  check('one probe per host per process', captured.filter(c => c.server === 'armed' && isProbeBody(c.body)).length === 1)
  delete process.env.MERCURY_TOOL_DEFER_PROBE
}

section('§7 THE REFUSAL FALLBACK — an endpoint that 400s the shape is remembered and the call re-issues once on the text form')
{
  clearToolRosterLatches()
  __resetOpenaiCatalogueForTest()
  probe._resetGatewayProbeFlightsForTesting()
  pointAt(lying)
  probe.recordGatewayProbe(probeKeyOf(lying.host), { verdict: 'openai-native', evidence: 'http 200: a verdict the endpoint no longer honours', status: 200, probedAt: new Date().toISOString() })
  const before = wire.deferralWireFormFor('gpt-6-astra')
  check('the stale verdict reads native', before.form === 'openai-native' && before.why === 'gateway-probed-native', `${before.form}/${before.why}`)
  const convo: Message[] = [createUserMessage({ content: 'Plan the fixture task.' }) as Message]
  const first = await drive('gpt-6-astra', convo, 'lying-proof', 'lying')
  const mine = captured.filter(c => c.server === 'lying')
  check('the native request drew the 400 and ONE re-issue followed on the text form (two requests, no more)', mine.length === 2 && carriesNativeShape(mine[0]!.body) && !carriesNativeShape(mine[1]!.body) && first.errors.length === 0, `${mine.length} request(s) ${first.errors.join(' | ')}`)
  const texts = first.replies.flatMap(r => r.message.content).filter(b => b.type === 'text').map(b => (b as { text: string }).text)
  check('the turn settled with the reply and a leading note naming the refusal and the form now riding', texts.some(t => t.includes("refused OpenAI's tool-search deferral form") && t.includes('text form')) && texts.some(t => t === 'ok'), JSON.stringify(texts).slice(0, 300))
  probe._resetGatewayProbeStoreForTesting()
  const record = probe.readGatewayProbeRecord(probeKeyOf(lying.host))
  check("the refusal recorded a durable 'text' verdict with the endpoint's words", record?.verdict === 'text' && record.status === 400 && record.evidence.includes('defer_loading'), JSON.stringify(record))
  const after = wire.deferralWireFormFor('gpt-6-astra')
  check('after the refusal: text / gateway-probed-text', after.form === 'text' && after.why === 'gateway-probed-text', `${after.form}/${after.why}`)
  clearToolRosterLatches()
  const next = await drive('gpt-6-astra', [createUserMessage({ content: 'A new conversation.' }) as Message], 'lying-proof-2', 'lying')
  check('a new conversation rides the text form outright — no 400, no second re-issue', next.capture !== undefined && !carriesNativeShape(next.capture.body) && captured.filter(c => c.server === 'lying').length === 3 && next.errors.length === 0)
}

passing.server.close()
refusing.server.close()
armed.server.close()
lying.server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} OPENAI NATIVE-DEFERRAL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL OPENAI NATIVE-DEFERRAL PROOFS PASS')
process.exit(0)
