#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-crossfamily-matrix.ts — LANE CF: any family
//  in any chair. Mercury routes ten model families; the operator's sittings
//  keep finding coordination seams that quietly assume one family. This
//  prover drives the WHOLE matrix through the REAL dispatch machinery —
//  runAgent (the Agent-tool runner) with the production query loop and
//  routedCallModel on the wire — against ONE loopback fixture speaking every
//  family's real dialect. No live credentials, no external calls.
//
//    §B the orchestrator→worker ring: every family dispatches a worker of a
//       DIFFERENT family (each family once as parent, once as worker; the
//       Anthropic↔non-Anthropic seam crossed both directions, the rest
//       non-Anthropic↔non-Anthropic), plus the operator's own examples
//       (a GPT session launches a Gemini worker; an Opus session launches a
//       Qwen worker via the openrouter/ namespace). Each leg proves: the
//       worker's endpoint took the turn in ITS dialect with the EXACT wire
//       id; the identity floor and the brief rode; the tool round-trip
//       settled through the worker's own wire; NO other family's endpoint
//       was touched (delegated work is never silently rerouted).
//    §I the inherit legs: on every family, a dispatch WITHOUT a model lands
//       the worker on the parent's own lane (the parent-chair completeness).
//
//  The qwen family has no route of its own — it rides the qualified
//  namespaces; this matrix exercises Qwen models as the openrouter, local
//  and compat workers, which is the routing law's own answer for them.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-crossfamily-matrix.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — crossfamily matrix prover exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

// ── hermetic env BEFORE any src import ──────────────────────────────────────
delete process.env.NODE_ENV
for (const ambient of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_SCRIPTED_STREAM',
  'MERCURY_WORKFLOW_ROUTING',
  'MERCURY_SIMPLE',
  'GOOGLE_API_KEY',
]) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'crossfamily-matrix-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'crossfamily-matrix-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'crossfamily-matrix-teams-'))
process.env.MERCURY_CREW_DIR = mkdtempSync(join(tmpdir(), 'crossfamily-matrix-crew-'))
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the ONE fixture: every family's dialect on one loopback server ──────────
type Body = Record<string, unknown>
type Family =
  | 'anthropic'
  | 'openai'
  | 'zai'
  | 'moonshot'
  | 'deepseek'
  | 'gemini'
  | 'openrouter'
  | 'huggingface'
  | 'local'
  | 'compat'

const FAMILIES: readonly Family[] = [
  'anthropic', 'openai', 'zai', 'moonshot', 'deepseek',
  'gemini', 'openrouter', 'huggingface', 'local', 'compat',
]

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const text = (v: unknown): string => JSON.stringify(v) ?? ''

/** Anthropic /v1/messages SSE — a tool_use turn or a final text turn. */
function anthropicSse(kind: 'tool' | 'final', family: Family): string {
  const open = `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`
  if (kind === 'tool') {
    return [
      open,
      `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fx_1', name: 'EchoTool', input: {} } })}`,
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `{"text":"ping-${family}"}` } })}`,
      `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
      `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } })}`,
      `event: message_stop\n${sse({ type: 'message_stop' })}`,
    ].join('')
  }
  return [
    open,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `matrix-final-${family}` } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}

/** OpenAI Responses SSE — function_call turn or final text turn. */
function responsesSse(kind: 'tool' | 'final', family: Family): string {
  if (kind === 'tool') {
    return [
      sse({ type: 'response.created', response: { id: 'resp_fx' } }),
      sse({ type: 'response.output_item.done', item: { type: 'function_call', name: 'EchoTool', call_id: 'call_fx_1', arguments: `{"text":"ping-${family}"}` } }),
      sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 8, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }),
    ].join('')
  }
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: `matrix-final-${family}` }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `matrix-final-${family}` }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}

/** chat-completions SSE (zai · moonshot · deepseek · gemini · openrouter ·
 *  huggingface · local · compat) — tool_calls turn or final text turn. */
function chatSse(kind: 'tool' | 'final', family: Family): string {
  if (kind === 'tool') {
    return [
      sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fx_1', type: 'function', function: { name: 'EchoTool', arguments: `{"text":"ping-${family}"}` } }] } }] }),
      sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 5 } }),
      'data: [DONE]\n\n',
    ].join('')
  }
  return [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: `matrix-final-${family}` } }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ].join('')
}

/** Dialect-aware: has the conversation already delivered a tool result?
 *  (Stateless two-phase scripting: first call answers with a tool call,
 *  a call carrying the result answers with the final text.) */
