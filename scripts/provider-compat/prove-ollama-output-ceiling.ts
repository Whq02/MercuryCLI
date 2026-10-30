#!/usr/bin/env bun
// gate-watch: src/services/providers/openaicompat/compatChatCallModel.ts src/services/providers/openaicompat/compatCallModel.ts src/services/providers/local/localCallModel.ts src/services/providers/local/ollamaChatTransport.ts src/services/providers/anthropic/streamCore.ts src/services/api/outputFit.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

delete process.env.NODE_ENV
for (const key of ['MERCURY_HOME', 'MERCURY_OAUTH_TOKEN', 'MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_SCRIPTED_STREAM', 'ANTHROPIC_API_KEY', 'MERCURY_LOCAL_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_MAX_OUTPUT_TOKENS', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_COMPAT_LABEL']) delete process.env[key]
for (const key of Object.keys(process.env)) if (/^MERCURY_COMPAT_.*_API_KEY$/.test(key)) delete process.env[key]
const base = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const proofHome = mkdtempSync(join(base, 'ollama-output-ceiling-'))
process.env.MERCURY_CONFIG_DIR = proofHome
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const debugLog = join(proofHome, 'd.log')
process.env.DEBUG = '1'
process.argv.push('--log-file', debugLog)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const record = (line: string): void => console.log(`  [record] ${line}`)
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the Ollama output-ceiling prover exceeded 120s')
  process.exit(1)
}, 120_000)
watchdog.unref?.()

const PLAIN = 'plain:8b'
const VLLM_MODEL = 'Qwen/Qwen3-32B'
const TRAINED_MAX = 40_960
const DETAILS = { parent_model: '', format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '8B', quantization_level: 'Q4_K_M' }
type Capture = { road: 'native' | 'compat'; model: string; numCtx: number | undefined; numPredict: number | undefined; maxTokens: number | undefined; body: Record<string, unknown> }
const captures: Capture[] = []
const loaded = new Map<string, number>()
let streamForever: ((req: Request, model: string) => Response) | null = null
const encoder = new TextEncoder()
const ndjson = (rows: unknown[]): Response => new Response(rows.map(row => `${JSON.stringify(row)}\n`).join(''), { headers: { 'content-type': 'application/x-ndjson' } })
const sse = (rows: unknown[]): Response => new Response(`${rows.map(row => `data: ${JSON.stringify(row)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
function serve(route: (url: string, body: Record<string, unknown>, req: Request) => Response | null): { server: ReturnType<typeof Bun.serve>; root: string } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url).pathname
      let body: Record<string, unknown> = {}
      try {
        const raw = await req.text()
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = {}
      }
      return route(url, body, req) ?? Response.json({ error: 'not found' }, { status: 404 })
    },
  })
  return { server, root: `http://127.0.0.1:${server.port}` }
}
const ollama = serve((url, body, req) => {
  if (url === '/api/tags') return Response.json({ models: [{ name: PLAIN, model: PLAIN, modified_at: '2026-01-01T00:00:00Z', size: 4_600_000_000, digest: 'bb22', details: DETAILS, capabilities: ['completion', 'tools'] }] })
  if (url === '/api/version') return Response.json({ version: '0.34.4' })
  if (url === '/api/ps') return Response.json({ models: [...loaded.entries()].map(([name, ctx]) => ({ name, model: name, size: 4_600_000_000, digest: 'bb22', details: DETAILS, expires_at: '2026-01-01T00:00:00Z', context_length: ctx })) })
  if (url === '/api/show') return Response.json({ modelfile: '', parameters: '', template: '{{ .Prompt }}', details: DETAILS, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': TRAINED_MAX }, capabilities: ['completion', 'tools'] })
  if (url === '/api/generate') {
    const options = body.options as { num_ctx?: number } | undefined
    loaded.set(String(body.model ?? ''), options?.num_ctx ?? 4096)
    return Response.json({ model: body.model, response: '', done: true, done_reason: 'load' })
  }
  if (url === '/v1/models') return Response.json({ object: 'list', data: [{ id: PLAIN, object: 'model', created: 1, owned_by: 'library' }] })
  if (url === '/api/chat') {
    const options = body.options as { num_ctx?: number; num_predict?: number } | undefined
    const model = String(body.model ?? '')
    loaded.set(model, options?.num_ctx ?? 4096)
    captures.push({ road: 'native', model, numCtx: options?.num_ctx, numPredict: options?.num_predict, maxTokens: undefined, body })
    if (streamForever !== null) return streamForever(req, model)
    return ndjson([
      { model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'ok.' }, done: false },
      { model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 2 },
    ])
  }
  if (url === '/v1/chat/completions') {
    const model = String(body.model ?? '')
    captures.push({ road: 'compat', model, numCtx: undefined, numPredict: undefined, maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined, body })
    return sse([
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] },
      { id: 'c1', object: 'chat.completion.chunk', created: 1, model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } },
    ])
  }
  return null
})
const vllm = serve((url, body) => {
  if (url === '/v1/models') return Response.json({ object: 'list', data: [{ id: VLLM_MODEL, object: 'model', created: 1, owned_by: 'vllm', root: '/models/Qwen3-32B', parent: null, max_model_len: 40960, permission: [] }] })
  if (url === '/v1/chat/completions') {
    const model = String(body.model ?? '')
    captures.push({ road: 'compat', model, numCtx: undefined, numPredict: undefined, maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined, body })
    return sse([{ id: 'v1', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }])
  }
  return null
})
process.env.MERCURY_LOCAL_PROBE_TARGETS = [`ollama=${ollama.root}`, `vllm=${vllm.root}`].join(',')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { localRecordFor } = await import('../../src/services/providers/local/localCatalogue.ts')
const { localCallModel } = await import('../../src/services/providers/local/localCallModel.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getMaxOutputTokensForModel } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.ts')
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const w = await import('../../src/services/providers/local/localWindow.ts')

