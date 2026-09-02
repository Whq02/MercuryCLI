#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-parallel-tool-rounds.ts — the tool-loop
//  invariants of a PARALLEL round, on every dialect, through the real loop.
//
//  A model that fires several tool calls in one turn meets the harness at
//  three seams: the decoder (one assistant message per block), the executor
//  (every block settles exactly once, an error rides back as its own
//  tool_result, never as a thrown run), and the next request's assembler
//  (every call the provider emitted meets its answer, in the assistant's
//  own order, and nothing the harness refused is replayed as if it ran).
//  Last night's coordinator loop lost a session to exactly the middle of
//  that law; this prover pins it for the MAIN query loop (subagents and
//  workflows consume the same loop) against ONE loopback fixture speaking
//  all three wire dialects:
//
//    Anthropic messages ........ claude-*
//    OpenAI Responses .......... openai (gpt-*)
//    chat-completions .......... zai · moonshot · deepseek · compat slot ·
//                                openrouter · gemini · huggingface · local
//
//  Per lane:
//    P1  a mixed round of four calls — one that succeeds, one whose tool
//        THROWS, one naming a tool the pool does not carry, one whose
//        arguments fail the schema — runs to completion in exactly two model
//        calls; the second request answers every executed call exactly
//        once, in the assistant's order; the throwing tool's error is an
//        is_error tool_result (the run never ends on it); a refused call is
//        never replayed as a tool_use and its typed correction rides the
//        same request.
//    P2  a result with a sibling feedback block keeps the round's order on
//        the wire (results first, in the assistant's order, feedback after).
//    P3  two calls carrying the SAME id in one turn: the id is answered
//        exactly once and at most one tool_use is minted for it.
//    P4  a model that hammers the identical failing call is stopped by the
//        repetition breaker in bounded rounds on this dialect too.
//
//  Endpoint bases: EVERY provider base pinned to the loopback fixture BEFORE
//  any src import; nothing here can reach a live service.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-parallel-tool-rounds.ts
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
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — parallel tool rounds prover exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

// ── env hygiene BEFORE any src import ───────────────────────────────────────
delete process.env.NODE_ENV
for (const ambient of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_SIMPLE', 'GOOGLE_API_KEY', 'DISABLE_COMPACT', 'DISABLE_AUTO_COMPACT']) {
  delete process.env[ambient]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'parallel-rounds-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'parallel-rounds-daemon-'))
process.env.MERCURY_TEAMS_DIR = mkdtempSync(join(tmpdir(), 'parallel-rounds-teams-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── the loopback fixture: three dialects, one server ────────────────────────
type ScriptedCall = { id: string; name: string; args: string }
type Turn = { calls: ScriptedCall[] } | { text: string }
type Body = Record<string, unknown>
type Dialect = 'anthropic' | 'responses' | 'chat'

/** The active script: request N of the current drive answers turns[N]; a
 *  `repeat` script answers every request with the same turn. */
let script: { turns: Turn[]; repeat?: boolean } = { turns: [{ text: 'idle' }] }
let requestOrdinal = 0
const captured: Array<{ dialect: Dialect; path: string; body: Body }> = []

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const evt = (name: string, obj: unknown): string => `event: ${name}\n${sse(obj)}`

function anthropicSse(turn: Turn): string {
  const usage = { input_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
  const out: string[] = [
    evt('message_start', { type: 'message_start', message: { id: `msg_${requestOrdinal}`, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage } }),
  ]
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      out.push(evt('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }))
      out.push(evt('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } }))
      out.push(evt('content_block_stop', { type: 'content_block_stop', index }))
    })
    out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage }))
  } else {
    out.push(evt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    out.push(evt('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } }))
    out.push(evt('content_block_stop', { type: 'content_block_stop', index: 0 }))
    out.push(evt('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
  }
  out.push(evt('message_stop', { type: 'message_stop' }))
  return out.join('')
}

function responsesSse(turn: Turn): string {
  const out: string[] = [sse({ type: 'response.created', response: { id: `resp_${requestOrdinal}` } })]
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      const itemId = `fc_${requestOrdinal}_${index}`
      out.push(sse({ type: 'response.output_item.added', item: { type: 'function_call', id: itemId, call_id: call.id, name: call.name, arguments: '' } }))
      out.push(sse({ type: 'response.function_call_arguments.delta', item_id: itemId, delta: call.args }))
      out.push(sse({ type: 'response.output_item.done', item: { type: 'function_call', id: itemId, call_id: call.id, name: call.name, arguments: call.args } }))
    })
  } else {
    out.push(sse({ type: 'response.output_text.delta', delta: turn.text }))
    out.push(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.text }] } }))
  }
  out.push(sse({ type: 'response.completed', response: { id: `resp_${requestOrdinal}`, usage: { input_tokens: 8, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } } } }))
  return out.join('')
}

