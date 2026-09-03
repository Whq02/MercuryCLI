#!/usr/bin/env bun
// ============================================================================
//  scripts/tool-economy/prove-announcement-cache-stability.ts — FN-020 row 1:
//  the deferred-tools announcement rides the transcript ONCE (a persisted
//  deferred_tools_delta row), never the request head.
//
//  Why: the per-request <available-deferred-tools> prepend was a function of
//  the live deferred pool, so every pool change — an MCP server connecting
//  mid-turn (the pending-to-connected hold), a reconnect, a disconnect,
//  apollo entry/exit — rewrote the request head and busted the provider's
//  cached conversation prefix on every route. The delta row is history: it
//  is appended once and never moves.
//
//    §1 THE GATE ROW — mercury_glacier_2xr is pinned true in FORK_GATE_TABLE
//       (the table's documented pin point, a reviewed source change); the
//       flag resolves true; the ToolSearch description names the carrier.
//    §2 NO PER-REQUEST ANNOUNCEMENT — on every route the plan's announcement
//       is null; the Anthropic-wire spelling prepends nothing; the chat and
//       Responses spelling folds nothing (the same array by reference); a
//       REAL first-party request body carries no announcement text, its
//       first message is the operator's own turn, and its tools term is
//       the whole pool — the deferrable entries marked defer_loading, the
//       rest in full (a wire that cannot defer lists everything unmarked).
//    §3 THE SAME INFORMATION, ONCE — a fresh transcript's delta row names the
//       whole deferred pool, sorted, names only; its lines are the prepend
//       oracle's inner lines byte-for-byte; rendered it is ONE system-
//       reminder meta user row, identical on every route; once persisted,
//       the next request emits nothing.
//    §4 HEAD STABILITY UNDER POOL CHANGE (the cache law) — a third MCP server
//       connecting between two requests of ONE conversation changes NOT ONE
//       BYTE of the request head (messages, system, the frozen tools array)
//       on the real first-party wire; the new server's tools join at the
//       END, deferred (an unreferenced deferred tool is not part of the
//       prefix); the delta appends one row naming only the new tools. The
//       prepend oracle, carried verbatim, shows the head the old shape
//       rewrote.
//    §5 THE COUNT — announcement bytes per request: before (the oracle) N
//       bytes on EVERY request; after 0 per request plus ONE persisted row.
//
//  Run: ~/.bun/bin/bun run scripts/tool-economy/prove-announcement-cache-stability.ts
// ============================================================================
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
  console.log('\nTIMEOUT — the announcement-stability prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

// ── hermetic env BEFORE any src import ──────────────────────────────────────
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'ANTHROPIC_MODEL', 'MERCURY_SCRIPTED_STREAM']) {
  delete process.env[k]
}
process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key'
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'announce-stab-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'announce-stab-daemon-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { planToolPayload, deferredToolsAnnouncement, announcementMessage, foldAnnouncementIntoFirstUserTurn } = await import('../../src/services/providers/toolEconomy.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { isDeferredToolsDeltaEnabled } = await import('../../src/utils/toolSearchFlags.ts')
const { getFeatureValue_CACHED_MAY_BE_STALE } = await import('../../src/services/analytics/featureGates.ts')
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
  'openai-compat': 'compat/qwen-max',
  openrouter: 'openrouter/qwen/qwen3-coder',
  local: 'local/qwen3-32b',
}

// ── the fixture pool ────────────────────────────────────────────────────────
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
// The server that connects LATE (the pending-to-connected bust of the old shape).
const MCP_C = ['search_issues', 'get_board'].map(n => fixtureTool(n, { mcp: 'jira', params: ['project', 'query'] }))
const POOL: Tool[] = [...NON_DEFERRED, ToolSearchTool as never, ...DEFERRED_BUILTINS, ...MCP_A, ...MCP_B]
const POOL_GROWN: Tool[] = [...POOL, ...MCP_C]
const DEFERRED_NAMES = [...DEFERRED_BUILTINS, ...MCP_A, ...MCP_B].map(t => t.name)
const DEFERRED_NAMES_GROWN = [...DEFERRED_NAMES, ...MCP_C.map(t => t.name)]

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

/** The delta row a transcript's next attachments pass would append. */
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

