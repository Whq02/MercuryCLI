#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-no-speed-tier.ts — no request on any wire
//  carries a speed tier or a fast-mode beta.
//
//  Mercury speaks to every provider family through one router and carries
//  no vendor-only speed tier. This prover drives ONE scripted text turn per
//  wire dialect through the REAL query loop against a loopback fixture that
//  captures every request's headers and body, then reads what the provider
//  actually received:
//
//    Anthropic messages ........ claude-*
//    OpenAI Responses .......... openai (gpt-*)
//    chat-completions .......... zai (glm-*)
//
//  Per dialect: exactly one request left; its body carries no `speed` or
//  `service_tier` field at any depth, no key or string value naming a fast
//  mode; its headers name no fast-mode beta (the anthropic-beta header and
//  the body's `betas` list both scanned). The scanner is proven on planted
//  poison first (a checker that cannot fail is not a check). Static pins
//  hold the constants module, the Anthropic transport, the settings schema
//  and the config schema free of the vocabulary.
//
//  Endpoint bases: EVERY provider base pinned to the loopback fixture BEFORE
//  any src import; nothing here can reach a live service.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-no-speed-tier.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — no-speed-tier prover exceeded 180s')
  process.exit(1)
}, 180_000)
watchdog.unref?.()

const ROOT = join(import.meta.dir, '..', '..')

// ── env hygiene BEFORE any src import ───────────────────────────────────────
delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SIMPLE', 'GOOGLE_API_KEY', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'no-speed-tier-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'no-speed-tier-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'no-speed-tier-teams-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the loopback fixture: three dialects, one server, headers captured ──────
type Body = Record<string, unknown>
type Dialect = 'anthropic' | 'responses' | 'chat'
type Captured = { dialect: Dialect; path: string; headers: Record<string, string>; body: Body }
const captured: Captured[] = []
let requestOrdinal = 0

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`
const TEXT = 'speed tier absent'

function anthropicSse(): string {
  const usage = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
  return [
    evt('message_start', { type: 'message_start', message: { id: `msg_${requestOrdinal}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } }),
    evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } }),
    evt('content_block_stop', { type: 'content_block_stop', index: 0 }),
    evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }),
    evt('message_stop', { type: 'message_stop' }),
  ].join('')
}
function responsesSse(): string {
  return [
    sse({ type: 'response.created', response: { id: `resp_${requestOrdinal}` } }),
    sse({ type: 'response.output_text.delta', delta: TEXT }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: TEXT }] } }),
    sse({ type: 'response.completed', response: { id: `resp_${requestOrdinal}`, usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function chatSse(): string {
  return [
    sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: TEXT }, finish_reason: null }] }),
    sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }),
    'data: [DONE]\n\n',
  ].join('')
}