function chatSse(turn: Turn): string {
  const out: string[] = []
  if ('calls' in turn) {
    turn.calls.forEach((call, index) => {
      out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { ...(index === 0 ? { role: 'assistant' } : {}), tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] }, finish_reason: null }] }))
    })
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }))
  } else {
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: turn.text }, finish_reason: null }] }))
    out.push(sse({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }))
  }
  out.push('data: [DONE]\n\n')
  return out.join('')
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
      captured.push({ dialect, path, body })
      const turn = script.repeat ? script.turns[0]! : (script.turns[requestOrdinal] ?? { text: 'script exhausted' })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(dialect === 'anthropic' ? anthropicSse(turn) : dialect === 'responses' ? responsesSse(turn) : chatSse(turn))
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
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MOONSHOT_API_KEY: 'fixture-moonshot-key',
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  DEEPSEEK_API_KEY: 'fixture-deepseek-key',
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  OPENROUTER_API_KEY: 'fixture-openrouter-key',
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  GEMINI_API_KEY: 'fixture-gemini-key',
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
  HF_TOKEN: 'fixture-hf-token',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
})

console.log('============================================================')
console.log(' parallel tool rounds — every dialect, through the real loop')
console.log('============================================================')

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
const { TOOL_CALL_REFUSAL_CORRECTION_HEAD } = await import('../../src/services/providers/toolCallGate.ts')
const guard = await import('../../src/services/tools/identicalFailureGuard.ts')
type AnyMsg = Record<string, unknown> & { type?: string }

// ── the rig tools ───────────────────────────────────────────────────────────
function makeTool(name: string, behaviour: 'echo' | 'throw'): never {
  return {
    name,
    async description() {
      return `${name} rig tool`
    },
    async prompt() {
      return `${name} rig tool`
    },
    inputSchema: z.object({ text: z.string() }),
    userFacingName: () => name,
    isEnabled: () => true,
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isMcp: false,
    needsPermissions: () => false,
    async validateInput() {
      return { result: true }
    },
    async call(input: { text: string }) {
      if (behaviour === 'throw') throw new Error(`FailTool exploded on ${input.text}`)
      return { data: `echo:${input.text}` }
    },
    mapToolResultToToolResultBlockParam: (data: unknown, toolUseId: string) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: String(data),
    }),
  } as never
}
const EchoTool = makeTool('EchoTool', 'echo')
const FailTool = makeTool('FailTool', 'throw')
const TOOLS = [EchoTool, FailTool]

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: TOOLS,
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

type Drive = {
  wire: Array<{ dialect: Dialect; path: string; body: Body }>
  yields: AnyMsg[]
  terminal: Record<string, unknown>
  threw: string | undefined
}

/** Drive the REAL loop (production callModel → the fixture) under a script.
 *  `feedbackFor` names the tool whose permission verdict carries a
 *  feedback line (P2). */
