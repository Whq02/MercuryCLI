#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-switch-matrix-adversary.ts — the multi-auth
//  SWITCH MATRIX, driven adversarially at the full engine seam (SWITCHADV):
//  every ordered provider-family pair across Anthropic Messages · OpenAI
//  Responses · chat-completions (Z.AI) · the OpenRouter carrier rides ONE
//  session through:
//
//    T1  a tool-round turn on lane A, with the pick landing MID-TURN through
//        the real settlement owner (settleModelSelection, turnActive) — the
//        pick must PARK (kind 'queued', crossProvider flagged) and BOTH of
//        T1's rounds must stay on lane A's wire (no re-model mid-flight);
//    ⋈   the turn boundary applies the parked switch through the real
//        boundary owner (settlePendingAtBoundary) — receipt previous/applied/
//        boundary/crossProvider pinned;
//    T2  the next turn rides lane B: B's path, B's dialect, B's wire model
//        id, the WHOLE history replayed (T1's user text, assistant text, the
//        tool_use/tool_result pair id-paired in B's own spelling);
//    T3  an IDLE pick back to lane A (turnActive:false → 'applied', boundary
//        'idle') and the third turn rides lane A again with the whole
//        history.
//
//  Every captured body is STRICT-PARSED for its dialect (role/shape law,
//  tool-call pairing, foreign-dialect key refusal) and swept for
//  cross-provider state leaks (Anthropic thinking signatures · Responses
//  encrypted reasoning) with needles composed from parts. One rogue leg pins
//  the engine's per-turn options snapshot: a direct mid-turn AppState-slice
//  model write (bypassing the park) still cannot re-model the flight. The
//  strict parsers and the leak sweep are themselves poison-tested against
//  deliberately malformed bodies, so a vacuous verifier fails loudly.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-switch-matrix-adversary.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — switch matrix adversary prover exceeded 240s')
  process.exit(1)
}, 240_000)
guard.unref?.()

delete process.env.NODE_ENV
delete process.env.CI
delete process.env.CLAUDE_EFFORT
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-matrix-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── leak needles, composed from parts (never self-matching) ────────────────
const SIG_NEEDLE = ['sig', 'fxswitch'].join('_') // Anthropic thinking signature
const ENC_NEEDLE = ['ENC', 'FXSWITCH'].join('_') // Responses encrypted reasoning
const THINK_NEEDLE = ['fixture', 'private', 'thought'].join(' ')

// ── the fixture: one server, four lanes, content-routed, stateless ─────────
type Body = Record<string, unknown>
type Captured = { path: string; body: Body; at: number }
const captured: Captured[] = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let toolSeq = 0

function anthropicToolRound(): string {
  const id = `toolu_swx_${++toolSeq}`
  const blocks = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINK_NEEDLE } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIG_NEEDLE } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Probing on lane A.' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 1 })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo probe-ok', description: 'probe' }) } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 2 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ]
  return blocks.join('')
}
function anthropicFinal(text: string): string {
  return [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
}
function responsesToolRound(): string {
  const id = `call_swx_${++toolSeq}`
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_item.done', item: { type: 'reasoning', id: `rs_swx_${toolSeq}`, summary: [{ type: 'summary_text', text: 'probing' }], encrypted_content: ENC_NEEDLE } }),
    sse({ type: 'response.output_item.done', item: { type: 'function_call', name: 'Bash', call_id: id, arguments: JSON.stringify({ command: 'echo probe-ok', description: 'probe' }) } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 6, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function responsesFinal(text: string): string {
  return [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_text.delta', delta: text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 6, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  ].join('')
}
function chatToolRound(): string {
  const id = `call_swx_${++toolSeq}`
  return [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Probing on the chat lane.', tool_calls: [{ index: 0, id, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo probe-ok', description: 'probe' }) } }] } }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 6, completion_tokens: 5 } }),
    'data: [DONE]\n\n',
  ].join('')
}
function chatFinal(text: string): string {
  return [
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    sse({ id: 'chat_fx', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ].join('')
}

/** Content routing: a body whose LAST tool call has been answered settles;
 *  otherwise a T1 prompt opens the tool round; anything else settles.
 *  Stateless — re-derived per request.
 *
 *  The answer is read AFTER the last call, never as the final item alone:
 *  Mercury's own user parts beside a tool result — the text or the
 *  attachment marker the round annotates — ride INSIDE the tool-result
 *  message on the Anthropic wire (its user rows merge) but as their own
 *  trailing item on the Responses and chat wires (function_call_output,
 *  then a user message; a `tool` row, then a user row — the documented
 *  order). The old final-item rule read that trailing item as an
 *  unanswered T1 prompt and opened a SECOND tool round on every third-party
 *  lane — a second permission callback, so the rig's mid-turn pick fired
 *  twice (picks=2) while the Anthropic lane saw one. */
function wantsToolRound(path: string, body: Body): boolean {
  const raw = JSON.stringify(body)
  if (path.endsWith('/responses')) {
    const input = (body.input as Array<Record<string, unknown>> | undefined) ?? []
    const lastCall = input.reduce((at, item, i) => (item.type === 'function_call' ? i : at), -1)
    if (lastCall >= 0 && input.slice(lastCall + 1).some(item => item.type === 'function_call_output')) return false
    return raw.includes('T1 ')
  }
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  // A call row: chat's assistant tool_calls, or the Anthropic assistant
  // message carrying a tool_use block (the needle's closing quote keeps a
  // tool_use_id from matching).
  const isCall = (m: Record<string, unknown>): boolean =>
    m.role === 'assistant' &&
    ((Array.isArray(m.tool_calls) && m.tool_calls.length > 0) || JSON.stringify(m.content ?? '').includes('"tool_use"'))
  const isAnswer = (m: Record<string, unknown>): boolean =>
    m.role === 'tool' || (m.role === 'user' && JSON.stringify(m.content ?? '').includes('tool_result'))
  const lastCall = messages.reduce((at, m, i) => (isCall(m) ? i : at), -1)
  if (lastCall >= 0 && messages.slice(lastCall + 1).some(isAnswer)) return false
  return raw.includes('T1 ')
}

const OPENAI_MODELS_BODY = {
  models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 272_000, input_modalities: ['text'], supported_in_api: true }],
}