let plain: ReturnType<typeof localRecordFor>
let qwen: ReturnType<typeof localRecordFor>
do {
  await refreshLocalDiscovery({ force: true })
  plain = localRecordFor(`local/${PLAIN}`)
  qwen = localRecordFor(`local/${VLLM_MODEL}`)
} while (plain === undefined || qwen === undefined)
check('the fixture is discovered: an Ollama model with a 40,960 trained window and a vLLM model', plain?.server === 'ollama' && plain.modelMaxContext === TRAINED_MAX && qwen?.server === 'vllm', JSON.stringify({ plain, qwen }))

async function send(model: string, text: string, override?: number): Promise<{ capture: Capture | undefined; errors: string[] }> {
  const before = captures.length
  const errors: string[] = []
  const params = {
    messages: [createUserMessage({ content: text })] as never,
    systemPrompt: asSystemPrompt(['You are a fixture session.']),
    thinkingConfig: { type: 'disabled' } as never,
    tools: [] as never,
    signal: new AbortController().signal,
    options: { model, querySource: 'user', isNonInteractiveSession: true, getToolPermissionContext: async () => ({ mode: 'default' }) as never, ...(override !== undefined ? { maxOutputTokensOverride: override } : {}) } as never,
  }
  const road = model.startsWith('local/') ? localCallModel(params as never) : routedCallModel(params as never)
  for await (const item of road) {
    const row = item as { isApiErrorMessage?: boolean; message?: { content?: Array<{ type?: string; text?: string }> } }
    if (row.isApiErrorMessage === true) errors.push((row.message?.content ?? []).map(b => b.text ?? '').join(''))
  }
  return { capture: captures[before], errors }
}

section('§1 the native road (/api/chat): every request carries the output ceiling the other providers get — options.num_predict is the model default (32,000), never absent')
{
  const model = `local/${PLAIN}`
  const ceiling = getMaxOutputTokensForModel(model)
  record(`the ceiling the Anthropic road sends as max_tokens for this id: ${ceiling} (model default ${getModelMaxOutputTokens(model).default}, upper limit ${getModelMaxOutputTokens(model).upperLimit})`)
  const sent = await send(model, 'hello')
  record(`the request: num_ctx ${String(sent.capture?.numCtx)} · num_predict ${String(sent.capture?.numPredict)} · errors ${JSON.stringify(sent.errors)}`)
  check('the request was answered on the native road at the trained window', sent.capture?.road === 'native' && sent.capture.numCtx === TRAINED_MAX && sent.errors.length === 0, JSON.stringify(sent))
  check(`options.num_predict carries the ceiling (${ceiling}) — the figure getMaxOutputTokensForModel gives every road`, sent.capture?.numPredict === ceiling, String(sent.capture?.numPredict))
  check('the window the request carries is the hold the limit reads (one truth, unchanged)', w.heldLocalWindow(plain!)?.window === TRAINED_MAX)
}

