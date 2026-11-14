import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixtureMcpTools } from './fixtureMcpEstate.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_DISABLE_1M_CONTEXT']) {
  delete process.env[k]
}
const HOME = mkdtempSync(join(tmpdir(), 'compat-llamacpp-deferral-'))
process.env.MERCURY_CONFIG_DIR = HOME
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
  console.log('\nTIMEOUT — the llama.cpp compat deferral proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const MODEL = 'qwen3.5-2b'
const COMPAT = `compat/lab/${MODEL}`
const POD = `compat/pod-llama0001/${MODEL}`
const VLLM_POD = 'compat/pod-vllm00001/openai/gpt-oss-120b'
const LOCAL = `local/${MODEL}`
const REFUSAL = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'llamacpp-qwen35-system-after-first.json'), 'utf8')) as { status: number; contentType: string; body: string }
type Wire = { messages: Array<Record<string, unknown>>; tools?: Array<{ function?: { name?: string; parameters?: unknown } }> } & Record<string, unknown>
const chats: Wire[] = []
let wanted = 'Crewmate'

function namedBy(body: Wire): string {
  const term = (body.tools ?? []).map(tool => String(tool.function?.name ?? ''))
  return term.includes(wanted) ? wanted : term.find(name => name !== 'ToolSearch') ?? ''
}

function answer(body: Wire, res: ServerResponse): void {
  if (body.messages.slice(1).some(row => row.role === 'system')) {
    res.writeHead(REFUSAL.status, { 'content-type': REFUSAL.contentType })
    res.end(REFUSAL.body)
    return
  }
  const base = { created: 1_794_000_000, id: 'chatcmpl-fixture', model: MODEL, system_fingerprint: 'b12359-b1b770d90', object: 'chat.completion.chunk' }
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (value: Record<string, unknown>): void => void res.write(`data: ${JSON.stringify({ ...value, ...base })}\n\n`)
  event({ choices: [{ finish_reason: null, index: 0, delta: { role: 'assistant', content: null } }] })
  event({ choices: [{ finish_reason: null, index: 0, delta: { tool_calls: [{ index: 0, id: 'call_fixture_1', type: 'function', function: { name: namedBy(body), arguments: '{}' } }] } }] })
  event({ choices: [{ finish_reason: 'tool_calls', index: 0, delta: {} }] })
  event({ choices: [], usage: { completion_tokens: 12, prompt_tokens: 4000, total_tokens: 4012, prompt_tokens_details: { cached_tokens: 0 } } })
  res.end('data: [DONE]\n\n')
}

function engine(): Promise<{ server: Server; root: string }> {
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0]
        const json = (status: number, value: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(value))
        }
        if (req.method === 'GET' && path === '/health') return json(200, { status: 'ok' })
        if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) return json(200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'llamacpp', meta: { n_ctx: 65536, n_ctx_train: 262144, n_params: 1881825088, size: 1269873920 } }] })
        if (req.method === 'GET' && path === '/props') return json(200, { default_generation_settings: { n_ctx: 65536 }, total_slots: 2, modalities: { vision: false }, chat_template_caps: { supports_tools: true, supports_tool_calls: true, supports_preserve_reasoning: false, supports_reasoning_effort: false, reasoning_effort_levels: [] }, build_info: 'b12359-b1b770d90' })
        if (req.method === 'GET' && path === '/slots') return json(200, [{ id: 0, n_ctx: 65536, is_processing: false }, { id: 1, n_ctx: 65536, is_processing: false }])
        if (req.method === 'GET' && path === '/metrics') {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
          res.end('llamacpp:prompt_tokens_seconds 1200\n')
          return
        }
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          const body = JSON.parse(raw) as Wire
          chats.push(body)
          return answer(body, res)
        }
        json(404, { error: { message: 'File Not Found', type: 'not_found_error', code: 404 } })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}