const PORT = 35301
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
      res.end(
        JSON.stringify(
          path.startsWith('/openai/')
            ? OPENAI_MODELS_BODY
            : { object: 'list', data: [{ id: 'qwen/qwen3-coder', object: 'model' }] },
        ),
      )
      return
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      captured.push({ path, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(wantsToolRound(path, body) ? anthropicToolRound() : anthropicFinal('settled on the anthropic lane'))
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      captured.push({ path, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(wantsToolRound(path, body) ? responsesToolRound() : responsesFinal('settled on the responses lane'))
      return
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      captured.push({ path, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(wantsToolRound(path, body) ? chatToolRound() : chatFinal('settled on the chat lane'))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
})
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(PORT, '127.0.0.1', resolve)
})
const base = `http://127.0.0.1:${PORT}`
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  OPENAI_API_KEY: 'fixture-openai-key',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  OPENROUTER_API_KEY: 'fixture-openrouter-key',
})

console.log('============================================================')
console.log(' switch matrix adversary — every ordered family pair')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryEvents } = await import('../../src/query.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
const { settleModelSelection, settlePendingAtBoundary } = await import(
  '../../src/utils/model/modelTransition.ts'
)
type Message = import('../../src/types/message.ts').Message

// ── the four lanes ─────────────────────────────────────────────────────────
type Lane = {
  key: string
  setting: string
  wireModel: string
  pathEnd: string
  dialect: 'anthropic' | 'responses' | 'chat'
}
const LANES: Lane[] = [
  { key: 'anthropic', setting: 'claude-sonnet-5', wireModel: 'claude-sonnet-5', pathEnd: '/v1/messages', dialect: 'anthropic' },
  { key: 'openai', setting: 'gpt-5.6-sol', wireModel: 'gpt-5.6-sol', pathEnd: '/openai/v1/responses', dialect: 'responses' },
  { key: 'zai', setting: 'glm-5.2', wireModel: 'glm-5.2', pathEnd: '/zai/v4/chat/completions', dialect: 'chat' },
  { key: 'openrouter', setting: 'openrouter/qwen/qwen3-coder', wireModel: 'qwen/qwen3-coder', pathEnd: '/openrouter/api/v1/chat/completions', dialect: 'chat' },
]

// ── strict dialect parsers: violations, not booleans ───────────────────────
function parseAnthropicStrict(body: Body): string[] {
  const v: string[] = []
  if (typeof body.model !== 'string') v.push('model missing')
  if ('input' in body) v.push("foreign key 'input' (Responses) on the Anthropic wire")
  if ('instructions' in body) v.push("foreign key 'instructions' on the Anthropic wire")
  if ('store' in body) v.push("foreign key 'store' on the Anthropic wire")
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  if (messages.length === 0) v.push('no messages')
  const openToolIds: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') v.push(`illegal role '${String(m.role)}'`)
    const content = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []
    for (const blk of content) {
      if (blk.type === 'tool_use') openToolIds.push(String(blk.id))
      if (blk.type === 'tool_result') {
        const id = String(blk.tool_use_id)
        const at = openToolIds.indexOf(id)
        if (at === -1) v.push(`tool_result '${id}' answers no prior tool_use`)
        else openToolIds.splice(at, 1)
      }
      if (blk.type === 'thinking' && (blk.signature === '' || blk.signature === undefined)) {
        v.push('unsigned thinking block on the Anthropic wire')
      }
      if (blk.type === 'reasoning') v.push('Responses reasoning item on the Anthropic wire')
      if (blk.type === 'function_call') v.push('Responses function_call on the Anthropic wire')
    }
  }
  if (openToolIds.length > 0) v.push(`unanswered tool_use ids: ${openToolIds.join(',')}`)
  return v
}
function parseResponsesStrict(body: Body): string[] {
  const v: string[] = []
  if (typeof body.model !== 'string') v.push('model missing')
  if ('messages' in body) v.push("foreign key 'messages' on the Responses wire")
  if ('system' in body) v.push("foreign key 'system' on the Responses wire")
  if (body.store !== false) v.push('store is not false (stateless replay law)')
  if (!JSON.stringify(body.include ?? []).includes('reasoning.encrypted_content')) {
    v.push('encrypted-reasoning include missing')
  }
  const input = (body.input as Array<Record<string, unknown>> | undefined) ?? []
  if (input.length === 0) v.push('no input items')
  const KNOWN = new Set(['message', 'function_call', 'function_call_output', 'reasoning'])
  const openCallIds: string[] = []
  for (const item of input) {
    const type = String(item.type)
    if (!KNOWN.has(type)) v.push(`unknown input item type '${type}'`)
    if (type === 'message' && item.role !== 'user' && item.role !== 'assistant' && item.role !== 'system' && item.role !== 'developer') {
      v.push(`illegal message role '${String(item.role)}'`)
    }
    if (type === 'function_call') openCallIds.push(String(item.call_id))
    if (type === 'function_call_output') {
      const id = String(item.call_id)
      const at = openCallIds.indexOf(id)
      if (at === -1) v.push(`function_call_output '${id}' answers no prior function_call`)
      else openCallIds.splice(at, 1)
    }
    if (type === 'message' && JSON.stringify(item.content ?? '').includes('tool_use')) {
      v.push('Anthropic tool_use block inside a Responses message item')
    }
  }
  if (openCallIds.length > 0) v.push(`unanswered function_call ids: ${openCallIds.join(',')}`)
  return v
}
function parseChatStrict(body: Body, opts: { preservedThinking: boolean }): string[] {
  const v: string[] = []
  if (typeof body.model !== 'string') v.push('model missing')
  if ('input' in body) v.push("foreign key 'input' (Responses) on the chat wire")
  if ('system' in body) v.push("foreign key 'system' (Anthropic) on the chat wire")
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  if (messages.length === 0) v.push('no messages')
  const openCallIds: string[] = []
  for (const m of messages) {
    const role = String(m.role)
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) v.push(`illegal role '${role}'`)
    if (role === 'assistant') {
      const calls = (m.tool_calls as Array<Record<string, unknown>> | undefined) ?? []
      for (const c of calls) openCallIds.push(String(c.id))
      if (calls.length === 0 && typeof m.content !== 'string') v.push('call-less assistant message with non-string content')
    }
    if (role === 'tool') {
      const id = String(m.tool_call_id)
      const at = openCallIds.indexOf(id)
      if (at === -1) v.push(`role:tool '${id}' answers no prior tool_call`)
      else openCallIds.splice(at, 1)
    }
    if (!opts.preservedThinking && 'reasoning_content' in m) v.push('reasoning_content on a non-preserving chat wire')
  }
  if (openCallIds.length > 0) v.push(`unanswered tool_call ids: ${openCallIds.join(',')}`)
  return v
}
function strictViolations(lane: Lane, body: Body): string[] {
  if (lane.dialect === 'anthropic') return parseAnthropicStrict(body)
  if (lane.dialect === 'responses') return parseResponsesStrict(body)
  return parseChatStrict(body, { preservedThinking: false })
}
/** Cross-provider state-leak sweep — the needles are lane-owned secrets. */
function leakViolations(lane: Lane, body: Body): string[] {
  const raw = JSON.stringify(body)
  const v: string[] = []
  if (lane.dialect !== 'anthropic' && raw.includes(SIG_NEEDLE)) v.push('Anthropic thinking signature leaked off-lane')
  if (lane.dialect !== 'responses' && raw.includes(ENC_NEEDLE)) v.push('Responses encrypted reasoning leaked off-lane')
  if (lane.dialect !== 'anthropic' && lane.dialect !== 'responses' && raw.includes(THINK_NEEDLE)) {
    v.push('foreign thinking text leaked onto a chat wire')
  }
  if (lane.dialect === 'anthropic' && raw.includes(ENC_NEEDLE)) v.push('Responses encrypted reasoning leaked onto the Anthropic wire')
  return v
}

