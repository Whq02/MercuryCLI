#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { buildFixtureMcpTools } from './fixtureMcpEstate.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'GOOGLE_API_KEY']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'text-route-deferral-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'text-route-deferral-daemon-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

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
  console.log('\nTIMEOUT — the text-route deferral proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

type Body = Record<string, unknown>
type Hit = { path: string; body: Body }
const hits: Hit[] = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
function chatSse(): string {
  return [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } }),
    'data: [DONE]\n\n',
  ].join('')
}
function geminiSse(): string {
  return [
    sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] } }] }),
    sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 } }),
  ].join('')
}
function fixture(): Promise<{ server: Server; base: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0] ?? ''
        const raw = Buffer.concat(chunks).toString('utf8')
        let body: Body = {}
        try {
          body = raw ? (JSON.parse(raw) as Body) : {}
        } catch {
          body = {}
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' })
          if (path === '/gemini/v1beta/models') {
            res.end(JSON.stringify({ models: [{ name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent'] }] }))
            return
          }
          res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
          return
        }
        if (req.method === 'POST' && (path.endsWith('/chat/completions') || path.endsWith(':streamGenerateContent'))) {
          hits.push({ path, body })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(path.endsWith(':streamGenerateContent') ? geminiSse() : chatSse())
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, base: `http://127.0.0.1:${port}` })
    })
  })
}

const wire = await fixture()
Object.assign(process.env, {
  MERCURY_ZAI_API_BASE: `${wire.base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_GEMINI_API_BASE: `${wire.base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${wire.base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${wire.base}/gemini/oauth/token`,
  GEMINI_API_KEY: 'fixture-gemini-key',
  MERCURY_HUGGINGFACE_API_BASE: `${wire.base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${wire.base}/hf/hub`,
  HF_TOKEN: 'fixture-hf-token',
  MERCURY_COMPAT_BASE_URL: `${wire.base}/compatslot/v1`,
  MERCURY_COMPAT_API_KEY: 'fixture-compat-key',
  MERCURY_COMPAT_MODELS: 'qwen-max',
  MERCURY_COMPAT_LABEL: 'text-route fixture endpoint',
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { MCPTool } = await import('../../src/tools/MCPTool/MCPTool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getDeferredToolsDeltaAttachment, DEFERRED_TOOLS_ANNOUNCEMENT_HEAD } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { deferralWireFormFor, DEFERRAL_WIRE_CAPABILITY, supportsToolDeferral } = await import('../../src/services/providers/deferralWire.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { clearToolRosterLatches, admissionRecordText, planToolPayload } = await import('../../src/services/providers/toolEconomy.ts')
const { getToolSearchMode } = await import('../../src/utils/toolSearch.ts')
type Tool = import('../../src/Tool.ts').Tool
type Tools = import('../../src/Tool.ts').Tools
type Message = import('../../src/types/message.ts').Message

const permissionContext = getEmptyToolPermissionContext()
const TEXT_ROUTE_MODELS: Record<string, string> = {
  zai: 'glm-5.3',
  xai: 'grok-5',
  meta: 'muse-spark',
  'openai-compat': 'compat/qwen-max',
  gemini: 'gemini-3-pro',
  huggingface: 'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813',
  mistral: 'mistral-large-3',
  nous: 'nous/nousresearch/hermes-4-405b',
  zen: 'zen/fixture-model',
  minimax: 'minimax-m2.7',
  together: 'together/qwen/qwen3-coder-480b',
  cohere: 'command-a-03-2025',
  groq: 'groq/openai/gpt-oss-120b',
  melious: 'melious/fixture-model',
  orcarouter: 'orcarouter/fixture/model',
  cerebras: 'cerebras/llama-3.3-70b',
  fireworks: 'fireworks/accounts/fireworks/models/kimi-k2',
  qwen: 'qwen3-coder-plus',
}
const OPENAI_TEXT_MODEL = 'gpt-5.3-codex'

function fixtureTool(name: string, opts: { defer?: boolean; mcp?: string; params?: string[]; doc?: string } = {}): Tool {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const p of opts.params ?? ['path']) shape[p] = z.string()
  const inputSchema = z.object(shape)
  const doc = opts.doc ?? `${name}: a fixture tool with ${Object.keys(shape).join(', ')}`
  return {
    name: opts.mcp ? `mcp__${opts.mcp}__${name}` : name,
    ...(opts.mcp ? { isMcp: true, mcpInfo: { serverName: opts.mcp, toolName: name } } : {}),
    ...(opts.defer ? { shouldDefer: true } : {}),
    prompt: async () => doc,
    description: async () => doc,
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
const CORE_NAMES = [...NON_DEFERRED.map(t => t.name), TOOL_SEARCH_TOOL_NAME]
const planFor = (model: string, messages: Message[], extra: { tools?: Tool[]; hasPendingMcpServers?: boolean; latchKey?: string } = {}) =>
  planToolPayload({
    model,
    tools: extra.tools ?? POOL,
    messages,
    getToolPermissionContext: async () => permissionContext,
    agents: [],
    hasPendingMcpServers: extra.hasPendingMcpServers ?? false,
    source: 'proof',
    ...(extra.latchKey !== undefined ? { latchKey: extra.latchKey } : {}),
  })
const fresh = (): Message[] => [createUserMessage({ content: 'begin' }) as Message]
function admission(id: string, names: string[]): Message[] {
  return [
    createAssistantMessage({ content: [{ type: 'tool_use', id, name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${names.join(',')}` } }] as never }) as Message,
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content: names.map(tool_name => ({ type: 'tool_reference', tool_name })) }] as never }) as Message,
  ]
}
function boundary(route: string, carried: string[]): Message {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: `boundary-${route}`,
    timestamp: new Date().toISOString(),
    content: 'compacted',
    compactMetadata: { trigger: 'auto', preTokens: 1, preCompactDiscoveredTools: carried },
  } as unknown as Message
}
const names = (plan: { roster: readonly Tool[] }): string => plan.roster.map(t => t.name).join(',')

