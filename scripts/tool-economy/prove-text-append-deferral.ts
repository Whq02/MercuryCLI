#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixtureMcpTools } from './fixtureMcpEstate.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_DISABLE_1M_CONTEXT']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'text-append-deferral-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'text-append-deferral-daemon-'))
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
  console.log('\nTIMEOUT — the text-append deferral proof exceeded 120s')
  process.exit(1)
}, 120_000)
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
        if (req.method === 'GET' && path === '/moonshot/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'moonshot', context_length: 1048576 }, { id: 'kimi-k2.6', object: 'model', owned_by: 'moonshot' }] }))
          return
        }
        if (req.method === 'POST' && path.endsWith('/chat/completions')) {
          hits.push({ path, body })
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(chatSse())
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
  MERCURY_MOONSHOT_API_BASE: `${wire.base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${wire.base}/moonshot/oauth`,
  MOONSHOT_API_KEY: 'fixture-moonshot-key',
  MERCURY_ZAI_API_BASE: `${wire.base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
})

const KIMI = 'kimi-k3'
const GLM = 'glm-5.3'
process.env.MERCURY_MODEL = KIMI

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
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { supportsToolDeferral, deferralWireFormFor, DEFERRAL_WIRE_CAPABILITY } = await import('../../src/services/providers/deferralWire.ts')
const { clearToolRosterLatches, admissionRecordText, planToolPayload } = await import('../../src/services/providers/toolEconomy.ts')
await (await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')).refreshMoonshotCatalogue({ force: true })
type Tool = import('../../src/Tool.ts').Tool
type Tools = import('../../src/Tool.ts').Tools
type Message = import('../../src/types/message.ts').Message

const permissionContext = getEmptyToolPermissionContext()
const mcpTools: Tool[] = buildFixtureMcpTools<Tool>(MCPTool)
const pool: Tools = assembleToolPool(permissionContext, mcpTools)
const poolNames = pool.map(t => t.name)
const isDeferredTool = (t: Tool): boolean => isDeferredToolFor(t, KIMI)
const deferredNames = pool.filter(t => isDeferredTool(t)).map(t => t.name)
const coreNames = pool.filter(t => !isDeferredTool(t)).map(t => t.name)

type WireTool = { name: string; hasSchema: boolean }
function wireTools(body: Body): WireTool[] {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return tools.map(t => {
    const fn = (t.function ?? {}) as Record<string, unknown>
    return { name: String(fn.name ?? t.name ?? ''), hasSchema: typeof fn.parameters === 'object' && fn.parameters !== null }
  })
}
type Row = Record<string, unknown>
const rowsOf = (body: Body): Row[] => (Array.isArray(body.messages) ? (body.messages as Row[]) : [])
type Declaration = { index: number; row: Row; names: string[]; hasContent: boolean }
function declarationRows(body: Body): Declaration[] {
  const out: Declaration[] = []
  rowsOf(body).forEach((row, index) => {
    if (row.role !== 'system' || !Array.isArray(row.tools)) return
    const names = (row.tools as Array<Record<string, unknown>>).map(t => String(((t.function ?? {}) as Record<string, unknown>).name ?? ''))
    out.push({ index, row, names, hasContent: 'content' in row })
  })
  return out
}
const toolsJson = (body: Body): string => JSON.stringify(body.tools ?? [])
const messagesText = (body: Body): string => JSON.stringify(body.messages ?? [])
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const fmt = (n: number): string => n.toLocaleString('en-US')

async function drive(model: string, messages: Message[]): Promise<{ body: Body | undefined; chats: number; error: string | undefined }> {
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

function admissionRound(id: string, names: string[]): Message[] {
  const block = ToolSearchTool.mapToolResultToToolResultBlockParam({ matches: names, query: `select:${names.join(',')}`, total_deferred_tools: deferredNames.length } as never, id)
  return [
    createAssistantMessage({ content: [{ type: 'tool_use', id, name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${names.join(',')}` } }] as never }) as Message,
    createUserMessage({ content: [block] as never }) as Message,
  ]
}