// ── the engine drive ───────────────────────────────────────────────────────
type Slice = {
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
}

function makeCtx(model: string): {
  ctx: Record<string, unknown>
  getAppStateObj: () => Record<string, unknown>
} {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  const ctx = {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [BashTool],
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
  return { ctx, getAppStateObj: () => appState }
}

type TurnResult = {
  settledMessages: Message[]
  requests: Captured[]
  terminal: Record<string, unknown>
  threw: unknown
}

async function driveTurn(
  history: Message[],
  model: string,
  onToolPermission?: () => void,
): Promise<TurnResult> {
  const before = captured.length
  const settledMessages: Message[] = []
  let terminal: Record<string, unknown> = {}
  let threw: unknown
  try {
    const { ctx } = makeCtx(model)
    const gen = queryEvents({
      messages: history as never,
      systemPrompt: ['switch adversary rig prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async (_t: unknown, input: Record<string, unknown>) => {
        onToolPermission?.()
        return { behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } }
      }) as never,
      toolUseContext: ctx as never,
      querySource: 'sdk' as never,
    })
    let r = await gen.next()
    while (!r.done) {
      const ev = r.value as { kind?: string; message?: Message }
      if ((ev.kind === 'assistant_settled' || ev.kind === 'tool_settled') && ev.message) {
        settledMessages.push(ev.message)
      }
      r = await gen.next()
    }
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error
  }
  return { settledMessages, requests: captured.slice(before), terminal, threw }
}