const llama = await engine()
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ compatProvider: {
  lab: { baseUrl: `${llama.root}/v1`, dialect: 'llamacpp' },
  'pod-llama0001': { baseUrl: `${llama.root}/v1`, hostPodId: 'llama0001', dialect: 'llamacpp' },
  'pod-vllm00001': { baseUrl: 'http://127.0.0.1:9/pod/v1', hostPodId: 'vllm00001', dialect: 'vllm' },
} }) + '\n')
process.env.MERCURY_LOCAL_PROBE_TARGETS = `llamacpp=${llama.root}`

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { assembleToolPool } = await import('../../src/tools.ts')
const { MCPTool } = await import('../../src/tools/MCPTool/MCPTool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { clearToolRosterLatches, admissionRecordText } = await import('../../src/services/providers/toolEconomy.ts')
type Tool = import('../../src/Tool.ts').Tool
type Tools = import('../../src/Tool.ts').Tools
type Message = import('../../src/types/message.ts').Message

await refreshLocalDiscovery({ force: true })
const permissionContext = getEmptyToolPermissionContext()
const mcpTools: Tool[] = buildFixtureMcpTools<Tool>(MCPTool)
const pool: Tools = assembleToolPool(permissionContext, mcpTools)
const deferredNames = pool.filter(t => isDeferredToolFor(t, COMPAT)).map(t => t.name)
const loadedNames = pool.filter(t => !isDeferredToolFor(t, COMPAT)).map(t => t.name)
const termOf = (body: Wire | undefined): string[] => (body?.tools ?? []).map(tool => String(tool.function?.name ?? ''))
const rolesOf = (body: Wire | undefined): string[] => (body?.messages ?? []).map(row => String(row.role))

async function drive(model: string, messages: Message[]): Promise<{ body: Wire | undefined; sent: number; error: string | undefined; called: string[] }> {
  const before = chats.length
  const errors: string[] = []
  const called: string[] = []
  try {
    const stream = routedCallModel({
      messages,
      systemPrompt: ['You are a fixture assistant.'] as never,
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
      if (m.type !== 'assistant') continue
      if (m.isApiErrorMessage) errors.push(JSON.stringify(m.message?.content).slice(0, 400))
      else if (Array.isArray(m.message?.content)) for (const block of m.message.content as Array<{ type?: string; name?: string }>) if (block.type === 'tool_use' && block.name) called.push(block.name)
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const sent = chats.slice(before)
  return { body: sent[sent.length - 1], sent: sent.length, error: errors.length > 0 ? errors.join(' | ') : undefined, called }
}

section('§0 the fixture holds the two things llama.cpp does: the Qwen3.5 template refuses a system row after the first, and a call can only name a tool of the tools term')
{
  const post = async (body: Wire): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${llama.root}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: response.status, text: await response.text() }
  }
  const tools = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }, { type: 'function', function: { name: 'ToolSearch', parameters: { type: 'object', properties: {} } } }]
  const late = await post({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'system', content: 'late' }], tools })
  check('a system row after the first is answered with the recorded refusal of the real server (HTTP 500, the template\'s own words)', late.status === 500 && late.text === REFUSAL.body && /Jinja Exception: System message must be at the beginning\./.test(late.text), `${late.status} ${late.text.slice(0, 120)}`)
  const outside = await post({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools })
  check('asked for a tool that is not in the tools term, the engine names one that is', outside.status === 200 && outside.text.includes('"name":"Read"') && !outside.text.includes(`"name":"${wanted}"`), outside.text.slice(0, 200))
  const inside = await post({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools: [...tools, { type: 'function', function: { name: wanted, parameters: { type: 'object', properties: {} } } }] })
  check('with the tool in the tools term, the engine names it', inside.status === 200 && inside.text.includes(`"name":"${wanted}"`), inside.text.slice(0, 200))
  chats.length = 0
}

section('§1 the seam — a llama.cpp endpoint reads the text form on the compat road as it does on the local road')
{
  const compat = deferralWireFormFor(COMPAT)
  const pod = deferralWireFormFor(POD)
  const local = deferralWireFormFor(LOCAL)
  const vllm = deferralWireFormFor(VLLM_POD)
  check('a named endpoint of dialect llamacpp → text', compat.form === 'text', `${compat.form}/${compat.why}`)
  check('a rented pod of dialect llamacpp → text', pod.form === 'text', `${pod.form}/${pod.why}`)
  check('the same engine reads the same form whichever road reaches it (the local llama.cpp record\'s verdict)', local.form === 'text' && JSON.stringify(compat) === JSON.stringify(local) && JSON.stringify(pod) === JSON.stringify(local), `${JSON.stringify(compat)} ${JSON.stringify(pod)} ${JSON.stringify(local)}`)
  check('a rented vLLM pod keeps the appended form', vllm.form === 'text-append' && vllm.why === 'self-hosted-engine', `${vllm.form}/${vllm.why}`)
  const words = await ToolSearchTool.prompt({ model: COMPAT } as never)
  check('ToolSearch\'s words for the endpoint do not promise definitions appended after the result', !/appended to the conversation right after it/.test(words))
  check('the pool defers on this road: Crewmate waits behind ToolSearch', deferredNames.includes(wanted) && loadedNames.includes(TOOL_SEARCH_TOOL_NAME), loadedNames.join(','))
}

