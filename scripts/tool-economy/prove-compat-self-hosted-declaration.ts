import { spawnSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildFixtureMcpTools } from './fixtureMcpEstate.ts'

const childHome = process.argv[2] === '--scratch-home' ? process.argv[3] : undefined
const HOME = childHome ?? mkdtempSync(join(process.env.MERCURY_TMPDIR ?? tmpdir(), 'compat-self-hosted-declaration-'))
if (childHome === undefined) {
  let status = 1
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--scratch-home', HOME], { env: { ...process.env, HOME, USERPROFILE: HOME }, stdio: 'inherit' })
    status = child.status ?? 1
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
  process.exit(status)
}
if (realpathSync(homedir()) !== realpathSync(HOME)) throw new Error('The self-hosted declaration proof requires its scratch HOME at process start.')

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const k of ['ANTHROPIC_BASE_URL', 'MERCURY_TOOL_SEARCH', 'MERCURY_TOOL_DEFER', 'MERCURY_TOOL_DEFER_PROBE', 'MERCURY_MODEL', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_DISABLE_1M_CONTEXT']) {
  delete process.env[k]
}
process.env.MERCURY_CONFIG_DIR = HOME
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
  console.log('\nTIMEOUT — the self-hosted declaration proof exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

type Engine = 'sglang' | 'vllm' | 'ollama' | 'lmstudio' | 'chat-completions'
type Template = 'refuses-late-system' | 'refuses-system-after-tool' | 'drops-late-system' | 'renders'
type Row = Record<string, unknown> & { role?: string; content?: unknown }
type Wire = { model?: string; messages: Row[]; tools?: Array<{ function?: { name?: string; parameters?: unknown } }> } & Record<string, unknown>

const QWEN_WORDS = 'System message must be at the beginning.'
const MISTRAL_WORDS = "Unexpected role 'system' after role 'tool'"
const SHIPPED: readonly { repository: string; engine: 'sglang' | 'vllm'; template: Template }[] = [
  { repository: 'Qwen/Qwen3.8-2.4T-A95B-FP8', engine: 'sglang', template: 'refuses-late-system' },
  { repository: 'RadixArk/Qwen3.8-2.4T-A95B-NVFP4', engine: 'sglang', template: 'refuses-late-system' },
  { repository: 'Qwen/Qwen3.8-27B-FP8', engine: 'sglang', template: 'refuses-late-system' },
  { repository: 'Qwen/Qwen3.8-Flash-Next-FP8', engine: 'sglang', template: 'refuses-late-system' },
  { repository: 'mistralai/Mistral-Large-3-675B-Instruct-2512', engine: 'vllm', template: 'refuses-system-after-tool' },
  { repository: 'MiniMaxAI/MiniMax-M3', engine: 'sglang', template: 'drops-late-system' },
  { repository: 'MiniMaxAI/MiniMax-M3-MXFP8', engine: 'sglang', template: 'drops-late-system' },
  { repository: 'reflection/Beam-1.0-501B-A23B-FP8', engine: 'sglang', template: 'drops-late-system' },
  { repository: 'reflection/Beam-1.0-501B-A23B-NVFP4', engine: 'sglang', template: 'drops-late-system' },
  { repository: 'openai/gpt-oss-120b', engine: 'vllm', template: 'drops-late-system' },
]
const RENDERS = 'zai-org/GLM-5.3'
const LOCAL_MODEL = 'qwen3.5-9b'
const templateOf = (model: string | undefined): Template => SHIPPED.find(row => row.repository === model)?.template ?? 'renders'

function refusalOf(template: Template, messages: readonly Row[]): string | undefined {
  if (template === 'refuses-late-system' && messages.slice(1).some(row => row.role === 'system')) return QWEN_WORDS
  if (template === 'refuses-system-after-tool' && messages.some((row, index) => row.role === 'system' && messages[index - 1]?.role === 'tool')) return MISTRAL_WORDS
  return undefined
}

function passedOn(template: Template, messages: readonly Row[]): Row[] {
  return template === 'drops-late-system' ? messages.filter((row, index) => index === 0 || row.role !== 'system') : [...messages]
}

const textOf = (rows: readonly Row[]): string => rows.map(row => (typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? ''))).join('\n')
const defines = (text: string, tool: string): boolean => text.includes('<tools>') && text.includes(`"name":"${tool}"`)

const chats = new Map<Engine, Wire[]>()