function sawToolResult(family: Family, body: Body): boolean {
  if (family === 'anthropic') {
    const messages = (body.messages as Array<{ content?: unknown }> | undefined) ?? []
    return messages.some(
      m => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(b => b?.type === 'tool_result'),
    )
  }
  if (family === 'openai') {
    const input = (body.input as Array<{ type?: string }> | undefined) ?? []
    return input.some(i => i?.type === 'function_call_output')
  }
  const messages = (body.messages as Array<{ role?: string }> | undefined) ?? []
  return messages.some(m => m?.role === 'tool')
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

/** Path → family attribution (each family's pinned base gets its own
 *  prefix, so one server serves all ten dialects distinguishably). */
function familyOfPath(path: string): Family | undefined {
  if (path.startsWith('/v1/messages')) return 'anthropic'
  if (path.startsWith('/openai/')) return 'openai'
  if (path.startsWith('/zai/')) return 'zai'
  if (path.startsWith('/moonshot/')) return 'moonshot'
  if (path.startsWith('/deepseek/')) return 'deepseek'
  if (path.startsWith('/gemini/')) return 'gemini'
  if (path.startsWith('/openrouter/')) return 'openrouter'
  if (path.startsWith('/hf/')) return 'huggingface'
  if (path.startsWith('/localsrv/')) return 'local'
  if (path.startsWith('/compatslot/')) return 'compat'
  return undefined
}

const captured: Array<{ family: Family; path: string; body: Body }> = []
const unknownHits: string[] = []

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
    const family = familyOfPath(path)

    // Discovery/catalogue GETs.
    if (req.method === 'GET') {
      if (path === '/openai/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(OPENAI_MODELS_BODY))
        return
      }
      if (path === '/localsrv/v1/models') {
        // vLLM-shaped listing: the local lane discovers qwen3-32b here.
        res.writeHead(200, { 'content-type': 'application/json' })
        // The served window must FIT the real composed request (the tool
        // catalog alone passed 49k tokens as landed tools accumulated — a
        // 32768 listing turned every drill into the preflight refusal). The
        // too-small-window refusal is its own prover's law; this fixture's
        // job is the lane end-to-end, so it serves a roomy window.
        res.end(JSON.stringify({ data: [{ id: 'qwen3-32b', object: 'model', owned_by: 'vllm', max_model_len: 131072 }] }))
        return
      }
      if (path === '/gemini/v1beta/models') {
        // Google-shaped listing: the gemini engine grammar validates here.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ models: [
          { name: 'models/gemini-3-pro', displayName: 'Gemini 3 Pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3-flash', displayName: 'Gemini 3 Flash', supportedGenerationMethods: ['generateContent'] },
        ] }))
        return
      }
      if (path === '/openrouter/api/v1/models') {
        // OpenRouter-shaped listing: vendor-prefixed slugs.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [
          { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder' },
          { id: 'openrouter/auto', name: 'Auto Router' },
        ] }))
        return
      }
      // Any other discovery probe answers empty-but-well-formed.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [], models: [] }))
      return
    }

    // Model-call POSTs, by dialect.
    if (req.method === 'POST' && family !== undefined) {
      const isAnthropic = family === 'anthropic' && path.endsWith('/v1/messages')
      const isResponses = family === 'openai' && path.endsWith('/responses')
      const isChat = path.endsWith('/chat/completions')
      if (isAnthropic || isResponses || isChat) {
        captured.push({ family, path, body })
        // A 'matrix-notool' brief settles in one text turn (the workflow
        // section's shape — its workers ride the REAL assembled tool pool,
        // which does not carry the rig tool); every other brief runs the
        // two-phase tool round.
        const kind: 'tool' | 'final' =
          sawToolResult(family, body) || text(body).includes('matrix-notool') ? 'final' : 'tool'
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(isAnthropic ? anthropicSse(kind, family) : isResponses ? responsesSse(kind, family) : chatSse(kind, family))
        return
      }
    }

    unknownHits.push(`${req.method} ${path}`)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`

// Every family's base pinned to the fixture; a scratch key per keyed lane.
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
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
  MERCURY_COMPAT_LABEL: 'CF fixture endpoint',
  MERCURY_LOCAL_PROBE_TARGETS: `vllm=${base}/localsrv`,
})

console.log('============================================================')
console.log(' cross-family matrix — any family in any chair (LANE CF)')
console.log('============================================================')

// ── src imports (after env) ─────────────────────────────────────────────────
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { runAgent } = await import('../../src/tools/AgentTool/runAgent.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { refreshLocalDiscovery } = await import('../../src/services/providers/local/localDiscovery.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { GLM_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/zai.ts')
const { KIMI_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/moonshot.ts')
const { DEEPSEEK_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/deepseek.ts')
const { HUGGINGFACE_STATIC_CATALOGUE } = await import('../../src/utils/router/providers/huggingface.ts')
type Message = import('../../src/types/message.ts').Message
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

// The local lane resolves models from live discovery — prime it against the
// fixture's vLLM listing once, before any local leg.
await refreshLocalDiscovery({ force: true })

// ── the worker-side rig tool ────────────────────────────────────────────────
const echoCalls: Array<{ family: string; text: string }> = []
const EchoTool = {
  name: 'EchoTool',
  async description() {
    return 'echo the text back (matrix rig tool)'
  },
  async prompt() {
    return 'echo the text back'
  },
  inputSchema: z.object({ text: z.string() }),
  userFacingName: () => 'EchoTool',
  isEnabled: () => true,
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isMcp: false,
  needsPermissions: () => false,
  async validateInput() {
    return { result: true }
  },
  async call(input: { text: string }) {
    echoCalls.push({ family: input.text.replace(/^ping-/, ''), text: input.text })
    return { data: `echo:${input.text}` }
  },
  mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: String(data),
  }),
} as never

const allowAll = (async (_tool: unknown, input: Record<string, unknown>) =>
  ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'matrix rig' } })) as never

/** The probe worker definition — a custom agent with its own prompt. */
const probeDefinition = {
  agentType: 'cf-matrix-probe',
  whenToUse: 'cross-family matrix probe',
  source: 'projectSettings',
  getSystemPrompt: () => 'You are the matrix probe worker. Call EchoTool exactly once, then report one line.',
} as never

function makeCtx(parentModel: string): { ctx: never; abort: AbortController } {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const abort = new AbortController()
  const ctx = {
    abortController: abort,
    options: {
      commands: [],
      tools: [EchoTool],
      mainLoopModel: parentModel,
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
  return { ctx: ctx as never, abort }
}

interface DriveOutcome {
  wire: Array<{ family: Family; path: string; body: Body }>
  finalText: string
  errors: string[]
  threw: string | undefined
  resolvedModel: string | undefined
  yields: number
}

async function driveAgent(opts: {
  parentModel: string
  workerModel?: string
  brief: string
}): Promise<DriveOutcome> {
  const before = captured.length
  const { ctx } = makeCtx(opts.parentModel)
  let resolvedModel: string | undefined
  const errors: string[] = []
  let finalText = ''
  let threw: string | undefined
  let yields = 0
  try {
    const stream = runAgent({
      agentDefinition: probeDefinition,
      promptMessages: [createUserMessage({ content: opts.brief }) as Message],
      toolUseContext: ctx,
      canUseTool: allowAll,
      isAsync: false,
      canShowPermissionPrompts: false,
      querySource: 'agent:custom:cf-matrix-probe' as never,
      availableTools: [EchoTool] as never,
      ...(opts.workerModel !== undefined ? { model: opts.workerModel } : {}),
      onResolvedIdentity: identity => {
        resolvedModel = identity.model
      },
    })
    for await (const message of stream) {
      yields++
      const m = message as { type?: string; isApiErrorMessage?: boolean; message?: { content?: unknown } }
      if (m.type === 'assistant') {
        const blocks = Array.isArray(m.message?.content) ? (m.message!.content as Array<{ type?: string; text?: string }>) : []
        const textOf = blocks.filter(b => b?.type === 'text').map(b => b.text ?? '').join('')
        if (m.isApiErrorMessage) errors.push(textOf || text(m.message?.content))
        else if (textOf) finalText = textOf
      }
    }
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  return { wire: captured.slice(before), finalText, errors, threw, resolvedModel, yields }
}

// ── the matrix rows ─────────────────────────────────────────────────────────
/** Worker-leg spelling per family: the persisted model id the dispatcher
 *  names, and the id the family's own wire must carry. */
const WORKER_SPELLINGS: Record<Family, { model: string; wireId: string }> = {
  anthropic: { model: 'claude-sonnet-5', wireId: 'claude-sonnet-5' },
  openai: { model: 'gpt-5.6-sol', wireId: 'gpt-5.6-sol' },
  zai: { model: GLM_STATIC_CATALOGUE[0]!.id, wireId: GLM_STATIC_CATALOGUE[0]!.id },
  moonshot: { model: KIMI_STATIC_CATALOGUE[0]!.id, wireId: KIMI_STATIC_CATALOGUE[0]!.id },
  deepseek: { model: DEEPSEEK_STATIC_CATALOGUE[0]!.id, wireId: DEEPSEEK_STATIC_CATALOGUE[0]!.id },
  gemini: { model: 'gemini-3-pro', wireId: 'gemini-3-pro' },
  // The operator's qwen example rides the openrouter namespace verbatim.
  openrouter: { model: 'openrouter/qwen/qwen3-coder', wireId: 'qwen/qwen3-coder' },
  huggingface: {
    model: HUGGINGFACE_STATIC_CATALOGUE[0]!.id,
    wireId: HUGGINGFACE_STATIC_CATALOGUE[0]!.id.replace(/^huggingface\//, ''),
  },
  local: { model: 'local/qwen3-32b', wireId: 'qwen3-32b' },
  compat: { model: 'compat/qwen-max', wireId: 'qwen-max' },
}

/** The ring: each family parent exactly once and worker exactly once; the
 *  anthropic seam crossed in both directions; openai→gemini is the
 *  operator's own example. */
const RING: Array<{ parent: Family; worker: Family }> = [
  { parent: 'anthropic', worker: 'openai' },
  { parent: 'openai', worker: 'gemini' },
  { parent: 'gemini', worker: 'zai' },
  { parent: 'zai', worker: 'moonshot' },
  { parent: 'moonshot', worker: 'deepseek' },
  { parent: 'deepseek', worker: 'openrouter' },
  { parent: 'openrouter', worker: 'huggingface' },
  { parent: 'huggingface', worker: 'local' },
  { parent: 'local', worker: 'compat' },
  { parent: 'compat', worker: 'anthropic' },
]

const IDENTITY_ANCHOR = 'Mercury was not built by the maker of any model it runs'

function assertWorkerLeg(tag: string, workerFamily: Family, o: DriveOutcome, expectedWireId: string, expectedResolved: string): void {
  const workerHits = o.wire.filter(h => h.family === workerFamily)
  const foreign = o.wire.filter(h => h.family !== workerFamily)
  check(`${tag}: the worker's endpoint took the whole turn (2 calls, no other family touched)`,
    workerHits.length === 2 && foreign.length === 0 && o.threw === undefined && o.errors.length === 0,
    `hits=${o.wire.map(h => h.family + ':' + h.path).join(',')} threw=${o.threw ?? ''} errors=${o.errors.join('|').slice(0, 300)}`)
  if (workerHits.length === 0) return
  const first = workerHits[0]!.body
  const wireModel = String(first.model ?? '')
  check(`${tag}: the wire carries the exact id '${expectedWireId}'`, wireModel === expectedWireId, wireModel)
  check(`${tag}: the resolved identity names '${expectedResolved}'`, o.resolvedModel === expectedResolved, String(o.resolvedModel))
  const serialized = text(first)
  check(`${tag}: the brief rode the wire`, serialized.includes('matrix-brief'), serialized.slice(0, 200))
  check(`${tag}: the identity floor rode the wire`, serialized.includes(IDENTITY_ANCHOR))
  check(`${tag}: the worker's tools were declared on the wire`, serialized.includes('EchoTool'))
  const second = workerHits[1]!.body
  check(`${tag}: the tool round-trip returned on the same wire (echo result delivered)`,
    text(second).includes(`echo:ping-${workerFamily}`), text(second).slice(0, 300))
  check(`${tag}: the worker settled with the final text`, o.finalText.includes(`matrix-final-${workerFamily}`), o.finalText.slice(0, 120))
}