const first = createUserMessage({ content: 'say pong' }) as Message
const nameRow = getDeferredToolsDeltaAttachment(pool, KIMI, [first])[0]
const nameRowRendered = nameRow ? (normalizeAttachmentForAPI(nameRow) as Message[]) : []
const opening: Message[] = [first, ...nameRowRendered]
const builtinPick = deferredNames.includes('WebFetch') ? 'WebFetch' : pool.find(t => isDeferredTool(t) && t.isMcp !== true)!.name
const secondPick = pool.find(t => isDeferredTool(t) && t.isMcp !== true && t.name !== builtinPick)!.name
const admitted = [builtinPick, 'mcp__filesys__read_file']

section('§0 the seam — the Moonshot row is text-append; kimi-k3 defers; the words spell the append form')
{
  check(`the real pool assembled: ${pool.length} tools, ${coreNames.length} never-deferred, ${deferredNames.length} deferrable (${mcpTools.length} fixture MCP)`, pool.length > 40 && deferredNames.length > 20 && coreNames.length >= 7)
  check("the table's moonshot row is 'text-append'", DEFERRAL_WIRE_CAPABILITY.moonshot === 'text-append', String(DEFERRAL_WIRE_CAPABILITY.moonshot))
  const verdict = deferralWireFormFor(KIMI)
  check(`${KIMI} reads the text-append form from the route table`, verdict.form === 'text-append' && verdict.why === 'route-table', `${verdict.form}/${verdict.why}`)
  check(`supportsToolDeferral admits ${KIMI} (the base answers false here)`, supportsToolDeferral(KIMI) === true)
  const older = deferralWireFormFor('kimi-k2.6')
  check('kimi-k2.6 (no dynamic tool loading, the docs) keeps the text form and does not defer', older.form === 'text' && supportsToolDeferral('kimi-k2.6') === false, `${older.form}/${older.why}`)
  const words = await ToolSearchTool.prompt({ model: KIMI } as never)
  check("the ToolSearch tool's words for kimi-k3 spell the append form (definitions appended to the conversation right after the result)", /appended to the conversation/.test(words) && !/in your tool list/.test(words))
  check('the name row rides once for a fresh Kimi transcript (the base announces nothing on this route)', nameRow !== undefined && nameRow.type === 'deferred_tools_delta' && nameRow.addedNames.join(',') === [...deferredNames].sort().join(','))
}

section('§1 the FRESH request on the Moonshot road — the core in full, the rest by name, every name present')
let freshBody: Body | undefined
let freshNames: string[] = []
{
  clearToolRosterLatches()
  const fresh = await drive(KIMI, opening)
  freshBody = fresh.body
  check('exactly one chat request rode the Moonshot wire, no refusal', fresh.chats === 1 && fresh.error === undefined && fresh.body !== undefined, fresh.error ?? `chats=${fresh.chats}`)
  const tools = fresh.body ? wireTools(fresh.body) : []
  freshNames = tools.map(t => t.name)
  check('the tools term is exactly the never-deferred set in pool order, ToolSearch at its place', freshNames.join(',') === coreNames.join(','), freshNames.join(','))
  check('no deferred tool has a schema on the wire', deferredNames.every(n => !freshNames.includes(n)), deferredNames.filter(n => freshNames.includes(n)).join(','))
  const text = fresh.body ? messagesText(fresh.body) : ''
  const missing = poolNames.filter(n => !freshNames.includes(n) && !text.includes(n))
  check('every pool tool is present on the wire — a schema for the core, a name in the row for the rest', missing.length === 0, missing.join(','))
  check('no declaration row rides before an admission', fresh.body !== undefined && declarationRows(fresh.body).length === 0)
  const bytes = fresh.body ? Buffer.byteLength(toolsJson(fresh.body), 'utf8') : 0
  console.log(`  tools term: ${freshNames.length} schemas, ${fmt(bytes)} bytes (est ${fmt(Math.round(bytes / 3.9))} tokens at bytes/3.9)`)
}