section('§1 THE GATE ROW — the pin point holds the reviewed decision')
{
  const gates = readFileSync(join(ROOT, 'src/services/analytics/featureGates.ts'), 'utf8')
  const table = gates.slice(gates.indexOf('const FORK_GATE_TABLE'), gates.indexOf('\n}\n', gates.indexOf('const FORK_GATE_TABLE')))
  check('FORK_GATE_TABLE pins mercury_glacier_2xr: true (a source pin, the documented pin point)', /^\s*mercury_glacier_2xr: true,/m.test(table))
  check('the gate resolves true through the getter', getFeatureValue_CACHED_MAY_BE_STALE('mercury_glacier_2xr', false) === true)
  check('the deferral flag reads it (the delta path is on)', isDeferredToolsDeltaEnabled() === true)
  check("the ToolSearch description names the carrier (system-reminder rows), not the retired header tag", getPrompt('block').includes('inside <system-reminder> messages') && !getPrompt('block').includes('<available-deferred-tools>') && getPrompt('text').includes('inside <system-reminder> messages'))
  const flags = readFileSync(join(ROOT, 'src/utils/toolSearchFlags.ts'), 'utf8')
  check('the inline default stays false (an unpinned table restores the prepend byte-for-byte)', /'mercury_glacier_2xr', false\)/.test(flags))
}

section('§2 NO PER-REQUEST ANNOUNCEMENT — every route, and the real first-party wire')
{
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    const plan = await planFor(model, fresh())
    if (plan.wireForm === 'block') check(`${route}: deferral is on and every deferrable tool rides the roster MARKED`, plan.enabled === true && DEFERRED_NAMES.every(n => plan.roster.some(t => t.name === n) && plan.deferredNames.has(n)))
    else check(`${route}: a wire that cannot defer lists every tool in full, unmarked (deferral off)`, plan.enabled === false && DEFERRED_NAMES.every(n => plan.roster.some(t => t.name === n)) && plan.deferredNames.size === 0)
    check(`${route}: the plan carries NO per-request announcement`, plan.announcement === null)
    check(`${route}: the Anthropic-wire spelling prepends nothing`, announcementMessage(plan) === null)
    const msgs = fresh()
    check(`${route}: the chat/Responses spelling folds nothing (the same array by reference)`, foldAnnouncementIntoFirstUserTurn(msgs, plan) === msgs)
  }
}

interface CapturedBody { messages: unknown[]; system: unknown; tools: unknown[] }
/** Drive the REAL first-party lane against a capturing fetch; returns the body. */
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
  process.env.ANTHROPIC_MODEL = ROUTE_MODELS.anthropic
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
        querySource: 'repl_main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
        fetchOverride: fetchOverride as never,
      } as never,
    })
    for await (const _ of stream) {
      // drain
    }
  } finally {
    delete process.env.ANTHROPIC_MODEL
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
    check('no message carries the announcement tag', texts.every(t => !t.includes('<available-deferred-tools>')))
    check("the first message is the operator's own turn (nothing prepended)", freshBody.messages.length === 1 && texts[0] === 'Plan the fixture task.')
    const term = freshBody.tools as Array<{ name?: string; defer_loading?: boolean }>
    const toolNames = term.map(t => t.name ?? '')
    check('the tools term is the roster law: every pool tool in pool order, ToolSearch at its place', toolNames.join(',') === POOL.map(t => t.name).join(','), toolNames.join(','))
    check('the deferrable entries carry the defer_loading mark; the rest ride in full, unmarked', DEFERRED_NAMES.every(n => term.find(t => t.name === n)?.defer_loading === true) && NON_DEFERRED.every(t => term.find(x => x.name === t.name)?.defer_loading === undefined), JSON.stringify(term.map(t => [t.name, t.defer_loading ?? null])))
  }
}