// ============================================================================
section('§B the orchestrator→worker ring — every family in both chairs')
// ============================================================================
for (const { parent, worker } of RING) {
  const parentSpelling = WORKER_SPELLINGS[parent].model
  const workerSpelling = WORKER_SPELLINGS[worker]
  echoCalls.length = 0
  const o = await driveAgent({
    parentModel: parentSpelling,
    workerModel: workerSpelling.model,
    brief: `matrix-brief: probe the ${worker} lane`,
  })
  assertWorkerLeg(`${parent}→${worker}`, worker, o, workerSpelling.wireId, workerSpelling.model)
}

// The operator's second example verbatim: an Opus session launches a Qwen
// worker (the openrouter namespace carries qwen).
{
  const o = await driveAgent({
    parentModel: 'claude-opus-5',
    workerModel: 'openrouter/qwen/qwen3-coder',
    brief: 'matrix-brief: probe the openrouter lane',
  })
  assertWorkerLeg('opus→qwen(openrouter)', 'openrouter', o, 'qwen/qwen3-coder', 'openrouter/qwen/qwen3-coder')
}

// ============================================================================
section('§I the inherit legs — a model-less dispatch lands on the parent lane')
// ============================================================================
for (const family of FAMILIES) {
  const spelling = WORKER_SPELLINGS[family]
  const o = await driveAgent({
    parentModel: spelling.model,
    brief: `matrix-brief: probe the ${family} lane`,
  })
  assertWorkerLeg(`inherit@${family}`, family, o, spelling.wireId, spelling.model)
}