section('§2 the ADMISSION — the tools term byte-identical; the declaration appended at the END of the messages, no content beside it')
let admittedBody: Body | undefined
const transcript: Message[] = [...opening, ...admissionRound('toolu_ts_1', admitted)]
{
  const next = await drive(KIMI, transcript)
  admittedBody = next.body
  check('the next request rode the wire, no refusal', next.chats === 1 && next.error === undefined && next.body !== undefined, next.error ?? `chats=${next.chats}`)
  check('the tools term is BYTE-IDENTICAL to the fresh request (the admission never touches the front)', freshBody !== undefined && next.body !== undefined && toolsJson(next.body) === toolsJson(freshBody))
  const rows = next.body ? rowsOf(next.body) : []
  const declarations = next.body ? declarationRows(next.body) : []
  check('exactly one declaration row rides', declarations.length === 1, String(declarations.length))
  const declaration = declarations[0]
  check('…it is the LAST row of the messages (appended, never inserted)', declaration !== undefined && declaration.index === rows.length - 1, `${declaration?.index} of ${rows.length}`)
  check("…a system row whose `tools` carry exactly the admitted definitions in admission order (the docs' shape)", declaration !== undefined && declaration.names.join(',') === admitted.join(','), declaration?.names.join(','))
  check('…with no `content` field beside the tools (a system row carrying both is a 400 on this wire)', declaration !== undefined && !declaration.hasContent)
  const schemas = declaration ? (declaration.row.tools as Array<Record<string, unknown>>) : []
  check('…each declaration is the full function definition (type, name, description, parameters)', schemas.length === admitted.length && schemas.every(t => t.type === 'function' && typeof (t.function as Record<string, unknown>)?.description === 'string' && typeof (t.function as Record<string, unknown>)?.parameters === 'object'))
  const freshRows = freshBody ? rowsOf(freshBody) : []
  check("the fresh request's rows are an unchanged prefix of this request's rows (the cached prefix holds)", freshRows.length > 0 && same(rows.slice(0, freshRows.length), freshRows))
  const recordIndex = rows.findIndex(r => r.role === 'tool' && r.tool_call_id === 'toolu_ts_1')
  check('the admission record rides as text naming the admitted tools, right before the declaration', recordIndex >= 0 && declaration !== undefined && recordIndex < declaration.index && String(rows[recordIndex]!.content).includes(admissionRecordText(admitted, 'text-append').split('\n')[0]!) && admitted.every(n => String(rows[recordIndex]!.content).includes(`- ${n}`)))
  check("…and its words say the declarations follow, not 'in your tool list'", recordIndex >= 0 && /follow/.test(String(rows[recordIndex]!.content)) && !/tool list/.test(String(rows[recordIndex]!.content)))
  const text = next.body ? messagesText(next.body) : ''
  check('no tool_reference block reaches a wire that cannot expand one', !text.includes('tool_reference'))
  check('every other deferred tool still has no schema anywhere on the wire', deferredNames.filter(n => !admitted.includes(n)).every(n => !freshNames.includes(n) && !(declaration?.names ?? []).includes(n)))
  const plan = await planToolPayload({ model: KIMI, tools: pool, messages: transcript, getToolPermissionContext: async () => permissionContext, agents: [], hasPendingMcpServers: false, source: 'proof' })
  check('the plan owner names the form and keeps the admitted tools OUT of the roster', plan.wireForm === 'text-append' && plan.enabled && admitted.every(n => !plan.roster.some(t => t.name === n)) && [...plan.admittedNames].sort().join(',') === [...admitted].sort().join(','))
  check('the gate still knows an unadmitted deferred tool from an admitted one', plan.isDeferredUnadmitted(secondPick) === true && plan.isDeferredUnadmitted(builtinPick) === false)
}

