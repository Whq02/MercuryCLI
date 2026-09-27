#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixtureMcpTools } from './fixtureMcpEstate.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_DISABLE_1M_CONTEXT']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-deferral-wire-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'

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
  console.log('\nTIMEOUT — the local deferral wire proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const MODEL = 'qwen3.5:9b-q4_K_M'
const PERSISTED = `local/${MODEL}`
const MODEL_MAX = 262144
type Hit = { method: string; url: string; body: Record<string, unknown> }
const hits: Hit[] = []
let loadedCtx: number | undefined

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function ollamaFixture(): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const url = req.url ?? ''
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        hits.push({ method: req.method ?? 'GET', url, body })
        const load = (): void => {
          const options = body.options as { num_ctx?: number } | undefined
          loadedCtx = options?.num_ctx !== undefined ? Math.min(options.num_ctx, MODEL_MAX) : MODEL_MAX
        }
        if (url === '/api/tags') return json(res, 200, { models: [{ name: MODEL, model: MODEL, size: 6594474711, details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' } }] })
        if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
        if (url === '/api/ps') {
          return json(res, 200, { models: loadedCtx !== undefined ? [{ name: MODEL, model: MODEL, size: 11400000000, size_vram: 11400000000, context_length: loadedCtx, expires_at: '2026-01-01T00:00:00Z' }] : [] })
        }
        if (url === '/api/show' && req.method === 'POST') {
          if (body.model !== MODEL) return json(res, 404, { error: `model '${String(body.model)}' not found` })
          return json(res, 200, {
            modelfile: '',
            parameters: 'top_k 20\ntop_p 0.95\ntemperature 1',
            details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' },
            model_info: { 'general.architecture': 'qwen35', 'qwen35.context_length': MODEL_MAX },
            capabilities: ['completion', 'vision', 'tools', 'thinking'],
          })
        }
        if (url === '/api/generate' && req.method === 'POST') {
          load()
          return json(res, 200, { model: body.model, created_at: '2026-01-01T00:00:00Z', response: '', done: true, done_reason: 'load' })
        }
        if (url === '/api/chat' && req.method === 'POST') {
          load()
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          res.write(JSON.stringify({ model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'pong' }, done: false }) + '\n')
          res.write(JSON.stringify({ model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 1 }) + '\n')
          res.end()
          return
        }
        json(res, 404, { error: 'not found' })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}

const ollama = await ollamaFixture()
process.env.MERCURY_LOCAL_PROBE_TARGETS = `ollama=${ollama.root}`
process.env.MERCURY_MODEL = PERSISTED

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
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { isDeferredTool, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { supportsToolDeferral, deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { clearToolRosterLatches, admissionRecordText } = await import('../../src/services/providers/toolEconomy.ts')
type Tool = import('../../src/Tool.ts').Tool
type Tools = import('../../src/Tool.ts').Tools
type Message = import('../../src/types/message.ts').Message

await refreshLocalDiscovery({ force: true })
const permissionContext = getEmptyToolPermissionContext()
const mcpTools: Tool[] = buildFixtureMcpTools<Tool>(MCPTool)
const pool: Tools = assembleToolPool(permissionContext, mcpTools)
const poolNames = pool.map(t => t.name)
const deferredNames = pool.filter(t => isDeferredTool(t)).map(t => t.name)
const coreNames = pool.filter(t => !isDeferredTool(t)).map(t => t.name)
const BRIEF_CORE = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', TOOL_SEARCH_TOOL_NAME]

type WireTool = { name: string; hasSchema: boolean }
function wireTools(body: Record<string, unknown>): WireTool[] {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : []
  return tools.map(t => {
    const fn = (t.function ?? {}) as Record<string, unknown>
    return { name: String(fn.name ?? t.name ?? ''), hasSchema: typeof fn.parameters === 'object' && fn.parameters !== null }
  })
}
const toolBytesOf = (body: Record<string, unknown>): number => Buffer.byteLength(JSON.stringify(body.tools ?? []), 'utf8')
const messagesText = (body: Record<string, unknown>): string => JSON.stringify(body.messages ?? [])
const fmt = (n: number): string => n.toLocaleString('en-US')

async function drive(messages: Message[]): Promise<{ body: Record<string, unknown> | undefined; chats: number; error: string | undefined }> {
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
        model: PERSISTED,
        isNonInteractiveSession: true,
        querySource: 'repl_main_thread' as never,
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
  const chats = hits.slice(before).filter(h => h.url === '/api/chat')
  return { body: chats[chats.length - 1]?.body, chats: chats.length, error: errors.length > 0 ? errors.join(' | ') : undefined }
}

section('§0 the fixture is the local record the 9B runs on')
{
  const record = localRecordFor(PERSISTED)
  check('the Ollama fixture lists the model with tools and thinking declared', record !== undefined && record.server === 'ollama' && record.toolsDeclared === true && record.thinkingDeclared === true, JSON.stringify(record))
  check(`the real pool assembled: ${pool.length} tools, ${coreNames.length} never-deferred, ${deferredNames.length} deferrable (${mcpTools.length} fixture MCP)`, pool.length > 40 && deferredNames.length > 20 && coreNames.length >= BRIEF_CORE.length)
  check(`the brief's core is never deferred by the law: ${BRIEF_CORE.join(', ')}`, BRIEF_CORE.every(n => coreNames.includes(n)), BRIEF_CORE.filter(n => !coreNames.includes(n)).join(','))
  console.log(`  never-deferred set (${coreNames.length}): ${coreNames.join(', ')}`)
}

section('§1 the seam — the local route defers in the text form the table gives it')
{
  const verdict = deferralWireFormFor(PERSISTED)
  check('the wire form for a local record is text, from the route table', verdict.form === 'text' && verdict.why === 'route-table', `${verdict.form}/${verdict.why}`)
  check('supportsToolDeferral admits the local route (the base answers false here)', supportsToolDeferral(PERSISTED) === true)
  const words = await ToolSearchTool.prompt({ model: PERSISTED } as never)
  check("the ToolSearch tool's words for a local model spell the text form (definitions join the tool list from the admitting request on)", /from that request on their complete definitions are in your tool list/.test(words))
}

section('§2 the FRESH request on the local wire — the core in full, the rest by name, every name present')
let freshBody: Record<string, unknown> | undefined
let freshNames: string[] = []
const first = createUserMessage({ content: 'say pong' }) as Message
{
  clearToolRosterLatches()
  const row = getDeferredToolsDeltaAttachment(pool, PERSISTED, [first])[0]
  check('a fresh local transcript gets the persisted name row (the base announces nothing on the local route)', row !== undefined && row.type === 'deferred_tools_delta' && row.addedNames.join(',') === [...deferredNames].sort().join(','), row === undefined ? 'no row' : (row as { addedNames?: string[] }).addedNames?.join(','))
  check('the row is names only — no schema bytes, no description', row !== undefined && row.type === 'deferred_tools_delta' && row.addedLines.join('\n') === [...deferredNames].sort().join('\n'))
  const rendered = row ? normalizeAttachmentForAPI(row) : []
  const transcript: Message[] = [first, ...(rendered as Message[])]
  const fresh = await drive(transcript)
  freshBody = fresh.body
  check('exactly one /api/chat request rode the wire, no refusal', fresh.chats === 1 && fresh.error === undefined && fresh.body !== undefined, fresh.error ?? `chats=${fresh.chats}`)
  const tools = fresh.body ? wireTools(fresh.body) : []
  freshNames = tools.map(t => t.name)
  check('the tools term is exactly the never-deferred set in pool order, ToolSearch at its place', freshNames.join(',') === coreNames.join(','), freshNames.join(','))
  check(`${BRIEF_CORE.join(', ')} ride with their full schemas`, BRIEF_CORE.every(n => tools.some(t => t.name === n && t.hasSchema)))
  check('no deferred tool has a schema on the wire', deferredNames.every(n => !freshNames.includes(n)), deferredNames.filter(n => freshNames.includes(n)).join(','))
  const text = fresh.body ? messagesText(fresh.body) : ''
  const missing = poolNames.filter(n => !freshNames.includes(n) && !text.includes(n))
  check('every pool tool is present on the wire — a schema for the core, a name in the row for the rest', missing.length === 0, missing.join(','))
  check('the native road carried the tools on /api/chat itself (the request body, not a side channel)', hits.some(h => h.url === '/api/chat' && Array.isArray(h.body.tools)))
}

section('§3 the measure — the same wire, the whole catalogue inlined (the off arm) against the deferring roster')
{
  process.env.MERCURY_TOOL_DEFER = '0'
  clearToolRosterLatches()
  const off = await drive([createUserMessage({ content: 'say pong (off arm)' }) as Message])
  delete process.env.MERCURY_TOOL_DEFER
  clearToolRosterLatches()
  const offNames = off.body ? wireTools(off.body).map(t => t.name) : []
  check('the off arm inlines every pool tool except ToolSearch', off.error === undefined && offNames.join(',') === poolNames.filter(n => n !== TOOL_SEARCH_TOOL_NAME).join(','), off.error ?? offNames.join(','))
  const fullBytes = off.body ? toolBytesOf(off.body) : 0
  const deferredBytes = freshBody ? toolBytesOf(freshBody) : 0
  const est = (b: number): number => Math.round(b / 3.9)
  console.log(`  whole catalogue: ${offNames.length} schemas, ${fmt(fullBytes)} tool bytes, est ${fmt(est(fullBytes))} tokens (bytes/3.9)`)
  console.log(`  deferring roster: ${freshNames.length} schemas, ${fmt(deferredBytes)} tool bytes, est ${fmt(est(deferredBytes))} tokens (bytes/3.9)`)
  check('the deferring request carries under half the whole catalogue\'s tool bytes', deferredBytes > 0 && fullBytes > 0 && deferredBytes * 2 < fullBytes, `${deferredBytes} vs ${fullBytes}`)
}

section('§4 the ADMISSION on the local road — ToolSearch admits, the next request carries the schema, the record rides as text')
{
  const builtinPick = deferredNames.includes('WebFetch') ? 'WebFetch' : pool.find(t => isDeferredTool(t) && t.isMcp !== true)!.name
  const admitted = [builtinPick, 'mcp__filesys__read_file']
  const context = {
    options: { tools: pool },
    getAppState: () => ({ toolPermissionContext: { ...permissionContext, mode: 'default' }, mcp: { clients: [] } }),
  }
  const result = await ToolSearchTool.call({ query: `select:${admitted.join(',')}`, max_results: 5 }, context as never)
  const output = (result as { data: { matches: string[] } }).data
  check(`ToolSearch select admits ${admitted.join(' and ')}`, output.matches.join(',') === admitted.join(','), output.matches.join(','))
  const block = ToolSearchTool.mapToolResultToToolResultBlockParam(output as never, 'toolu_ts_1')
  const references = Array.isArray(block.content) ? (block.content as Array<{ type?: string }>).filter(b => b.type === 'tool_reference').length : 0
  check('the tool writes the neutral admission record (tool_reference blocks)', references === admitted.length)
  const row = getDeferredToolsDeltaAttachment(pool, PERSISTED, [first])[0]
  const rendered = row ? normalizeAttachmentForAPI(row) : []
  const turn = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${admitted.join(',')}` } }] as never }) as Message
  const record = createUserMessage({ content: [block] as never }) as Message
  const transcript: Message[] = [first, ...(rendered as Message[]), turn, record]
  const next = await drive(transcript)
  check('the next request rode /api/chat, no refusal', next.chats === 1 && next.error === undefined && next.body !== undefined, next.error ?? `chats=${next.chats}`)
  const tools = next.body ? wireTools(next.body) : []
  const names = tools.map(t => t.name)
  check('the tools term is the frozen core followed by the admitted definitions, appended at the end', names.join(',') === [...freshNames, ...admitted].join(','), names.join(','))
  check('each admitted tool now rides with its full schema', admitted.every(n => tools.some(t => t.name === n && t.hasSchema)))
  check('every other deferred tool still has no schema on the wire', deferredNames.filter(n => !admitted.includes(n)).every(n => !names.includes(n)))
  const text = next.body ? messagesText(next.body) : ''
  check('the admission record reaches the wire as text naming the admitted tools', text.includes(admissionRecordText(admitted).split('\n')[0]!) && admitted.every(n => text.includes(`- ${n}`)))
  check('no tool_reference block reaches a wire that cannot expand one', !text.includes('tool_reference'))
  const later = await drive([...transcript, createAssistantMessage({ content: 'pong' }) as Message, createUserMessage({ content: 'and again' }) as Message])
  const laterNames = later.body ? wireTools(later.body).map(t => t.name) : []
  check('a later turn of the same conversation keeps the admitted schemas (the roster never shrinks)', later.error === undefined && laterNames.join(',') === names.join(','), later.error ?? laterNames.join(','))
}

ollama.server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} LOCAL DEFERRAL WIRE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LOCAL DEFERRAL WIRE PROOFS PASS')
process.exit(0)