const OPENAI_MODELS_BODY = {
  models: [
    {
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }, { effort: 'high', description: 'high' }],
      default_reasoning_level: 'low',
      visibility: 'list',
      priority: 1,
      context_window: 272_000,
      input_modalities: ['text', 'image'],
      supported_in_api: true,
    },
  ],
}

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
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(path.startsWith('/openai/') ? JSON.stringify(OPENAI_MODELS_BODY) : JSON.stringify({ object: 'list', data: [{ id: 'fixture-local', object: 'model', owned_by: 'fixture' }] }))
      return
    }
    const dialect: Dialect | undefined = path.endsWith('/v1/messages') ? 'anthropic' : path.endsWith('/responses') ? 'responses' : path.endsWith('/chat/completions') ? 'chat' : undefined
    if (req.method === 'POST' && dialect !== undefined) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
      captured.push({ dialect, path, headers, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(dialect === 'anthropic' ? anthropicSse() : dialect === 'responses' ? responsesSse() : chatSse())
      requestOrdinal++
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`

Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_COMPAT_API_KEY: 'fixture-compat-key',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
})

console.log('============================================================')
console.log(' no speed tier — every dialect, through the real loop')
console.log('============================================================')

// ── the scanner, proven on poison before it reads the real wire ─────────────
const FAST_WORDS = /\bfast[-_ ]?mode|service_tier|\bspeed\b/i
type Hit = { where: string; what: string }
function scanValue(value: unknown, path: string, out: Hit[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, `${path}[${i}]`, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FAST_WORDS.test(k)) out.push({ where: `${path}.${k}`, what: `key ${k}` })
      scanValue(v, `${path}.${k}`, out)
    }
    return
  }
  if (typeof value === 'string' && /\bfast[-_]mode|service_tier/i.test(value)) out.push({ where: path, what: `value ${value.slice(0, 60)}` })
}
function scanRequest(c: { headers: Record<string, string>; body: Body }): Hit[] {
  const hits: Hit[] = []
  scanValue(c.body, 'body', hits)
  for (const [k, v] of Object.entries(c.headers)) {
    if (/\bfast/i.test(k)) hits.push({ where: `header ${k}`, what: 'header name' })
    if (k === 'anthropic-beta' && v.split(',').some(t => /\bfast[-_]mode/i.test(t.trim()))) hits.push({ where: 'header anthropic-beta', what: v })
  }
  return hits
}

section('§0 the scanner trips on planted poison')
{
  const poisonBody = scanRequest({ headers: {}, body: { model: 'x', speed: 'fast', messages: [] } })
  check('a `speed` body field is flagged', poisonBody.some(h => h.where === 'body.speed'))
  const poisonNested = scanRequest({ headers: {}, body: { output_config: { service_tier: 'priority' } } })
  check('a nested `service_tier` field is flagged', poisonNested.length === 1)
  const poisonBetas = scanRequest({ headers: {}, body: { betas: ['context-1m-2025-08-07', 'fast-mode-2026-02-01'] } })
  check('a fast-mode token in the body betas list is flagged', poisonBetas.some(h => h.where === 'body.betas[1]'))
  const poisonHeader = scanRequest({ headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14,fast-mode-2026-02-01' }, body: {} })
  check('a fast-mode token in the anthropic-beta header is flagged', poisonHeader.length === 1)
  const clean = scanRequest({ headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14', 'content-type': 'application/json' }, body: { model: 'x', messages: [{ role: 'user', content: 'a fast answer please' }], betas: ['context-1m-2025-08-07'] } })
  check('an ordinary request (prose may say "fast") is clean', clean.length === 0, JSON.stringify(clean))
}

// ── src imports (after env) ─────────────────────────────────────────────────
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { query } = await import('../../src/query.ts')
const { productionDeps } = await import('../../src/query/deps.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [],
      mainLoopModel: model,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: (f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(100),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    agentId: undefined,
  }
}

async function drive(model: string): Promise<{ wire: Captured[]; threw: string | undefined; terminal: Record<string, unknown> }> {
  requestOrdinal = 0
  const before = captured.length
  const ctx = makeCtx(model)
  const canUseTool = (async (_tool: { name: string }, input: Record<string, unknown>) => ({
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'other', reason: 'rig' },
  })) as never
  const deps = productionDeps()
  let terminal: Record<string, unknown> = {}
  let threw: string | undefined
  try {
    const gen = query({
      messages: [createUserMessage({ content: 'answer in one line' })] as never,
      systemPrompt: ['fixture system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: ctx as never,
      querySource: 'sdk' as never,
      deps: {
        callModel: deps.callModel,
        autocompact: (async () => ({ wasCompacted: false })) as never,
        microcompact: (async (messages: unknown[]) => ({ messages })) as never,
        uuid: deps.uuid,
      },
    })
    let r = await gen.next()
    while (!r.done) r = await gen.next()
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { wire: captured.slice(before), threw, terminal }
}

const LANES: Array<{ lane: string; model: string; dialect: Dialect }> = [
  { lane: 'anthropic', model: 'claude-opus-4-8', dialect: 'anthropic' },
  { lane: 'openai', model: 'gpt-5.6-sol', dialect: 'responses' },
  { lane: 'zai', model: 'glm-5.2', dialect: 'chat' },
]

for (const { lane, model, dialect } of LANES) {
  section(`${lane} · ${dialect} dialect · ${model}`)
  const r = await drive(model)
  check('the turn completed through the fixture in exactly one request', r.threw === undefined && r.terminal.reason === 'completed' && r.wire.length === 1, `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} requests=${r.wire.length}`)
  const req = r.wire[0]
  check('the request left on the expected dialect', req?.dialect === dialect, req?.path)
  if (req === undefined) continue
  check('the request is a real model call (model + conversation present)', typeof req.body.model === 'string' && (Array.isArray(req.body.messages) || Array.isArray(req.body.input)), Object.keys(req.body).join(','))
  const hits = scanRequest(req)
  check('no speed tier, service tier or fast-mode beta anywhere in the body or headers', hits.length === 0, hits.map(h => `${h.where}: ${h.what}`).join(' · '))
  if (dialect === 'anthropic') {
    const betas = Array.isArray(req.body.betas) ? (req.body.betas as string[]) : (req.headers['anthropic-beta'] ?? '').split(',').map(t => t.trim()).filter(Boolean)
    check('the Anthropic request still carries its ordinary beta set (the capture is not vacuous)', betas.length > 0, JSON.stringify(betas))
  }
}

// ── static pins: the vocabulary is gone from the owners ─────────────────────
section('static pins — the owners carry no speed-tier vocabulary')
{
  const read = (p: string): string => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '')
  check('constants/betas.ts names no fast-mode beta', !/fast[-_]?mode|FAST_MODE/i.test(read('src/constants/betas.ts')))
  const transportDirs = ['src/services/providers/anthropic'].filter(d => existsSync(join(ROOT, d)))
  const transportFiles: string[] = []
  for (const d of transportDirs) {
    for (const f of readdirSync(join(ROOT, d))) {
      if (statSync(join(ROOT, d, f)).isFile() && /\.tsx?$/.test(f)) transportFiles.push(`${d}/${f}`)
    }
  }
  check('the Anthropic transport directory exists', transportFiles.length > 0, transportDirs.join(','))
  // Camel-case and shouting spellings are case-sensitive on purpose: the
  // small-model tier getter (getSmallFastModel) and the response usage's
  // `speed` field are ordinary vocabulary; a request-side speed param is not.
  const offenders = transportFiles.filter(f => /fastMode|FAST_MODE|speed\s*=\s*'fast'|speed:\s*'fast'|\{\s*speed\s*\}/.test(read(f)) || /\bfast[-_]mode/i.test(read(f)))
  check('the Anthropic transport neither latches a fast-mode header nor sets a speed param', offenders.length === 0, offenders.join(','))
  check('the settings schema carries no fast-mode key', !/fastMode/.test(read('src/utils/settings/types.ts')))
  check('the global config schema carries no fast-mode key', !/penguin|fastMode/i.test(read('src/utils/config/schema.ts')))
  check('the query engine seeds no fast-mode state', !/fastMode|fast_mode/.test(read('src/QueryEngine.ts')) && !/fastMode/.test(read('src/run-core/turn-machine.ts')))
  check('no fast-mode owner module remains', !existsSync(join(ROOT, 'src/utils/fastMode.ts')) && !existsSync(join(ROOT, 'src/commands/fast')))
}

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