// ============================================================================
section('§C the workflow driver — scripted fan-out across every family')
// ============================================================================
{
  const { compileWorkflow } = await import('../../src/tools/WorkflowTool/compiler.ts')
  const { runWorkflowScript } = await import('../../src/tools/WorkflowTool/executor.ts')
  const { makeWorkflowHooks } = await import('../../src/tools/WorkflowTool/agentHooks.ts')

  async function driveWorkflow(driverModel: string, script: string): Promise<{
    result: unknown
    failures: Array<{ label?: string; error?: string }>
    agentCount: number
    error?: string
    wire: Array<{ family: Family; path: string; body: Body }>
  }> {
    const before = captured.length
    const compiled = compileWorkflow(script)
    if (!('ok' in compiled) || compiled.ok !== true) {
      throw new Error(`workflow compile failed: ${JSON.stringify(compiled)}`)
    }
    const { ctx } = makeCtx(driverModel)
    const out = await runWorkflowScript(
      (compiled as { vmScript: never }).vmScript,
      ctx as never,
      () => {},
      {
        makeHooks: makeWorkflowHooks as never,
        workflowRunId: `cf-matrix-${Math.random().toString(36).slice(2, 8)}`,
      } as never,
    )
    return {
      result: out.result,
      failures: (out.failures ?? []) as never,
      agentCount: out.agentCount,
      ...(out.error !== undefined ? { error: out.error } : {}),
      wire: captured.slice(before),
    }
  }

  // Ten workers, one per family, exact ids — the anthropic-driver run.
  const fanoutScript = `
    phase('fan out');
    const briefs = ${JSON.stringify(FAMILIES.map(f => ({ family: f, model: WORKER_SPELLINGS[f].model })))};
    const results = {};
    await Promise.all(briefs.map(async b => {
      results[b.family] = await agent('matrix-notool: probe the ' + b.family + ' lane', { model: b.model, label: 'w-' + b.family });
    }));
    return results;
  `
  const o = await driveWorkflow('claude-opus-5', fanoutScript)
  check('the ten-family fan-out ran to completion (no run error)', o.error === undefined, String(o.error ?? ''))
  check('all ten agents were admitted and none failed', o.agentCount === FAMILIES.length && o.failures.length === 0,
    `agentCount=${o.agentCount} failures=${text(o.failures).slice(0, 300)}`)
  const results = (o.result ?? {}) as Record<string, unknown>
  for (const family of FAMILIES) {
    check(`workflow worker on ${family}: returned its own lane's final text`,
      String(results[family] ?? '').includes(`matrix-final-${family}`), String(results[family] ?? '').slice(0, 120))
    const hits = o.wire.filter(h => h.family === family)
    check(`workflow worker on ${family}: its endpoint took the turn with the exact wire id`,
      hits.length >= 1 && hits.every(h => String(h.body.model) === WORKER_SPELLINGS[family].wireId),
      `hits=${hits.length} models=${hits.map(h => h.body.model).join(',')}`)
  }

  // The driver seam crossed the other way: a GPT session fans out across
  // three families (anthropic included — non-Anthropic→Anthropic).
  const gptDriver = await driveWorkflow(
    'gpt-5.6-sol',
    `
      const a = await agent('matrix-notool: probe the anthropic lane', { model: 'claude-sonnet-5' });
      const z = await agent('matrix-notool: probe the zai lane', { model: '${WORKER_SPELLINGS.zai.model}' });
      const g = await agent('matrix-notool: probe the gemini lane', { model: 'gemini-3-pro' });
      return [a, z, g];
    `,
  )
  const gptResults = (gptDriver.result ?? []) as unknown[]
  check('a GPT-session workflow drives anthropic + zai + gemini workers',
    gptDriver.error === undefined && gptDriver.failures.length === 0 &&
      String(gptResults[0]).includes('matrix-final-anthropic') &&
      String(gptResults[1]).includes('matrix-final-zai') &&
      String(gptResults[2]).includes('matrix-final-gemini'),
    `error=${gptDriver.error ?? ''} failures=${text(gptDriver.failures).slice(0, 200)} results=${text(gptResults).slice(0, 200)}`)

  // Driver totality: EVERY family takes the workflow driver's chair once —
  // a one-worker script per driver, the worker on the ring's next family.
  for (let i = 0; i < FAMILIES.length; i++) {
    const driver = FAMILIES[i]!
    const worker = FAMILIES[(i + 1) % FAMILIES.length]!
    const run = await driveWorkflow(
      WORKER_SPELLINGS[driver].model,
      `return await agent('matrix-notool: probe the ${worker} lane', { model: '${WORKER_SPELLINGS[worker].model}' });`,
    )
    const workerHits = run.wire.filter(h => h.family === worker)
    check(`workflow driver on ${driver}: drives a ${worker} worker end-to-end`,
      run.error === undefined && run.failures.length === 0 &&
        String(run.result).includes(`matrix-final-${worker}`) &&
        workerHits.length >= 1 && workerHits.every(h => String(h.body.model) === WORKER_SPELLINGS[worker].wireId),
      `error=${run.error ?? ''} failures=${text(run.failures).slice(0, 150)} result=${String(run.result).slice(0, 80)}`)
  }

  // The one-grammar law: a CLASS alias in a workflow resolves to the same
  // exact id the Agent tool resolves — never an invalid bare id on the wire.
  const aliasRun = await driveWorkflow(
    'claude-opus-5',
    `return await agent('matrix-notool: probe the zai lane', { model: 'glm' });`,
  )
  const aliasZaiHits = aliasRun.wire.filter(h => h.family === 'zai')
  check("workflow agent({model:'glm'}) resolves through the engine grammar to the exact pin",
    aliasRun.error === undefined && aliasZaiHits.length >= 1 &&
      aliasZaiHits.every(h => h.body.model === WORKER_SPELLINGS.zai.model) &&
      String(aliasRun.result).includes('matrix-final-zai'),
    `error=${aliasRun.error ?? ''} models=${aliasZaiHits.map(h => h.body.model).join(',')}`)

  // The documented refusal: a model string the grammar cannot verify FAILS
  // the dispatch loudly — it never rides to the wire as an invented id.
  const junkRun = await driveWorkflow(
    'claude-opus-5',
    `
      try {
        await agent('matrix-notool: junk id', { model: 'glm-9999-nonexistent' });
        return 'dispatched';
      } catch (e) {
        return 'refused: ' + String(e && e.message || e);
      }
    `,
  )
  check('a non-catalogue engine id fails the dispatch with the catalogue refusal (no wire call)',
    String(junkRun.result).startsWith('refused:') &&
      String(junkRun.result).includes('not a catalogue-verified id') &&
      junkRun.wire.filter(h => h.family === 'zai').length === 0,
    String(junkRun.result).slice(0, 200))
}