section('§3 THE SAME INFORMATION, ONCE — the delta row is the carrier, on every route')
const oracle = deferredToolsAnnouncement(POOL, new Set(DEFERRED_NAMES))
const oracleLines = oracle === null ? [] : oracle.split('\n').slice(1, -1)
let rowBytes = 0
{
  const renderedRows = new Set<string>()
  check('the prepend oracle (the retired per-request shape) spells the sorted names inside the tag pair', oracle !== null && oracle.startsWith('<available-deferred-tools>\n') && oracle.endsWith('\n</available-deferred-tools>') && oracleLines.join(',') === [...DEFERRED_NAMES].sort().join(','))
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    const row = deltaRow(POOL, model, fresh())
    check(`${route}: a fresh transcript's delta row names the whole deferred pool, sorted`, row !== null && row.type === 'deferred_tools_delta' && row.addedNames.join(',') === [...DEFERRED_NAMES].sort().join(',') && row.removedNames.length === 0)
    check(`${route}: its lines are the oracle's inner lines byte-for-byte (names only, no schema bytes)`, row !== null && row.type === 'deferred_tools_delta' && row.addedLines.join('\n') === oracleLines.join('\n') && !row.addedLines.join('\n').includes('{'))
    const content = row ? renderedContent(row) : ''
    check(`${route}: rendered, it is ONE system-reminder meta user row carrying every name`, content.startsWith('<system-reminder>\n') && content.endsWith('\n</system-reminder>') && DEFERRED_NAMES.every(n => content.split('\n').includes(n)) && (row ? normalizeAttachmentForAPI(row)[0]!.isMeta === true : false))
    renderedRows.add(content)
    const persisted: Message[] = row ? [...fresh(), createAttachmentMessage(row) as Message] : fresh()
    check(`${route}: with the row persisted the next request announces nothing more`, getDeferredToolsDeltaAttachment(POOL, model, persisted).length === 0)
  }
  check('the rendered row is byte-identical on every route', renderedRows.size === 1, String(renderedRows.size))
  rowBytes = bytes([...renderedRows][0] ?? '')
}

section('§4 HEAD STABILITY UNDER POOL CHANGE — a server connecting between requests moves no byte of the head')
{
  // ONE conversation, two requests (the same first row keys the roster
  // latch): the frozen head holds; the new server's tools join at the end.
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
  // The transcript that already carries the first row learns ONLY the new server.
  const model = ROUTE_MODELS.anthropic
  const first = deltaRow(POOL, model, fresh())
  const persisted: Message[] = first ? [...fresh(), createAttachmentMessage(first) as Message] : fresh()
  const second = deltaRow(POOL_GROWN, model, persisted)
  check('the delta appends one row naming ONLY the newly connected server\'s tools', second !== null && second.type === 'deferred_tools_delta' && second.addedNames.join(',') === MCP_C.map(t => t.name).sort().join(',') && second.removedNames.length === 0)
  const bothPersisted: Message[] = second ? [...persisted, createAttachmentMessage(second) as Message] : persisted
  check('…and the transcript is then quiet again', getDeferredToolsDeltaAttachment(POOL_GROWN, model, bothPersisted).length === 0)
  check('the grown plan still carries no per-request announcement', (await planFor(model, bothPersisted, POOL_GROWN)).announcement === null)
  // The oracle shows the bust the old shape paid: its head bytes tracked the pool.
  const oracleGrown = deferredToolsAnnouncement(POOL_GROWN, new Set(DEFERRED_NAMES_GROWN))
  check('the prepend oracle\'s bytes moved with the pool (the old head rewrote on every such connect)', oracle !== null && oracleGrown !== null && oracleGrown !== oracle)
  // A disconnect: the row records the departure; the head still does not move.
  const shrunk = deltaRow(POOL, model, bothPersisted)
  check('a server dropping appends a removal row (never a head rewrite)', shrunk !== null && shrunk.type === 'deferred_tools_delta' && shrunk.removedNames.join(',') === MCP_C.map(t => t.name).sort().join(',') && shrunk.addedNames.length === 0)
}

section('§5 THE COUNT — announcement bytes per request, before and after')
{
  const before = oracle === null ? 0 : bytes(oracle)
  const requests = 10
  console.log(`  BEFORE (the prepend oracle): ${before} bytes on EVERY request — ${before * requests} bytes over ${requests} requests, and a head rewrite on every pool change`)
  console.log(`  AFTER  (the delta row):      0 bytes per request; ONE persisted row of ${rowBytes} bytes per transcript — ${rowBytes} bytes over ${requests} requests, head rewrites 0`)
  check('before: the oracle carried the names on every request (non-zero per request)', before > 0)
  check('after: zero announcement bytes per request', freshBody !== null && textsOf(freshBody.messages).every(t => !t.includes('<available-deferred-tools>')))
  check('after: the one-time row costs less than two requests of the old prepend', rowBytes > 0 && rowBytes < 2 * before, `${rowBytes} vs ${before}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} ANNOUNCEMENT CACHE-STABILITY PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL ANNOUNCEMENT CACHE-STABILITY PROOFS PASS')
process.exit(0)