function engine(kind: Engine): Promise<{ server: Server; root: string }> {
  chats.set(kind, [])
  const listed = [...SHIPPED.filter(row => row.engine === kind).map(row => row.repository), RENDERS, LOCAL_MODEL]
  return new Promise(resolve => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = ''
      req.on('data', chunk => {
        raw += String(chunk)
      })
      req.on('end', () => {
        const path = (req.url ?? '').split('?')[0]
        const json = (status: number, value: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(value))
        }
        if (req.method === 'GET' && path === '/v1/models') return json(200, { object: 'list', data: listed.map(id => ({ id, object: 'model', owned_by: kind, ...(kind === 'vllm' || kind === 'sglang' ? { max_model_len: 262144 } : {}) })) })
        if (req.method === 'POST' && path === '/v1/chat/completions') {
          const body = JSON.parse(raw) as Wire
          chats.get(kind)!.push(body)
          const words = refusalOf(templateOf(body.model), body.messages)
          if (words !== undefined) {
            const error = { message: words, type: 'BadRequestError', param: null, code: 400 }
            return json(400, kind === 'sglang' ? { object: 'error', ...error } : { error })
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const event = (value: Record<string, unknown>): void => void res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1_794_000_000, model: body.model, ...value })}\n\n`)
          event({ choices: [{ index: 0, delta: { role: 'assistant', content: 'engine accepted' }, finish_reason: null }] })
          event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4000, completion_tokens: 3, total_tokens: 4003 } })
          res.end('data: [DONE]\n\n')
          return
        }
        json(404, { error: { message: 'not found', type: 'not_found_error', code: 404 } })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, root: `http://127.0.0.1:${port}` })
    })
  })
}

const KINDS: readonly Engine[] = ['sglang', 'vllm', 'ollama', 'lmstudio', 'chat-completions']
const engines = new Map<Engine, { server: Server; root: string }>()
for (const kind of KINDS) engines.set(kind, await engine(kind))
const base = (kind: Engine): string => `${engines.get(kind)!.root}/v1`
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ compatProvider: {
  'pod-sglang0001': { baseUrl: base('sglang'), hostPodId: 'sglang0001', dialect: 'sglang' },
  'pod-vllm00001': { baseUrl: base('vllm'), hostPodId: 'vllm00001', dialect: 'vllm' },
  'sglang-box': { baseUrl: base('sglang'), dialect: 'sglang' },
  'vllm-box': { baseUrl: base('vllm'), dialect: 'vllm' },
  'ollama-box': { baseUrl: base('ollama'), dialect: 'ollama' },
  'lmstudio-box': { baseUrl: base('lmstudio'), dialect: 'lmstudio' },
  hosted: { baseUrl: base('chat-completions'), dialect: 'chat-completions' },
  answers: { baseUrl: base('chat-completions'), dialect: 'responses' },
} }) + '\n')

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
const { isDeferredToolFor, TOOL_SEARCH_TOOL_NAME } = await import('../../src/tools/ToolSearchTool/prompt.ts')
const { ToolSearchTool } = await import('../../src/tools/ToolSearchTool/ToolSearchTool.ts')
const { getDeferredToolsDeltaAttachment } = await import('../../src/utils/attachments/deltas.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { clearToolRosterLatches, admissionRecordText } = await import('../../src/services/providers/toolEconomy.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
type Tool = import('../../src/Tool.ts').Tool
type Tools = import('../../src/Tool.ts').Tools
type Message = import('../../src/types/message.ts').Message

const permissionContext = getEmptyToolPermissionContext()
const mcpTools: Tool[] = buildFixtureMcpTools<Tool>(MCPTool)
const pool: Tools = assembleToolPool(permissionContext, mcpTools)
const WANTED = 'Crewmate'
const termOf = (body: Wire | undefined): string[] => (body?.tools ?? []).map(tool => String(tool.function?.name ?? ''))
const rolesOf = (body: Wire | undefined): string[] => (body?.messages ?? []).map(row => String(row.role))

async function drive(kind: Engine, model: string, messages: Message[]): Promise<{ body: Wire | undefined; sent: number; error: string | undefined; answered: boolean }> {
  const log = chats.get(kind)!
  const before = log.length
  const errors: string[] = []
  let answered = false
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
      const m = message as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown; stop_reason?: string | null } }
      if (m.type !== 'assistant') continue
      if (m.isApiErrorMessage) errors.push(JSON.stringify(m.message?.content).slice(0, 300))
      else if (m.message?.stop_reason === 'end_turn') answered = true
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  const sent = log.slice(before)
  return { body: sent[sent.length - 1], sent: sent.length, error: errors.length > 0 ? errors.join(' | ') : undefined, answered }
}