const ledger: Array<{ pair: string; turn: string; path: string; model: string }> = []

async function drivePair(a: Lane, b: Lane): Promise<void> {
  section(`${a.key} → ${b.key} (mid-turn park) → back (idle)`)
  let slice: Slice = { mainLoopModel: a.setting, mainLoopModelForSession: null, pendingModelSwitch: null }
  let history: Message[] = [createUserMessage({ content: 'T1 run the probe tool and report' }) as Message]

  // T1 on lane A — the pick lands mid-turn, between the rounds.
  let queuedKind = ''
  let queuedCross: boolean | undefined
  let switchesInsideTurn = 0
  const t1 = await driveTurn(history, slice.mainLoopModel!, () => {
    switchesInsideTurn++
    const settled = settleModelSelection(slice, b.setting, { turnActive: true })
    queuedKind = settled.kind
    if (settled.kind === 'queued') {
      queuedCross = settled.crossProvider
      slice = { ...slice, ...settled.patch }
    }
  })
  check(`T1 settled clean on ${a.key} (${t1.requests.length} rounds)`, t1.threw === undefined && t1.terminal.reason === 'completed' && t1.requests.length >= 2, `threw=${String(t1.threw)} terminal=${JSON.stringify(t1.terminal)} rounds=${t1.requests.length}`)
  check('the mid-turn pick PARKED (settlement kind queued, exactly one pick)', queuedKind === 'queued' && switchesInsideTurn === 1, `kind=${queuedKind} picks=${switchesInsideTurn}`)
  check('the park flags crossProvider truthfully', queuedCross === crossExpected(a, b), `flagged=${String(queuedCross)} expected=${String(crossExpected(a, b))}`)
  check(`NO re-model mid-flight: every T1 round rode ${a.key}'s wire`, t1.requests.every(r => r.path.endsWith(a.pathEnd) && r.body.model === a.wireModel), t1.requests.map(r => `${r.path}:${String(r.body.model)}`).join(' '))
  check('the pending slot survives the turn (applies at the boundary, not inside it)', slice.pendingModelSwitch?.setting === b.setting)
  for (const r of t1.requests) {
    const sv = strictViolations(a, r.body)
    const lv = leakViolations(a, r.body)
    check(`T1 body strict-parses as ${a.dialect} with no leaks`, sv.length === 0 && lv.length === 0, [...sv, ...lv].join('; '))
    ledger.push({ pair: `${a.key}->${b.key}`, turn: 'T1', path: r.path, model: String(r.body.model) })
  }

  // The boundary applies the park.
  const boundary = settlePendingAtBoundary(slice)
  check('the boundary settles the park', boundary !== null)
  if (boundary === null) return
  slice = { ...slice, ...boundary.patch } as Slice
  const rc = boundary.receipt
  check('the receipt is honest (previous=A, applied=B, boundary=turn-boundary, crossProvider)', rc.previous === a.setting && rc.applied === b.setting && rc.boundary === 'turn-boundary' && rc.resolution === 'applied' && rc.crossProvider === crossExpected(a, b), JSON.stringify(rc))
  check('the pending slot cleared exactly-once', slice.pendingModelSwitch === null && slice.mainLoopModel === b.setting)

  // T2 on lane B — the whole history must replay in B's dialect.
  history = [...history, ...t1.settledMessages, createUserMessage({ content: 'T2 continue after the switch' }) as Message]
  const t2 = await driveTurn(history, slice.mainLoopModel!, undefined)
  check(`T2 settled clean on ${b.key}`, t2.threw === undefined && t2.terminal.reason === 'completed' && t2.requests.length >= 1, `threw=${String(t2.threw)} terminal=${JSON.stringify(t2.terminal)}`)
  const t2main = t2.requests.find(r => JSON.stringify(r.body).includes('T2 '))
  check(`T2 rode ${b.key}'s wire (${b.pathEnd} · ${b.wireModel})`, t2main !== undefined && t2main.path.endsWith(b.pathEnd) && t2main.body.model === b.wireModel, t2.requests.map(r => `${r.path}:${String(r.body.model)}`).join(' '))
  if (t2main) {
    const raw = JSON.stringify(t2main.body)
    check('T2 replays the WHOLE history (T1 text · the tool result both present)', raw.includes('T1 run the probe tool') && raw.includes('probe-ok'), 'history fragments missing')
    const pairOk = b.dialect === 'anthropic'
      ? raw.includes('"tool_use"') && raw.includes('"tool_result"')
      : b.dialect === 'responses'
        ? raw.includes('"function_call"') && raw.includes('"function_call_output"')
        : raw.includes('"tool_calls"') && raw.includes('"tool_call_id"')
    check(`T2 tool pair rides in ${b.dialect}'s own spelling, id-paired`, pairOk)
    const sv = strictViolations(b, t2main.body)
    const lv = leakViolations(b, t2main.body)
    check(`T2 body strict-parses as ${b.dialect} with no leaks`, sv.length === 0 && lv.length === 0, [...sv, ...lv].join('; '))
    ledger.push({ pair: `${a.key}->${b.key}`, turn: 'T2', path: t2main.path, model: String(t2main.body.model) })
  }

  // Idle pick back to A, then T3 rides A with the whole history.
  const idle = settleModelSelection(slice, a.setting, { turnActive: false })
  check("the idle pick applies NOW (kind 'applied', boundary 'idle')", idle.kind === 'applied' && idle.receipt?.boundary === 'idle' && idle.receipt.applied === a.setting && idle.receipt.crossProvider === crossExpected(b, a), JSON.stringify(idle))
  if (idle.kind === 'applied') slice = { ...slice, ...idle.patch } as Slice
  history = [...history, ...t2.settledMessages, createUserMessage({ content: 'T3 ride the idle switch back' }) as Message]
  const t3 = await driveTurn(history, slice.mainLoopModel!, undefined)
  const t3main = t3.requests.find(r => JSON.stringify(r.body).includes('T3 '))
  check(`T3 rode ${a.key}'s wire again after the idle switch back`, t3.threw === undefined && t3main !== undefined && t3main.path.endsWith(a.pathEnd) && t3main.body.model === a.wireModel, `threw=${String(t3.threw)} ${t3.requests.map(r => `${r.path}:${String(r.body.model)}`).join(' ')}`)
  if (t3main) {
    const raw = JSON.stringify(t3main.body)
    check('T3 history is whole (T1 + T2 texts both present)', raw.includes('T1 run the probe tool') && raw.includes('T2 continue after the switch'))
    const sv = strictViolations(a, t3main.body)
    const lv = leakViolations(a, t3main.body)
    check(`T3 body strict-parses as ${a.dialect} with no leaks`, sv.length === 0 && lv.length === 0, [...sv, ...lv].join('; '))
    ledger.push({ pair: `${a.key}->${b.key}`, turn: 'T3', path: t3main.path, model: String(t3main.body.model) })
  }
}