section('§0 THE TABLE — every text row has a representative id here, and every id declares its route and reads the text form')
const textRoutes = Object.entries(DEFERRAL_WIRE_CAPABILITY).filter(([, c]) => c === 'text').map(([r]) => r).sort()
{
  const named = Object.keys(TEXT_ROUTE_MODELS).sort()
  check(`the text rows of the table are exactly the routes this proof drives (${textRoutes.length})`, textRoutes.join(',') === named.join(','), `table: ${textRoutes.join(',')} · proof: ${named.join(',')}`)
  for (const [route, model] of Object.entries(TEXT_ROUTE_MODELS)) {
    const verdict = deferralWireFormFor(model)
    check(`${route}: ${model} declares the route and reads text / route-table`, declaredRouteOf(model) === route && verdict.form === 'text' && verdict.why === 'route-table', `${String(declaredRouteOf(model))} ${verdict.form}/${verdict.why}`)
  }
  const openaiText = deferralWireFormFor(OPENAI_TEXT_MODEL)
  check(`${OPENAI_TEXT_MODEL} is the openai route's text form (the control every text route is compared to)`, declaredRouteOf(OPENAI_TEXT_MODEL) === 'openai' && openaiText.form === 'text' && openaiText.why === 'model-below-native-floor', `${openaiText.form}/${openaiText.why}`)
  check('the text form carries deferral on every text route and on the openai text form', Object.values(TEXT_ROUTE_MODELS).every(model => supportsToolDeferral(model, 'text')) && supportsToolDeferral(OPENAI_TEXT_MODEL, 'text') && supportsToolDeferral('kimi-k2.6', 'text') && supportsToolDeferral('deepseek-v4-pro', 'text'))
  check('the home lane keeps the whole roster on a text-form gateway (its wire binds thinking to the tools term, and the ledger reads an admitted schema as a rewrite); an unrecognised id rides that lane and absence has no wire', supportsToolDeferral('claude-sonnet-5', 'text') === false && supportsToolDeferral('mystery-model-9000', 'text') === false && supportsToolDeferral('', 'text') === false && supportsToolDeferral('claude-sonnet-5', 'block') === true)
}