const first = createUserMessage({ content: 'Delegate the reading of notes/step-three.txt to a crewmate.' }) as Message
const context = {
  options: { tools: pool },
  getAppState: () => ({ toolPermissionContext: { ...permissionContext, mode: 'default' }, mcp: { clients: [] } }),
}
const admission = (await ToolSearchTool.call({ query: `select:${WANTED}`, max_results: 5 }, context as never) as { data: { matches: string[] } }).data
const block = ToolSearchTool.mapToolResultToToolResultBlockParam(admission as never, 'toolu_ts_1')

async function load(kind: Engine, model: string): Promise<{ fresh: Awaited<ReturnType<typeof drive>>; next: Awaited<ReturnType<typeof drive>>; toolText: string }> {
  clearToolRosterLatches()
  const row = getDeferredToolsDeltaAttachment(pool, model, [first])[0]
  const rendered = (row ? normalizeAttachmentForAPI(row) : []) as Message[]
  const fresh = await drive(kind, model, [first, ...rendered])
  const turn = createAssistantMessage({ content: [{ type: 'tool_use', id: 'toolu_ts_1', name: TOOL_SEARCH_TOOL_NAME, input: { query: `select:${WANTED}` } }] as never }) as Message
  const record = createUserMessage({ content: [block] as never }) as Message
  const next = await drive(kind, model, [first, ...rendered, turn, record])
  const toolRow = next.body?.messages.find(entry => entry.role === 'tool' && entry.tool_call_id === 'toolu_ts_1')
  return { fresh, next, toolText: typeof toolRow?.content === 'string' ? toolRow.content : '' }
}