// ============================================================================
section('§D the coordinator seat — every family takes a coordinator turn')
// ============================================================================
{
  const { COORDINATOR_CONTRACT, COORDINATOR_CONTRACT_VERSION } = await import('../../src/services/concourse/coordinatorLane.ts')
  const { liveCoordinatorCallModel } = await import('../../src/services/concourse/coordinatorCall.ts')
  const { coordinatorToolSet } = await import('../../src/services/concourse/coordinatorTools.ts')
  const q = await import('../../src/services/providers/openai/qualificationStore.ts')
  const { composeCoordinatorModelRegistry } = await import('../../src/services/concourse/coordinatorModels.ts')

  // The cross-family board: the coordinator on family X reads seats living
  // on OTHER families — their model ids must reach its wire un-flattened.
  const board = {
    counts: { running: 2 },
    sessions: [
      { sessionId: 'seat-openai', title: 'the gpt seat', state: 'running', means: 'working now', model: 'gpt-5.6-sol' },
      { sessionId: 'seat-zai', title: 'the glm seat', state: 'running', means: 'working now', model: WORKER_SPELLINGS.zai.model },
    ],
    openObligations: [],
  }
  const firstToolName = coordinatorToolSet()[0]?.name ?? ''

  for (const family of FAMILIES) {
    const spelling = WORKER_SPELLINGS[family]
    const before = captured.length
    let reply = ''
    let threw: string | undefined
    try {
      const proposal = await liveCoordinatorCallModel(
        {
          contractVersion: COORDINATOR_CONTRACT_VERSION,
          contract: COORDINATOR_CONTRACT,
          event: { kind: 'operator-message', messageId: `cf-${family}`, text: 'matrix-notool: say ok' } as never,
          board: board as never,
        },
        spelling.model,
      )
      reply = String((proposal as { reply?: unknown }).reply ?? '')
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    const hits = captured.slice(before)
    const own = hits.filter(h => h.family === family)
    check(`coordinator@${family}: the turn settled on its own endpoint with the exact id`,
      threw === undefined && own.length >= 1 && hits.length === own.length &&
        own.every(h => String(h.body.model) === spelling.wireId) && reply.includes(`matrix-final-${family}`),
      `threw=${threw ?? ''} hits=${hits.map(h => h.family + ':' + String(h.body.model)).join(',')} reply=${reply.slice(0, 100)}`)
    if (own.length === 0) continue
    const serialized = text(own[0]!.body)
    check(`coordinator@${family}: the coordinator seat identity rides its wire`,
      serialized.includes('You are the Mercury coordinator'))
    check(`coordinator@${family}: the cross-family board reaches the wire (both seats' model ids)`,
      serialized.includes('gpt-5.6-sol') && serialized.includes(WORKER_SPELLINGS.zai.model))
    check(`coordinator@${family}: the switchboard tools are declared on its wire`,
      firstToolName !== '' && serialized.includes(firstToolName))
  }

  // CM's minting seam, both sides of the asymmetry: a GPT coordinator turn
  // mints the coordinator-role receipt (the OpenAI provider contract's own
  // role fact) and the registry reads it 'ready'; no other family mints one
  // — their rows never carried the qualification law, and pretending they
  // did would be fake equality.
  const receipts = q.readQualificationReceipts()
  check("the GPT coordinator turn minted {gpt-5.6-sol · coordinator} (CM's seam)",
    receipts.some(r => r.receipt.modelId === 'gpt-5.6-sol' && r.receipt.role === 'coordinator'),
    text(receipts.map(r => [r.receipt.modelId, r.receipt.role])))
  check('no non-GPT family minted a qualification receipt (the receipt law is the OpenAI contract\'s own)',
    receipts.every(r => declaredRouteOf(r.receipt.modelId) === 'openai'),
    text(receipts.map(r => r.receipt.modelId)))
  const registry = await composeCoordinatorModelRegistry()
  const gptRow = registry.entries.find(e => e.modelId === 'gpt-5.6-sol')
  check("the registry reads the qualified GPT row 'ready' on the next read",
    gptRow?.availability === 'ready', text(gptRow))
  check('every registry row names its own family in the routing law\'s vocabulary (no family folded into another)',
    registry.entries.length > 0 && registry.entries.every(e => e.source === (declaredRouteOf(e.modelId) ?? 'unrecognised')),
    text(registry.entries.slice(0, 6).map(e => [e.modelId, e.source])))
}

// ============================================================================
section('§A the dispatch boundary — the engine grammar is TOTAL over the routing law')
// ============================================================================
{
  const engine = await import('../../src/utils/swarm/engineDispatch.ts')
  const { PROVIDER_ID_SPACES } = await import('../../src/services/providers/routeLaw.ts')
  const { enforceSubagentModelFloor, isHaikuTier } = await import('../../src/utils/model/modelFloor.ts')

  // Totality: every non-Anthropic route the routing law declares has a
  // class alias in the engine grammar — a new family row without a grammar
  // row goes red HERE, not in an operator's failed dispatch.
  const CLASS_TO_ROUTE: Record<string, string> = {
    gpt: 'openai', glm: 'zai', kimi: 'moonshot', deepseek: 'deepseek',
    compat: 'openai-compat', huggingface: 'huggingface', local: 'local',
    gemini: 'gemini', openrouter: 'openrouter',
  }
  const declaredRoutes = [...new Set(PROVIDER_ID_SPACES.map(s => s.route))].sort()
  const grammarRoutes = [...new Set(engine.ENGINE_DISPATCH_MODELS.map(c => CLASS_TO_ROUTE[c]).filter(Boolean))].sort()
  check('every routed family has an engine class alias (the totality law)',
    declaredRoutes.length > 0 && declaredRoutes.every(r => grammarRoutes.includes(r)),
    `declared=${declaredRoutes.join(',')} grammar=${grammarRoutes.join(',')}`)
  check('the schema-visible engine list carries the gemini and openrouter classes',
    engine.engineDispatchModelsForSchema().includes('gemini') && engine.engineDispatchModelsForSchema().includes('openrouter'))

  // Every class alias resolves to a concrete catalogue id on its own backend.
  const CLASS_EXPECT: Array<{ cls: string; backend: string; model?: string }> = [
    { cls: 'gpt', backend: 'openai', model: 'gpt-5.6-sol' },
    { cls: 'glm', backend: 'zai', model: WORKER_SPELLINGS.zai.model },
    { cls: 'kimi', backend: 'moonshot', model: WORKER_SPELLINGS.moonshot.model },
    { cls: 'deepseek', backend: 'deepseek', model: WORKER_SPELLINGS.deepseek.model },
    { cls: 'gemini', backend: 'gemini', model: 'gemini-3-pro' },
    { cls: 'openrouter', backend: 'openrouter', model: 'openrouter/openrouter/auto' },
    { cls: 'huggingface', backend: 'huggingface' },
    { cls: 'local', backend: 'local', model: 'local/qwen3-32b' },
    { cls: 'compat', backend: 'openai-compat' },
  ]
  // The class arms are SESSION-FIRST (an openrouter main resolves to itself,
  // by the resolver's own law), and earlier legs of this prover legitimately
  // leave an openrouter session model behind them — pin the main loop to the
  // anthropic parent for this loop so every class row exercises its else-arm
  // deterministically, then restore.
  const bootState = await import('../../src/bootstrap/state.ts')
  const priorOverride = bootState.getMainLoopModelOverride()
  bootState.setMainLoopModelOverride('claude-opus-4-8')
  for (const { cls, backend, model } of CLASS_EXPECT) {
    let resolved: { backend: string; model: string } | null = null
    let threw: string | undefined
    try {
      resolved = await engine.resolveEngineDispatch(cls)
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error)
    }
    check(`class '${cls}' resolves on its own backend${model ? ` to ${model}` : ''}`,
      threw === undefined && resolved !== null && resolved.backend === backend &&
        (model === undefined || resolved.model === model) &&
        declaredRouteOf(resolved.model) === backend,
      `threw=${threw ?? ''} resolved=${text(resolved)}`)
  }
  bootState.setMainLoopModelOverride(priorOverride)

  // Exact-id validation both ways on the two families the grammar gained.
  const geminiOk = await engine.resolveEngineDispatch('gemini-3-flash')
  check("exact 'gemini-3-flash' validates against the live catalogue", geminiOk?.backend === 'gemini' && geminiOk.model === 'gemini-3-flash', text(geminiOk))
  const geminiBad = await engine.resolveEngineDispatch('gemini-9999-nope').then(() => undefined, (e: unknown) => String((e as Error).message))
  check('an unlisted gemini id refuses, naming the live catalogue', typeof geminiBad === 'string' && geminiBad.includes('not listed by the live catalogue'), String(geminiBad))
  const orOk = await engine.resolveEngineDispatch('openrouter/qwen/qwen3-coder')
  check("exact 'openrouter/qwen/qwen3-coder' validates against the live catalogue", orOk?.backend === 'openrouter' && orOk.model === 'openrouter/qwen/qwen3-coder', text(orOk))
  const orBad = await engine.resolveEngineDispatch('openrouter/nope/never').then(() => undefined, (e: unknown) => String((e as Error).message))
  check('an unlisted openrouter slug refuses, naming the live catalogue', typeof orBad === 'string' && orBad.includes('not listed by the live catalogue'), String(orBad))
  const anthropicPass = await engine.resolveEngineDispatch('claude-sonnet-5')
  check('an anthropic id stays outside the engine grammar (null — the home lane untouched)', anthropicPass === null)

  // The never-Haiku floor judges ONLY the Anthropic family: a foreign model
  // whose NAME contains 'haiku' must never be silently swapped onto an
  // Anthropic model (that swap would be the cross-provider fallback the
  // routing law forbids).
  check('the floor still floors anthropic haiku spellings', enforceSubagentModelFloor('haiku', 'cf-test') === 'claude-sonnet-5' && isHaikuTier('claude-haiku-4-5-20251001'))
  for (const foreign of ['huggingface/TheDrummer/Haiku-RP-12B', 'local/haiku-13b', 'openrouter/thedrummer/haiku-writer']) {
    check(`a foreign '${foreign.split('/')[0]}' id named haiku rides untouched`,
      !isHaikuTier(foreign) && enforceSubagentModelFloor(foreign, 'cf-test') === foreign)
  }
}

// ── close ───────────────────────────────────────────────────────────────────
check('no request ever hit an unpinned path (base-pin drift guard)', unknownHits.length === 0, unknownHits.slice(0, 8).join(' | '))

server.close()
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