async function drive(model: string, s: typeof script, feedbackFor?: string): Promise<Drive> {
  script = s
  requestOrdinal = 0
  const before = captured.length
  const ctx = makeCtx(model)
  const canUseTool = (async (tool: { name: string }, input: Record<string, unknown>) => ({
    behavior: 'allow',
    updatedInput: input,
    decisionReason: { type: 'other', reason: 'rig' },
    ...(feedbackFor !== undefined && tool.name === feedbackFor ? { acceptFeedback: 'operator feedback: noted' } : {}),
  })) as never
  const deps = productionDeps()
  const yields: AnyMsg[] = []
  let terminal: Record<string, unknown> = {}
  let threw: string | undefined
  try {
    const gen = query({
      messages: [createUserMessage({ content: 'run the fixture round' })] as never,
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
    while (!r.done) {
      yields.push(r.value as AnyMsg)
      r = await gen.next()
    }
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  await new Promise(resolve => setTimeout(resolve, 5))
  return { wire: captured.slice(before), yields, terminal, threw }
}

// ── wire readers (what the provider actually receives) ──────────────────────
type Answer = { id: string; text: string }
type RoundOnWire = { toolUseIds: string[]; answers: Answer[]; trailingText: string[] }

/** The LAST assistant tool round on the wire and everything that answers
 *  it, per dialect. */
function readRound(dialect: Dialect, body: Body): RoundOnWire {
  const toolUseIds: string[] = []
  const answers: Answer[] = []
  const trailingText: string[] = []
  if (dialect === 'anthropic') {
    const messages = (body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
    let lastAssistant = -1
    messages.forEach((m, i) => {
      if (m.role === 'assistant' && Array.isArray(m.content) && (m.content as AnyMsg[]).some(b => b.type === 'tool_use')) lastAssistant = i
    })
    if (lastAssistant === -1) return { toolUseIds, answers, trailingText }
    for (const b of messages[lastAssistant]!.content as AnyMsg[]) if (b.type === 'tool_use') toolUseIds.push(String(b.id))
    for (const m of messages.slice(lastAssistant + 1)) {
      if (m.role !== 'user') continue
      const content = Array.isArray(m.content) ? (m.content as AnyMsg[]) : [{ type: 'text', text: String(m.content) }]
      for (const b of content) {
        if (b.type === 'tool_result') {
          const raw = b.content
          answers.push({ id: String(b.tool_use_id), text: typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(x => String((x as AnyMsg).text ?? '')).join('') : '' })
        } else if (b.type === 'text') trailingText.push(String(b.text ?? ''))
      }
    }
    return { toolUseIds, answers, trailingText }
  }
  if (dialect === 'responses') {
    const input = (body.input as AnyMsg[] | undefined) ?? []
    let lastCall = -1
    input.forEach((item, i) => {
      if (item.type === 'function_call') lastCall = i
    })
    // The round = the maximal trailing run of function_call items.
    let start = lastCall
    while (start > 0 && input[start - 1]!.type === 'function_call') start--
    if (lastCall === -1) return { toolUseIds, answers, trailingText }
    for (let i = start; i <= lastCall; i++) toolUseIds.push(String(input[i]!.call_id))
    for (const item of input.slice(lastCall + 1)) {
      if (item.type === 'function_call_output') {
        const out = item.output
        answers.push({ id: String(item.call_id), text: typeof out === 'string' ? out : Array.isArray(out) ? out.map(x => String((x as AnyMsg).text ?? '')).join('') : '' })
      } else if (item.type === 'message' || item.role === 'user') {
        const content = item.content
        if (typeof content === 'string') trailingText.push(content)
        else if (Array.isArray(content)) for (const p of content as AnyMsg[]) if (typeof p.text === 'string') trailingText.push(p.text)
      }
    }
    return { toolUseIds, answers, trailingText }
  }
  const messages = (body.messages as AnyMsg[] | undefined) ?? []
  let lastAssistant = -1
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0) lastAssistant = i
  })
  if (lastAssistant === -1) return { toolUseIds, answers, trailingText }
  for (const c of messages[lastAssistant]!.tool_calls as AnyMsg[]) toolUseIds.push(String(c.id))
  for (const m of messages.slice(lastAssistant + 1)) {
    if (m.role === 'tool') answers.push({ id: String(m.tool_call_id), text: String(m.content ?? '') })
    else if (m.role === 'user') {
      const content = m.content
      if (typeof content === 'string') trailingText.push(content)
      else if (Array.isArray(content)) for (const p of content as AnyMsg[]) if (typeof p.text === 'string') trailingText.push(p.text)
    }
  }
  return { toolUseIds, answers, trailingText }
}

/** On the chat dialect every `tool` row must directly follow the assistant
 *  tool_calls row or another `tool` row — a user row between them is a
 *  400 on strict servers. */
function chatToolRowsAdjacent(body: Body): boolean {
  const messages = (body.messages as AnyMsg[] | undefined) ?? []
  let lastAssistant = -1
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0) lastAssistant = i
  })
  if (lastAssistant === -1) return true
  let sawNonTool = false
  for (const m of messages.slice(lastAssistant + 1)) {
    if (m.role === 'tool') {
      if (sawNonTool) return false
    } else sawNonTool = true
  }
  return true
}