section('§0 the fixture holds the two things the read templates do with a system row after the first')
{
  const late: Row[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: null }, { role: 'tool', content: 'r' }, { role: 'system', content: '<tools>\n{"type":"function","function":{"name":"Crewmate"}}\n</tools>' }]
  const inside: Row[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, { role: 'assistant', content: null }, { role: 'tool', content: 'r\n\n<tools>\n{"type":"function","function":{"name":"Crewmate"}}\n</tools>' }]
  const post = async (kind: Engine, model: string, messages: Row[]): Promise<{ status: number; text: string }> => {
    const response = await fetch(`${base(kind)}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages }) })
    return { status: response.status, text: await response.text() }
  }
  const qwen = await post('sglang', 'Qwen/Qwen3.8-27B-FP8', late)
  check('a template that holds the system message to the first place refuses a later one in its own words (SGLang\'s error shape)', qwen.status === 400 && qwen.text.includes(QWEN_WORDS) && qwen.text.includes('"object":"error"'), `${qwen.status} ${qwen.text.slice(0, 160)}`)
  const mistral = await post('vllm', 'mistralai/Mistral-Large-3-675B-Instruct-2512', late)
  check('a template that orders the roles refuses a system row after a tool row in its own words (vLLM\'s error shape)', mistral.status === 400 && mistral.text.includes(MISTRAL_WORDS) && mistral.text.includes('"error":{'), `${mistral.status} ${mistral.text.slice(0, 160)}`)
  check('both answer the same conversation when the definition rides inside the tool result', (await post('sglang', 'Qwen/Qwen3.8-27B-FP8', inside)).status === 200 && (await post('vllm', 'mistralai/Mistral-Large-3-675B-Instruct-2512', inside)).status === 200)
  check('a template that drops a later system row passes on no definition from it, and passes on one that rides inside the tool result', !defines(textOf(passedOn('drops-late-system', late)), WANTED) && defines(textOf(passedOn('drops-late-system', inside)), WANTED))
  check('a template that renders every row passes the definition on from either place', defines(textOf(passedOn('renders', late)), WANTED) && defines(textOf(passedOn('renders', inside)), WANTED))
  for (const kind of KINDS) chats.get(kind)!.length = 0
}

section('§1 the seam — the form of each dialect stands: appended for the self-hosted engines, the tools term for a hosted provider')
{
  for (const [name, model] of [['pod-sglang0001', 'Qwen/Qwen3.8-27B-FP8'], ['pod-vllm00001', 'openai/gpt-oss-120b'], ['sglang-box', RENDERS], ['vllm-box', RENDERS], ['ollama-box', LOCAL_MODEL], ['lmstudio-box', LOCAL_MODEL]] as const) {
    const verdict = deferralWireFormFor(`compat/${name}/${model}`)
    check(`${name} reads the appended form`, verdict.form === 'text-append' && verdict.why === 'self-hosted-engine', `${verdict.form}/${verdict.why}`)
  }
  for (const name of ['hosted', 'answers'] as const) {
    const verdict = deferralWireFormFor(`compat/${name}/${RENDERS}`)
    check(`${name} (a hosted provider's dialect) reads the text form from the route table`, verdict.form === 'text' && verdict.why === 'route-table', `${verdict.form}/${verdict.why}`)
  }
  check(`ToolSearch select admits ${WANTED}`, admission.matches.join(',') === WANTED, admission.matches.join(','))
  check('the pool defers on this road: Crewmate waits behind ToolSearch', pool.some(tool => tool.name === WANTED && isDeferredToolFor(tool, `compat/pod-sglang0001/${RENDERS}`)) && pool.some(tool => tool.name === TOOL_SEARCH_TOOL_NAME))
}

section('§2 the ten shipped repositories whose template refuses or drops a system row after the tool result, each on a rented pod of its engine')
for (const shipped of SHIPPED) {
  const model = `compat/pod-${shipped.engine === 'sglang' ? 'sglang0001' : 'vllm00001'}/${shipped.repository}`
  check(`${shipped.repository} is the model of a shipped ${shipped.engine === 'sglang' ? 'SGLang' : 'vLLM'} recipe`, HOST_RECIPES.some(recipe => recipe.model === shipped.repository && (recipe.engine ?? 'sglang') === shipped.engine))
  const { fresh, next, toolText } = await load(shipped.engine, model)
  const roles = rolesOf(next.body)
  check(`${shipped.repository}: after the load no system row rides after the first`, next.sent === 1 && roles[0] === 'system' && roles.slice(1).every(role => role !== 'system'), roles.join(','))
  check(`${shipped.repository}: the ToolSearch result carries the admission record and, after it, the loaded tool's complete definition`, toolText.startsWith(admissionRecordText([WANTED], 'text-append')) && defines(toolText, WANTED) && toolText.includes('"parameters"'), toolText.slice(0, 160))
  check(`${shipped.repository}: the tools term is the fresh request's, byte for byte`, fresh.error === undefined && next.body !== undefined && JSON.stringify(next.body.tools) === JSON.stringify(fresh.body?.tools) && !termOf(next.body).includes(WANTED), termOf(next.body).join(','))
  if (shipped.template === 'drops-late-system') check(`${shipped.repository}: what its template passes on to the model carries the definition`, next.body !== undefined && defines(textOf(passedOn(shipped.template, next.body.messages)), WANTED), `${rolesOf(next.body).join(',')}`)
  else check(`${shipped.repository}: the engine answers, with no refusal from the template`, next.answered && next.error === undefined, next.error ?? 'no answer')
}

section('§3 a template that renders every row carries the definition as it did, and every self-hosted dialect sends the one shape')
for (const [kind, name, model] of [['sglang', 'pod-sglang0001', RENDERS], ['sglang', 'sglang-box', 'Qwen/Qwen3.8-27B-FP8'], ['vllm', 'vllm-box', 'mistralai/Mistral-Large-3-675B-Instruct-2512'], ['ollama', 'ollama-box', LOCAL_MODEL], ['lmstudio', 'lmstudio-box', LOCAL_MODEL]] as const) {
  const { fresh, next, toolText } = await load(kind, `compat/${name}/${model}`)
  const roles = rolesOf(next.body)
  check(`${name} (${model}): the engine answers and what its template passes on carries the definition`, next.answered && next.error === undefined && next.body !== undefined && defines(textOf(passedOn(templateOf(model), next.body.messages)), WANTED), next.error ?? roles.join(','))
  check(`${name} (${model}): the definition rides inside the ToolSearch result, no system row after the first, the tools term frozen`, roles.slice(1).every(role => role !== 'system') && defines(toolText, WANTED) && JSON.stringify(next.body?.tools) === JSON.stringify(fresh.body?.tools), `${roles.join(',')} | ${toolText.slice(0, 80)}`)
}

section('§4 no dialect of a hosted provider moves — the loaded tool joins the tools term and no definition is written into the conversation')
{
  const { fresh, next, toolText } = await load('chat-completions', `compat/hosted/${RENDERS}`)
  check('the engine answers', next.answered && next.error === undefined, next.error ?? 'no answer')
  check('the loaded tool is in the tools term, after the tools the request opened with', termOf(next.body).join(',') === [...termOf(fresh.body), WANTED].join(','), termOf(next.body).join(','))
  check('the ToolSearch result says the schemas are in the tool list and carries no definition', toolText === admissionRecordText([WANTED], 'text') && !textOf(next.body?.messages ?? []).includes('<tools>'), toolText.slice(0, 160))
  check('no system row rides after the first', rolesOf(next.body).slice(1).every(role => role !== 'system'), rolesOf(next.body).join(','))
}

for (const { server } of engines.values()) server.close()
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`❌ ${failures} SELF-HOSTED DECLARATION PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL SELF-HOSTED DECLARATION PROOFS PASS')
process.exit(0)
