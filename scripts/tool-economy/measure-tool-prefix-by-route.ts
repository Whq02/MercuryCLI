#!/usr/bin/env bun
// ============================================================================
//  scripts/tool-economy/measure-tool-prefix-by-route.ts — the tool-surface
//  prefix instrument: what each provider route's request carries in tool
//  schemas, read off the wire bytes the REAL lanes emit.
//
//  One loopback fixture speaks every family's dialect (the cross-family
//  matrix prover's shape); the first-party Anthropic leg rides the lane's
//  own fetch seam with the base URL UNSET, so its request is the genuine
//  api.anthropic.com shape (the control every other route is compared to).
//  The tool pool is the real assembled pool (assembleToolPool over the
//  built-ins this environment enables) plus two fixture MCP servers of
//  twelve tools each — the "standard builtin set plus two MCP servers"
//  fixture the acceptance criteria name.
//
//  Per route, two request views are captured:
//    FRESH    — a first user turn, nothing discovered yet;
//    ADMITTED — the same conversation after one ToolSearch round admitted
//               three deferred tools (two built-ins, one MCP tool).
//
//  Measured per capture: tools sent (count), tool-payload bytes (the exact
//  serialized `tools` term of the body), an estimated token figure
//  (bytes / 3.9 — the chat wire's measured ratio; labelled estimate, never a
//  billing claim), the name-only announcement (present + bytes + names
//  announced — per REQUEST, the retired prepend's cost: 0 since FN-020
//  row 1), the persisted delta row a fresh transcript's attachments pass
//  appends ONCE (names + rendered bytes — the carrier now), defer_loading
//  marks and the beta header on the Anthropic wire, whole-body bytes, and a
//  digest of the tools term. The table is
//  printed and written to scripts/tool-economy/.out/ (untracked) for the
//  receipt. Laws are the provers' business; this file is the measurement,
//  and it fails only when a route did not capture at all.
//
//  Run: ~/.bun/bin/bun run scripts/tool-economy/measure-tool-prefix-by-route.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixtureMcpTools, fixtureMcpSchemaBytes } from './fixtureMcpEstate.ts'

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
  console.log('\nTIMEOUT — the prefix instrument exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

// ── hermetic env BEFORE any src import ──────────────────────────────────────
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_WORKFLOW_ROUTING',
  'MERCURY_SIMPLE',
  'MERCURY_TOOL_SEARCH',
  'MERCURY_TOOL_DEFER',
  'GOOGLE_API_KEY',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'tool-prefix-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'tool-prefix-daemon-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Body = Record<string, unknown>
type Route =
  | 'anthropic'
  | 'anthropic-gateway'
  | 'anthropic-gateway-unprobed'
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'openai-compat'
  | 'openrouter'
  | 'gemini'
  | 'huggingface'
  | 'local'

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

function anthropicSse(): string {
  const usage = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
function responsesSse(): string {
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: 'ok' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function chatSse(): string {
  return [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 } }),
    'data: [DONE]\n\n',
  ].join('')
}

const OPENAI_MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'high', description: 'high' }],
      default_reasoning_level: 'high',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text'],
      supported_in_api: true,
    },
  ],
}

function routeOfPath(path: string): Route | undefined {
  if (path.startsWith('/v1/messages')) return 'anthropic-gateway'
  if (path.startsWith('/openai/')) return 'openai'
  if (path.startsWith('/zai/')) return 'zai'
  if (path.startsWith('/moonshot/')) return 'moonshot'
  if (path.startsWith('/deepseek/')) return 'deepseek'
  if (path.startsWith('/gemini/')) return 'gemini'
  if (path.startsWith('/openrouter/')) return 'openrouter'
  if (path.startsWith('/hf/')) return 'huggingface'
  if (path.startsWith('/localsrv/')) return 'local'
  if (path.startsWith('/compatslot/')) return 'openai-compat'
  return undefined
}

