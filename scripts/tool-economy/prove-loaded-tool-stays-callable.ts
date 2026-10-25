#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
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
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the loaded-tool proof exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'MERCURY_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE',
  'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_COMPACT', 'MERCURY_AUTO_COMPACT',
  'MERCURY_BLOCKING_LIMIT_OVERRIDE', 'MERCURY_EFFORT_LEVEL', 'MERCURY_GPT_PRUNE_PRIOR_REASONING', 'MERCURY_WIRE_DUMP',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_COMPACT_KEEP_TAIL', 'MERCURY_HOME',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'loaded-tool-stays-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'loaded-tool-stays-daemon-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

type Dialect = 'responses' | 'anthropic' | 'chat'
type Body = Record<string, unknown>
type Call = { id: string; name: string; args: Record<string, unknown> }
type Turn = { text: string } | { calls: Call[]; search?: string[] }
type Seen = {
  n: number
  dialect: Dialect
  body: Body
  loaded: string[]
  listed: string[]
  deferredMarks: string[]
  searchFound?: string[]
  violations: string[]
}
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`
const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined)

const MODELS_BODY = {
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 1_050_000, input_modalities: ['text', 'image'], supported_in_api: true },
    { slug: 'gpt-5.3-codex', display_name: 'GPT-5.3 Codex', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 9, context_window: 272_000, input_modalities: ['text'], supported_in_api: true },
  ],
}

const toolsArrayOf = (body: Body): Array<Record<string, unknown>> => (Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [])
const inputItems = (body: Body): Array<Record<string, unknown>> => (Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : [])
const chatMessages = (body: Body): Array<Record<string, unknown>> => (Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [])

function functionEntries(body: Body, dialect: Dialect): Array<{ name: string; deferred: boolean; definition: Record<string, unknown> }> {
  const out: Array<{ name: string; deferred: boolean; definition: Record<string, unknown> }> = []
  for (const raw of toolsArrayOf(body)) {
    if (dialect === 'chat') {
      const fn = asRecord(raw.function)
      if (fn && typeof fn.name === 'string') out.push({ name: fn.name, deferred: false, definition: raw })
      continue
    }
    if (dialect === 'responses' && raw.type !== 'function') continue
    if (typeof raw.name === 'string') out.push({ name: raw.name, deferred: raw.defer_loading === true, definition: raw })
  }
  return out
}
function loadedBySearchOutputs(body: Body): string[] {
  const names: string[] = []
  const walk = (tools: unknown): void => {
    if (!Array.isArray(tools)) return
    for (const raw of tools) {
      const tool = asRecord(raw)
      if (!tool) continue
      if (tool.type === 'namespace') walk(tool.tools)
      else if (typeof tool.name === 'string') names.push(tool.name)
    }
  }
  for (const item of inputItems(body)) if (item.type === 'tool_search_output') walk(item.tools)
  return names
}
function declaredOnChat(body: Body, names: readonly string[]): string[] {
  const out = new Set<string>()
  for (const row of chatMessages(body)) {
    if (Array.isArray(row.tools)) {
      for (const raw of row.tools as unknown[]) {
        const fn = asRecord(asRecord(raw)?.function) ?? asRecord(raw)
        if (fn && typeof fn.name === 'string') out.add(fn.name)
      }
    }
    const text = typeof row.content === 'string' ? row.content : Array.isArray(row.content) ? JSON.stringify(row.content) : ''
    for (const name of names) {
      if (text.includes(`"name": "${name}"`) || text.includes(`"name":"${name}"`)) out.add(name)
    }
  }
  return [...out]
}
function referencedOnAnthropic(body: Body): string[] {
  const out: string[] = []
  for (const row of chatMessages(body)) {
    if (!Array.isArray(row.content)) continue
    for (const block of row.content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue
      for (const part of block.content as Array<Record<string, unknown>>) {
        if (part.type === 'tool_reference' && typeof part.tool_name === 'string') out.push(part.tool_name)
      }
    }
  }
  return out
}
function describe(n: number, dialect: Dialect, body: Body, deferredPool: readonly string[]): Seen {
  const entries = functionEntries(body, dialect)
  const listed = entries.map(e => e.name)
  const deferredMarks = entries.filter(e => e.deferred).map(e => e.name)
  const loaded = new Set<string>(entries.filter(e => !e.deferred).map(e => e.name).filter(name => deferredPool.includes(name)))
  if (dialect === 'responses') for (const name of loadedBySearchOutputs(body)) loaded.add(name)
  if (dialect === 'chat') for (const name of declaredOnChat(body, deferredPool)) loaded.add(name)
  if (dialect === 'anthropic') for (const name of referencedOnAnthropic(body)) if (deferredMarks.includes(name)) loaded.add(name)
  return { n, dialect, body, loaded: [...loaded], listed, deferredMarks, violations: [] }
}

function responsesSse(turn: Turn, seen: Seen, ordinal: number): string {
  const id = `resp_${ordinal}`
  const out: string[] = [sse({ type: 'response.created', response: { id } })]
  if ('text' in turn) {
    out.push(sse({ type: 'response.output_item.added', item: { type: 'message', id: `msg_${ordinal}`, role: 'assistant', content: [] } }))
    out.push(sse({ type: 'response.output_text.delta', delta: turn.text }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'message', id: `msg_${ordinal}`, role: 'assistant', content: [{ type: 'output_text', text: turn.text }] } }))
    out.push(sse({ type: 'response.completed', response: { id, usage: { input_tokens: 1200, output_tokens: 12, input_tokens_details: { cached_tokens: 0 } } } }))
    return out.join('')
  }
  const reasoning = (tag: string): void => {
    const rs = `rs_${ordinal}_${tag}`
    out.push(sse({ type: 'response.output_item.added', item: { type: 'reasoning', id: rs, summary: [] } }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'reasoning', id: rs, summary: [], content: [], encrypted_content: `enc-${ordinal}-${tag}` } }))
  }
  reasoning('a')
  if (turn.search !== undefined) {
    const found = functionEntries(seen.body, 'responses').filter(e => e.deferred && turn.search!.includes(e.name))
    seen.searchFound = found.map(e => e.name)
    out.push(sse({ type: 'response.output_item.added', item: { type: 'tool_search_call', id: `tsc_${ordinal}`, status: 'in_progress' } }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'tool_search_call', id: `tsc_${ordinal}`, call_id: null, execution: 'server', status: 'completed', arguments: { paths: turn.search } } }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'tool_search_output', id: `tso_${ordinal}`, call_id: null, execution: 'server', status: 'completed', tools: found.map(e => e.definition) } }))
    reasoning('b')
  }
  turn.calls.forEach((call, index) => {
    const itemId = `fc_${ordinal}_${index}`
    const args = JSON.stringify(call.args)
    out.push(sse({ type: 'response.output_item.added', item: { type: 'function_call', id: itemId, call_id: call.id, name: call.name, arguments: '' } }))
    out.push(sse({ type: 'response.function_call_arguments.delta', item_id: itemId, delta: args }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'function_call', id: itemId, call_id: call.id, name: call.name, arguments: args } }))
  })
  out.push(sse({ type: 'response.completed', response: { id, usage: { input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 0 } } } }))
  return out.join('')
}
function anthropicSse(turn: Turn, ordinal: number): string {
  const usage = { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 }
  const out: string[] = [evt('message_start', { type: 'message_start', message: { id: `msg_${ordinal}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } })]
  if ('text' in turn) {
    out.push(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    out.push(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }))
    out.push(evt('content_block_stop', { type: 'content_block_stop', index: 0 }))
    out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  } else {
    turn.calls.forEach((call, index) => {
      out.push(evt('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }))
      out.push(evt('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } }))
      out.push(evt('content_block_stop', { type: 'content_block_stop', index }))
    })
    out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }))
  }
  out.push(evt('message_stop', { type: 'message_stop' }))
  return out.join('')
}
function chatSse(turn: Turn): string {
  const out: string[] = []
  const usage = { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 }
  if ('text' in turn) {
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: turn.text }, finish_reason: null }] }))
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }))
  } else {
    turn.calls.forEach((call, index) => {
      out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] }))
    })
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }))
  }
  out.push('data: [DONE]\n\n')
  return out.join('')
}

