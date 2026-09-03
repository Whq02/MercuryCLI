#!/usr/bin/env bun
// ============================================================================
//  scripts/tool-economy/prove-deferral-every-route.ts — tool deferral is a
//  Mercury-side context-assembly law that holds on EVERY provider route.
//
//    §1 THE ROSTER LAW — every tool rides every request from the first: on
//       the block wire (first-party) the deferrable ones ride MARKED
//       (defer_loading — the API's own deferred loading) beside ToolSearch,
//       the rest in full; a wire that cannot defer lists every tool in full
//       with deferral off and no ToolSearch. The name-only announcement
//       rides the transcript ONCE as a persisted delta row (FN-020 row 1 —
//       never the request head), byte-identical across routes.
//    §1b THE FREEZE — for a conversation's life the array never grows,
//       shrinks or reorders on a request's own initiative: an admission
//       moves nothing, a dropped tool still rides, a deferrable joiner is
//       appended at the END (deferred) under a deferring latch, and every
//       other joiner is held until the next compaction or /clear.
//    §2 ADMISSION IS INERT ON THE WIRE — over N distinct ToolSearch
//       admissions the tools term changes ZERO times (the tool_reference
//       expands server-side against the definition already on the wire),
//       the roster never shrinks, and the admitted set is derived from the
//       transcript (a compaction boundary's snapshot keeps it) on the wire
//       that defers; a text wire admits nothing because nothing is deferred.
//    §3 PENDING-SERVER HONESTY — with nothing deferred but a server still
//       connecting, ToolSearch stays on every route; the no-match result
//       names the connecting server; with nothing pending it steps aside.
//    §4 TYPED REFUSALS — an unresolvable name refuses typed naming the
//       discovery path on the text-form gate AND the Anthropic executor's
//       sentence; a deferred-but-unadmitted tool called with arguments that
//       satisfy its schema EXECUTES (deferral is an economy, never a
//       capability reduction); one called blind with arguments that miss the
//       schema refuses typed naming the admission road — and the Anthropic
//       executor's schema-not-sent hint answers the same case on its wire.
//    §5 THE SUBAGENT BOUND — a child inheriting the parent's whole pool
//       (both MCP servers included) sends the array the parent sends — the
//       deferrable entries marked, their context cost deferred until
//       referenced — plus the name lines once; the parent's admissions
//       never leak into it.
//    §6 THE OFF ARM — MERCURY_TOOL_DEFER=0 inlines the whole catalogue on
//       every route, unpools ToolSearch and announces nothing.
//    §7 THE LANE CENSUS (static) — every runtime that assembles a tools term
//       builds it from the plan's roster; no lane hands the raw pool to its
//       schema builder; every routed family reaches one of those runtimes.
//
//  Run: ~/.bun/bin/bun run scripts/tool-economy/prove-deferral-every-route.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
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

delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'ANTHROPIC_MODEL']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'deferral-route-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const { planToolPayload, deferredToolsAnnouncement, announcementMessage, foldAnnouncementIntoFirstUserTurn, clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { gateToolCall, toolCallRefusalNote, toolCallRefusalCorrection, schemaNotSentSentence } = await import('../../src/services/providers/toolCallGate.ts')
const { buildSchemaNotSentHint } = await import('../../src/services/tools/toolExecution.ts')
const { fingerprintCacheablePrefix } = await import('../../src/services/api/prefixFingerprint.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { isToolSearchEnabledOptimistic, extractDiscoveredToolNames } = await import('../../src/utils/toolSearch.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
type Tool = import('../../src/Tool.ts').Tool
type Message = import('../../src/types/message.ts').Message

const ROUTE_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.6-sol',
  zai: 'glm-5.3',
  moonshot: 'kimi-k3',
  deepseek: 'deepseek-v4-pro',
  'openai-compat': 'compat/qwen-max',
  openrouter: 'openrouter/qwen/qwen3-coder',
  gemini: 'gemini-3-pro',
  huggingface: 'huggingface/deepseek-ai/DeepSeek-V4-Pro-0813',
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
const DEFERRED_BUILTINS = ['WebFetch', 'NotebookEdit', 'Browser', 'Blender', 'Debug'].map(n => fixtureTool(n, { defer: true, params: ['url', 'count'] }))
const MCP_A = ['read_file', 'write_file', 'list_directory', 'search_files'].map(n => fixtureTool(n, { mcp: 'filesys', params: ['path', 'pattern'] }))
const MCP_B = ['create_issue', 'list_issues', 'get_issue'].map(n => fixtureTool(n, { mcp: 'github', params: ['owner', 'repo'] }))
const POOL: Tool[] = [...NON_DEFERRED, ToolSearchTool as never, ...DEFERRED_BUILTINS, ...MCP_A, ...MCP_B]
const DEFERRED_NAMES = [...DEFERRED_BUILTINS, ...MCP_A, ...MCP_B].map(t => t.name)

const permissionContext = getEmptyToolPermissionContext()
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

/** One ToolSearch round admitting `names`, spelled as the transcript stores it. */
function admission(id: string, names: string[]): Message[] {
  return [
    createAssistantMessage({
      content: [{ type: 'tool_use', id, name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${names.join(',')}` } }] as never,
    }) as Message,
    createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: id, content: names.map(tool_name => ({ type: 'tool_reference', tool_name })) }] as never,
    }) as Message,
  ]
}

async function toolsTermDigest(roster: readonly Tool[], model: string): Promise<string> {
  const schemas = await Promise.all(
    roster.map(tool =>
      toolToAPISchema(tool, { getToolPermissionContext: async () => permissionContext, tools: roster as never, agents: [], model }),
    ),
  )
  return fingerprintCacheablePrefix({ systemBlocks: [], tools: schemas }).segments[0]!.digest
}

section('§1 THE ROSTER LAW — every route, the same roster; the announcement rides the transcript once, never the request')
{
  const renderedRows = new Set<string>()
  const oracle = deferredToolsAnnouncement(POOL, new Set(DEFERRED_NAMES))
  const oracleLines = oracle === null ? [] : oracle.split('\n').slice(1, -1)
  const blockRoutes: string[] = []
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    check(`${route}: ${model} declares the route`, declaredRouteOf(model) === route)
    const plan = await planFor(model, fresh())
    const names = plan.roster.map(t => t.name)
    if (plan.wireForm === 'block') {
      blockRoutes.push(route)
      check(`${route}: the block wire defers (deferral is on)`, plan.enabled === true, `wire=${plan.wireForm}/${plan.wireWhy}`)
      check(`${route}: the roster is EVERY pool tool in pool order — ToolSearch at its place, the deferrable ones riding marked`, names.join(',') === POOL.map(t => t.name).join(','), names.join(','))
    } else {
      check(`${route}: a wire that cannot defer lists everything in full (deferral is off)`, plan.enabled === false, `wire=${plan.wireForm}/${plan.wireWhy}`)
      check(`${route}: the roster is every pool tool in pool order minus ToolSearch (nothing to search)`, names.join(',') === POOL.filter(t => t.name !== TOOL_SEARCH_TOOL_NAME).map(t => t.name).join(','), names.join(','))
    }
    check(`${route}: every deferrable tool rides the request (an economy, never an omission)`, DEFERRED_NAMES.every(n => names.includes(n)))
    check(`${route}: no per-request announcement rides (the persisted delta row is the carrier — FN-020 row 1)`, plan.announcement === null)
    const row = getDeferredToolsDeltaAttachment(POOL, model, fresh())[0]
    check(`${route}: a fresh transcript's delta row names every deferred tool, sorted, names only`, row !== undefined && row.type === 'deferred_tools_delta' && row.addedNames.join(',') === [...DEFERRED_NAMES].sort().join(',') && row.addedLines.join('\n') === oracleLines.join('\n') && !row.addedLines.join('\n').includes('{'))
    const rendered = row ? normalizeAttachmentForAPI(row) : []
    const content = rendered[0]?.message.content
    check(`${route}: …rendered as ONE meta system-reminder user row`, rendered.length === 1 && rendered[0]!.isMeta === true && typeof content === 'string' && content.startsWith('<system-reminder>\n'))
    if (typeof content === 'string') renderedRows.add(content)
    check(`${route}: with the row persisted the next request announces nothing more`, row !== undefined && getDeferredToolsDeltaAttachment(POOL, model, [...fresh(), createAttachmentMessage(row) as Message]).length === 0)
    check(`${route}: the marks — ${plan.wireForm === 'block' ? "exactly the fixture's deferred tools" : 'none on a text wire'}`, [...plan.deferredNames].sort().join(',') === (plan.wireForm === 'block' ? [...DEFERRED_NAMES].sort().join(',') : ''))
  }
  check("the block wire is the first-party route alone (deferral rides the API's own deferred loading)", blockRoutes.join(',') === 'anthropic', blockRoutes.join(','))
  check('the delta row is byte-identical on every route', renderedRows.size === 1, String(renderedRows.size))
  check('the prepend oracle (the retired per-request shape, kept as the oracle) still spells the sorted name list inside the tag pair', oracle !== null && oracle.startsWith('<available-deferred-tools>\n') && oracle.endsWith('\n</available-deferred-tools>') && oracleLines.join(',') === [...DEFERRED_NAMES].sort().join(','))
  const plan = await planFor('gpt-5.6-sol', fresh())
  check('the Anthropic-wire spelling prepends nothing (no synthetic first user message)', announcementMessage(plan) === null)
  const msgs = fresh()
  check('the chat/Responses spelling folds nothing (the same array by reference — the first user turn is untouched)', foldAnnouncementIntoFirstUserTurn(msgs, plan) === msgs)
}
section('§1b THE FREEZE — the array and every mark byte-identical across consecutive requests; a joiner appends at the end, deferred')
{
  const JOINER_DEFERRED = fixtureTool('search_boards', { mcp: 'jira', params: ['project'] })
  const JOINER_PLAIN = fixtureTool('Later')
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    clearToolRosterLatches()
    // ONE conversation: the same first row keys the latch on every request.
    const convo = fresh()
    const first = await planFor(model, convo, { latchKey: 'proof' })
    const firstNames = first.roster.map(t => t.name).join(',')
    const firstMarks = [...first.deferredNames].sort().join(',')
    const again = await planFor(model, [...convo, ...admission(`toolu_${route}_freeze`, ['WebFetch'])], { latchKey: 'proof' })
    check(`${route}: the second request's array is byte-identical — an admission moves nothing`, again.roster.map(t => t.name).join(',') === firstNames, again.roster.map(t => t.name).join(','))
    check(`${route}: …and every mark is re-sent as first sent`, [...again.deferredNames].sort().join(',') === firstMarks)
    const shrunk = await planFor(model, convo, { latchKey: 'proof', tools: POOL.filter(t => t.name !== 'WebFetch') })
    check(`${route}: a tool the pool dropped still rides the frozen array (never a shrink)`, shrunk.roster.map(t => t.name).join(',') === firstNames, shrunk.roster.map(t => t.name).join(','))
    const grown = await planFor(model, convo, { latchKey: 'proof', tools: [...POOL, JOINER_DEFERRED, JOINER_PLAIN] })
    const grownNames = grown.roster.map(t => t.name).join(',')
    if (first.enabled) {
      check(`${route}: a deferrable joiner is appended at the END, deferred; a non-deferrable joiner is HELD`, grownNames === `${firstNames},${JOINER_DEFERRED.name}` && grown.deferredNames.has(JOINER_DEFERRED.name) && !grownNames.includes(JOINER_PLAIN.name), grownNames)
    } else {
      check(`${route}: under a non-deferring latch every joiner is HELD (the array never grows)`, grownNames === firstNames, grownNames)
    }
    clearToolRosterLatches()
  }
}

section('§2 ADMISSION IS INERT ON THE WIRE — N distinct admissions ⇒ zero payload changes, never a shrink; the admitted set is the transcript\'s')
{
  const steps: string[][] = [['WebFetch'], ['mcp__filesys__read_file'], ['Browser', 'mcp__github__create_issue'], ['NotebookEdit']]
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    let messages = fresh()
    const base = await planFor(model, messages)
    const baseNames = base.roster.map(t => t.name).join(',')
    let previous = new Set(base.roster.map(t => t.name))
    let digest = await toolsTermDigest(base.roster, model)
    let changes = 0
    let monotone = true
    let whole = true
    const admittedSoFar = new Set<string>()
    for (let i = 0; i < steps.length; i++) {
      messages = [...messages, ...admission(`toolu_${route}_${i}`, steps[i]!)]
      for (const n of steps[i]!) admittedSoFar.add(n)
      const plan = await planFor(model, messages)
      const names = new Set(plan.roster.map(t => t.name))
      if (![...previous].every(n => names.has(n))) monotone = false
      if (plan.roster.map(t => t.name).join(',') !== baseNames) whole = false
      const next = await toolsTermDigest(plan.roster, model)
      if (next !== digest) changes++
      digest = next
      previous = names
    }
    check(`${route}: ${steps.length} distinct admissions changed the tools term ZERO times (the definition is already on the wire)`, changes === 0, String(changes))
    check(`${route}: the roster never shrank`, monotone)
    check(`${route}: after each step the roster is the whole array the first request sent`, whole)
    // A repeated admission is a no-op on the payload.
    const repeated = [...messages, ...admission(`toolu_${route}_rep`, ['WebFetch'])]
    const planRep = await planFor(model, repeated)
    check(`${route}: re-admitting an admitted tool changes nothing`, (await toolsTermDigest(planRep.roster, model)) === digest)
    // A compaction boundary snapshot carries the admitted set forward.
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: `boundary-${route}`,
      timestamp: new Date().toISOString(),
      content: 'compacted',
      compactMetadata: { trigger: 'auto', preTokens: 1, preCompactDiscoveredTools: [...admittedSoFar].sort() },
    } as unknown as Message
    const afterCompact = [boundary, createUserMessage({ content: 'summary' }) as Message]
    const planCompact = await planFor(model, afterCompact)
    if (base.enabled) {
      check(`${route}: a compaction boundary keeps every admission (the snapshot is the record)`, [...planCompact.admittedNames].sort().join(',') === [...admittedSoFar].sort().join(','))
    } else {
      check(`${route}: a text wire admits nothing — nothing is deferred there (the snapshot is carried, never read)`, planCompact.admittedNames.size === 0 && (await planFor(model, messages)).admittedNames.size === 0)
    }
    check(`${route}: the admitted set is derived from the transcript, not held in memory`, [...extractDiscoveredToolNames(messages)].sort().join(',') === [...admittedSoFar].sort().join(','))
  }
}

section('§3 PENDING-SERVER HONESTY — a connecting server keeps ToolSearch, on every route')
{
  const nothingDeferred = [...NON_DEFERRED, ToolSearchTool as never]
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    const pending = await planFor(model, fresh(), { tools: nothingDeferred, hasPendingMcpServers: true })
    if (pending.wireForm === 'block') {
      check(`${route}: nothing deferred + a server still connecting ⇒ ToolSearch stays (the model can discover its tools once they land)`, pending.enabled === true && pending.roster.some(t => t.name === TOOL_SEARCH_TOOL_NAME) && pending.announcement === null)
    } else {
      check(`${route}: a wire that cannot defer keeps ToolSearch aside even with a server connecting (its tools join the array at the next lawful boundary)`, pending.enabled === false && !pending.roster.some(t => t.name === TOOL_SEARCH_TOOL_NAME) && pending.announcement === null)
    }
    const settled = await planFor(model, fresh(), { tools: nothingDeferred, hasPendingMcpServers: false })
    check(`${route}: nothing deferred + nothing pending ⇒ ToolSearch steps aside`, settled.enabled === false && !settled.roster.some(t => t.name === TOOL_SEARCH_TOOL_NAME))
  }
  const noMatch = ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: [], query: 'x', total_deferred_tools: 0, pending_mcp_servers: ['filesys'] } as never, 'toolu_p')
  check('the no-match result names the connecting server, in the same sentence on every wire (it is text)', typeof noMatch.content === 'string' && noMatch.content.includes('still connecting: filesys'))
}