interface Capture {
  route: Route
  url: string
  headers: Record<string, string>
  body: Body
  bodyBytes: number
  /** The gateway deferral probe's own request (one fixture tool marked
   *  defer_loading, one output token) — recorded, never mistaken for the
   *  session request. */
  probe: boolean
}
const captured: Capture[] = []
let activeGatewayLeg: Route = 'anthropic-gateway'

function isProbeBody(body: Body): boolean {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return body.max_tokens === 1 && tools.length === 1 && tools[0]?.name === 'deferral_probe'
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Body = {}
    try {
      body = JSON.parse(raw) as Body
    } catch {
      body = {}
    }
    if (req.method === 'GET') {
      if (path === '/openai/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(OPENAI_MODELS_BODY))
        return
      }
      if (path === '/localsrv/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'qwen3-32b', object: 'model', owned_by: 'vllm', max_model_len: 131072 }] }))
        return
      }
      if (path === '/gemini/v1beta/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ models: [
          { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent'] },
        ] }))
        return
      }
      if (path === '/openrouter/api/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' }] }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
      return
    }
    const route = routeOfPath(path)
    if (req.method === 'POST' && route !== undefined) {
      const isAnthropic = route === 'anthropic-gateway' && path.endsWith('/v1/messages')
      const isResponses = route === 'openai' && path.endsWith('/responses')
      const isChat = path.endsWith('/chat/completions')
      if (isAnthropic || isResponses || isChat) {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k.toLowerCase()] = v
        }
        // The gateway legs share one path; the leg running right now owns
        // the capture (legs run strictly in sequence).
        const owner: Route = route === 'anthropic-gateway' ? activeGatewayLeg : route
        captured.push({ route: owner, url: path, headers, body, bodyBytes: Buffer.byteLength(raw, 'utf8'), probe: isProbeBody(body) })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(isAnthropic ? anthropicSse() : isResponses ? responsesSse() : chatSse())
        return
      }
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
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MOONSHOT_API_KEY: 'fixture-moonshot-key',
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  DEEPSEEK_API_KEY: 'fixture-deepseek-key',
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  GEMINI_API_KEY: 'fixture-gemini-key',
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  OPENROUTER_API_KEY: 'fixture-openrouter-key',
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
  HF_TOKEN: 'fixture-hf-token',
  MERCURY_COMPAT_BASE_URL: `${base}/compatslot/v1`,
  MERCURY_COMPAT_API_KEY: 'fixture-compat-key',
  MERCURY_COMPAT_MODELS: 'qwen-max',
  MERCURY_COMPAT_LABEL: 'prefix fixture endpoint',
  MERCURY_LOCAL_PROBE_TARGETS: `vllm=${base}/localsrv`,
})

console.log('============================================================')
console.log(' tool-surface prefix by route — the wire-bytes instrument')
console.log('============================================================')