section('§1 THE FIRST REQUEST — on every text route the plan defers: the never-deferred set in full, every deferred name in the persisted row')
for (const [route, model] of Object.entries(TEXT_ROUTE_MODELS)) {
  clearToolRosterLatches()
  const plan = await planFor(model, fresh())
  check(`${route}: deferral is on in the text form`, plan.enabled === true && plan.wireForm === 'text', `enabled=${plan.enabled} wire=${plan.wireForm}/${plan.wireWhy}`)
  check(`${route}: the roster is the never-deferred set in pool order with ToolSearch at its place, no deferred schema`, names(plan) === CORE_NAMES.join(','), names(plan))
  check(`${route}: every deferrable tool is marked deferred`, [...plan.deferredNames].sort().join(',') === [...DEFERRED_NAMES].sort().join(','), [...plan.deferredNames].sort().join(','))
  check(`${route}: nothing is admitted on a fresh transcript and every deferred tool waits for admission`, plan.admittedNames.size === 0 && DEFERRED_NAMES.every(n => plan.isDeferredUnadmitted(n)))
  const row = getDeferredToolsDeltaAttachment(POOL, model, fresh())[0]
  const rendered = row ? normalizeAttachmentForAPI(row) : []
  const content = rendered[0]?.message.content
  check(`${route}: the fresh transcript gets the name row — every deferred tool by name, sorted, no schema bytes`, row !== undefined && row.type === 'deferred_tools_delta' && row.addedNames.join(',') === [...DEFERRED_NAMES].sort().join(',') && !row.addedLines.join('\n').includes('{'), row === undefined ? 'no row' : '')
  check(`${route}: the row renders as one meta row whose head names ToolSearch as the loading road`, rendered.length === 1 && rendered[0]!.isMeta === true && typeof content === 'string' && content.includes(DEFERRED_TOOLS_ANNOUNCEMENT_HEAD))
  check(`${route}: with the row persisted the next request announces nothing more`, row !== undefined && getDeferredToolsDeltaAttachment(POOL, model, [...fresh(), createAttachmentMessage(row) as Message]).length === 0)
}

section('§2 THE ADMISSION — a select: loads a deferred tool and the next request carries its schema; the rest stay out')
for (const [route, model] of Object.entries(TEXT_ROUTE_MODELS)) {
  clearToolRosterLatches()
  const convo = fresh()
  const first = await planFor(model, convo, { latchKey: 'proof' })
  const admitted = ['WebFetch', 'mcp__filesys__read_file']
  const next = await planFor(model, [...convo, ...admission(`toolu_${route}_1`, admitted)], { latchKey: 'proof' })
  check(`${route}: the next request carries the first roster followed by exactly the admitted tools, in admission order`, names(next) === `${names(first)},${admitted.join(',')}`, names(next))
  check(`${route}: the admitted tools are no longer unadmitted; every other deferred tool still is`, admitted.every(n => !next.isDeferredUnadmitted(n)) && DEFERRED_NAMES.filter(n => !admitted.includes(n)).every(n => next.isDeferredUnadmitted(n)))
  check(`${route}: the admitted set is read from the transcript`, [...next.admittedNames].sort().join(',') === [...admitted].sort().join(','))
  check(`${route}: the marks are re-sent as first sent`, [...next.deferredNames].sort().join(',') === [...first.deferredNames].sort().join(','))
  const again = await planFor(model, [...convo, ...admission(`toolu_${route}_1`, admitted), createAssistantMessage({ content: 'ok' }) as Message, createUserMessage({ content: 'go on' }) as Message, ...admission(`toolu_${route}_2`, ['WebFetch'])], { latchKey: 'proof' })
  check(`${route}: re-admitting an admitted tool adds nothing`, names(again) === names(next), names(again))
  clearToolRosterLatches()
}

section('§3 THE FREEZE — the roster never grows on a request\'s own initiative: a dropped tool still rides, a joiner waits, a plain turn is byte-identical')
for (const [route, model] of Object.entries(TEXT_ROUTE_MODELS)) {
  clearToolRosterLatches()
  const convo = fresh()
  const first = await planFor(model, convo, { latchKey: 'proof' })
  const plain = await planFor(model, [...convo, createAssistantMessage({ content: 'ok' }) as Message, createUserMessage({ content: 'and again' }) as Message], { latchKey: 'proof' })
  check(`${route}: a later plain turn sends the same array`, names(plain) === names(first) && [...plain.deferredNames].sort().join(',') === [...first.deferredNames].sort().join(','), names(plain))
  const shrunk = await planFor(model, convo, { latchKey: 'proof', tools: POOL.filter(t => t.name !== 'Glob') })
  check(`${route}: a tool the pool dropped still rides the frozen array`, names(shrunk) === names(first), names(shrunk))
  const joinerDeferred = fixtureTool('search_boards', { mcp: 'jira', params: ['project'] })
  const joinerPlain = fixtureTool('Later')
  const grown = await planFor(model, convo, { latchKey: 'proof', tools: [...POOL, joinerDeferred, joinerPlain] })
  check(`${route}: a deferrable joiner is marked deferred and rides as a name only; a plain joiner is held; no schema joins the array`, names(grown) === names(first) && grown.deferredNames.has(joinerDeferred.name) && !grown.roster.some(t => t.name === joinerPlain.name), names(grown))
  clearToolRosterLatches()
}