function crossExpected(a: Lane, b: Lane): boolean {
  // providerFamilyOfSetting truth: anthropic/openai/zai/openrouter are four
  // DISTINCT route families — every off-diagonal pair here is cross-provider.
  return a.key !== b.key
}

// ── run the ordered matrix ─────────────────────────────────────────────────
for (const a of LANES) {
  for (const b of LANES) {
    if (a.key === b.key) continue
    await drivePair(a, b)
  }
}

// ── the rogue mid-turn write: options snapshot beats a direct state write ──
section('rogue leg — a direct mid-turn slice write cannot re-model the flight')
{
  const a = LANES[0]!
  const b = LANES[1]!
  const history: Message[] = [createUserMessage({ content: 'T1 run the probe tool and report' }) as Message]
  let rogueSlice: Slice = { mainLoopModel: a.setting, mainLoopModelForSession: null, pendingModelSwitch: null }
  const t1 = await driveTurn(history, rogueSlice.mainLoopModel!, () => {
    // The rogue write: no park, no settlement — straight onto the slice the
    // NEXT turn would read. The running turn's options snapshot must hold.
    rogueSlice = { ...rogueSlice, mainLoopModel: b.setting }
  })
  check('the rogue drive settled', t1.threw === undefined && t1.terminal.reason === 'completed', String(t1.threw))
  check('every round STILL rode the spawn lane (options snapshot law)', t1.requests.length >= 2 && t1.requests.every(r => r.path.endsWith(a.pathEnd) && r.body.model === a.wireModel), t1.requests.map(r => `${r.path}:${String(r.body.model)}`).join(' '))
}

