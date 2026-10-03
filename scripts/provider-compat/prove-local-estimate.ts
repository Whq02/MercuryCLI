#!/usr/bin/env bun
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixtureMcpTools } from '../tool-economy/fixtureMcpEstate.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_DISABLE_1M_CONTEXT']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'local-estimate-'))
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
  console.log('\nTIMEOUT — the local estimate proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const MODEL = 'qwen3.5:9b-q4_K_M'
const PERSISTED = `local/${MODEL}`
const MODEL_MAX = 262144
const WIRE_BYTES_PER_TOKEN = 3.9
const OWNER_BYTES_PER_TOKEN = 4.1
const OLLAMA_OVER_WINDOW = 'the prompt is longer than the context length currently available to the model; shorten the prompt, adjust the context length in settings, or use a model with a longer context length'
const SYSTEM_PROMPT = ['You are a fixture assistant. Reply with one word. ' + 'The rest of this prompt stands in for the real instructions. '.repeat(40)]
type Hit = { method: string; url: string; body: Record<string, unknown>; bytes: number }
const hits: Hit[] = []
const state = { loadedCtx: undefined as number | undefined, refuse: false }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function ollamaFixture(): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk as Buffer))
      req.on('end', () => {
        const url = req.url ?? ''
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        hits.push({ method: req.method ?? 'GET', url, body, bytes: Buffer.byteLength(raw, 'utf8') })
        if (url === '/api/tags') return json(res, 200, { models: [{ name: MODEL, model: MODEL, size: 6594474711, details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' } }] })
        if (url === '/api/version') return json(res, 200, { version: '0.34.4' })
        if (url === '/api/ps') {
          return json(res, 200, { models: state.loadedCtx !== undefined ? [{ name: MODEL, model: MODEL, size: 11400000000, size_vram: 11400000000, context_length: state.loadedCtx, expires_at: '2026-01-01T00:00:00Z' }] : [] })
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
        if (url === '/api/chat' && req.method === 'POST') {
          if (state.refuse) return json(res, 400, { error: OLLAMA_OVER_WINDOW })
          const options = body.options as { num_ctx?: number } | undefined
          state.loadedCtx = options?.num_ctx !== undefined ? Math.min(options.num_ctx, MODEL_MAX) : MODEL_MAX
          res.writeHead(200, { 'content-type': 'application/x-ndjson' })
          res.write(JSON.stringify({ model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'pong' }, done: false }) + '\n')
          res.write(JSON.stringify({ model: body.model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: Math.round(Buffer.byteLength(raw, 'utf8') / OWNER_BYTES_PER_TOKEN), eval_count: 1 }) + '\n')
          res.end()
          return
        }
        if (url === '/api/generate' || url === '/v1/chat/completions' || url === '/api/create' || url === '/api/delete') return json(res, 500, { error: `the proof must never call ${url}` })
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
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { MCPTool } = await import('../../src/tools/MCPTool/MCPTool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { refreshLocalDiscovery, __resetLocalDiscoveryForTest } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { isDeferredTool, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { clearToolRosterLatches } = await import('../../src/services/providers/toolEconomy.ts')
const { overflowSignalOf } = await import('../../src/services/api/overflowSignal.ts')
const callModel = await import('../../src/services/providers/local/localCallModel.ts')
const w = await import('../../src/services/providers/local/localWindow.ts')
const warm = await import('../../src/services/providers/local/localWarm.ts')
const { __pinLocalServerTruthForTest, __resetLocalServerTruthForTest } = await import('../../src/services/localServer/localServerTruth.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
type Tool = import('../../src/Tool.ts').Tool
type Tools = import('../../src/Tool.ts').Tools
type Message = import('../../src/types/message.ts').Message
type LocalParams = import('../../src/services/providers/openaicompat/compatChatCallModel.ts').CompatCallModelParams
type ToolWire = { schemas: number; schemaBytes: number; named: number; nameRowBytes: number }
type Tip = {
  localToolWireOf?: (params: LocalParams) => Promise<ToolWire>
  LOCAL_FIT_TOLERANCE?: number
  LOCAL_WIRE_BYTES_PER_TOKEN?: number
}
const tip = callModel as unknown as Tip
const onTip = typeof tip.localToolWireOf === 'function'

__pinLocalServerTruthForTest(null)
__resetLocalServerTruthForTest()
await refreshLocalDiscovery({ force: true })
const permissionContext = getEmptyToolPermissionContext()
const mcpTools: Tool[] = buildFixtureMcpTools<Tool>(MCPTool)
const pool: Tools = assembleToolPool(permissionContext, mcpTools)
const coreNames = pool.filter(t => !isDeferredTool(t)).map(t => t.name)
const deferredNames = pool.filter(t => isDeferredTool(t)).map(t => t.name)
const record = (): NonNullable<ReturnType<typeof localRecordFor>> => localRecordFor(PERSISTED)!
const fmt = (n: number): string => Math.round(n).toLocaleString('en-US')
const j = (v: unknown): string => JSON.stringify(v) ?? ''
const within = (a: number, b: number, share: number): boolean => Math.abs(a - b) <= b * share

function fresh(content: string): Message[] {
  const first = createUserMessage({ content }) as Message
  const row = getDeferredToolsDeltaAttachment(pool, PERSISTED, [first])[0]
  const rendered = row ? normalizeAttachmentForAPI(row) : []
  return [first, ...(rendered as Message[])]
}

function paramsFor(messages: Message[], extra: Record<string, unknown> = {}): LocalParams {
  return {
    messages,
    systemPrompt: SYSTEM_PROMPT as never,
    thinkingConfig: { type: 'disabled' } as never,
    tools: pool,
    signal: new AbortController().signal,
    options: {
      model: PERSISTED,
      querySource: 'main_thread',
      getToolPermissionContext: async () => permissionContext,
      agents: [],
      isNonInteractiveSession: true,
      mcpTools,
      hasPendingMcpServers: false,
      ...extra,
    } as never,
  } as LocalParams
}

async function estimateOf(params: LocalParams): Promise<number> {
  if (onTip) return callModel.localPreComposeEstimate({ ...params, toolWire: await tip.localToolWireOf!(params) } as never)
  return callModel.localPreComposeEstimate(params)
}

type Yielded = { type?: string; isApiErrorMessage?: boolean; message?: { content?: Array<{ text?: string }> | string } }
const textOf = (m: Yielded | undefined): string => {
  const content = m?.message?.content
  if (typeof content === 'string') return content
  return (content ?? []).map(b => b.text ?? '').join('')
}

async function drive(params: LocalParams): Promise<{ chat: Hit | undefined; error: Yielded | undefined; errorText: string | undefined; texts: string[] }> {
  const from = hits.length
  const yielded: Yielded[] = []
  for await (const item of callModel.localCallModel(params)) yielded.push(item as never)
  const chat = hits.slice(from).find(h => h.url === '/api/chat')
  const error = yielded.find(m => m.type === 'assistant' && m.isApiErrorMessage === true)
  return { chat, error, errorText: error ? textOf(error) : undefined, texts: yielded.filter(m => m.type === 'assistant' && m.isApiErrorMessage !== true).map(textOf) }
}

const wireSchemas = (hit: Hit | undefined): number => (Array.isArray(hit?.body.tools) ? (hit!.body.tools as unknown[]).length : 0)
const realOf = (hit: Hit | undefined): number => (hit?.bytes ?? 0) / WIRE_BYTES_PER_TOKEN

function reset(setting: 'server' | 'max' | number | undefined): void {
  clearToolRosterLatches()
  w.__resetLocalWindowsForTest()
  __pinLocalServerTruthForTest(null)
  __resetLocalServerTruthForTest()
  w.writeLocalWindowSetting({ id: MODEL }, setting)
  state.refuse = false
}

section(`§0 the world: the fixture Ollama (no KV geometry stated, the trained max stated), the real pool (${pool.length} tools: ${coreNames.length} never deferred, ${deferredNames.length} by name)`)
{
  const r = record()
  check('discovery found the fixture model with tools declared, the trained max, no geometry and no served window', r !== undefined && r.server === 'ollama' && r.toolsDeclared === true && r.modelMaxContext === MODEL_MAX && r.geometry === undefined && r.contextWindow === undefined, j({ max: r?.modelMaxContext, geometry: r?.geometry, window: r?.contextWindow }))
  check(`the real pool assembled: ${pool.length} tools, ToolSearch pooled, most of them deferrable`, pool.length > 40 && pool.some(t => t.name === TOOL_SEARCH_TOOL_NAME) && deferredNames.length > coreNames.length * 3)
}

section('§1 the seam (red on the base): the estimate weighs the tools the way the request sends them — the never-deferred schemas in full, the rest by name — at the wire\'s 3.9 bytes per token')
let fixedBytes = 0
let beforeAfter = ''
{
  reset(undefined)
  const params = paramsFor(fresh('say pong'))
  const estimate = await estimateOf(params)
  const sent = await drive(params)
  const real = realOf(sent.chat)
  fixedBytes = sent.chat?.bytes ?? 0
  const wire = onTip ? await tip.localToolWireOf!(params) : undefined
  beforeAfter = `estimate ${fmt(estimate)} tokens · the request on the wire ${fmt(fixedBytes)} bytes = ${fmt(real)} tokens at ${WIRE_BYTES_PER_TOKEN} bytes/token · ${wireSchemas(sent.chat)} schemas + ${deferredNames.length} names on the wire`
  console.log(`  ${beforeAfter}`)
  check('the fresh request rode /api/chat and settled', sent.chat !== undefined && sent.error === undefined && sent.texts.some(t => t.includes('pong')), sent.errorText ?? 'no chat')
  check(`the estimate is within 10% of the real request's bytes/${WIRE_BYTES_PER_TOKEN} (the base weighs every pooled tool at 1,000 tokens: ${pool.length} × 1,000 on a ${wireSchemas(sent.chat)}-schema wire)`, within(estimate, real, 0.1), `estimate ${fmt(estimate)} vs real ${fmt(real)} (${fmt(estimate - real)} off)`)
  check('the estimate reads the plan: the schemas it weighs are the schemas on the wire, the names it weighs are the deferred pool', wire !== undefined && wire.schemas === wireSchemas(sent.chat) && wire.named === deferredNames.length, wire === undefined ? 'no tool-wire composer on the base' : j(wire))
  check('the schema bytes it weighs are the wire\'s own tools term, byte for byte', wire !== undefined && wire.schemaBytes === Buffer.byteLength(JSON.stringify(sent.chat?.body.tools ?? []), 'utf8'), wire === undefined ? 'no tool-wire composer on the base' : `${wire.schemaBytes} vs ${Buffer.byteLength(JSON.stringify(sent.chat?.body.tools ?? []), 'utf8')}`)
  const pick = deferredNames.includes('WebFetch') ? 'WebFetch' : pool.find(t => isDeferredTool(t) && t.isMcp !== true)!.name
  const admitted = [pick, 'mcp__filesys__read_file']
  const context = { options: { tools: pool }, getAppState: () => ({ toolPermissionContext: { ...permissionContext, mode: 'default' }, mcp: { clients: [] } }) }
  const result = await ToolSearchTool.call({ query: `select:${admitted.join(',')}`, max_results: 5 }, context as never)
  const block = ToolSearchTool.mapToolResultToToolResultBlockParam((result as { data: unknown }).data as never, 'toolu_ts_1')
  const turn = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${admitted.join(',')}` } }] as never }) as Message
  const admission = createUserMessage({ content: [block] as never }) as Message
  const after = paramsFor([...params.messages, turn, admission])
  const estimateAfter = await estimateOf(after)
  const sentAfter = await drive(after)
  check(`after an admission the estimate follows the roster (${coreNames.length} + ${admitted.length} schemas) within 10% of that request's bytes/${WIRE_BYTES_PER_TOKEN}`, sentAfter.chat !== undefined && wireSchemas(sentAfter.chat) === wireSchemas(sent.chat) + admitted.length && within(estimateAfter, realOf(sentAfter.chat), 0.1), `estimate ${fmt(estimateAfter)} vs real ${fmt(realOf(sentAfter.chat))} · ${wireSchemas(sentAfter.chat)} schemas`)
  check('nothing but tags/version/ps/show/chat reached the server — never a load, never a generation', hits.every(h => /^\/api\/(tags|version|ps|show|chat)$/.test(h.url)), hits.map(h => h.url).join(','))
}

section('§2 generous: a request that fits is never refused; the refusal fires only past a margin no estimation error could explain; within it the server\'s own answer is the truth')
{
  reset(65536)
  const setting = w.localWindowSettingOf(record())
  check('the window setting for this section is 64k (your setting)', setting === 65536, String(setting))
  const forty = await drive(paramsFor(fresh('x'.repeat(160_000))))
  check('a 40k-token message on a 64k window is SENT with num_ctx 65536 (the base sends it too: its refusal reads the composed bytes at /4)', forty.chat !== undefined && forty.error === undefined && (forty.chat.body.options as { num_ctx?: number }).num_ctx === 65536, forty.errorText ?? 'no chat')
  const target = 263_000
  const edge = await drive(paramsFor(fresh('x'.repeat(Math.max(1, target - fixedBytes)))))
  const edgeTokens = (edge.chat?.bytes ?? target) / OWNER_BYTES_PER_TOKEN
  check(`a request the owner's measured ratio says fits (≈${fmt(edgeTokens)} tokens of 65,536 at ${OWNER_BYTES_PER_TOKEN} bytes/token) is SENT — the base refuses it at bytes/4 + a 1,024 floor`, edge.chat !== undefined && edge.error === undefined, edge.errorText ?? 'no chat')
  const far = await drive(paramsFor(fresh('x'.repeat(1_200_000))))
  const farBytes = 1_200_000 + fixedBytes
  check('a request four and a half times the window is refused before the send, naming the window, its source and the in-app road', far.chat === undefined && far.errorText !== undefined && far.errorText.includes('65536 tokens — your setting — /config → Local model window'), far.errorText ?? 'no error')
  check(`the refusal counts the request at the wire's ratio (≈${Math.round(farBytes / WIRE_BYTES_PER_TOKEN / 1000)}k tokens), not at bytes/4 (≈${Math.round(farBytes / 4 / 1000)}k)`, far.errorText !== undefined && new RegExp(`≈${Math.round(farBytes / WIRE_BYTES_PER_TOKEN / 1000)}k tokens`).test(far.errorText), far.errorText ?? 'no error')
  const profile = callModel.localLaneProfileFor(record())
  const tolerance = tip.LOCAL_FIT_TOLERANCE ?? 1
  const boundary = Math.floor(65536 * WIRE_BYTES_PER_TOKEN * tolerance)
  const pure = (bytes: number): string | undefined => profile.requestFitRefusal?.({ requestBytes: bytes, estTokens: Math.ceil(bytes / 4), toolCount: coreNames.length, wireModel: MODEL })
  check('the margin is one third of the window (LOCAL_FIT_TOLERANCE 4/3): a request would have to tokenize past 5.2 bytes per token to fit — no real prompt does', tolerance === 4 / 3, String(tolerance))
  check(`just inside the margin (${fmt(boundary - 40)} bytes ≈ ${fmt((boundary - 40) / WIRE_BYTES_PER_TOKEN)} tokens on a 65,536 window) is sent`, pure(boundary - 40) === undefined, pure(boundary - 40) ?? '')
  check(`just past it (${fmt(boundary + 400)} bytes) is refused`, pure(boundary + 400) !== undefined)
  state.refuse = true
  const refusedByServer = await drive(paramsFor(fresh('x'.repeat(160_000))))
  state.refuse = false
  check('the server\'s own refusal (HTTP 400, Ollama\'s truncate:false sentence) comes back as an API error carrying the server\'s words', refusedByServer.chat !== undefined && refusedByServer.errorText !== undefined && refusedByServer.errorText.includes('longer than the context length'), refusedByServer.errorText ?? 'no error')
  const signal = overflowSignalOf(refusedByServer.error as never)
  check('that answer is stamped as the provider\'s overflow (family local, shape context-size) — the fold/prune ladder reads the stamp, never the prose', signal !== null && signal.source === 'provider' && signal.family === 'local' && signal.shape === 'context-size', j(signal))
  reset(undefined)
  state.loadedCtx = undefined
  __resetLocalDiscoveryForTest()
  await refreshLocalDiscovery({ force: true })
  check('L4 stands: with no held window and no served window (the model unloaded) the guard is absent and nothing is refused, however large', callModel.localGuardWindow(record()) === undefined && callModel.localLaneProfileFor(record()).requestFitRefusal?.({ requestBytes: 4_000_000, estTokens: 1_000_000, toolCount: 78, wireModel: MODEL }) === undefined)
}

section('§3 the unreadable machine (red on the base): with no memory truth the window comes out bigger, not smaller — the trained max, else the served window, else twice the request and never under 64k')
{
  reset(undefined)
  const r = record()
  const params = paramsFor(fresh('say pong'))
  const estimate = await estimateOf(params)
  const decided = w.chooseLocalWindow(r, estimate, undefined, null)
  check(`no truth, no geometry, the trained max stated: auto = 262144 (reason max), never twice the guess (the base: ${w.doubledRequestWindow(estimate, MODEL_MAX)} from a ${fmt(estimate)}-token guess)`, decided.window === MODEL_MAX && decided.reason === 'max', `${decided.window} · ${decided.reason} · ${decided.words}`)
  check('the words say why: the trained max, the machine not read', decided.words.includes('trained max') && /not read|no memory truth/.test(decided.words), decided.words)
  const sent = await drive(params)
  check('the first send rides /api/chat with num_ctx 262144 and the hold reads max', sent.chat !== undefined && sent.error === undefined && (sent.chat.body.options as { num_ctx?: number }).num_ctx === MODEL_MAX && w.heldLocalWindow(r)?.reason === 'max', j(sent.chat?.body.options))
  const servedOnly = { ...r, modelMaxContext: undefined, contextWindow: { tokens: 131072, source: 'served' as const } }
  const served = w.chooseLocalWindow(servedOnly as never, 15_000, undefined, null)
  check('no trained max, a served window of 128k: auto = the served window', served.window === 131072, `${served.window} · ${served.reason} · ${served.words}`)
  const servedSmall = w.chooseLocalWindow({ ...servedOnly, contextWindow: { tokens: 4096, source: 'served' as const } } as never, 15_000, undefined, null)
  check('a served window smaller than the request needs (4096) never wins: 64k, the floor of the doubling rule', servedSmall.window === 65536, `${servedSmall.window} · ${servedSmall.words}`)
  const bare = { ...r, modelMaxContext: undefined, contextWindow: undefined }
  const small = w.chooseLocalWindow(bare as never, 15_000, undefined, null)
  const big = w.chooseLocalWindow(bare as never, 100_000, undefined, null)
  check('neither stated: twice the request rounded up to 16k, never under 64k — 15k ⇒ 65536 (the base floors at 32k), 100k ⇒ 212992', small.window === 65536 && big.window === 212992 && small.reason === 'req' && big.reason === 'req', `${small.window} · ${big.window}`)
  check('the pure arithmetic: doubledRequestWindow(1k) = 65536, (62k) = 131072, (62k, max 32k) = 32768', w.doubledRequestWindow(1_000) === 65536 && w.doubledRequestWindow(62_000) === 131072 && w.doubledRequestWindow(62_000, 32768) === 32768)
  check('a user setting still wins over every fallback: 64k set ⇒ 64k', w.chooseLocalWindow(bare as never, 100_000, 65536, null).window === 65536)
}

section('§4 the warm follows: its estimate is the same rule and reads the roster its own request carries')
{
  reset(undefined)
  const appState = { toolPermissionContext: permissionContext, mcp: { clients: [], tools: [] }, effortValue: undefined }
  const toolUseContext = {
    options: { tools: pool, thinkingConfig: { type: 'disabled' }, mainLoopModel: PERSISTED, agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: [] }, commands: [], mcpClients: [], isNonInteractiveSession: true },
    getAppState: () => appState,
    setAppState: () => {},
    abortController: new AbortController(),
    messages: [],
  }
  const context ={ systemPrompt: asSystemPrompt(SYSTEM_PROMPT), userContext: {}, systemContext: {}, toolUseContext, forkContextMessages: [] }
  const body = await warm.composeLocalWarm(record(), PERSISTED, context as never)
  const composed = 'skipped' in body ? undefined : body
  const warmReal = composed === undefined ? 0 : Buffer.byteLength(JSON.stringify(composed.request), 'utf8') / WIRE_BYTES_PER_TOKEN
  check('the warm composes its prefix (not skipped)', composed !== undefined, 'skipped' in body ? body.skipped : '')
  check(`the warm's estimate is within 10% of its own request's bytes/${WIRE_BYTES_PER_TOKEN} (${composed?.toolCount ?? 0} schemas)`, composed !== undefined && within(composed.estTokens, warmReal, 0.1), composed === undefined ? 'no body' : `estimate ${fmt(composed.estTokens)} vs real ${fmt(warmReal)}`)
  check('the warm\'s window is the same fallback the turn takes: num_ctx 262144 on the unread machine', composed !== undefined && composed.knobs.numCtx === MODEL_MAX, j(composed?.knobs))
}

ollama.server.close()
console.log(`\n${beforeAfter}`)
console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} LOCAL ESTIMATE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LOCAL ESTIMATE PROOFS PASS')
process.exit(0)