section('§4 THE COMPACTION BOUNDARY — the loaded set is carried into the new conversation\'s first request')
for (const [route, model] of Object.entries(TEXT_ROUTE_MODELS)) {
  clearToolRosterLatches()
  const carried = ['Browser', 'mcp__github__get_issue']
  const compacted: Message[] = [boundary(route, carried), createUserMessage({ content: 'summary of the work so far' }) as Message]
  const plan = await planFor(model, compacted, { latchKey: 'proof' })
  check(`${route}: the first request after the fold carries the core set followed by the carried tools`, names(plan) === `${CORE_NAMES.join(',')},${carried.join(',')}`, names(plan))
  check(`${route}: the carried tools are admitted and unmarked; every other deferred tool is still deferred`, carried.every(n => plan.admittedNames.has(n) && !plan.deferredNames.has(n) && !plan.isDeferredUnadmitted(n)) && DEFERRED_NAMES.filter(n => !carried.includes(n)).every(n => plan.deferredNames.has(n)))
  const later = await planFor(model, [...compacted, createAssistantMessage({ content: 'ok' }) as Message, createUserMessage({ content: 'go on' }) as Message], { latchKey: 'proof' })
  check(`${route}: the next request of the folded conversation keeps that array`, names(later) === names(plan), names(later))
  const row = getDeferredToolsDeltaAttachment(POOL, model, compacted)[0]
  check(`${route}: the name row after the fold names only the tools still deferred`, row !== undefined && row.type === 'deferred_tools_delta' && carried.every(n => !row.addedNames.includes(n)) && DEFERRED_NAMES.filter(n => !carried.includes(n)).every(n => row.addedNames.includes(n)), row === undefined ? 'no row' : row.type === 'deferred_tools_delta' ? row.addedNames.join(',') : row.type)
  clearToolRosterLatches()
}

section('§5 THE OFF ARM — MERCURY_TOOL_SEARCH=0 turns deferral off and the whole roster rides again, on every text route')
process.env.MERCURY_TOOL_SEARCH = '0'
check('MERCURY_TOOL_SEARCH=0 reads standard mode', getToolSearchMode() === 'standard')
for (const [route, model] of Object.entries(TEXT_ROUTE_MODELS)) {
  clearToolRosterLatches()
  const plan = await planFor(model, [...fresh(), ...admission('toolu_off', ['WebFetch'])])
  check(`${route}: deferral off ⇒ every tool in full minus ToolSearch, nothing marked, nothing admitted`, plan.enabled === false && names(plan) === POOL.filter(t => t.name !== TOOL_SEARCH_TOOL_NAME).map(t => t.name).join(',') && plan.deferredNames.size === 0 && plan.admittedNames.size === 0, names(plan))
  check(`${route}: deferral off ⇒ no name row`, getDeferredToolsDeltaAttachment(POOL, model, fresh()).length === 0)
}
delete process.env.MERCURY_TOOL_SEARCH
clearToolRosterLatches()
check('the flag read is live: deferral returns once the switch lifts', (await planFor(TEXT_ROUTE_MODELS.zai!, fresh())).enabled === true)