const toolResultsYielded = (yields: AnyMsg[]): Array<{ id: string; text: string; isError: boolean }> => {
  const out: Array<{ id: string; text: string; isError: boolean }> = []
  for (const m of yields) {
    if (m.type !== 'user') continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as AnyMsg[]) {
      if (b.type !== 'tool_result') continue
      const raw = b.content
      out.push({ id: String(b.tool_use_id), text: typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(x => String((x as AnyMsg).text ?? '')).join('') : '', isError: b.is_error === true })
    }
  }
  return out
}
const mintedToolUses = (yields: AnyMsg[]): string[] => {
  const ids: string[] = []
  for (const m of yields) {
    if (m.type !== 'assistant') continue
    const content = (m.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const b of content as AnyMsg[]) if (b.type === 'tool_use') ids.push(String(b.id))
  }
  return ids
}
const systemNotices = (yields: AnyMsg[]): string[] =>
  yields.filter(m => m.type === 'system').map(m => String((m as { content?: unknown }).content ?? ''))

// ── the lanes ───────────────────────────────────────────────────────────────
const LANES: Array<{ lane: string; model: string; dialect: Dialect }> = [
  { lane: 'anthropic', model: 'claude-opus-4-8', dialect: 'anthropic' },
  { lane: 'openai', model: 'gpt-5.6-sol', dialect: 'responses' },
  { lane: 'zai', model: 'glm-5.2', dialect: 'chat' },
  { lane: 'moonshot', model: 'kimi-k3', dialect: 'chat' },
  { lane: 'deepseek', model: 'deepseek-v4-pro', dialect: 'chat' },
  { lane: 'openai-compat', model: 'compat/fixture-model', dialect: 'chat' },
  { lane: 'openrouter', model: 'openrouter/fixture/model', dialect: 'chat' },
  { lane: 'gemini', model: 'gemini-3-pro', dialect: 'chat' },
  { lane: 'huggingface', model: 'huggingface/fixture-org/fixture-model', dialect: 'chat' },
  { lane: 'local', model: 'local/fixture-local', dialect: 'chat' },
]

const MIXED_ROUND: ScriptedCall[] = [
  { id: 'call_ok', name: 'EchoTool', args: '{"text":"one"}' },
  { id: 'call_throw', name: 'FailTool', args: '{"text":"two"}' },
  { id: 'call_unknown', name: 'NoSuchTool', args: '{"text":"three"}' },
  { id: 'call_badargs', name: 'EchoTool', args: '{"text":4}' },
]

