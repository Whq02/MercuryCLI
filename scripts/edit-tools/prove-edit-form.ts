#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.length > 400 ? `${detail.slice(0, 400)}…` : detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the edit form proof exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

const FLAG = 'MERCURY_EDIT_FORM'
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'MERCURY_MODEL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_BARE',
  'MERCURY_TOOL_SEARCH',
  'MERCURY_TOOL_DEFER',
  'MERCURY_EDIT_HUNKS',
  'MERCURY_CHANGE_RECEIPTS',
  'MERCURY_LINE_ANCHORS',
  'MERCURY_LOCAL_PROMPT_PROFILE',
  'GOOGLE_API_KEY',
  FLAG,
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'edit-form-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'edit-form-daemon-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Body = Record<string, unknown>
type Json = Record<string, unknown>
type Form = 'full' | 'plain'
type Arm = Form | undefined

const j = (value: unknown): string => JSON.stringify(value)
const sse = (obj: unknown): string => `data: ${j(obj)}\n\n`

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
function geminiSse(): string {
  return [
    sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'ok' }] } }] }),
    sse({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 1, totalTokenCount: 9 } }),
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

const captured: Array<{ road: string; body: Body }> = []
let activeRoad = ''

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    let body: Body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body
    } catch {
      body = {}
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      if (path === '/openai/v1/models') res.end(j(OPENAI_MODELS_BODY))
      else if (path === '/moonshot/v1/models') res.end(j({ object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'moonshot', context_length: 1048576 }] }))
      else if (path === '/localsrv/v1/models') res.end(j({ data: [{ id: 'qwen3-32b', object: 'model', owned_by: 'vllm', max_model_len: 131072 }] }))
      else if (path === '/gemini/v1beta/models') res.end(j({ models: [{ name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent'] }] }))
      else if (path === '/openrouter/api/v1/models') res.end(j({ data: [{ id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' }] }))
      else res.end(j({ object: 'list', data: [], models: [] }))
      return
    }
    const isMessages = path.endsWith('/v1/messages')
    const isResponses = path.endsWith('/responses')
    const isChat = path.endsWith('/chat/completions')
    const isGemini = path.endsWith(':streamGenerateContent')
    if (req.method === 'POST' && (isMessages || isResponses || isChat || isGemini)) {
      captured.push({ road: activeRoad, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(isMessages ? anthropicSse() : isResponses ? responsesSse() : isGemini ? geminiSse() : chatSse())
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`

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
  MERCURY_COMPAT_LABEL: 'edit form fixture endpoint',
  MERCURY_LOCAL_PROBE_TARGETS: `vllm=${base}/localsrv`,
})

console.log('============================================================')
console.log(' the Edit tool in two forms — full and plain, one flag')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { GLM_STATIC_CATALOGUE } = await import('../../src/services/providers/zai/zaiAdapter.ts')
const { moonshotCatalogueEntries } = await import('../../src/services/providers/moonshot/moonshotAdapter.ts')
const { refreshMoonshotCatalogue } = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const { DEEPSEEK_STATIC_CATALOGUE } = await import('../../src/services/providers/deepseek/deepseekAdapter.ts')
const { HUGGINGFACE_STATIC_CATALOGUE } = await import('../../src/services/providers/huggingface/huggingfaceAdapter.ts')
const { PROVIDER_ID_SPACES, FIRST_PARTY_ID_MARK } = await import('../../src/services/providers/idSpaces.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { deferralWireFormFor } = await import('../../src/services/providers/deferralWire.ts')
const { resolveModelCapabilities } = await import('../../src/utils/model/capabilities.ts')
const { localPromptProfileApplies } = await import('../../src/constants/localPromptProfile.ts')
const { toolToAPISchema } = await import('../../src/utils/api.ts')
const { getToolSchemaCache, clearToolSchemaCache } = await import('../../src/utils/toolSchemaCache.ts')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')
const { FileEditTool } = await import('../../src/tools/FileEditTool/FileEditTool.ts')
const { FileReadTool } = await import('../../src/tools/FileReadTool/FileReadTool.ts')
type Message = import('../../src/types/message.ts').Message

await refreshLocalDiscovery({ force: true })
await refreshMoonshotCatalogue({ force: true })

const FIXTURES = join(import.meta.dir, 'fixtures')
const STORED = JSON.parse(readFileSync(join(FIXTURES, 'edit-forms.json'), 'utf8')) as {
  full: { description: string; strict: Json }
  plain: { description: string; schema: Json; strict: Json }
}
const FORMS: Record<Form, { description: string; schema: Json; strict: Json }> = {
  full: { description: STORED.full.description, schema: JSON.parse(readFileSync(join(FIXTURES, 'edit-input-schema-28.json'), 'utf8')) as Json, strict: STORED.full.strict },
  plain: STORED.plain,
}
const keysOf = (schema: Json): string[] => Object.keys((schema.properties ?? {}) as Json)

type Envelope = 'messages-first-party' | 'messages' | 'responses' | 'chat' | 'gemini'
const ENVELOPES: Record<Envelope, (form: Form) => unknown> = {
  'messages-first-party': form => ({ name: 'Edit', description: FORMS[form].description, input_schema: FORMS[form].schema, eager_input_streaming: true }),
  messages: form => ({ name: 'Edit', description: FORMS[form].description, input_schema: FORMS[form].schema }),
  responses: form => ({ type: 'function', name: 'Edit', description: FORMS[form].description, parameters: FORMS[form].strict, strict: true }),
  chat: form => ({ type: 'function', function: { name: 'Edit', description: FORMS[form].description, parameters: FORMS[form].schema } }),
  gemini: form => ({ name: 'Edit', description: FORMS[form].description, parametersJsonSchema: FORMS[form].schema }),
}

interface Road {
  road: string
  envelope: Envelope
  model: string
  env: Record<string, string | undefined>
  firstParty?: true
  local?: true
}
const ROADS: Road[] = [
  { road: 'anthropic', envelope: 'messages-first-party', model: 'claude-sonnet-5', env: { ANTHROPIC_API_KEY: 'fixture-anthropic-key', ANTHROPIC_BASE_URL: undefined }, firstParty: true },
  { road: 'anthropic-gateway', envelope: 'messages', model: 'claude-sonnet-5', env: { ANTHROPIC_AUTH_TOKEN: 'fixture-token', ANTHROPIC_BASE_URL: base } },
  { road: 'openai', envelope: 'responses', model: 'gpt-5.6-sol', env: {} },
  { road: 'zai', envelope: 'chat', model: GLM_STATIC_CATALOGUE[0]!.id, env: {} },
  { road: 'moonshot', envelope: 'chat', model: moonshotCatalogueEntries()[0]!.id, env: {} },
  { road: 'deepseek', envelope: 'chat', model: DEEPSEEK_STATIC_CATALOGUE[0]!.id, env: {} },
  { road: 'openai-compat', envelope: 'chat', model: 'compat/qwen-max', env: {} },
  { road: 'openrouter', envelope: 'chat', model: 'openrouter/qwen/qwen3-coder', env: {} },
  { road: 'gemini', envelope: 'gemini', model: 'gemini-3-pro', env: {} },
  { road: 'huggingface', envelope: 'chat', model: HUGGINGFACE_STATIC_CATALOGUE[0]!.id, env: {} },
  { road: 'local', envelope: 'chat', model: 'local/qwen3-32b', env: {}, local: true },
]
const roadNamed = (name: string): Road => ROADS.find(road => road.road === name)!
const formSent = (road: Road, arm: Arm): Form => arm ?? (road.local ? 'plain' : 'full')

const POOL = [FileEditTool, FileReadTool] as never
const permissionContext = getEmptyToolPermissionContext()

function setArm(arm: Arm): void {
  if (arm === undefined) delete process.env[FLAG]
  else process.env[FLAG] = arm
}

function firstPartyFetch(road: string): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    let body: Body = {}
    try {
      body = JSON.parse(typeof init?.body === 'string' ? init.body : '') as Body
    } catch {
      body = {}
    }
    captured.push({ road, body })
    return new Response(anthropicSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
}

const opening = (): Message => createUserMessage({ content: 'Say ok.' }) as Message
const nextTurn = (conversation: Message[]): Message[] => [
  ...conversation,
  createAssistantMessage({ content: 'ok' }) as Message,
  createUserMessage({ content: 'Say ok again.' }) as Message,
]

async function drive(road: Road, messages: Message[], tools: unknown = POOL): Promise<{ body: Body | undefined; error: string }> {
  for (const [k, v] of Object.entries(road.env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  process.env.MERCURY_MODEL = road.model
  activeRoad = road.road
  const before = captured.length
  const errors: string[] = []
  try {
    const stream = routedCallModel({
      messages: messages as never,
      systemPrompt: ['You are a fixture assistant. Reply with one word.'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: tools as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => permissionContext,
        model: road.model,
        isNonInteractiveSession: true,
        querySource: 'main_thread' as never,
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        hasPendingMcpServers: false,
        ...(road.firstParty ? { fetchOverride: firstPartyFetch(road.road) as never } : {}),
      } as never,
    })
    for await (const message of stream) {
      const m = message as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
      if (m.type === 'assistant' && m.isApiErrorMessage) errors.push(j(m.message?.content).slice(0, 300))
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  for (const k of Object.keys(road.env)) delete process.env[k]
  delete process.env.MERCURY_MODEL
  const mine = captured.slice(before).filter(c => c.road === road.road)
  return { body: mine[0]?.body, error: mine.length === 1 ? errors.join(' | ') : `${mine.length} requests ${errors.join(' | ')}` }
}

function toolEntries(road: Road, body: Body | undefined): Json[] {
  const tools = Array.isArray(body?.tools) ? (body.tools as Json[]) : []
  return road.envelope === 'gemini' ? tools.flatMap(tool => (Array.isArray(tool.functionDeclarations) ? (tool.functionDeclarations as Json[]) : [])) : tools
}
const nameOfEntry = (entry: Json): unknown => (entry.function as Json | undefined)?.name ?? entry.name
const editEntry = (road: Road, body: Body | undefined): Json | undefined => toolEntries(road, body).find(entry => nameOfEntry(entry) === 'Edit')

function aroundEdit(road: Road, body: Body | undefined): string {
  if (body === undefined) return 'no request'
  const { diagnostics: _diagnostics, prompt_cache_key: _key, ...rest } = body
  const entries = (Array.isArray(rest.tools) ? (rest.tools as Json[]) : []).map(tool =>
    road.envelope === 'gemini' && Array.isArray(tool.functionDeclarations)
      ? { ...tool, functionDeclarations: (tool.functionDeclarations as Json[]).map(entry => (nameOfEntry(entry) === 'Edit' ? 'Edit' : entry)) }
      : nameOfEntry(tool) === 'Edit'
        ? 'Edit'
        : tool,
  )
  return j({ ...rest, tools: entries })
}

const sentByArm = new Map<string, Body | undefined>()
async function everyRoad(arm: Arm, label: string): Promise<void> {
  setArm(arm)
  for (const road of ROADS) {
    const { body, error } = await drive(road, [opening()])
    sentByArm.set(`${label}/${road.road}`, body)
    const entry = editEntry(road, body)
    const form = formSent(road, arm)
    check(`${road.road} (${road.model}): one request, Edit and Read on it`, error === '' && j(toolEntries(road, body).map(nameOfEntry)) === j(['Edit', 'Read']), `${error} ${j(toolEntries(road, body).map(nameOfEntry))}`)
    check(`${road.road}: Edit goes out in the ${form} form, byte for byte the stored definition in this road's own envelope`, j(entry) === j(ENVELOPES[road.envelope](form)), j(entry))
  }
  setArm(undefined)
}

section('§1 the flag unset: every road sends for Edit what it sent before the flag existed')
check('the stored full form is four shapes over eight keys in 358 bytes of description, the plain form the swap and append over five keys in 183', j(keysOf(FORMS.full.schema)) === j(['file_path', 'old_string', 'new_string', 'replace_all', 'expected_anchor', 'hunks', 'append', 'section']) && Buffer.byteLength(FORMS.full.description) === 358 && j(keysOf(FORMS.plain.schema)) === j(['file_path', 'old_string', 'new_string', 'replace_all', 'append']) && Buffer.byteLength(FORMS.plain.description) === 183)
await everyRoad(undefined, 'unset')

section('§2 MERCURY_EDIT_FORM=plain: every road sends the form a local model gets; around it the request is the unset one, but for a prompt cache key that digests the tool list')
await everyRoad('plain', 'plain')
for (const road of ROADS) {
  const before = sentByArm.get(`unset/${road.road}`)
  const after = sentByArm.get(`plain/${road.road}`)
  check(`${road.road}: the request around the Edit definition is the unset request`, aroundEdit(road, after) === aroundEdit(road, before), aroundEdit(road, after))
  if (typeof before?.prompt_cache_key === 'string') {
    check(`${road.road}: its prompt cache key, a digest over the tool list, follows the definition`, typeof after?.prompt_cache_key === 'string' && after.prompt_cache_key !== before.prompt_cache_key, String(after?.prompt_cache_key))
  }
}
const strictPlain = editEntry(roadNamed('openai'), sentByArm.get('plain/openai'))?.parameters as Json | undefined
check('on the strict road a plain Edit call carries five keys where a full one carries eight', j(strictPlain?.required) === j(['file_path', 'old_string', 'new_string', 'replace_all', 'append']) && (FORMS.full.strict.required as unknown[]).length === 8, j(strictPlain?.required))

section('§3 MERCURY_EDIT_FORM=full: a cloud road sends the unset request, a local model is sent the four shapes and the rest of its request stays')
await everyRoad('full', 'full')
for (const road of ROADS) {
  const before = sentByArm.get(`unset/${road.road}`)
  const after = sentByArm.get(`full/${road.road}`)
  check(`${road.road}: the request around the Edit definition is the unset request`, aroundEdit(road, after) === aroundEdit(road, before), aroundEdit(road, after))
  if (!road.local && typeof before?.prompt_cache_key === 'string') {
    check(`${road.road}: its prompt cache key is the unset one`, after?.prompt_cache_key === before.prompt_cache_key, String(after?.prompt_cache_key))
  }
}

section('§4 the flag unset again in the same process: both arms left nothing behind')
await everyRoad(undefined, 'unset-again')
for (const road of ROADS) {
  const before = sentByArm.get(`unset/${road.road}`)
  const after = sentByArm.get(`unset-again/${road.road}`)
  check(`${road.road}: the request around the Edit definition, and any prompt cache key, are the first unset request's`, aroundEdit(road, after) === aroundEdit(road, before) && after?.prompt_cache_key === before?.prompt_cache_key, aroundEdit(road, after))
}

section('§5 the one seam every road builds a definition at, over all 24 route families')
type IdSpace = { route: string; qualifiedPrefix?: string; barePrefixes?: readonly string[]; innerGrammar?: string }
const modelOfSpace = (space: IdSpace, name: string): string =>
  space.qualifiedPrefix !== undefined ? `${space.qualifiedPrefix}${space.innerGrammar === 'segments-2' ? `vendor/${name}` : name}` : `${space.barePrefixes![0]}${name}`
const FAMILIES: Array<{ route: string; model: string; twin: string }> = [
  { route: 'anthropic', model: `${FIRST_PARTY_ID_MARK}fixture-one`, twin: `${FIRST_PARTY_ID_MARK}fixture-two` },
  ...(PROVIDER_ID_SPACES as readonly IdSpace[]).map(space => ({ route: space.route, model: modelOfSpace(space, 'fixture-one'), twin: modelOfSpace(space, 'fixture-two') })),
]
check('the families are the 24 the router knows, each fixture id on its own route', FAMILIES.length === 24 && new Set(FAMILIES.map(family => family.route)).size === 24 && FAMILIES.every(family => declaredRouteOf(family.model) === family.route && declaredRouteOf(family.twin) === family.route), j(FAMILIES.map(family => `${family.route}=${declaredRouteOf(family.model)}`)))

type Built = { description: string; input_schema: Json }
const build = async (model: string): Promise<Built> => (await toolToAPISchema(FileEditTool, { getToolPermissionContext: async () => permissionContext, tools: POOL, agents: [], model })) as unknown as Built
const isForm = (built: Built, form: Form): boolean => built.description === FORMS[form].description && j(built.input_schema) === j(FORMS[form].schema)
const formOf = (built: Built): string => (isForm(built, 'full') ? 'full' : isForm(built, 'plain') ? 'plain' : `neither (${built.description.slice(0, 60)}… ${j(keysOf(built.input_schema))})`)
const keyBefore = (model: string): string => {
  const caps = resolveModelCapabilities(model)
  return `Edit@${declaredRouteOf(model) ?? 'unrecognised'}:${caps.media.pdf ? 'p' : ''}${caps.media.images ? 'i' : ''}:${deferralWireFormFor(model).form}${localPromptProfileApplies(model) ? ':local-profile' : ''}|Edit,Read`
}
const cacheKeys = (): string[] => [...getToolSchemaCache().keys()]

for (const [arm, label] of [[undefined, 'unset'], ['plain', 'plain'], ['full', 'full']] as Array<[Arm, string]>) {
  setArm(arm)
  clearToolSchemaCache()
  const wrong: string[] = []
  for (const family of FAMILIES) {
    const want = arm ?? (family.route === 'local' ? 'plain' : 'full')
    const built = await build(family.model)
    if (!isForm(built, want)) wrong.push(`${family.route}: ${formOf(built)}`)
  }
  check(`${label}: ${arm === undefined ? 'the local family is built plain and the other 23 full' : `all 24 families are built ${arm}`}`, wrong.length === 0, wrong.join(' · '))
  if (arm === undefined) check('unset: the 24 cache keys are the keys the definition cache had before the flag existed', j(cacheKeys()) === j(FAMILIES.map(family => keyBefore(family.model))), j(cacheKeys().filter((key, i) => key !== keyBefore(FAMILIES[i]!.model))))
  else check(`${label}: no cache key is an unset key, so a build under the flag can neither take nor leave an unset definition`, cacheKeys().length === 24 && cacheKeys().every((key, i) => key !== keyBefore(FAMILIES[i]!.model) && key.startsWith('Edit@') && key.endsWith('|Edit,Read')), j(cacheKeys().slice(0, 3)))
}
setArm(undefined)

section('§6 the definition cache: two models on one road share a cached Edit only while their forms agree')
for (const family of FAMILIES.filter(row => ['openrouter', 'openai', 'anthropic', 'local'].includes(row.route))) {
  const natural: Form = family.route === 'local' ? 'plain' : 'full'
  const other: Form = natural === 'full' ? 'plain' : 'full'
  setArm(undefined)
  clearToolSchemaCache()
  const first = await build(family.model)
  const twinUnset = await build(family.twin)
  check(`${family.route}: unset, the two models share one cached Edit under the one key the cache had before`, isForm(first, natural) && twinUnset.input_schema === first.input_schema && j(cacheKeys()) === j([keyBefore(family.model)]), `${formOf(first)} ${j(cacheKeys())}`)
  setArm(other)
  const twinForced = await build(family.twin)
  check(`${family.route}: with the second model's form forced to ${other}, it is built ${other} and never handed the first model's cached ${natural} Edit`, isForm(twinForced, other) && twinForced.input_schema !== first.input_schema, formOf(twinForced))
  check(`${family.route}: the cache then holds the two definitions under two keys, the unset one untouched`, cacheKeys().length === 2 && cacheKeys()[0] === keyBefore(family.model) && getToolSchemaCache().get(keyBefore(family.model))?.input_schema === first.input_schema, j(cacheKeys()))
  setArm(undefined)
  const firstAgain = await build(family.model)
  const twinAgain = await build(family.twin)
  check(`${family.route}: unset again, both models are served the first cached definition and nothing new is built`, firstAgain.input_schema === first.input_schema && twinAgain.input_schema === first.input_schema && cacheKeys().length === 2, `${formOf(twinAgain)} ${j(cacheKeys())}`)
}
clearToolSchemaCache()

section('§7 two conversations in one process: each keeps the form it began with, whatever the flag reads later')
for (const name of ['anthropic-gateway', 'openai', 'zai', 'local']) {
  const road = roadNamed(name)
  const natural = formSent(road, undefined)
  const other: Form = natural === 'full' ? 'plain' : 'full'
  const sent = async (conversation: Message[]): Promise<string> => {
    const { body, error } = await drive(road, conversation)
    const entry = editEntry(road, body)
    return error !== '' ? error : j(entry) === j(ENVELOPES[road.envelope]('full')) ? 'full' : j(entry) === j(ENVELOPES[road.envelope]('plain')) ? 'plain' : `neither: ${j(entry).slice(0, 200)}`
  }
  setArm(undefined)
  const begun = [opening()]
  const begunFirst = await sent(begun)
  setArm(other)
  const later = [opening()]
  const laterFirst = await sent(later)
  const begunSecond = await sent(nextTurn(begun))
  setArm(undefined)
  const laterSecond = await sent(nextTurn(later))
  const fresh = await sent([opening()])
  check(`${name}: a conversation begun unset is sent ${natural}, and ${natural} again on its next request after the flag turned ${other}`, begunFirst === natural && begunSecond === natural, `${begunFirst} then ${begunSecond}`)
  check(`${name}: a conversation begun under ${other} is sent ${other}, and ${other} again on its next request after the flag was unset`, laterFirst === other && laterSecond === other, `${laterFirst} then ${laterSecond}`)
  check(`${name}: a third conversation, begun after the flag was unset, is sent ${natural}`, fresh === natural, fresh)
}
setArm(undefined)
clearToolSchemaCache()

section('§8 a value that is neither form reads as unset')
const cloud = FAMILIES.find(family => family.route === 'openrouter')!
const local = FAMILIES.find(family => family.route === 'local')!
for (const value of ['PLAIN', 'Full', ' plain', 'plain ', 'lines', '1', '0', 'true', '']) {
  process.env[FLAG] = value
  clearToolSchemaCache()
  const builtCloud = await build(cloud.model)
  const builtLocal = await build(local.model)
  check(`${j(value)}: a cloud model is built full, a local model plain, under the unset cache keys`, isForm(builtCloud, 'full') && isForm(builtLocal, 'plain') && j(cacheKeys()) === j([keyBefore(cloud.model), keyBefore(local.model)]), `${formOf(builtCloud)} ${formOf(builtLocal)} ${j(cacheKeys())}`)
}
setArm(undefined)
clearToolSchemaCache()

section('§9 with the local prompt profile switched off, the flag still decides a local model\'s Edit')
process.env.MERCURY_LOCAL_PROMPT_PROFILE = '0'
for (const [arm, want, label] of [[undefined, 'full', 'unset'], ['plain', 'plain', 'plain'], ['full', 'full', 'full']] as Array<[Arm, Form, string]>) {
  setArm(arm)
  clearToolSchemaCache()
  const built = await build(local.model)
  check(`profile off, ${label}: a local model is built ${want}${arm === undefined ? ', the profile\'s own off arm as it was' : ''}`, isForm(built, want) && j(cacheKeys()) === j([arm === undefined ? keyBefore(local.model) : keyBefore(local.model).replace('|', `:edit-${arm}|`)]), `${formOf(built)} ${j(cacheKeys())}`)
}
delete process.env.MERCURY_LOCAL_PROMPT_PROFILE
setArm(undefined)
clearToolSchemaCache()

section('§10 the form is what a model is shown: the tool accepts every shape in either form')
const target = join(mkdtempSync(join(tmpdir(), 'edit-form-file-')), 'notes.md')
writeFileSync(target, '# Notes\n\n## Checks\n\nalpha\nbeta\n')
const absent = join(tmpdir(), `edit-form-absent-${process.pid}.md`)
const context = {
  readFileState: new Map<string, unknown>(),
  abortController: new AbortController(),
  getAppState: () => ({ toolPermissionContext: permissionContext }),
} as never
const SHAPES: Array<[string, Json]> = [
  ['the swap', { file_path: target, old_string: 'alpha', new_string: 'gamma' }],
  ['hunks against an anchor', { file_path: target, hunks: [{ lines: '5', replace: 'gamma' }], expected_anchor: 'fa:0123456789ab' }],
  ['hunks without their anchor', { file_path: target, hunks: [{ lines: '5', replace: 'gamma' }] }],
  ['a section replaced', { file_path: target, section: '## Checks', new_string: '## Checks\n\ngamma\n' }],
  ['a section alone', { file_path: target, section: '## Checks' }],
  ['append to a file that is not there', { file_path: absent, append: 'tail' }],
  ['append beside old_string', { file_path: target, append: 'tail', old_string: 'alpha' }],
]
const parses = (input: Json): boolean => (FileEditTool.inputSchema as unknown as { safeParse: (value: unknown) => { success: boolean } }).safeParse(input).success
const verdictOf = async (input: Json): Promise<string> => {
  try {
    return j(await FileEditTool.validateInput(structuredClone(input) as never, context))
  } catch (error) {
    return `threw: ${error instanceof Error ? error.message : String(error)}`
  }
}
const unsetVerdicts = new Map<string, string>()
for (const [label, input] of SHAPES) unsetVerdicts.set(label, await verdictOf(input))
check('unset: hunks without an anchor are refused as hunks, a lone section as a section, and an append to an absent file is accepted', (unsetVerdicts.get('hunks without their anchor') ?? '').includes('hunks require expected_anchor') && (unsetVerdicts.get('a section alone') ?? '').includes('section takes exactly one of new_string') && unsetVerdicts.get('append to a file that is not there') === j({ result: true }), j([...unsetVerdicts.values()]).slice(0, 300))
for (const arm of ['plain', 'full'] as Form[]) {
  setArm(arm)
  const moved: string[] = []
  for (const [label, input] of SHAPES) {
    if (!parses(input) || (await verdictOf(input)) !== unsetVerdicts.get(label)) moved.push(label)
  }
  check(`${arm}: the executor's schema parses all seven inputs and validateInput answers each exactly as it does unset`, moved.length === 0, moved.join(' · '))
}
setArm(undefined)

section('§11 the flag is a registered value')
const row = FLAG_REGISTRY.find(flag => flag.env === FLAG)
check('MERCURY_EDIT_FORM has a registry row, a value flag whose evidence is this proof', row?.kind === 'value' && row.evidence === 'scripts/edit-tools/prove-edit-form.ts', j(row ?? null))

section('§12 with the whole default tool list, deferred definitions and all: every road still carries Edit once, in full, in the form in force')
const { assembleToolPool } = await import('../../src/tools.ts')
const WHOLE = assembleToolPool(permissionContext, [])
const formCarried = (entry: Json | undefined): string => {
  const inner = (entry?.function as Json | undefined) ?? entry
  const schema = inner?.parameters ?? inner?.input_schema ?? inner?.parametersJsonSchema
  for (const form of ['full', 'plain'] as Form[]) {
    if (inner?.description === FORMS[form].description && (j(schema) === j(FORMS[form].schema) || j(schema) === j(FORMS[form].strict))) return form
  }
  return `neither: ${j(entry ?? null).slice(0, 120)}`
}
const wholeByArm = new Map<string, Body | undefined>()
const listSizes: number[] = []
for (const [arm, label] of [[undefined, 'unset'], ['plain', 'plain'], ['full', 'full']] as Array<[Arm, string]>) {
  setArm(arm)
  const wrong: string[] = []
  for (const road of ROADS) {
    const { body, error } = await drive(road, [opening()], WHOLE)
    wholeByArm.set(`${label}/${road.road}`, body)
    const edits = toolEntries(road, body).filter(entry => nameOfEntry(entry) === 'Edit')
    const carried = edits.length === 1 && edits[0]!.defer_loading !== true ? formCarried(edits[0]) : `${edits.length} Edit entries`
    if (arm === undefined) listSizes.push(toolEntries(road, body).length)
    if (error !== '' || carried !== formSent(road, arm)) wrong.push(`${road.road}: ${error} ${carried}`)
  }
  check(`${label}: on all eleven roads Edit goes out once, loaded in full, in the ${arm ?? 'form each road sent before'}${arm === undefined ? ' (plain on the local road, full on the ten others)' : ' form'}`, wrong.length === 0, wrong.join(' · '))
}
setArm(undefined)
check('the lists driven are whole ones: every road sends more than the two tools of the sections above', listSizes.length === ROADS.length && listSizes.every(size => size > 2), j(listSizes))
for (const arm of ['plain', 'full'] as Form[]) {
  const moved = ROADS.filter(road => aroundEdit(road, wholeByArm.get(`${arm}/${road.road}`)) !== aroundEdit(road, wholeByArm.get(`unset/${road.road}`))).map(road => road.road)
  check(`${arm}: around the Edit definition each of the eleven whole requests is the unset one`, moved.length === 0, moved.join(' · '))
}

server.close()
console.log('')
console.log(`${failures === 0 ? 'GREEN' : 'RED'}: ${checks - failures} of ${checks} checks pass${failures === 0 ? '' : `, ${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
