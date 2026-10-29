#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { FORBIDDEN_HEAD_WORDS, requestHeadIsPlain, requestHeadSource } from './requestHeadSource.ts'

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
  console.log('\nTIMEOUT — the announcement-stability prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE']) {
  delete process.env[k]
}
process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'announce-stab-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'announce-stab-daemon-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { planToolPayload, renderAdmissionRecordsAsText } = await import('../../src/services/providers/toolEconomy.ts')
const { getDeferredToolsDeltaAttachment, SERVER_SEARCH_ANNOUNCEMENT_HEAD } = await import('../../src/utils/attachments/deltas.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { getPrompt, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
type Tool = import('../../src/Tool.ts').Tool
type Tools = import('../../src/Tool.ts').Tools
type Message = import('../../src/types/message.ts').Message
type Attachment = import('../../src/utils/attachments/types.ts').Attachment

const ROUTE_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-sol',
  zai: 'glm-5.3',
  moonshot: 'kimi-for-coding',
  'openai-compat': 'compat/qwen-max',
  openrouter: 'openrouter/qwen/qwen3-coder',
  local: 'local/qwen3-32b',
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
const DEFERRED_BUILTINS = ['WebFetch', 'NotebookEdit', 'Browser'].map(n => fixtureTool(n, { defer: true, params: ['url', 'count'] }))
const MCP_A = ['read_file', 'write_file', 'list_directory'].map(n => fixtureTool(n, { mcp: 'filesys', params: ['path', 'pattern'] }))
const MCP_B = ['create_issue', 'list_issues'].map(n => fixtureTool(n, { mcp: 'github', params: ['owner', 'repo'] }))
const MCP_C = ['search_issues', 'get_board'].map(n => fixtureTool(n, { mcp: 'jira', params: ['project', 'query'] }))
const POOL: Tool[] = [...NON_DEFERRED, ToolSearchTool as never, ...DEFERRED_BUILTINS, ...MCP_A, ...MCP_B]
const POOL_GROWN: Tool[] = [...POOL, ...MCP_C]
const DEFERRED_NAMES = [...DEFERRED_BUILTINS, ...MCP_A, ...MCP_B].map(t => t.name)

const permissionContext = getEmptyToolPermissionContext()
const planFor = (model: string, messages: Message[], tools: Tool[] = POOL) =>
  planToolPayload({
    model,
    tools,
    messages,
    getToolPermissionContext: async () => permissionContext,
    agents: [],
    hasPendingMcpServers: false,
    source: 'proof',
  })
const fresh = (): Message[] => [createUserMessage({ content: 'Plan the fixture task.' }) as Message]

function deltaRow(tools: Tools, model: string, messages: Message[]): Attachment | null {
  const rows = getDeferredToolsDeltaAttachment(tools, model, messages)
  return rows.length === 1 ? rows[0]! : null
}
function renderedContent(row: Attachment): string {
  const rendered = normalizeAttachmentForAPI(row)
  const content = rendered[0]?.message.content
  return rendered.length === 1 && typeof content === 'string' ? content : ''
}
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

section('§1 THE ONE ANNOUNCEMENT ROAD — no flag gates it; the ToolSearch description names the carrier')
{
  check("the ToolSearch description names the carrier (system-reminder rows), not the retired header tag", getPrompt('block').includes('listed in <system-reminder> messages') && FORBIDDEN_HEAD_WORDS.every(word => !getPrompt('block').includes(word)) && getPrompt('text').includes('listed in <system-reminder> messages'))
  check('the description is one text per wire form, the same carrier sentence on each', ['block', 'text', 'text-append'].every(form => getPrompt(form as never).split('listed in <system-reminder> messages').length === 2))
}

section('§2 NO PER-REQUEST ANNOUNCEMENT — every route, and the real first-party wire')
{
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    const plan = await planFor(model, fresh())
    if (plan.wireForm === 'block') check(`${route}: deferral is on and every deferrable tool rides the roster MARKED`, plan.enabled === true && DEFERRED_NAMES.every(n => plan.roster.some(t => t.name === n) && plan.deferredNames.has(n)))
    else if (plan.wireForm === 'openai-native') check(`${route}: the provider's own deferral form — deferral is on, every deferrable tool rides the roster MARKED, Mercury's ToolSearch stays off the wire`, plan.enabled === true && DEFERRED_NAMES.every(n => plan.roster.some(t => t.name === n) && plan.deferredNames.has(n)) && !plan.roster.some(t => t.name === TOOL_SEARCH_TOOL_NAME))
    else if (plan.wireForm === 'openrouter-native') check(`${route}: deferral is on, every deferrable tool rides the roster MARKED for the server's search, Mercury's ToolSearch does not`, plan.enabled === true && DEFERRED_NAMES.every(n => plan.roster.some(t => t.name === n) && plan.deferredNames.has(n)) && !plan.roster.some(t => t.name === TOOL_SEARCH_TOOL_NAME))
    else if (plan.wireForm === 'text-append') check(`${route}: the append form sends only initial definitions and discovery (admissions ride the end of the messages)`, plan.enabled && DEFERRED_NAMES.every(name => !plan.roster.some(t => t.name === name)) && plan.admissionDeclarations.length === 0)
    else check(`${route}: the text form sends only initial definitions and discovery (an admission joins the next request's tools term)`, plan.enabled === true && plan.wireForm === 'text' && DEFERRED_NAMES.every(name => !plan.roster.some(t => t.name === name)) && DEFERRED_NAMES.every(n => plan.deferredNames.has(n)), `enabled=${plan.enabled} wire=${plan.wireForm}`)
    check(`${route}: the request builder cannot mint a tool head`, requestHeadIsPlain(route))
    check(`${route}: the first-party builder retains no retired head spelling`, FORBIDDEN_HEAD_WORDS.every(word => !requestHeadSource('anthropic').includes(word)))
    const msgs = fresh()
    check(`${route}: the admission projection leaves the operator's head unchanged`, renderAdmissionRecordsAsText(msgs)[0] === msgs[0] && JSON.stringify(renderAdmissionRecordsAsText(msgs)) === JSON.stringify(msgs))
  }
}