section('§3 LATER TURNS — the declaration keeps its place and bytes; a second admission appends a second row; a re-admission adds nothing')
{
  const later: Message[] = [...transcript, createAssistantMessage({ content: 'ok' }) as Message, createUserMessage({ content: 'and again' }) as Message]
  const turn = await drive(KIMI, later)
  const rows = turn.body ? rowsOf(turn.body) : []
  const declarations = turn.body ? declarationRows(turn.body) : []
  const previous = admittedBody ? declarationRows(admittedBody)[0] : undefined
  check('a later turn rode the wire, no refusal', turn.chats === 1 && turn.error === undefined, turn.error ?? '')
  check('the tools term is still byte-identical', freshBody !== undefined && turn.body !== undefined && toolsJson(turn.body) === toolsJson(freshBody))
  check('the declaration row keeps its index and its bytes (carried unchanged, the docs\' second law)', previous !== undefined && declarations.length === 1 && declarations[0]!.index === previous.index && same(declarations[0]!.row, previous.row))
  const admittedRows = admittedBody ? rowsOf(admittedBody) : []
  check("the admitted request's rows are an unchanged prefix of the later request's rows", admittedRows.length > 0 && same(rows.slice(0, admittedRows.length), admittedRows))

  const second: Message[] = [...later, ...admissionRound('toolu_ts_2', [secondPick, builtinPick])]
  const again = await drive(KIMI, second)
  const rows2 = again.body ? rowsOf(again.body) : []
  const declarations2 = again.body ? declarationRows(again.body) : []
  check('a second admission rode the wire, no refusal', again.chats === 1 && again.error === undefined, again.error ?? '')
  check('the tools term is still byte-identical after a second admission', freshBody !== undefined && again.body !== undefined && toolsJson(again.body) === toolsJson(freshBody))
  check('two declaration rows ride; the first is untouched', declarations2.length === 2 && previous !== undefined && same(declarations2[0]!.row, previous.row) && declarations2[0]!.index === previous.index, String(declarations2.length))
  check(`the second row declares only the NEW tool (${secondPick}) — a re-admitted tool is not declared twice`, declarations2[1]?.names.join(',') === secondPick, declarations2[1]?.names.join(','))
  check('…and it is the last row, after its own record', declarations2[1] !== undefined && declarations2[1].index === rows2.length - 1 && rows2.findIndex(r => r.role === 'tool' && r.tool_call_id === 'toolu_ts_2') < declarations2[1].index)
  check("the later request's rows are an unchanged prefix of the second-admission request's rows", rows.length > 0 && same(rows2.slice(0, rows.length), rows))

  const repeated: Message[] = [...second, ...admissionRound('toolu_ts_3', [builtinPick])]
  const rep = await drive(KIMI, repeated)
  const declarations3 = rep.body ? declarationRows(rep.body) : []
  check('re-admitting an admitted tool appends NO declaration row (nothing new to declare)', rep.error === undefined && declarations3.length === 2, `${rep.error ?? ''} rows=${declarations3.length}`)
  check('the tools term never moved across the whole session', freshBody !== undefined && rep.body !== undefined && toolsJson(rep.body) === toolsJson(freshBody))
}

section('§4 THE COMPACTION BOUNDARY — a snapshot-admitted tool rides the new conversation\'s tools term from its first request; no row hangs on a summary')
{
  clearToolRosterLatches()
  const boundary = {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'boundary-kimi',
    timestamp: new Date().toISOString(),
    content: 'compacted',
    compactMetadata: { trigger: 'auto', preTokens: 1, preCompactDiscoveredTools: [builtinPick] },
  } as unknown as Message
  const compacted: Message[] = [boundary, createUserMessage({ content: 'summary of the work so far' }) as Message]
  const after = await drive(KIMI, compacted)
  const names = after.body ? wireTools(after.body).map(t => t.name) : []
  check('the request after a compaction rode the wire, no refusal', after.chats === 1 && after.error === undefined, after.error ?? '')
  check(`the tools term is the core followed by the snapshot-admitted ${builtinPick} (fixed for the new conversation's life)`, names.join(',') === [...coreNames, builtinPick].join(','), names.join(','))
  check('no declaration row rides (the new prefix carries the schema in its own tools term)', after.body !== undefined && declarationRows(after.body).length === 0)
  const later = await drive(KIMI, [...compacted, createAssistantMessage({ content: 'ok' }) as Message, createUserMessage({ content: 'go on' }) as Message])
  check('…and the next request of the compacted conversation keeps it byte-identical', after.body !== undefined && later.body !== undefined && toolsJson(later.body) === toolsJson(after.body))
  clearToolRosterLatches()
}