section('§4 TYPED REFUSALS — the discovery path is named, the economy never refuses a real call')
{
  const messages = fresh()
  // The admission road exists on the wire that defers (the block form); a
  // text wire lists every schema in full and never names it.
  const plan = await planFor(ROUTE_MODELS.anthropic!, messages)
  const hints = { deferredUnadmitted: plan.isDeferredUnadmitted }
  const textPlan = await planFor('gpt-5.6-sol', messages)
  check('a text wire lists every schema in full: nothing is ever deferred-unadmitted there', textPlan.isDeferredUnadmitted('WebFetch') === false && textPlan.deferredNames.size === 0)
  const unknown = gateToolCall(POOL as never, { id: 'c1', name: 'Nonexistent', argumentsRaw: '{}', malformed: false }, hints)
  check('an unresolvable name refuses typed (unknown-tool)', !unknown.ok && unknown.refusal.code === 'unknown-tool')
  check('…and the note names the discovery path', !unknown.ok && /ToolSearch/.test(toolCallRefusalNote('openai', unknown.refusal)) && /No such tool available: Nonexistent/.test(toolCallRefusalNote('openai', unknown.refusal)))
  const executorSentence = readFileSync(join(ROOT, 'src/services/tools/toolExecution.ts'), 'utf8')
  check("the Anthropic executor's unknown-tool sentence is the same core sentence and names ToolSearch too", /No such tool available: \$\{requestedName\}[^`]*ToolSearch/.test(executorSentence))
  const blindOk = gateToolCall(POOL as never, { id: 'c2', name: 'WebFetch', argumentsRaw: '{"url":"https://x","count":"3"}', malformed: false }, hints)
  check('a deferred-but-unadmitted tool called with arguments that satisfy its schema EXECUTES (economy, never a capability reduction)', blindOk.ok === true && plan.isDeferredUnadmitted('WebFetch') === true)
  const blindMiss = gateToolCall(POOL as never, { id: 'c3', name: 'WebFetch', argumentsRaw: '{"url":"https://x"}', malformed: false }, hints)
  check('one called blind with arguments that miss the schema refuses typed (schema)', !blindMiss.ok && blindMiss.refusal.code === 'schema')
  check('…naming the admission road (ToolSearch select:<name>)', !blindMiss.ok && blindMiss.refusal.reason.includes(schemaNotSentSentence('WebFetch')) && /select:WebFetch/.test(blindMiss.refusal.reason))
  check('…and the model-visible correction carries it', !blindMiss.ok && toolCallRefusalCorrection([blindMiss.refusal]).includes('select:WebFetch'))
  const admittedPlan = await planFor(ROUTE_MODELS.anthropic!, [...messages, ...admission('toolu_a', ['WebFetch'])])
  const admittedMiss = gateToolCall(POOL as never, { id: 'c4', name: 'WebFetch', argumentsRaw: '{"url":"https://x"}', malformed: false }, { deferredUnadmitted: admittedPlan.isDeferredUnadmitted })
  check('once admitted, a schema miss is an ordinary schema refusal (no admission road named)', !admittedMiss.ok && !admittedMiss.refusal.reason.includes('select:WebFetch'))
  const nonDeferredMiss = gateToolCall(POOL as never, { id: 'c5', name: 'Read', argumentsRaw: '{}', malformed: false }, hints)
  check('a non-deferred tool never names the road', !nonDeferredMiss.ok && !nonDeferredMiss.refusal.reason.includes('select:'))
  // The Anthropic executor's hint answers the same case on its wire — on every route.
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    process.env.ANTHROPIC_MODEL = model
    const hint = buildSchemaNotSentHint(DEFERRED_BUILTINS[0]!, messages, POOL as never)
    check(`${route}: the schema-not-sent hint fires for an unadmitted deferred tool`, hint !== null && /select:WebFetch/.test(hint ?? ''))
    const none = buildSchemaNotSentHint(DEFERRED_BUILTINS[0]!, [...messages, ...admission('toolu_h', ['WebFetch'])], POOL as never)
    check(`${route}: …and stays silent once admitted`, none === null)
  }
  delete process.env.ANTHROPIC_MODEL
}

section('§5 THE SUBAGENT BOUND — inheriting the whole pool costs the non-deferred schemas plus ONE name-lines row')
{
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    const parent = await planFor(model, [...fresh(), ...admission('toolu_parent', ['Browser', 'mcp__github__list_issues'])])
    const child = await planFor(model, fresh())
    check(`${route}: the child's array is the parent's array (the deferrable entries marked alike, their context cost deferred until referenced)`, child.roster.map(t => t.name).join(',') === parent.roster.map(t => t.name).join(',') && [...child.deferredNames].sort().join(',') === [...parent.deferredNames].sort().join(','))
    check(`${route}: the parent's admissions do not leak into the child (admission is per conversation)`, child.admittedNames.size === 0 && parent.admittedNames.size === (parent.enabled ? 2 : 0))
    check(`${route}: the child's request carries no announcement bytes (the row is the carrier)`, child.announcement === null)
    const row = getDeferredToolsDeltaAttachment(POOL, model, fresh())[0]
    const lineBytes = DEFERRED_NAMES.reduce((a, n) => a + Buffer.byteLength(n, 'utf8'), 0) + (DEFERRED_NAMES.length - 1)
    check(`${route}: the child's deferred cost is exactly the name lines (${lineBytes} bytes), paid once as the persisted row`, row !== undefined && row.type === 'deferred_tools_delta' && Buffer.byteLength(row.addedLines.join('\n'), 'utf8') === lineBytes)
    check(`${route}: …and zero on the next request`, row !== undefined && getDeferredToolsDeltaAttachment(POOL, model, [...fresh(), createAttachmentMessage(row) as Message]).length === 0)
  }
}
section('§6 THE OFF ARM — MERCURY_TOOL_DEFER=0 reproduces the inlined catalogue on every route')
{
  process.env.MERCURY_TOOL_DEFER = '0'
  check('ToolSearch is unpooled everywhere', isToolSearchEnabledOptimistic() === false && ToolSearchTool.isEnabled() === false)
  for (const [route, model] of Object.entries(ROUTE_MODELS)) {
    const plan = await planFor(model, [...fresh(), ...admission('toolu_off', ['WebFetch'])])
    check(`${route}: deferral off ⇒ the whole catalogue rides, minus ToolSearch, nothing announced`, plan.enabled === false && plan.roster.length === POOL.length - 1 && !plan.roster.some(t => t.name === TOOL_SEARCH_TOOL_NAME) && plan.announcement === null && plan.deferredNames.size === 0)
  }
  delete process.env.MERCURY_TOOL_DEFER
  const back = await planFor(ROUTE_MODELS.anthropic!, fresh())
  check('the flag read is live (deferral returns on the block wire once the kill lifts)', back.enabled === true)
}

section('§7 THE LANE CENSUS — every tools term is built from the plan')
{
  const lanes = [
    'src/services/providers/openai/openaiCallModel.ts',
    'src/services/providers/zai/zaiCallModel.ts',
    'src/services/providers/openaicompat/compatChatCallModel.ts',
  ]
  for (const lane of lanes) {
    const src = readFileSync(join(ROOT, lane), 'utf8')
    check(`${lane}: consumes the plan owner`, /planToolPayload\(\{/.test(src) && /from '\.\.\/toolEconomy\.js'/.test(src))
    check(`${lane}: builds its tools term from plan.roster`, /buildApiShapedTools\(plan\.roster,/.test(src))
    check(`${lane}: never hands the raw pool to its schema builder`, !/buildApiShapedTools\(tools,/.test(src))
    check(`${lane}: renders admission records as text and folds the announcement`, /renderAdmissionRecordsAsText\(messages\)/.test(src) && /foldAnnouncementIntoFirstUserTurn\(/.test(src))
    check(`${lane}: the gate carries the admission predicate`, /deferredUnadmitted: plan\.isDeferredUnadmitted/.test(src) && /\{ deferredUnadmitted: ctx\.deferredUnadmitted \}/.test(src))
  }
  const core = readFileSync(join(ROOT, 'src/services/providers/anthropic/streamCore.ts'), 'utf8')
  check('streamCore: consumes the plan owner', /planToolPayload\(\{/.test(core) && /const filteredTools: Tools = plan\.roster/.test(core))
  check('streamCore: the beta header and defer_loading ride the block form only', /useToolSearch && blockForm \? getToolSearchBetaHeader\(\) : null/.test(core) && /const willDefer = \(t: Tool\) => useToolSearch && blockForm && deferredToolNames\.has\(t\.name\)/.test(core))
  check('streamCore: the text form renders admission records as text', /else if \(!blockForm\) \{[\s\S]*renderAdmissionRecordsAsText\(messagesForAPI\)/.test(core))
  check('streamCore: the announcement is the plan\'s message', /announcementMessage\(plan\)/.test(core) && !/<available-deferred-tools>\\n\$\{deferredToolList\}/.test(core))
  // Every routed family reaches one of the plan-consuming runtimes.
  const router = readFileSync(join(ROOT, 'src/services/providers/callModelRouter.ts'), 'utf8')
  const compatLanes = ['moonshot', 'deepseek', 'openrouter', 'gemini', 'huggingface', 'local']
  for (const lane of compatLanes) {
    const file = join(ROOT, `src/services/providers/${lane}/${lane}CallModel.ts`)
    const src = readFileSync(file, 'utf8')
    check(`${lane}: rides the shared compat chat runtime (a plan consumer)`, /compatChatCallModel\(/.test(src) || /from '\.\.\/openaicompat\/compatChatCallModel\.js'/.test(src))
  }
  const compat = readFileSync(join(ROOT, 'src/services/providers/openaicompat/compatCallModel.ts'), 'utf8')
  check('openai-compat: rides the shared compat chat runtime', /compatChatCallModel\(/.test(compat))
  check('the router dispatches every declared route to a lane file (no family reaches a wire outside the census)', ['zai', 'openai', 'moonshot', 'deepseek', 'openai-compat', 'openrouter', 'gemini', 'huggingface', 'local', 'anthropic'].every(r => new RegExp(`case '${r}':`).test(router)))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} DEFERRAL EVERY-ROUTE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL DEFERRAL EVERY-ROUTE PROOFS PASS')
process.exit(0)