interface CapturedBody { messages: unknown[]; system: unknown; tools: unknown[] }
async function captureFirstParty(tools: Tools, messages: Message[]): Promise<CapturedBody | null> {
  let body: CapturedBody | null = null
  const fetchOverride = (async (_input: unknown, init?: RequestInit) => {
    const raw = typeof init?.body === 'string' ? init.body : ''
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      body = { messages: (parsed.messages as unknown[]) ?? [], system: parsed.system, tools: (parsed.tools as unknown[]) ?? [] }
    } catch {
      body = null
    }
    const usage = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
    const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
    const stream = [
      `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } })}`,
      `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}`,
      `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
      `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage })}`,
      `event: message_stop\n${sse({ type: 'message_stop' })}`,
    ].join('')
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  process.env.MERCURY_MODEL = ROUTE_MODELS.anthropic
  try {
    const stream = routedCallModel({
      messages,
      systemPrompt: ['You are a fixture assistant. Reply with one word.'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model: ROUTE_MODELS.anthropic,
        isNonInteractiveSession: true,
        querySource: 'main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
        fetchOverride: fetchOverride as never,
      } as never,
    })
    for await (const _ of stream) {
    }
  } finally {
    delete process.env.MERCURY_MODEL
  }
  return body
}
const textsOf = (messages: unknown[]): string[] => {
  const out: string[] = []
  for (const m of messages as Array<{ content?: unknown }>) {
    if (typeof m.content === 'string') out.push(m.content)
    else if (Array.isArray(m.content)) for (const part of m.content as Array<{ text?: unknown }>) if (typeof part.text === 'string') out.push(part.text)
  }
  return out
}

section('§2b THE REAL FIRST-PARTY REQUEST — no announcement text, the operator\'s turn first')
const freshBody = await captureFirstParty(POOL, fresh())
{
  check('the first-party request was captured', freshBody !== null)
  if (freshBody) {
    const texts = textsOf(freshBody.messages)
    check('no message carries the announcement tag', texts.every(t => FORBIDDEN_HEAD_WORDS.every(word => !t.includes(word))))
    check("the first message is the operator's own turn (nothing prepended)", freshBody.messages.length === 1 && texts[0] === 'Plan the fixture task.')
    const term = freshBody.tools as Array<{ name?: string; defer_loading?: boolean }>
    const toolNames = term.map(t => t.name ?? '')
    check('the tools term is the roster law: every pool tool in pool order, ToolSearch at its place', toolNames.join(',') === POOL.map(t => t.name).join(','), toolNames.join(','))
    check('the deferrable entries carry the defer_loading mark; the rest ride in full, unmarked', DEFERRED_NAMES.every(n => term.find(t => t.name === n)?.defer_loading === true) && NON_DEFERRED.every(t => term.find(x => x.name === t.name)?.defer_loading === undefined), JSON.stringify(term.map(t => [t.name, t.defer_loading ?? null])))
  }
}

section('§3 THE SAME INFORMATION, ONCE — the delta row is the carrier, on every route')
const nameLines = [...DEFERRED_NAMES].sort()
let rowBytes = 0
{
  const historical = { type: 'deferred_tools_delta' as const, addedNames: ['LegacyFixture'], addedLines: ['LegacyFixture'], removedNames: [] }
  const first = renderedContent(historical)
  check('older recorded announcements render the one deferred-tools head', first.includes('Deferred tools: offered in this session, but their definitions are not loaded.') && first.includes('LegacyFixture'))
  const current = deltaRow(POOL, ROUTE_MODELS.openai!, fresh())
  check('new announcements persist their exact body without promising an absent tool', current?.type === 'deferred_tools_delta' && typeof current.body === 'string' && !current.body.includes('via ToolSearch') && renderedContent(JSON.parse(JSON.stringify(current))) === renderedContent(current))
  check('rendering a new announcement does not change old recorded content', renderedContent(historical) === first)
}
{
  const renderedRows = new Set<string>()
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    const row = deltaRow(POOL, model, fresh())
    const routePlan = await planFor(model, fresh())
    check(`${route}: deferral is on`, routePlan.enabled === true, `wire=${routePlan.wireForm}/${routePlan.wireWhy}`)
    check(`${route}: a fresh transcript's delta row names the whole deferred pool, sorted`, row !== null && row.type === 'deferred_tools_delta' && row.addedNames.join(',') === [...DEFERRED_NAMES].sort().join(',') && row.removedNames.length === 0)
    check(`${route}: its lines are the fixture's sorted names byte-for-byte (no schema bytes)`, row !== null && row.type === 'deferred_tools_delta' && row.addedLines.join('\n') === nameLines.join('\n') && !row.addedLines.join('\n').includes('{'))
    const content = row ? renderedContent(row) : ''
    check(`${route}: rendered, it is ONE system-reminder meta user row carrying every name`, content.startsWith('<system-reminder>\n') && content.endsWith('\n</system-reminder>') && DEFERRED_NAMES.every(n => content.split('\n').includes(n)) && (row ? normalizeAttachmentForAPI(row)[0]!.isMeta === true : false))
    if (routePlan.wireForm === 'openrouter-native' || routePlan.wireForm === 'openai-native') check(`${route}: the row's head names the server's search as the loading road (its own wording, the same name lines)`, content.includes(SERVER_SEARCH_ANNOUNCEMENT_HEAD))
    else renderedRows.add(content)
    const persisted: Message[] = row ? [...fresh(), createAttachmentMessage(row) as Message] : fresh()
    check(`${route}: with the row persisted the next request announces nothing more`, getDeferredToolsDeltaAttachment(POOL, model, persisted).length === 0)
  }
  check('the rendered row is byte-identical on every route that loads through Mercury\'s ToolSearch', renderedRows.size === 1, String(renderedRows.size))
  rowBytes = bytes([...renderedRows][0] ?? '')
}