const captured: Seen[] = []
let script: Turn[] = []
let scriptCursor = 0
let deferredPool: string[] = []
const summaryTurn: Turn = { text: 'Summary: the operator listed the tools, loaded Computer and used it twice.' }
let compacting = false

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(path.startsWith('/openai/') ? JSON.stringify(MODELS_BODY) : path.startsWith('/moonshot/') ? JSON.stringify({ object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'moonshot', context_length: 1_048_576 }] }) : JSON.stringify({ object: 'list', data: [] }))
      return
    }
    let body: Body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
    } catch {
      body = {}
    }
    const dialect: Dialect | undefined = path.endsWith('/v1/messages') ? 'anthropic' : path.endsWith('/responses') ? 'responses' : path.endsWith('/chat/completions') ? 'chat' : undefined
    if (req.method !== 'POST' || dialect === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const seen = describe(captured.length + 1, dialect, body, deferredPool)
    captured.push(seen)
    const turn: Turn = compacting ? summaryTurn : script[scriptCursor++] ?? { text: 'script exhausted' }
    if ('calls' in turn) {
      for (const call of turn.calls) {
        if (deferredPool.includes(call.name) && !seen.loaded.includes(call.name) && !(turn.search ?? []).includes(call.name)) seen.violations.push(call.name)
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(dialect === 'responses' ? responsesSse(turn, seen, captured.length) : dialect === 'anthropic' ? anthropicSse(turn, captured.length) : chatSse(turn))
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MOONSHOT_API_KEY: 'fixture-moonshot-key',
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { createContentReplacementState } = await import('../../src/utils/toolResultStorage.ts')
const { compactConversation, buildPostCompactMessages } = await import('../../src/services/compact/compact.ts')
const { buildTool } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const probe = await import('../../src/services/providers/deferralProbe.ts')
const wire = await import('../../src/services/providers/deferralWire.ts')
const { __resetOpenaiCatalogueForTest } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const { recordTranscript, settleTranscriptMessage, flushSessionStorage } = await import('../../src/utils/sessionStorage/writer.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

function fixtureTool(name: string, opts: { defer?: boolean; params: string[]; result: string; hint?: string }): Tool {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of opts.params) shape[p] = z.string()
  return buildTool({
    name,
    ...(opts.defer ? { shouldDefer: true } : {}),
    ...(opts.hint ? { searchHint: opts.hint } : {}),
    inputSchema: z.object(shape),
    description: async () => `${name}: a fixture tool`,
    prompt: async () => `${name}: a fixture tool taking ${opts.params.join(', ')}`,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    call: async () => ({ data: opts.result }),
    mapToolResultToToolResultBlockParam: (output: string, toolUseID: string) => ({ tool_use_id: toolUseID, type: 'tool_result' as const, content: output }),
  } as never) as unknown as Tool
}
const COMPUTER = 'Computer'
const POOL: Tool[] = [
  fixtureTool('Read', { params: ['file_path'], result: 'the file' }),
  fixtureTool('Bash', { params: ['command'], result: 'ok' }),
  fixtureTool('Glob', { params: ['pattern'], result: 'a.ts' }),
  ToolSearchTool as never,
  fixtureTool(COMPUTER, { defer: true, params: ['action', 'label'], result: 'frontmost: Terminal', hint: 'computer use: see the screen, drive the mouse and keyboard, screenshot the desktop' }),
  fixtureTool('WebFetch', { defer: true, params: ['url'], result: 'the page', hint: 'fetches and extracts content from a URL' }),
  fixtureTool('Browser', { defer: true, params: ['url'], result: 'the browser', hint: 'drive a real browser' }),
]
const CORE = ['Read', 'Bash', 'Glob']
const DEFERRED = [COMPUTER, 'WebFetch', 'Browser']
deferredPool = DEFERRED

const allowAll = async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }) as never

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: POOL,
      engineModel: model,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    contentReplacementState: createContentReplacementState(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

type AnyMsg = Record<string, unknown> & { type?: string }
type Drive = { yields: AnyMsg[]; threw: string | undefined; wire: Seen[] }
async function drive(ctx: Record<string, unknown>, messages: Message[]): Promise<Drive> {
  const before = captured.length
  ctx.abortController = new AbortController()
  ctx.messages = messages
  const yields: AnyMsg[] = []
  let threw: string | undefined
  try {
    const gen = query({
      messages: messages as never,
      systemPrompt: ['fixture system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: allowAll as never,
      toolUseContext: ctx as never,
      querySource: 'sdk' as never,
      deps: productionDeps(),
    })
    let r = await gen.next()
    while (!r.done) {
      yields.push(r.value as AnyMsg)
      r = await gen.next()
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { yields, threw, wire: captured.slice(before) }
}
const transcriptAfter = (seed: Message[], run: Drive): Message[] => [
  ...seed,
  ...(run.yields.filter(y => y.type === 'user' || y.type === 'assistant' || y.type === 'attachment' || y.type === 'system') as unknown as Message[]),
]
const toolResultsOf = (run: Drive): Array<{ id: string; text: string; isError: boolean }> => {
  const out: Array<{ id: string; text: string; isError: boolean }> = []
  for (const y of run.yields) {
    if (y.type !== 'user') continue
    const content = (y.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result') continue
      const inner = block.content
      const text = typeof inner === 'string' ? inner : Array.isArray(inner) ? (inner as Array<Record<string, unknown>>).map(p => String(p.text ?? (p.type === 'tool_reference' ? `[ref ${String(p.tool_name)}]` : ''))).join('') : ''
      out.push({ id: String(block.tool_use_id), text, isError: block.is_error === true })
    }
  }
  return out
}
const refusalsOf = (run: Drive): string[] =>
  run.yields.flatMap(y => (y.type === 'assistant' && Array.isArray((y as { refusedToolCalls?: unknown[] }).refusedToolCalls) ? ((y as { refusedToolCalls: Array<{ reason?: string }> }).refusedToolCalls.map(r => String(r.reason ?? ''))) : []))
const ranComputer = (run: Drive): boolean => toolResultsOf(run).some(r => r.text.includes('frontmost: Terminal') && !r.isError) && refusalsOf(run).length === 0

interface Road {
  name: string
  model: string
  form: 'openai-native' | 'text' | 'text-append' | 'block'
  dialect: Dialect
  env?: Record<string, string>
  fetch: (call: Call) => Turn[]
  afterFold: 'carried' | 'searched-again'
}
let ids = 0
const callId = (prefix: string): string => `${prefix}_${++ids}`
const clientFetch = (prefix: string) => (call: Call): Turn[] => [
  { calls: [{ id: callId(`${prefix}_search`), name: TOOL_SEARCH_TOOL_NAME, args: { query: `select:${COMPUTER}` } }] },
  { calls: [call] },
]
const roads: Road[] = [
  {
    name: 'openai-native · gpt-6-astra on the Responses wire: the server loads the definition, a stateless client replays it',
    model: 'gpt-6-astra',
    form: 'openai-native',
    dialect: 'responses',
    fetch: call => [{ calls: [call], search: [COMPUTER] }],
    afterFold: 'searched-again',
  },
  {
    name: 'text · gpt-5.3-codex on the Responses wire: the admitted schema joins the tools array',
    model: 'gpt-5.3-codex',
    form: 'text',
    dialect: 'responses',
    fetch: clientFetch('call'),
    afterFold: 'carried',
  },
  {
    name: 'text-append · kimi-k3 on Moonshot: the admitted definition is appended to the conversation',
    model: 'kimi-k3',
    form: 'text-append',
    dialect: 'chat',
    fetch: clientFetch('call'),
    afterFold: 'carried',
  },
  {
    name: 'block · claude on a gateway the operator asserts passes the beta form (MERCURY_TOOL_SEARCH=1)',
    model: 'claude-opus-4-8',
    form: 'block',
    dialect: 'anthropic',
    env: { MERCURY_TOOL_SEARCH: '1' },
    fetch: clientFetch('toolu'),
    afterFold: 'searched-again',
  },
]

const only = process.argv.slice(2).filter(a => !a.startsWith('-'))
for (const road of roads) {
  if (only.length > 0 && !only.some(o => road.name.includes(o) || road.form === o)) continue
  section(road.name)
  delete process.env.MERCURY_TOOL_SEARCH
  Object.assign(process.env, road.env ?? {})
  clearToolRosterLatches()
  __resetOpenaiCatalogueForTest()
  probe._resetGatewayProbeFlightsForTesting?.()
  if (road.form === 'openai-native') {
    probe.recordGatewayProbe(probe.openaiGatewayProbeKey(`127.0.0.1:${port}`), { verdict: 'openai-native', evidence: 'http 200: fixture pass-through', status: 200, probedAt: new Date().toISOString() })
  }
  const verdict = wire.deferralWireFormFor(road.model)
  check(`the wire form reads ${road.form}`, verdict.form === road.form, `${verdict.form}/${verdict.why}`)
  const ctx = makeCtx(road.model)
  const idPrefix = road.dialect === 'anthropic' ? 'toolu' : 'call'

  script = [{ text: 'The tools are listed.' }]
  scriptCursor = 0
  let history: Message[] = [createUserMessage({ content: 'List the tools you have.' }) as Message]
  const a = await drive(ctx, history)
  check('(a) one request, no throw', a.threw === undefined && a.wire.length === 1, a.threw ?? `${a.wire.length} requests`)
  const r1 = a.wire[0]
  if (r1) {
    if (road.form === 'openai-native') {
      check('(a) the tools array carries every pool tool, the deferred ones marked, tool_search last, no ToolSearch function', CORE.every(n => r1.listed.includes(n)) && DEFERRED.every(n => r1.deferredMarks.includes(n)) && !r1.listed.includes(TOOL_SEARCH_TOOL_NAME) && toolsArrayOf(r1.body).at(-1)?.type === 'tool_search', `${r1.listed.join(',')} deferred=${r1.deferredMarks.join(',')}`)
    } else if (road.form === 'block') {
      check('(a) the tools array carries every pool tool, the deferred ones marked, ToolSearch in full', CORE.every(n => r1.listed.includes(n)) && DEFERRED.every(n => r1.deferredMarks.includes(n)) && r1.listed.includes(TOOL_SEARCH_TOOL_NAME), `${r1.listed.join(',')} deferred=${r1.deferredMarks.join(',')}`)
    } else {
      check('(a) the tools array carries the core and ToolSearch; no deferred schema', CORE.every(n => r1.listed.includes(n)) && r1.listed.includes(TOOL_SEARCH_TOOL_NAME) && DEFERRED.every(n => !r1.listed.includes(n)), r1.listed.join(','))
    }
    check('(a) no deferred definition loaded yet', r1.loaded.length === 0, r1.loaded.join(','))
  }
  history = transcriptAfter(history, a)

  script = [...road.fetch({ id: callId(`${idPrefix}_computer`), name: COMPUTER, args: { action: 'frontmost', label: 'where am I' } }), { text: 'The front window is Terminal.' }]
  scriptCursor = 0
  history.push(createUserMessage({ content: 'Which window is in front? Use Computer.' }) as Message)
  const b = await drive(ctx, history)
  const fetchRequests = road.form === 'openai-native' ? 2 : 3
  check(`(b) ${fetchRequests} requests, no throw`, b.threw === undefined && b.wire.length === fetchRequests, b.threw ?? `${b.wire.length} requests`)
  check('(c) the Computer call ran and its result came back, no refusal', ranComputer(b), JSON.stringify({ results: toolResultsOf(b), refusals: refusalsOf(b) }).slice(0, 400))
  if (road.form === 'openai-native') {
    check('(b) the hosted search found Computer among the deferred tools of the request', b.wire[0]?.searchFound?.join(',') === COMPUTER, JSON.stringify(b.wire[0]?.searchFound))
    const after = b.wire[1]
    const types = after ? inputItems(after.body).map(i => String(i.type)).join(',') : ''
    check('(c) the next request replays the loaded definition: tool_search_call, tool_search_output carrying Computer, then the call and its output', after !== undefined && after.loaded.includes(COMPUTER) && types.includes('tool_search_call,tool_search_output') && types.includes('function_call,function_call_output'), `${JSON.stringify(after?.loaded)} ${types}`)
  } else {
    const callRequest = b.wire[1]
    check('(c) the request that calls Computer carries its definition on the wire', callRequest !== undefined && callRequest.loaded.includes(COMPUTER), JSON.stringify({ loaded: callRequest?.loaded, listed: callRequest?.listed }))
  }
  check('(b)(c) no scripted call reached a wire without its definition', b.wire.every(s => s.violations.length === 0), b.wire.map(s => `${s.n}:${s.violations.join('/')}`).join(' '))
  history = transcriptAfter(history, b)

  for (const ask of ['Say hello.', 'Say hello again.']) {
    script = [{ text: 'Hello.' }]
    scriptCursor = 0
    history.push(createUserMessage({ content: ask }) as Message)
    const d = await drive(ctx, history)
    check(`(d) "${ask}": one request, no throw, the loaded definition still on the wire`, d.threw === undefined && d.wire.length === 1 && d.wire[0]!.loaded.includes(COMPUTER), d.threw ?? JSON.stringify({ requests: d.wire.length, loaded: d.wire[0]?.loaded, listed: d.wire[0]?.listed }))
    history = transcriptAfter(history, d)
  }

  script = [{ calls: [{ id: callId(`${idPrefix}_again`), name: COMPUTER, args: { action: 'screenshot', label: 'look' } }] }, { text: 'Done.' }]
  scriptCursor = 0
  history.push(createUserMessage({ content: 'Take a screenshot with Computer.' }) as Message)
  const e = await drive(ctx, history)
  check('(e) two requests, no throw', e.threw === undefined && e.wire.length === 2, e.threw ?? `${e.wire.length} requests`)
  check('(e) the definition was on the wire when the model called Computer again, no fetch', e.wire[0] !== undefined && e.wire[0].loaded.includes(COMPUTER) && e.wire[0].violations.length === 0, JSON.stringify({ loaded: e.wire[0]?.loaded, violations: e.wire[0]?.violations }))
  check('(e) the call was admitted and ran', ranComputer(e), JSON.stringify({ results: toolResultsOf(e), refusals: refusalsOf(e) }).slice(0, 400))
  history = transcriptAfter(history, e)

  const before = captured.length
  ctx.abortController = new AbortController()
  let compacted: Message[] | undefined
  let compactThrew: string | undefined
  compacting = true
  process.env.MERCURY_COMPACT_KEEP_TAIL = '0'
  try {
    const result = await compactConversation(history as never, ctx as never, { systemPrompt: ['fixture system prompt'], userContext: {}, systemContext: {}, toolUseContext: ctx, forkContextMessages: history } as never, true)
    compacted = buildPostCompactMessages(result)
  } catch (error) {
    compactThrew = error instanceof Error ? error.message : String(error)
  } finally {
    compacting = false
    delete process.env.MERCURY_COMPACT_KEEP_TAIL
  }
  check('(f) the compaction made its summary request and landed; the fetch turn is folded away', compactThrew === undefined && compacted !== undefined && captured.length > before && !compacted.some(m => m.type === 'assistant'), compactThrew ?? `${captured.length - before} requests; rows=${compacted?.map(m => m.type).join(',')}`)
  const boundary = compacted?.find(m => m.type === 'system' && (m as { subtype?: string }).subtype === 'compact_boundary') as { compactMetadata?: { preCompactDiscoveredTools?: string[] } } | undefined
  if (road.form === 'openai-native') {
    check('(f) the boundary carries no admission: the native admission is a server-side item, not a tool_reference', boundary?.compactMetadata?.preCompactDiscoveredTools === undefined, JSON.stringify(boundary?.compactMetadata?.preCompactDiscoveredTools))
  } else {
    check('(f) the boundary carries the admission (preCompactDiscoveredTools)', boundary?.compactMetadata?.preCompactDiscoveredTools?.join(',') === COMPUTER, JSON.stringify(boundary?.compactMetadata?.preCompactDiscoveredTools))
  }
  if (compacted !== undefined) history = compacted

  const afterCall: Call = { id: callId(`${idPrefix}_after`), name: COMPUTER, args: { action: 'click', label: 'the button' } }
  script = road.afterFold === 'carried' ? [{ calls: [afterCall] }, { text: 'Clicked.' }] : [...road.fetch(afterCall), { text: 'Clicked.' }]
  scriptCursor = 0
  history.push(createUserMessage({ content: 'Click the button with Computer.' }) as Message)
  const g = await drive(ctx, history)
  const foldRequests = road.afterFold === 'carried' ? 2 : fetchRequests
  check(`(g) ${foldRequests} requests after the fold, no throw`, g.threw === undefined && g.wire.length === foldRequests, g.threw ?? `${g.wire.length} requests`)
  if (road.afterFold === 'carried') {
    check('(g) the admission crossed the fold: the definition is on the wire for a direct call', g.wire[0] !== undefined && g.wire[0].loaded.includes(COMPUTER) && g.wire[0].violations.length === 0, JSON.stringify({ loaded: g.wire[0]?.loaded, listed: g.wire[0]?.listed, violations: g.wire[0]?.violations }))
  } else {
    const first = g.wire[0]
    check('(g) after the fold the tool is still offered deferred and a fresh search finds it', first !== undefined && first.deferredMarks.includes(COMPUTER) && first.loaded.length === 0 && (road.form === 'openai-native' ? first.searchFound?.join(',') === COMPUTER : g.wire[1]?.loaded.includes(COMPUTER) === true), JSON.stringify({ marks: first?.deferredMarks, loaded: first?.loaded, found: first?.searchFound, next: g.wire[1]?.loaded }))
  }
  check('(g) the call was admitted and ran after the fold', ranComputer(g) && g.wire.every(s => s.violations.length === 0), JSON.stringify({ results: toolResultsOf(g), refusals: refusalsOf(g), violations: g.wire.map(s => s.violations) }).slice(0, 400))
}

if (only.length === 0 || only.includes('writer')) {
  section('the record on disk: a settlement that lands ahead of its record is never lost, whatever the interleaving')
  const makeAssistant = (n: number) => ({
    type: 'assistant',
    uuid: `00000000-0000-4000-a000-${String(100000000000 + n)}`,
    timestamp: new Date().toISOString(),
    requestId: undefined,
    message: { id: `openai_turn_${n}`, type: 'message', role: 'assistant', model: 'gpt-6-astra', content: [{ type: 'tool_use', id: `call_${n}`, name: 'Read', input: { file_path: '/x' } }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  }) as unknown as Message
  const record = (n: number) => ({ provider: 'openai', items: [{ type: 'tool_search_call', id: `tsc_${n}`, call_id: null, execution: 'server', status: 'completed', arguments: { paths: [COMPUTER] } }, { type: 'tool_search_output', id: `tso_${n}`, call_id: null, execution: 'server', status: 'completed', tools: [{ type: 'function', name: COMPUTER, parameters: {} }] }, { type: 'function_call', call_id: `call_${n}`, name: 'Read', arguments: '{}' }] })
  const rows: Message[] = []
  const TICKS = 24
  for (let n = 0; n <= TICKS; n++) {
    const user = createUserMessage({ content: `ask ${n}` }) as Message
    const assistant = makeAssistant(n)
    rows.push(user, assistant)
    const pending = recordTranscript([...rows])
    for (let i = 0; i < n; i++) await Promise.resolve()
    ;(assistant as { apexProviderTurn?: unknown }).apexProviderTurn = record(n)
    ;(assistant as { message: { stop_reason: string | null } }).message.stop_reason = 'tool_use'
    void settleTranscriptMessage(assistant)
    await pending
  }
  await flushSessionStorage()
  await new Promise(resolve => setTimeout(resolve, 150))
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? walk(join(d, entry.name)) : [join(d, entry.name)]))
  const files = walk(join(process.env.MERCURY_CONFIG_DIR!, 'projects')).filter(f => f.endsWith('.jsonl'))
  const lines = files.flatMap(f => readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>))
  const withRecord = new Map<string, boolean>()
  for (const line of lines) {
    const payload = asRecord(line.payload)
    const uuid = String(asRecord(line.annotations)?.uuid ?? line.uuid ?? '')
    if (payload?.kind !== 'output' && line.type !== 'assistant') continue
    withRecord.set(uuid, JSON.stringify(line).includes('tool_search_output') || withRecord.get(uuid) === true)
  }
  const mine = [...Array(TICKS + 1).keys()].map(n => `00000000-0000-4000-a000-${String(100000000000 + n)}`)
  const lost = mine.filter(uuid => withRecord.get(uuid) !== true)
  check(`${TICKS + 1} assistant rows on disk, each with its turn record (the loaded definition and the calls), at every settle timing from 0 to ${TICKS} microtasks after the record`, mine.every(uuid => withRecord.has(uuid)) && lost.length === 0, `on disk=${mine.filter(uuid => withRecord.has(uuid)).length} lost=${lost.length} (${lost.map(uuid => mine.indexOf(uuid)).join(',')})`)
}

server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} LOADED-TOOL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LOADED-TOOL PROOFS PASS')
process.exit(0)