section('§2 the user\'s own ceiling: MERCURY_MAX_OUTPUT_TOKENS rides to Ollama exactly, and an explicit per-call override still wins')
{
  const model = `local/${PLAIN}`
  process.env.MERCURY_MAX_OUTPUT_TOKENS = '12000'
  const ceiling = getMaxOutputTokensForModel(model)
  const sent = await send(model, 'hello again')
  record(`MERCURY_MAX_OUTPUT_TOKENS=12000: the ceiling ${ceiling} · num_predict ${String(sent.capture?.numPredict)}`)
  check('num_predict is the user\'s 12,000 — the same figure, not a smaller one', ceiling === 12_000 && sent.capture?.numPredict === 12_000, String(sent.capture?.numPredict))
  const overridden = await send(model, 'and once more', 1_500)
  check('an explicit per-call override (1,500) is what rides, as on every road', overridden.capture?.numPredict === 1_500, String(overridden.capture?.numPredict))
  delete process.env.MERCURY_MAX_OUTPUT_TOKENS
}

section('§3 the compat road to Ollama (a compat endpoint with the ollama dialect, /v1/chat/completions): max_tokens carries the same ceiling')
{
  const result = updateSettingsForSource('userSettings', { compatProvider: { box: { baseUrl: `${ollama.root}/v1`, dialect: 'ollama', models: [PLAIN] } } })
  check('the compat endpoint is configured with the ollama dialect', result.error === null, JSON.stringify(result))
  const model = `compat/box/${PLAIN}`
  const ceiling = getMaxOutputTokensForModel(model)
  const sent = await send(model, 'hello from the compat road')
  record(`the compat request: max_tokens ${String(sent.capture?.maxTokens)} · ceiling ${ceiling} · errors ${JSON.stringify(sent.errors)}`)
  check('the request reached /v1/chat/completions and was answered', sent.capture?.road === 'compat' && sent.capture.model === PLAIN && sent.errors.length === 0, JSON.stringify(sent))
  check(`max_tokens carries the ceiling (${ceiling})`, sent.capture?.maxTokens === ceiling, String(sent.capture?.maxTokens))
}

section('§4 a small window: the ceiling is fitted to the window\'s room the way every road fits it (never above the room, never under the 3,000 floor)')
{
  const model = `local/${PLAIN}`
  w.__resetLocalWindowsForTest()
  w.writeLocalWindowSetting(plain!, 4_096)
  const sent = await send(model, 'a short question')
  record(`window set to 4,096: num_ctx ${String(sent.capture?.numCtx)} · num_predict ${String(sent.capture?.numPredict)} · errors ${JSON.stringify(sent.errors)}`)
  check('the request rides at num_ctx 4096 with num_predict fitted below the 32,000 ceiling, inside the window and at or above the 3,000 floor', sent.capture?.numCtx === 4_096 && sent.capture.numPredict !== undefined && sent.capture.numPredict < 32_000 && sent.capture.numPredict <= 4_096 && sent.capture.numPredict >= 3_000 && sent.errors.length === 0, JSON.stringify(sent.capture))
  w.writeLocalWindowSetting(plain!, undefined)
  w.__resetLocalWindowsForTest()
}

section('§5 the other local servers are unchanged: a vLLM request carries no max_tokens unless overridden')
{
  const model = `local/${VLLM_MODEL}`
  const sent = await send(model, 'hello vllm')
  record(`the vLLM request: max_tokens ${String(sent.capture?.maxTokens)} · errors ${JSON.stringify(sent.errors)}`)
  check('the vLLM request carries no max_tokens (the server default governs, as before)', sent.capture?.road === 'compat' && sent.capture.maxTokens === undefined && sent.errors.length === 0, JSON.stringify(sent.capture?.body))
  const overridden = await send(model, 'hello vllm', 2_048)
  check('an explicit override still rides to vLLM as max_tokens', overridden.capture?.maxTokens === 2_048, String(overridden.capture?.maxTokens))
}