for (const { lane, model, dialect } of LANES) {
  section(`${lane} · ${dialect} dialect · ${model}`)
  const gated = dialect !== 'anthropic'

  // ── P1 ────────────────────────────────────────────────────────────────────
  {
    const r = await drive(model, { turns: [{ calls: MIXED_ROUND }, { text: 'round settled' }] })
    check('P1 the run never threw and completed in exactly two model calls', r.threw === undefined && r.terminal.reason === 'completed' && r.wire.length === 2, `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} calls=${r.wire.length}`)
    const second = r.wire[1]
    const round = second ? readRound(dialect, second.body) : { toolUseIds: [], answers: [], trailingText: [] }
    // What the harness executed: on the gated dialects the unknown tool and
    // the bad arguments never mint; on the Anthropic wire (the API already
    // validated them upstream — the fixture stands in for it) the executor
    // answers both with an error result.
    const executed = gated ? ['call_ok', 'call_throw'] : ['call_ok', 'call_throw', 'call_unknown', 'call_badargs']
    check('P1 the replayed assistant carries exactly the executed calls, in the assistant\'s order', JSON.stringify(round.toolUseIds) === JSON.stringify(executed), JSON.stringify(round.toolUseIds))
    check('P1 every executed call is answered exactly once, in that same order', JSON.stringify(round.answers.map(a => a.id)) === JSON.stringify(executed), JSON.stringify(round.answers.map(a => a.id)))
    check("P1 the throwing tool's failure rode back as its own tool_result (the run did not end on it)", round.answers.some(a => a.id === 'call_throw' && a.text.includes('FailTool exploded')), JSON.stringify(round.answers.find(a => a.id === 'call_throw')))
    const yielded = toolResultsYielded(r.yields)
    check('P1 the failure was flagged is_error for the model', yielded.some(t => t.id === 'call_throw' && t.isError))
    check('P1 the successful call answered with its data', round.answers.some(a => a.id === 'call_ok' && a.text === 'echo:one'))
    if (gated) {
      check('P1 no tool_use was minted for the unknown tool or the bad arguments', !mintedToolUses(r.yields).includes('call_unknown') && !mintedToolUses(r.yields).includes('call_badargs'))
      const correction = round.trailingText.find(t => t.startsWith(TOOL_CALL_REFUSAL_CORRECTION_HEAD))
      check('P1 the typed correction for both refusals rides the same request, after the results', correction !== undefined && correction.includes('call_unknown') && correction.includes('call_badargs'), round.trailingText.join(' | ').slice(0, 200))
    } else {
      check('P1 the unknown tool answered with the no-such-tool error', round.answers.some(a => a.id === 'call_unknown' && a.text.includes('No such tool available')))
      check('P1 the bad arguments answered with the validation error', round.answers.some(a => a.id === 'call_badargs' && a.text.includes('InputValidationError')))
    }
    if (dialect === 'chat') check('P1 every tool row directly follows the assistant tool_calls row', second !== undefined && chatToolRowsAdjacent(second.body))
  }

  // ── P2 ────────────────────────────────────────────────────────────────────
  {
    const calls: ScriptedCall[] = [
      { id: 'call_a', name: 'EchoTool', args: '{"text":"a"}' },
      { id: 'call_b', name: 'EchoTool', args: '{"text":"b"}' },
      { id: 'call_c', name: 'EchoTool', args: '{"text":"c"}' },
    ]
    const r = await drive(model, { turns: [{ calls }, { text: 'ordered' }] }, 'EchoTool')
    check('P2 the run completed in two calls', r.threw === undefined && r.terminal.reason === 'completed' && r.wire.length === 2, `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)} calls=${r.wire.length}`)
    const second = r.wire[1]
    const round = second ? readRound(dialect, second.body) : { toolUseIds: [], answers: [], trailingText: [] }
    check('P2 results with a sibling feedback block keep the assistant\'s order on the wire', JSON.stringify(round.answers.map(a => a.id)) === JSON.stringify(['call_a', 'call_b', 'call_c']), JSON.stringify(round.answers.map(a => a.id)))
    check('P2 the feedback reached the model', JSON.stringify(second?.body ?? {}).includes('operator feedback: noted'))
    if (dialect === 'chat') check('P2 every tool row directly follows the assistant tool_calls row (feedback after)', second !== undefined && chatToolRowsAdjacent(second.body))
  }

  // ── P3 ────────────────────────────────────────────────────────────────────
  {
    const calls: ScriptedCall[] = [
      { id: 'call_dup', name: 'EchoTool', args: '{"text":"first"}' },
      { id: 'call_dup', name: 'EchoTool', args: '{"text":"second"}' },
    ]
    const r = await drive(model, { turns: [{ calls }, { text: 'deduped' }] })
    check('P3 two calls with the same id never end the run', r.threw === undefined && r.terminal.reason === 'completed', `threw=${r.threw ?? 'no'} terminal=${JSON.stringify(r.terminal)}`)
    const second = r.wire[1]
    const round = second ? readRound(dialect, second.body) : { toolUseIds: [], answers: [], trailingText: [] }
    check('P3 the duplicated id is answered exactly once on the wire', round.answers.filter(a => a.id === 'call_dup').length === 1, JSON.stringify(round.answers.map(a => a.id)))
    check('P3 at most one tool_use was replayed for the duplicated id', round.toolUseIds.filter(id => id === 'call_dup').length <= 1, JSON.stringify(round.toolUseIds))
  }

  // ── P4 ────────────────────────────────────────────────────────────────────
  {
    const r = await drive(model, { turns: [{ calls: [{ id: 'call_hammer', name: 'FailTool', args: '{"text":"again"}' }] }], repeat: true })
    const bound = guard.IDENTICAL_FAILURES_TO_STOP + 1
    check(`P4 a model hammering the identical failing call is stopped after exactly ${bound} model calls`, r.terminal.reason === 'repetition_breaker' && r.wire.length === bound, `terminal=${JSON.stringify(r.terminal)} calls=${r.wire.length} threw=${r.threw ?? 'no'}`)
    check('P4 the nudge reached the model once as an is_error result', toolResultsYielded(r.yields).filter(t => t.text.includes(guard.IDENTICAL_RETRY_NUDGE) && t.isError).length === 1)
    check("P4 the operator's screen carries the warning", systemNotices(r.yields).some(t => t.includes('Stopped this turn') && t.includes('FailTool')))
  }
}

section('cross-lane facts')
check('every model call left through the loopback fixture', captured.every(c => c.path.startsWith('/')), String(captured.length))

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