// ── src imports (after env) ─────────────────────────────────────────────────
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { MCPTool } = await import('../../src/tools/MCPTool/MCPTool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { isDeferredTool, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { GLM_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/zai.ts')
const { KIMI_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/moonshot.ts')
const { DEEPSEEK_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/deepseek.ts')
const { HUGGINGFACE_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/huggingface.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
type Message = import('../../src/types/message.ts').Message
type Tool = import('../../src/Tool.ts').Tool
type Tools = import('../../src/Tool.ts').Tools

await refreshLocalDiscovery({ force: true })

// ── the two fixture MCP servers (twelve tools each, realistic schemas) ──────
const mcpTools: Tool[] = buildFixtureMcpTools<Tool>(MCPTool)
const mcpSchemaBytes = fixtureMcpSchemaBytes(mcpTools as never)

// ── the legs ────────────────────────────────────────────────────────────────
interface Leg {
  route: Route
  model: string
  /** Env applied for THIS leg only (the main-loop model rides ANTHROPIC_MODEL). */
  env: Record<string, string | undefined>
}
const LEGS: Leg[] = [
  { route: 'anthropic', model: 'claude-sonnet-5', env: { ANTHROPIC_API_KEY: 'fixture-anthropic-key', ANTHROPIC_BASE_URL: undefined } },
  // The gateway as shipped (the probe unarmed): the honest fallback form,
  // exactly what a gateway rides until (or unless) a probe has spoken.
  { route: 'anthropic-gateway-unprobed', model: 'claude-sonnet-5', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-token', ANTHROPIC_BASE_URL: base, MERCURY_TOOL_DEFER_PROBE: undefined } },
  // The gateway with the probe ARMED (MERCURY_TOOL_DEFER_PROBE=1): the FRESH
  // request rides the fallback form while the probe fires; the loopback
  // passes the beta shape (2xx), the verdict lands in the config home, and
  // the ADMITTED request rides whatever form the verdict selected.
  { route: 'anthropic-gateway', model: 'claude-sonnet-5', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-token', ANTHROPIC_BASE_URL: base, MERCURY_TOOL_DEFER_PROBE: '1' } },
  { route: 'openai', model: 'gpt-5.6-sol', env: {} },
  { route: 'zai', model: GLM_STATIC_CATALOGUE[0]!.id, env: {} },
  { route: 'moonshot', model: KIMI_STATIC_CATALOGUE[0]!.id, env: {} },
  { route: 'deepseek', model: DEEPSEEK_STATIC_CATALOGUE[0]!.id, env: {} },
  { route: 'openai-compat', model: 'compat/qwen-max', env: {} },
  { route: 'openrouter', model: 'openrouter/qwen/qwen3-coder', env: {} },
  { route: 'gemini', model: 'gemini-3-pro', env: {} },
  { route: 'huggingface', model: HUGGINGFACE_STATIC_CATALOGUE[0]!.id, env: {} },
  { route: 'local', model: 'local/qwen3-32b', env: {} },
]

const SYSTEM_PROMPT = ['You are a fixture assistant. Reply with one word.']
const permissionContext = getEmptyToolPermissionContext()

/** The first-party leg's fetch: capture the body, answer the Anthropic SSE,
 *  never touch the network. */
function firstPartyCaptureFetch(): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const headers: Record<string, string> = {}
    const h = init?.headers
    if (h instanceof Headers) h.forEach((v, k) => { headers[k.toLowerCase()] = v })
    else if (Array.isArray(h)) for (const [k, v] of h) headers[String(k).toLowerCase()] = String(v)
    else if (h && typeof h === 'object') for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v)
    const raw = typeof init?.body === 'string' ? init.body : ''
    let body: Body = {}
    try {
      body = JSON.parse(raw) as Body
    } catch {
      body = {}
    }
    captured.push({ route: 'anthropic', url, headers, body, bodyBytes: Buffer.byteLength(raw, 'utf8'), probe: isProbeBody(body) })
    return new Response(anthropicSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
}

/** The ADMITTED conversation: one ToolSearch round that admitted three
 *  deferred tools, spelled as the transcript stores it. */
function admittedConversation(admitted: string[]): Message[] {
  const assistant = createAssistantMessage({
    content: [
      { type: 'tool_use', id: 'toolu_ts_1', name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${admitted.join(',')}` } },
    ] as never,
  })
  const result = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_ts_1',
        content: admitted.map(tool_name => ({ type: 'tool_reference', tool_name })),
      },
    ] as never,
  })
  return [createUserMessage({ content: 'Plan the fixture task.' }) as Message, assistant as Message, result as Message]
}

interface Measure {
  route: Route
  model: string
  view: 'fresh' | 'admitted'
  captured: boolean
  url: string
  poolSize: number
  poolDeferrable: number
  toolSearchPooled: boolean
  toolsSent: number
  toolNames: string[]
  toolBytes: number
  estTokens: number
  announcementPresent: boolean
  announcementBytes: number
  announcedNames: number
  /** The persisted deferred_tools_delta row a fresh transcript appends ONCE
   *  (its rendered system-reminder bytes) — the carrier since FN-020 row 1. */
  deltaRowNames: number
  deltaRowBytes: number
  deferLoadingMarked: number
  betaHeader: string
  bodyBytes: number
  toolsDigest: string
  /** sha256[0:16] of the whole body with the per-process `metadata` term
   *  removed — the first-party control's identity across runs. */
  bodyDigest: string
  /** Probe requests seen on this leg (the gateway deferral probe). */
  probes: number
  error?: string
}

function isHomeWire(route: Route): boolean {
  return route === 'anthropic' || route === 'anthropic-gateway' || route === 'anthropic-gateway-unprobed'
}

function toolsOfBody(route: Route, body: Body): Array<{ name: string; deferLoading: boolean }> {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return tools.map(t => {
    if (isHomeWire(route)) {
      return { name: String(t.name ?? ''), deferLoading: t.defer_loading === true }
    }
    if (route === 'openai') return { name: String(t.name ?? ''), deferLoading: false }
    const fn = (t.function ?? {}) as Record<string, unknown>
    return { name: String(fn.name ?? t.name ?? ''), deferLoading: false }
  })
}

const ANNOUNCE_OPEN = '<available-deferred-tools>'

function announcementOf(route: Route, body: Body): { present: boolean; bytes: number; names: number } {
  const texts: string[] = []
  const collect = (content: unknown): void => {
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        const rec = part as Record<string, unknown>
        if (typeof rec?.text === 'string') texts.push(rec.text)
        if (typeof rec?.content === 'string') texts.push(rec.content)
      }
    }
  }
  if (route === 'openai') {
    for (const item of (body.input as Array<Record<string, unknown>> | undefined) ?? []) collect(item.content)
  } else {
    for (const m of (body.messages as Array<Record<string, unknown>> | undefined) ?? []) collect(m.content)
  }
  for (const t of texts) {
    const at = t.indexOf(ANNOUNCE_OPEN)
    if (at < 0) continue
    const end = t.indexOf('</available-deferred-tools>', at)
    const block = end > at ? t.slice(at, end + '</available-deferred-tools>'.length) : t.slice(at)
    const names = block.split('\n').filter(l => l.trim() !== '' && !l.startsWith('<')).length
    return { present: true, bytes: Buffer.byteLength(block, 'utf8'), names }
  }
  return { present: false, bytes: 0, names: 0 }
}

/** The delta row a fresh transcript's attachments pass would append for this
 *  pool — rendered exactly as the wire sees it (one system-reminder row). */
function deltaRowOf(pool: Tools, model: string): { names: number; bytes: number } {
  const row = getDeferredToolsDeltaAttachment(pool, model, [])[0]
  if (!row || row.type !== 'deferred_tools_delta') return { names: 0, bytes: 0 }
  const content = normalizeAttachmentForAPI(row)[0]?.message.content
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
  return { names: row.addedNames.length, bytes: Buffer.byteLength(text, 'utf8') }
}

async function drive(leg: Leg, view: 'fresh' | 'admitted', pool: Tools, admitted: string[]): Promise<Measure> {
  const before = captured.length
  const messages: Message[] =
    view === 'fresh' ? [createUserMessage({ content: 'Plan the fixture task.' }) as Message] : admittedConversation(admitted)
  const errors: string[] = []
  try {
    const stream = routedCallModel({
      messages,
      systemPrompt: SYSTEM_PROMPT as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: pool,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model: leg.model,
        isNonInteractiveSession: true,
        querySource: 'repl_main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: mcpTools,
        hasPendingMcpServers: false,
        ...(leg.route === 'anthropic' ? { fetchOverride: firstPartyCaptureFetch() as never } : {}),
      } as never,
    })
    for await (const message of stream) {
      const m = message as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
      if (m.type === 'assistant' && m.isApiErrorMessage) errors.push(JSON.stringify(m.message?.content).slice(0, 300))
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const mine = captured.slice(before).filter(c => c.route === leg.route)
  const hit = mine.find(c => !c.probe)
  const probes = mine.filter(c => c.probe).length
  const poolDeferrable = pool.filter(t => isDeferredTool(t)).length
  const toolSearchPooled = pool.some(t => t.name === TOOL_SEARCH_TOOL_NAME)
  if (!hit) {
    return {
      route: leg.route, model: leg.model, view, captured: false, url: '', poolSize: pool.length, poolDeferrable, toolSearchPooled,
      toolsSent: 0, toolNames: [], toolBytes: 0, estTokens: 0, announcementPresent: false, announcementBytes: 0, announcedNames: 0,
      deltaRowNames: 0, deltaRowBytes: 0, deferLoadingMarked: 0, betaHeader: '', bodyBytes: 0, toolsDigest: '', bodyDigest: '', probes, error: errors.join(' | ') || 'no capture',
    }
  }
  const tools = toolsOfBody(leg.route, hit.body)
  const toolsJson = JSON.stringify(hit.body.tools ?? [])
  const toolBytes = Buffer.byteLength(toolsJson, 'utf8')
  const ann = announcementOf(leg.route, hit.body)
  const deltaRow = view === 'fresh' ? deltaRowOf(pool, leg.model) : { names: 0, bytes: 0 }
  const { metadata: _metadata, ...bodySansMetadata } = hit.body
  if (leg.route === 'anthropic') {
    mkdirSync(join(import.meta.dir, '.out'), { recursive: true })
    writeFileSync(join(import.meta.dir, '.out', `first-party-${view}.json`), JSON.stringify(bodySansMetadata, null, 2))
  }
  return {
    route: leg.route,
    model: leg.model,
    view,
    captured: true,
    url: hit.url,
    poolSize: pool.length,
    poolDeferrable,
    toolSearchPooled,
    toolsSent: tools.length,
    toolNames: tools.map(t => t.name),
    toolBytes,
    estTokens: Math.round(toolBytes / 3.9),
    announcementPresent: ann.present,
    announcementBytes: ann.bytes,
    announcedNames: ann.names,
    deltaRowNames: deltaRow.names,
    deltaRowBytes: deltaRow.bytes,
    deferLoadingMarked: tools.filter(t => t.deferLoading).length,
    betaHeader: hit.headers['anthropic-beta'] ?? '',
    bodyBytes: hit.bodyBytes,
    toolsDigest: createHash('sha256').update(toolsJson).digest('hex').slice(0, 16),
    bodyDigest: createHash('sha256').update(JSON.stringify(bodySansMetadata)).digest('hex').slice(0, 16),
    probes,
    ...(errors.length > 0 ? { error: errors.join(' | ') } : {}),
  }
}

/** The probe is fire-and-forget inside the lane; the probed gateway leg
 *  waits (bounded) for its verdict to land before the next view, so the
 *  ADMITTED row reads the form the verdict selected. */
async function settleGatewayProbe(): Promise<void> {
  const file = join(process.env.MERCURY_CONFIG_DIR ?? '', 'tool-deferral-probe.json')
  for (let i = 0; i < 40; i++) {
    if (existsSync(file)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

section('§A capture every route — FRESH and ADMITTED views')
const rows: Measure[] = []
let admittedNames: string[] = []
for (const leg of LEGS) {
  for (const [k, v] of Object.entries(leg.env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.env.ANTHROPIC_MODEL = leg.model
  // The pool is assembled per leg: today's pooling predicate reads the
  // main-loop model, so a route's pool is a fact about that route.
  const pool = assembleToolPool(permissionContext, mcpTools)
  if (admittedNames.length === 0) {
    const builtins = pool.filter(t => isDeferredTool(t) && !t.isMcp).slice(0, 2).map(t => t.name)
    admittedNames = [...builtins, 'mcp__filesys__read_file']
  }
  if (leg.route === 'anthropic-gateway' || leg.route === 'anthropic-gateway-unprobed') activeGatewayLeg = leg.route
  const fresh = await drive(leg, 'fresh', pool, admittedNames)
  if (leg.route === 'anthropic-gateway') await settleGatewayProbe()
  const admitted = await drive(leg, 'admitted', pool, admittedNames)
  rows.push(fresh, admitted)
  check(`${leg.route} (${leg.model}): both views captured on the wire`, fresh.captured && admitted.captured, `${fresh.error ?? ''} ${admitted.error ?? ''}`.trim())
  for (const k of Object.keys(leg.env)) delete process.env[k]
}
delete process.env.ANTHROPIC_MODEL

// The first-party leg must have gone to the genuine host, the gateway legs
// to the loopback — the control is only a control if it is first-party.
const fp = rows.find(r => r.route === 'anthropic' && r.view === 'fresh')
const gw = rows.find(r => r.route === 'anthropic-gateway' && r.view === 'fresh')
const gwOff = rows.find(r => r.route === 'anthropic-gateway-unprobed' && r.view === 'fresh')
check('first-party leg captured at api.anthropic.com', fp?.url.includes('api.anthropic.com') === true, fp?.url ?? '')
check('gateway legs captured at the loopback', gw?.url.startsWith('/v1/messages') === true && gwOff?.url.startsWith('/v1/messages') === true, `${gw?.url ?? ''} ${gwOff?.url ?? ''}`)
check('no probe request rode the first-party or the probe-off gateway leg', (fp?.probes ?? 0) === 0 && (gwOff?.probes ?? 0) === 0 && rows.filter(r => r.route === 'anthropic-gateway-unprobed').every(r => r.probes === 0))

section('§B the table')
const fmt = (n: number): string => n.toLocaleString('en-US')
const header = '| route | model | view | pool | deferrable | ToolSearch pooled | tools sent | tool bytes | est tokens (bytes/3.9) | announced names (per request) | announcement bytes (per request) | delta row names (once) | delta row bytes (once) | defer_loading marks | beta header | body bytes | tools digest | body digest (sans metadata) | probes |'
const divider = '|---|---|---|---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|---:|'
const lines = [header, divider]
for (const r of rows) {
  lines.push(
    `| ${r.route} | ${r.model} | ${r.view} | ${r.poolSize} | ${r.poolDeferrable} | ${r.toolSearchPooled ? 'yes' : 'no'} | ${r.toolsSent} | ${fmt(r.toolBytes)} | ${fmt(r.estTokens)} | ${r.announcedNames} | ${fmt(r.announcementBytes)} | ${r.deltaRowNames} | ${fmt(r.deltaRowBytes)} | ${r.deferLoadingMarked} | ${r.betaHeader || '—'} | ${fmt(r.bodyBytes)} | ${r.toolsDigest || '—'} | ${r.bodyDigest || '—'} | ${r.probes} |`,
  )
}
console.log(lines.join('\n'))
console.log(`\nfixture MCP estate: ${mcpTools.length} tools across 2 servers, ${fmt(mcpSchemaBytes)} schema bytes (name + input_schema); admitted in the ADMITTED view: ${admittedNames.join(', ')}`)

const outDir = join(import.meta.dir, '.out')
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString()
writeFileSync(join(outDir, 'tool-prefix-by-route.json'), JSON.stringify({ stamp, admittedNames, mcpTools: mcpTools.length, mcpSchemaBytes, rows }, null, 2))
writeFileSync(
  join(outDir, 'tool-prefix-by-route.md'),
  `# tool-surface prefix by route\n\n${stamp}\n\n${lines.join('\n')}\n\nfixture MCP estate: ${mcpTools.length} tools / 2 servers / ${fmt(mcpSchemaBytes)} schema bytes; admitted: ${admittedNames.join(', ')}\n`,
)
console.log(`\nwritten: ${join(outDir, 'tool-prefix-by-route.md')}`)

server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} PREFIX INSTRUMENT CAPTURE(S) FAILED`)
  process.exit(1)
}
console.log('✅ every route captured')
process.exit(0)