section('§6 a stream that never ends is cut at the run\'s time limit: the abort reaches the transport and the turn ends with the existing time-limit outcome within a second of the deadline')
{
  const { Conversation } = await import('../../src/rows/turn.ts')
  const { exitCodeOf, OUTCOME_SENTENCES } = await import('../../src/rows/vocabulary.ts')
  const { flushDebugLogs } = await import('../../src/utils/debug.ts')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
  const bootstrap = await import('../../src/bootstrap/state.ts')
  bootstrap.setIsInteractive(false)
  bootstrap.setAskChannel('none')
  bootstrap.setSessionPersistenceDisabled(true)
  const requestsAt: number[] = []
  const closes: number[] = []
  streamForever = (req, model) => {
    requestsAt.push(Date.now())
    let tick: ReturnType<typeof setInterval> | null = null
    const closed = (): void => {
      if (tick !== null) clearInterval(tick)
      tick = null
      if (closes.length === 0) closes.push(Date.now())
    }
    req.signal.addEventListener('abort', closed)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        tick = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify({ model, created_at: '2026-01-01T00:00:00Z', message: { role: 'assistant', content: 'more ' }, done: false })}\n`))
          } catch {
            closed()
          }
        }, 50)
      },
      cancel: closed,
    })
    return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
  }
  const LIMIT_MS = 5_000
  let appState: Record<string, unknown> = { ...(getDefaultAppState() as unknown as Record<string, unknown>), effortValue: 'high' }
  const startedAt = Date.now()
  const conversation = new Conversation({
    cwd: proofHome,
    tools: [] as never,
    commands: [],
    mcpClients: [],
    agents: { activeAgents: [], allAgents: [] } as never,
    canUseTool: (async (_tool: unknown, input: Record<string, unknown>) => ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never,
    getAppState: () => appState as never,
    setAppState: ((f: (prev: never) => never): void => {
      appState = f(appState as never) as unknown as Record<string, unknown>
    }) as never,
    readFileState: createFileStateCacheWithSizeLimit(100),
    customSystemPrompt: 'You are a fixture session.',
    userSpecifiedModel: `local/${PLAIN}`,
    thinkingConfig: { type: 'disabled' } as never,
    maxTurns: 3,
    maxTime: { limitMs: LIMIT_MS, at: startedAt + LIMIT_MS },
  })
  let outcome: Record<string, unknown> | undefined
  let outcomeAt = 0
  for await (const row of conversation.turn('talk forever')) {
    const draft = row as unknown as Record<string, unknown>
    if (draft.type === 'outcome') {
      outcome = draft
      outcomeAt = Date.now()
    }
  }
  streamForever = null
  const error = outcome?.error as { message?: string; class?: string } | undefined
  const deadline = startedAt + LIMIT_MS
  while (closes.length === 0 && Date.now() - deadline < 1_000) await new Promise(resolve => setTimeout(resolve, 10))
  await flushDebugLogs()
  const wireLine = readFileSync(debugLog, 'utf8').split('\n').find(line => line.includes(`/api/chat stream from ${PLAIN}:`) && line.includes('ended cancelled'))
  record(`the request reached the server ${requestsAt.length > 0 ? `${deadline - requestsAt[0]!}ms before the deadline` : 'never'}; the outcome ${JSON.stringify(outcome?.status)} (${JSON.stringify(error?.class)}: ${JSON.stringify(error?.message)}) landed ${outcomeAt - deadline}ms after the deadline; the server saw its socket close ${closes.length > 0 ? `${closes[0]! - deadline}ms after the deadline` : 'never'}`)
  check('the stream was in flight when the deadline passed (the request reached the server before it, and kept streaming)', requestsAt.length === 1 && requestsAt[0]! < deadline, JSON.stringify(requestsAt.map(at => at - deadline)))
  check('the turn ends with the existing time-limit outcome (status time_limit, class time_limit, the sentence naming the limit) — exit code 1', outcome?.status === 'time_limit' && error?.class === 'time_limit' && error.message === OUTCOME_SENTENCES.time_limit({ maxTimeMs: LIMIT_MS }) && exitCodeOf(outcome.status as never) === 1, JSON.stringify(outcome))
  check('the outcome lands within a second of the deadline, not at the stream\'s end (which never comes)', outcomeAt >= deadline - 50 && outcomeAt - deadline < 1_000, `${outcomeAt - deadline}ms`)
  check('the abort reached the transport: the stream\'s own wire record says it ended cancelled (the fetch aborted, the body released)', wireLine !== undefined, wireLine ?? 'no wire record')
  check('the server saw the request socket close within a second of the deadline', closes.length >= 1 && closes[0]! - deadline < 1_000, JSON.stringify(closes.map(at => at - deadline)))
}

ollama.server.stop(true)
vllm.server.stop(true)
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