section('§5 THE Z.AI ROAD — the table row decides: text-append rides a TEXT declaration row (a system row with content); text keeps the whole catalogue')
{
  clearToolRosterLatches()
  process.env.MERCURY_MODEL = GLM
  const zaiCapability = DEFERRAL_WIRE_CAPABILITY.zai
  const glmNameRow = getDeferredToolsDeltaAttachment(pool, GLM, [first])[0]
  const glmOpening: Message[] = [first, ...(glmNameRow ? (normalizeAttachmentForAPI(glmNameRow) as Message[]) : [])]
  const fresh = await drive(GLM, glmOpening)
  const freshGlmNames = fresh.body ? wireTools(fresh.body).map(t => t.name) : []
  check('the fresh GLM request rode the Z.AI wire, no refusal', fresh.chats === 1 && fresh.error === undefined && fresh.body !== undefined, fresh.error ?? `chats=${fresh.chats}`)
  const next = await drive(GLM, [...glmOpening, ...admissionRound('toolu_ts_glm', admitted)])
  const nextRows = next.body ? rowsOf(next.body) : []
  check('the admitted GLM request rode the wire, no refusal', next.chats === 1 && next.error === undefined && next.body !== undefined, next.error ?? `chats=${next.chats}`)
  if (zaiCapability === 'text-append') {
    check(`zai is text-append: ${GLM} defers`, deferralWireFormFor(GLM).form === 'text-append' && supportsToolDeferral(GLM) === true)
    check('the fresh tools term is exactly the never-deferred set', freshGlmNames.join(',') === coreNames.join(','), freshGlmNames.join(','))
    check('the tools term is byte-identical across the admission', fresh.body !== undefined && next.body !== undefined && toolsJson(next.body) === toolsJson(fresh.body))
    const last = nextRows[nextRows.length - 1]
    check('the last row is a system row whose CONTENT carries the admitted definitions as text (Z.AI documents content on a system row, no per-message tools field)', last !== undefined && last.role === 'system' && typeof last.content === 'string' && !('tools' in last) && admitted.every(n => String(last.content).includes(`"name":"${n}"`)))
    check("the fresh request's rows are an unchanged prefix of the admitted request's rows", fresh.body !== undefined && same(nextRows.slice(0, rowsOf(fresh.body).length), rowsOf(fresh.body)))
  } else {
    check(`zai stays '${String(zaiCapability)}': ${GLM} does not defer (the live measurement ruled: the cache held, but GLM never called a tool declared in a text row)`, deferralWireFormFor(GLM).form === 'text' && supportsToolDeferral(GLM) === false)
    check('the whole catalogue rides in full, minus ToolSearch, from the first request', freshGlmNames.join(',') === poolNames.filter(n => n !== TOOL_SEARCH_TOOL_NAME).join(','), freshGlmNames.join(','))
    check('an admission round changes nothing on the tools term', fresh.body !== undefined && next.body !== undefined && toolsJson(next.body) === toolsJson(fresh.body))
    check('no declaration row rides', next.body !== undefined && declarationRows(next.body).length === 0 && !nextRows.some(r => r.role === 'system' && typeof r.content === 'string' && String(r.content).includes('"type":"function"')))
  }
  clearToolRosterLatches()
}

wire.server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} TEXT-APPEND DEFERRAL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL TEXT-APPEND DEFERRAL PROOFS PASS')
process.exit(0)