// ── poison controls: the verifiers must fail malformed bodies ──────────────
section('poison controls — the strict parsers and the leak sweep can fail')
{
  const anthLane = LANES[0]!
  const respLane = LANES[1]!
  const chatLane = LANES[2]!
  const poisonAnthropic: Body = {
    model: 'claude-sonnet-5',
    input: [],
    messages: [
      { role: 'tool', content: 'x' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_MISSING', content: 'x' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'loose', signature: '' }] },
    ],
  }
  check('poison Anthropic body FAILS the strict parse (4+ classes)', parseAnthropicStrict(poisonAnthropic).length >= 4, parseAnthropicStrict(poisonAnthropic).join('; '))
  const poisonResponses: Body = {
    model: 'gpt-5.6-sol',
    messages: [],
    store: true,
    input: [
      { type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c_OTHER', output: 'x' },
      { type: 'weird_item' },
    ],
  }
  check('poison Responses body FAILS the strict parse (4+ classes)', parseResponsesStrict(poisonResponses).length >= 4, parseResponsesStrict(poisonResponses).join('; '))
  const poisonChat: Body = {
    model: 'glm-5.2',
    system: 'x',
    messages: [
      { role: 'assistant', content: [{ weird: true }] },
      { role: 'tool', tool_call_id: 'nope', content: 'x' },
      { role: 'user', content: 'hi', reasoning_content: 'leaked' },
    ],
  }
  check('poison chat body FAILS the strict parse (3+ classes)', parseChatStrict(poisonChat, { preservedThinking: false }).length >= 3, parseChatStrict(poisonChat, { preservedThinking: false }).join('; '))
  const leakyChat: Body = { model: 'glm-5.2', messages: [{ role: 'user', content: `carry ${SIG_NEEDLE} and ${ENC_NEEDLE}` }] }
  check('the leak sweep FAILS a body carrying both needles off-lane', leakViolations(chatLane, leakyChat).length >= 2, leakViolations(chatLane, leakyChat).join('; '))
  check('the leak sweep passes clean bodies (control)', leakViolations(anthLane, { model: 'x' }).length === 0 && leakViolations(respLane, { model: 'x' }).length === 0)
}

// ── ledger out ─────────────────────────────────────────────────────────────
const ledgerPath = join(process.env.MERCURY_CONFIG_DIR!, 'switch-matrix-ledger.json')
writeFileSync(ledgerPath, JSON.stringify({ ledger, capturedBodies: captured.length }, null, 2))
console.log(`\n  ledger: ${ledgerPath} (${captured.length} captured bodies)`)

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