section('§4 HEAD STABILITY UNDER POOL CHANGE — a server connecting between requests moves no byte of the head')
{
  const convo = fresh()
  const firstBody = await captureFirstParty(POOL, convo)
  const grownBody = await captureFirstParty(POOL_GROWN, convo)
  check('both requests of the conversation were captured', firstBody !== null && grownBody !== null)
  if (firstBody && grownBody) {
    check('messages: byte-identical (the head did not move)', JSON.stringify(grownBody.messages) === JSON.stringify(firstBody.messages))
    check('system: byte-identical', JSON.stringify(grownBody.system) === JSON.stringify(firstBody.system))
    const firstTerm = firstBody.tools as Array<{ name?: string; defer_loading?: boolean }>
    const grownTerm = grownBody.tools as Array<{ name?: string; defer_loading?: boolean }>
    check('tools term: the frozen array is byte-identical — every entry the first request sent, in its order, with its mark', JSON.stringify(grownTerm.slice(0, firstTerm.length)) === JSON.stringify(firstTerm))
    check("the new server's tools join at the END, deferred (an unreferenced deferred tool is not part of the prefix)", grownTerm.slice(firstTerm.length).map(t => t.name).join(',') === MCP_C.map(t => t.name).join(',') && grownTerm.slice(firstTerm.length).every(t => t.defer_loading === true), grownTerm.slice(firstTerm.length).map(t => `${t.name}:${String(t.defer_loading)}`).join(','))
  }
  const model = ROUTE_MODELS.anthropic
  const first = deltaRow(POOL, model, fresh())
  const persisted: Message[] = first ? [...fresh(), createAttachmentMessage(first) as Message] : fresh()
  const second = deltaRow(POOL_GROWN, model, persisted)
  check('the delta appends one row naming ONLY the newly connected server\'s tools', second !== null && second.type === 'deferred_tools_delta' && second.addedNames.join(',') === MCP_C.map(t => t.name).sort().join(',') && second.removedNames.length === 0)
  const bothPersisted: Message[] = second ? [...persisted, createAttachmentMessage(second) as Message] : persisted
  check('…and the transcript is then quiet again', getDeferredToolsDeltaAttachment(POOL_GROWN, model, bothPersisted).length === 0)
  check('the grown request still carries no minted head', requestHeadIsPlain('anthropic') && grownBody !== null && textsOf(grownBody.messages).every(text => FORBIDDEN_HEAD_WORDS.every(word => !text.includes(word))))
  const shrunk = deltaRow(POOL, model, bothPersisted)
  check('a server dropping appends a removal row (never a head rewrite)', shrunk !== null && shrunk.type === 'deferred_tools_delta' && shrunk.removedNames.join(',') === MCP_C.map(t => t.name).sort().join(',') && shrunk.addedNames.length === 0)
}

section('§5 THE COUNT — no tool-head bytes per request')
{
  console.log(`  ONE persisted row of ${rowBytes} bytes per transcript; no minted head per request`)
  check('zero tool-head bytes per request', freshBody !== null && textsOf(freshBody.messages).every(text => FORBIDDEN_HEAD_WORDS.every(word => !text.includes(word))))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} ANNOUNCEMENT CACHE-STABILITY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL ANNOUNCEMENT CACHE-STABILITY PROOFS PASS')
process.exit(0)