section('§2 the fresh request — one system row, the loaded tools in the tools term')
const first = createUserMessage({ content: 'Delegate the reading of notes/step-three.txt to a crewmate.' }) as Message
let freshTerm: string[] = []
{
  clearToolRosterLatches()
  const row = getDeferredToolsDeltaAttachment(pool, COMPAT, [first])[0]
  const rendered = row ? normalizeAttachmentForAPI(row) : []
  wanted = 'Read'
  const fresh = await drive(COMPAT, [first, ...(rendered as Message[])])
  wanted = 'Crewmate'
  freshTerm = termOf(fresh.body)
  check('one request rode the wire and was answered', fresh.sent === 1 && fresh.error === undefined, fresh.error ?? `sent=${fresh.sent}`)
  check('the system row is the first and the only one', rolesOf(fresh.body)[0] === 'system' && rolesOf(fresh.body).slice(1).every(role => role !== 'system'), rolesOf(fresh.body).join(','))
  check('the tools term is the set this road loads in full; Crewmate is not in it', freshTerm.join(',') === loadedNames.join(',') && !freshTerm.includes('Crewmate'), freshTerm.join(','))
}

section('§3 the load — ToolSearch admits Crewmate; the next request carries it in the tools term and no declaration row')
{
  const context = {
    options: { tools: pool },
    getAppState: () => ({ toolPermissionContext: { ...permissionContext, mode: 'default' }, mcp: { clients: [] } }),
  }
  const result = await ToolSearchTool.call({ query: `select:${wanted}`, max_results: 5 }, context as never)
  const output = (result as { data: { matches: string[] } }).data
  check(`ToolSearch select admits ${wanted}`, output.matches.join(',') === wanted, output.matches.join(','))
  const block = ToolSearchTool.mapToolResultToToolResultBlockParam(output as never, 'toolu_ts_1')
  const row = getDeferredToolsDeltaAttachment(pool, COMPAT, [first])[0]
  const rendered = row ? normalizeAttachmentForAPI(row) : []
  const turn = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${wanted}` } }] as never }) as Message
  const record = createUserMessage({ content: [block] as never }) as Message
  const transcript: Message[] = [first, ...(rendered as Message[]), turn, record]
  const next = await drive(COMPAT, transcript)
  const roles = rolesOf(next.body)
  const term = termOf(next.body)
  check('no system row rides after the first (the template refuses one)', roles[0] === 'system' && roles.slice(1).every(role => role !== 'system'), roles.join(','))
  check('the loaded tool is in the tools term with its schema, after the tools the request opened with', term.join(',') === [...freshTerm, wanted].join(',') && typeof next.body?.tools?.find(tool => tool.function?.name === wanted)?.function?.parameters === 'object', term.join(','))
  const toolRow = next.body?.messages.find(row => row.role === 'tool' && row.tool_call_id === 'toolu_ts_1')
  const toolText = typeof toolRow?.content === 'string' ? toolRow.content : ''
  check('the ToolSearch result says the schemas are in the tool list, and carries no definitions of its own', toolText === admissionRecordText([wanted], 'text') && !toolText.includes('<tools>'), toolText.slice(0, 200))
  check('the engine answered once, with no refusal', next.sent === 1 && next.error === undefined, next.error ?? `sent=${next.sent}`)
  check('the call that comes back names the loaded tool', next.called.join(',') === wanted, next.called.join(',') || next.error || 'no call')
  const pod = await drive(POD, transcript)
  check('the rented llama.cpp pod sends the same shape and gets the same call', pod.error === undefined && rolesOf(pod.body).slice(1).every(role => role !== 'system') && termOf(pod.body).includes(wanted) && pod.called.join(',') === wanted, pod.error ?? `${rolesOf(pod.body).join(',')} | ${pod.called.join(',')}`)
  const later = await drive(COMPAT, [...transcript, createAssistantMessage({ content: 'The crewmate has the task.' }) as Message, createUserMessage({ content: 'and again' }) as Message])
  check('a later turn keeps the loaded tool in the tools term', later.error === undefined && termOf(later.body).join(',') === term.join(','), later.error ?? termOf(later.body).join(','))
  check('no tool_reference block reaches the wire', !JSON.stringify(next.body?.messages ?? []).includes('tool_reference'))
}

llama.server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} LLAMA.CPP COMPAT DEFERRAL PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL LLAMA.CPP COMPAT DEFERRAL PROOFS PASS')
process.exit(0)