section('§6 THE AUTO MODE — the percentage threshold gives every text route the verdict the openai text form gets')
{
  const bigDoc = 'x'.repeat(200_000)
  const BIG_POOL: Tool[] = [...NON_DEFERRED, ToolSearchTool as never, ...['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map(n => ({ ...fixtureTool(n, { defer: true, doc: bigDoc }), inputJSONSchema: { type: 'object', properties: { path: { type: 'string', description: bigDoc } }, required: ['path'] } }) as unknown as Tool)]
  for (const [flag, expectSmall, expectBig] of [['auto:0', true, true], ['auto:100', false, false], ['auto:3', false, true]] as const) {
    process.env.MERCURY_TOOL_SEARCH = flag
    clearToolRosterLatches()
    const controlSmall = await planFor(OPENAI_TEXT_MODEL, fresh())
    const controlBig = await planFor(OPENAI_TEXT_MODEL, fresh(), { tools: BIG_POOL })
    check(`${flag}: the openai text form reads ${expectSmall ? 'on' : 'off'} for the small pool and ${expectBig ? 'on' : 'off'} for the big one`, controlSmall.enabled === expectSmall && controlBig.enabled === expectBig, `small=${controlSmall.enabled} big=${controlBig.enabled}`)
    for (const [route, model] of Object.entries(TEXT_ROUTE_MODELS)) {
      clearToolRosterLatches()
      const small = await planFor(model, fresh())
      const big = await planFor(model, fresh(), { tools: BIG_POOL })
      check(`${flag}: ${route} reads the same verdicts (small ${small.enabled ? 'on' : 'off'}, big ${big.enabled ? 'on' : 'off'})`, small.enabled === controlSmall.enabled && big.enabled === controlBig.enabled && (!big.enabled || (big.wireForm === 'text' && names(big) === CORE_NAMES.join(','))), `small=${small.enabled} big=${big.enabled} wire=${big.wireForm}`)
    }
    delete process.env.MERCURY_TOOL_SEARCH
  }
  clearToolRosterLatches()
}

section('§7 THE WIRE — the stand-in model on the loopback: the compat slot, Z.AI, Gemini and Hugging Face carry the text form as the lanes send it')
type WireTool = { name: string; hasSchema: boolean }
function wireTools(body: Body): WireTool[] {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return tools.flatMap(t => {
    if (Array.isArray(t.functionDeclarations)) {
      return (t.functionDeclarations as Array<Record<string, unknown>>).map(d => ({ name: String(d.name ?? ''), hasSchema: typeof d.parametersJsonSchema === 'object' || typeof d.parameters === 'object' }))
    }
    const fn = (t.function ?? {}) as Record<string, unknown>
    return [{ name: String(fn.name ?? t.name ?? ''), hasSchema: typeof fn.parameters === 'object' && fn.parameters !== null }]
  })
}
const toolsJson = (body: Body): string => JSON.stringify(body.tools ?? [])
const bodyText = (body: Body): string => JSON.stringify(body.messages ?? body.contents ?? [])
const fmt = (n: number): string => n.toLocaleString('en-US')
const mcpTools: Tool[] = buildFixtureMcpTools<Tool>(MCPTool)
async function drive(model: string, pool: Tools, messages: Message[]): Promise<{ body: Body | undefined; chats: number; error: string | undefined }> {
  const before = hits.length
  const errors: string[] = []
  try {
    const stream = routedCallModel({
      messages,
      systemPrompt: ['You are a fixture assistant. Reply with one word.'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: pool,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model,
        isNonInteractiveSession: true,
        querySource: 'main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools,
        hasPendingMcpServers: false,
      } as never,
    })
    for await (const message of stream) {
      const m = message as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
      if (m.type === 'assistant' && m.isApiErrorMessage) errors.push(JSON.stringify(m.message?.content).slice(0, 300))
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const chats = hits.slice(before)
  return { body: chats[chats.length - 1]?.body, chats: chats.length, error: errors.length > 0 ? errors.join(' | ') : undefined }
}
const WIRE_LEGS: Array<[string, string]> = [
  ['openai-compat', 'compat/qwen-max'],
  ['zai', 'glm-5.3'],
  ['gemini', 'gemini-3-pro'],
  ['huggingface', 'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813'],
]
for (const [route, model] of WIRE_LEGS) {
  console.log(`\n  ── ${route} (${model}) ──`)
  process.env.MERCURY_MODEL = model
  clearToolRosterLatches()
  const pool: Tools = assembleToolPool(permissionContext, mcpTools)
  const poolNames = pool.map(t => t.name)
  const deferred = pool.filter(t => isDeferredToolFor(t, model)).map(t => t.name)
  const core = pool.filter(t => !isDeferredToolFor(t, model)).map(t => t.name)
  const first = createUserMessage({ content: 'say pong' }) as Message
  const nameRow = getDeferredToolsDeltaAttachment(pool, model, [first])[0]
  const opening: Message[] = [first, ...(nameRow ? (normalizeAttachmentForAPI(nameRow) as Message[]) : [])]
  const freshRun = await drive(model, pool, opening)
  const freshNames = freshRun.body ? wireTools(freshRun.body).map(t => t.name) : []
  check(`${route}: one request rode the wire, no refusal`, freshRun.chats === 1 && freshRun.error === undefined && freshRun.body !== undefined, freshRun.error ?? `chats=${freshRun.chats}`)
  check(`${route}: the tools term is exactly the never-deferred set in pool order, ToolSearch at its place (${core.length} of ${pool.length})`, freshNames.join(',') === core.join(','), freshNames.join(','))
  check(`${route}: every tool on the term carries its schema; no deferred tool is on it`, freshRun.body !== undefined && wireTools(freshRun.body).every(t => t.hasSchema) && deferred.every(n => !freshNames.includes(n)))
  const text = freshRun.body ? bodyText(freshRun.body) : ''
  const missing = poolNames.filter(n => !freshNames.includes(n) && !text.includes(n))
  check(`${route}: every pool tool is on the wire — a schema for the core, a name in the row for the rest`, missing.length === 0, missing.join(','))
  const freshBytes = freshRun.body ? Buffer.byteLength(toolsJson(freshRun.body), 'utf8') : 0
  const builtinPick = deferred.includes('WebFetch') ? 'WebFetch' : pool.find(t => isDeferredToolFor(t, model) && t.isMcp !== true)!.name
  const admitted = [builtinPick, 'mcp__filesys__read_file']
  const block = ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: admitted, query: `select:${admitted.join(',')}`, total_deferred_tools: deferred.length } as never, 'toolu_ts_1')
  const transcript: Message[] = [
    ...opening,
    createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${admitted.join(',')}` } }] as never }) as Message,
    createUserMessage({ content: [block] as never }) as Message,
  ]
  const next = await drive(model, pool, transcript)
  const nextNames = next.body ? wireTools(next.body).map(t => t.name) : []
  check(`${route}: the request after the admission rode the wire, no refusal`, next.chats === 1 && next.error === undefined && next.body !== undefined, next.error ?? `chats=${next.chats}`)
  check(`${route}: its tools term is the fresh term followed by exactly the admitted schemas`, nextNames.join(',') === [...core, ...admitted].join(','), nextNames.join(','))
  const nextText = next.body ? bodyText(next.body) : ''
  check(`${route}: the admission record rides as text naming the admitted tools, and no tool_reference block reaches the wire`, nextText.includes(admissionRecordText(admitted).split('\n')[0]!) && admitted.every(n => nextText.includes(`- ${n}`)) && !nextText.includes('tool_reference'))
  check(`${route}: every other deferred tool still has no schema on the wire`, deferred.filter(n => !admitted.includes(n)).every(n => !nextNames.includes(n)))
  const later = await drive(model, pool, [...transcript, createAssistantMessage({ content: 'pong' }) as Message, createUserMessage({ content: 'and again' }) as Message])
  check(`${route}: a later plain turn keeps the tools term byte-identical`, later.error === undefined && next.body !== undefined && later.body !== undefined && toolsJson(later.body) === toolsJson(next.body), later.error ?? '')
  clearToolRosterLatches()
  const compacted: Message[] = [boundary(route, [builtinPick]), createUserMessage({ content: 'summary of the work so far' }) as Message]
  const after = await drive(model, pool, compacted)
  const afterNames = after.body ? wireTools(after.body).map(t => t.name) : []
  check(`${route}: the first request after a fold carries the core followed by the carried ${builtinPick}`, after.error === undefined && afterNames.join(',') === [...core, builtinPick].join(','), after.error ?? afterNames.join(','))
  process.env.MERCURY_TOOL_SEARCH = '0'
  clearToolRosterLatches()
  const off = await drive(model, pool, [createUserMessage({ content: 'say pong (off arm)' }) as Message])
  delete process.env.MERCURY_TOOL_SEARCH
  clearToolRosterLatches()
  const offNames = off.body ? wireTools(off.body).map(t => t.name) : []
  check(`${route}: MERCURY_TOOL_SEARCH=0 ⇒ every pool tool rides in full, minus ToolSearch`, off.error === undefined && offNames.join(',') === poolNames.filter(n => n !== TOOL_SEARCH_TOOL_NAME).join(','), off.error ?? offNames.join(','))
  const offBytes = off.body ? Buffer.byteLength(toolsJson(off.body), 'utf8') : 0
  console.log(`  ${route}: deferring ${freshNames.length} schemas / ${fmt(freshBytes)} tool bytes · whole roster ${offNames.length} schemas / ${fmt(offBytes)} tool bytes`)
  check(`${route}: the deferring request carries under half the whole roster's tool bytes`, freshBytes > 0 && offBytes > 0 && freshBytes * 2 < offBytes, `${freshBytes} vs ${offBytes}`)
}
delete process.env.MERCURY_MODEL

wire.server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} TEXT-ROUTE DEFERRAL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TEXT-ROUTE DEFERRAL PROOFS PASS')
process.exit(0)
