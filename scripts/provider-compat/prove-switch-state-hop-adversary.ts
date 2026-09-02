#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-switch-state-hop-adversary.ts — the
//  RESPONSES-STATE HOP (SWITCHADV drive family 4, the known unknown): a
//  session that has accumulated provider-native continuation state hops to a
//  foreign family and BACK, and every captured request body must stay
//  wire-legal on its own dialect with the foreign state contained.
//
//    Leg 1 — OpenAI Responses state out and back:
//      T1 rides gpt: a tool round whose fixture turn carries a reasoning
//      item WITH encrypted content (and the settled final carries one too,
//      so the persisted turn record holds Responses state);
//        · the WITHIN-TURN continuation (round 2, same wire) must replay
//          the reasoning item with its encrypted content in position — the
//          documented native continuation contract;
//      T2 hops to Anthropic: the request must strict-parse as Messages —
//      NO reasoning items, NO encrypted content, NO rs_ item ids — with
//      T1's tool pair converted to tool_use/tool_result;
//      T3 hops back to gpt: the request must strict-parse as Responses;
//      what SURVIVES of T1's reasoning state is captured and printed (the
//      drive records the truth; wire legality is the hard assert), and the
//      stateless-replay law (store:false, no previous_response_id) holds.
//
//    Leg 2 — Anthropic thinking out and back (the mirror):
//      T1 rides claude with a SIGNED thinking block in the tool round;
//      the within-turn continuation is captured (signed-thinking presence
//      recorded); T2 hops to gpt — no thinking text, no signature leak;
//      T3 hops home to claude — never an unsigned thinking block, the tool
//      pair intact, thinking survival recorded.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-switch-state-hop-adversary.ts
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
const note = (label: string): void => {
  console.log(`  [NOTE] ${label}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — state hop adversary prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

delete process.env.NODE_ENV
delete process.env.CI
delete process.env.CLAUDE_EFFORT
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switch-hop-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SIG_NEEDLE = ['sig', 'hopfx'].join('_')
const ENC_NEEDLE = ['ENC', 'HOPFX'].join('_')
const THINK_NEEDLE = ['hop', 'private', 'thought'].join(' ')
const REASONING_ID = ['rs', 'hopfx', '1'].join('_')

type Body = Record<string, unknown>
type Captured = { path: string; body: Body; at: number }
const captured: Captured[] = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let toolSeq = 0

function anthropicSseTurn(opts: { tool: boolean; text: string }): string {
  const parts: string[] = [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: THINK_NEEDLE } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: SIG_NEEDLE } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: opts.text } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 1 })}`,
  ]
  if (opts.tool) {
    const id = `toolu_hop_${++toolSeq}`
    parts.push(
      `event: content_block_start\n${sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id, name: 'Bash', input: {} } })}`,
      `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'echo hop-ok', description: 'hop probe' }) } })}`,
      `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 2 })}`,
      `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 } })}`,
      `event: message_stop\n${sse({ type: 'message_stop' })}`,
    )
    return parts.join('')
  }
  parts.push(
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  )
  return parts.join('')
}
function responsesSseTurn(opts: { tool: boolean; text: string }): string {
  const parts: string[] = [
    sse({ type: 'response.created', response: { id: 'resp_fx' } }),
    sse({ type: 'response.output_item.done', item: { type: 'reasoning', id: REASONING_ID, summary: [{ type: 'summary_text', text: 'hop reasoning summary' }], encrypted_content: ENC_NEEDLE } }),
  ]
  if (opts.tool) {
    const id = `call_hop_${++toolSeq}`
    parts.push(
      sse({ type: 'response.output_item.done', item: { type: 'function_call', name: 'Bash', call_id: id, arguments: JSON.stringify({ command: 'echo hop-ok', description: 'hop probe' }) } }),
      sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 6, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } }),
    )
    return parts.join('')
  }
  parts.push(
    sse({ type: 'response.output_text.delta', delta: opts.text }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: opts.text }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_fx', usage: { input_tokens: 6, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } } }),
  )
  return parts.join('')
}

function wantsToolRound(path: string, body: Body): boolean {
  const raw = JSON.stringify(body)
  if (path.endsWith('/responses')) {
    const input = (body.input as Array<Record<string, unknown>> | undefined) ?? []
    if (input.at(-1)?.type === 'function_call_output') return false
    return raw.includes('H1 ')
  }
  const messages = (body.messages as Array<Record<string, unknown>> | undefined) ?? []
  const last = messages.at(-1)
  if (last?.role === 'user' && JSON.stringify(last.content ?? '').includes('tool_result')) return false
  return raw.includes('H1 ')
}

const OPENAI_MODELS_BODY = {
  models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 272_000, input_modalities: ['text'], supported_in_api: true }],
}

const PORT = 35302
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
      res.end(JSON.stringify(path.startsWith('/openai/') ? OPENAI_MODELS_BODY : { object: 'list', data: [] }))
      return
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      captured.push({ path, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSseTurn(wantsToolRound(path, body) ? { tool: true, text: 'Home-lane probing.' } : { tool: false, text: 'settled on the home lane' }))
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      captured.push({ path, body, at: Date.now() })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(responsesSseTurn(wantsToolRound(path, body) ? { tool: true, text: '' } : { tool: false, text: 'settled on the responses lane' }))
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
})

console.log('============================================================')
console.log(' the responses-state hop — provider state out and back')
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
type Message = import('../../src/types/message.ts').Message

function makeCtx(model: string): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
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
}

async function driveTurn(history: Message[], model: string): Promise<{ settled: Message[]; requests: Captured[]; terminal: Record<string, unknown>; threw: unknown }> {
  const before = captured.length
  const settled: Message[] = []
  let terminal: Record<string, unknown> = {}
  let threw: unknown
  try {
    const gen = queryEvents({
      messages: history as never,
      systemPrompt: ['hop adversary rig prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async (_t: unknown, input: Record<string, unknown>) =>
        ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never,
      toolUseContext: makeCtx(model) as never,
      querySource: 'sdk' as never,
    })
    let r = await gen.next()
    while (!r.done) {
      const ev = r.value as { kind?: string; message?: Message }
      if ((ev.kind === 'assistant_settled' || ev.kind === 'tool_settled') && ev.message) settled.push(ev.message)
      r = await gen.next()
    }
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error
  }
  return { settled, requests: captured.slice(before), terminal, threw }
}

const raw = (b: Body): string => JSON.stringify(b)

// ── Leg 1: Responses state out and back ────────────────────────────────────
section('leg 1 · gpt → claude → gpt (reasoning items out and back)')
{
  let history: Message[] = [createUserMessage({ content: 'H1 run the hop probe' }) as Message]
  const t1 = await driveTurn(history, 'gpt-5.6-sol')
  check('T1 (gpt) settled clean over a tool round', t1.threw === undefined && t1.terminal.reason === 'completed' && t1.requests.length >= 2, `threw=${String(t1.threw)} rounds=${t1.requests.length}`)
  const round2 = t1.requests.at(-1)
  if (round2) {
    const items = (round2.body.input as Array<Record<string, unknown>> | undefined) ?? []
    const reasoningAt = items.findIndex(i => i.type === 'reasoning')
    const callAt = items.findIndex(i => i.type === 'function_call')
    const outputAt = items.findIndex(i => i.type === 'function_call_output')
    check('the WITHIN-TURN continuation replays the reasoning item with its encrypted content, in position (before its call)', reasoningAt !== -1 && callAt !== -1 && outputAt === callAt + 1 && reasoningAt < callAt && raw(round2.body).includes(ENC_NEEDLE), items.map(i => String(i.type)).join(','))
    check('the continuation stays stateless (store:false, no previous_response_id)', round2.body.store === false && !('previous_response_id' in round2.body))
  }

  history = [...history, ...t1.settled, createUserMessage({ content: 'H2 hop to the home lane' }) as Message]
  const t2 = await driveTurn(history, 'claude-sonnet-5')
  const t2main = t2.requests.find(r => raw(r.body).includes('H2 '))
  check('T2 (claude) settled clean', t2.threw === undefined && t2.terminal.reason === 'completed' && t2main !== undefined, `threw=${String(t2.threw)}`)
  if (t2main) {
    const b = raw(t2main.body)
    check('the hop-out body carries NO Responses state (no reasoning item, no encrypted content, no rs_ id)', !b.includes('"reasoning"') && !b.includes(ENC_NEEDLE) && !b.includes(REASONING_ID), b.slice(0, 400))
    check("T1's tool pair converted to tool_use/tool_result with the call id preserved", b.includes('"tool_use"') && b.includes('"tool_result"') && b.includes('call_hop_'), 'pair or id missing')
    check('the reasoning SUMMARY text does not leak as visible content either', !b.includes('hop reasoning summary'))
  }

  history = [...history, ...t2.settled, createUserMessage({ content: 'H3 hop back out' }) as Message]
  const t3 = await driveTurn(history, 'gpt-5.6-sol')
  const t3main = t3.requests.find(r => raw(r.body).includes('H3 '))
  check('T3 (gpt again) settled clean — the return hop dispatches', t3.threw === undefined && t3.terminal.reason === 'completed' && t3main !== undefined, `threw=${String(t3.threw)} terminal=${JSON.stringify(t3.terminal)}`)
  if (t3main) {
    const items = (t3main.body.input as Array<Record<string, unknown>> | undefined) ?? []
    const KNOWN = new Set(['message', 'function_call', 'function_call_output', 'reasoning'])
    check('every replayed item is a known Responses type (nothing malformed rides back)', items.every(i => KNOWN.has(String(i.type))), items.map(i => String(i.type)).join(','))
    const openCalls = items.filter(i => i.type === 'function_call').map(i => String(i.call_id))
    const answered = items.filter(i => i.type === 'function_call_output').map(i => String(i.call_id))
    check('every function_call is answered on the return hop (id-paired)', openCalls.length > 0 && openCalls.every(id => answered.includes(id)), `calls=${openCalls.join(',')} answered=${answered.join(',')}`)
    check('the return hop stays stateless (store:false, no previous_response_id)', t3main.body.store === false && !('previous_response_id' in t3main.body))
    const survived = raw(t3main.body).includes(ENC_NEEDLE)
    const reasoningItems = items.filter(i => i.type === 'reasoning').length
    note(`reasoning survival on the return hop: encrypted_content ${survived ? 'REPLAYS' : 'does NOT replay'} · ${reasoningItems} reasoning item(s) in the replay`)
    check("the claude-served middle turn rides back as plain content (its text present)", raw(t3main.body).includes('settled on the home lane'))
  }
}

// ── Leg 2: Anthropic thinking out and back ─────────────────────────────────
section('leg 2 · claude → gpt → claude (signed thinking out and back)')
{
  let history: Message[] = [createUserMessage({ content: 'H1 run the hop probe' }) as Message]
  const t1 = await driveTurn(history, 'claude-sonnet-5')
  check('T1 (claude) settled clean over a tool round', t1.threw === undefined && t1.terminal.reason === 'completed' && t1.requests.length >= 2, `threw=${String(t1.threw)} rounds=${t1.requests.length}`)
  const round2 = t1.requests.at(-1)
  if (round2) {
    const b = raw(round2.body)
    const signedPresent = b.includes(SIG_NEEDLE)
    note(`within-turn continuation: the signed thinking block ${signedPresent ? 'REPLAYS on the home wire' : 'does NOT replay (thinking disabled run)'}`)
    check('the continuation never carries an UNSIGNED thinking block', !b.includes('"signature":""'))
  }

  history = [...history, ...t1.settled, createUserMessage({ content: 'H2 hop out to gpt' }) as Message]
  const t2 = await driveTurn(history, 'gpt-5.6-sol')
  const t2main = t2.requests.find(r => raw(r.body).includes('H2 '))
  check('T2 (gpt) settled clean', t2.threw === undefined && t2.terminal.reason === 'completed' && t2main !== undefined, `threw=${String(t2.threw)}`)
  if (t2main) {
    const b = raw(t2main.body)
    check('NO thinking text and NO signature leak onto the Responses wire', !b.includes(THINK_NEEDLE) && !b.includes(SIG_NEEDLE), b.slice(0, 300))
    check("T1's tool pair rides as function_call/function_call_output with the id preserved", b.includes('"function_call"') && b.includes('"function_call_output"') && b.includes('toolu_hop_'))
  }

  history = [...history, ...t2.settled, createUserMessage({ content: 'H3 hop home again' }) as Message]
  const t3 = await driveTurn(history, 'claude-sonnet-5')
  const t3main = t3.requests.find(r => raw(r.body).includes('H3 '))
  check('T3 (claude again) settled clean — the return hop dispatches', t3.threw === undefined && t3.terminal.reason === 'completed' && t3main !== undefined, `threw=${String(t3.threw)}`)
  if (t3main) {
    const b = raw(t3main.body)
    check('the return home never carries an unsigned thinking block', !b.includes('"signature":""'))
    check('no Responses reasoning state contaminates the home wire', !b.includes(ENC_NEEDLE) && !b.includes('"reasoning"'))
    const thinkingSurvived = b.includes(SIG_NEEDLE)
    note(`thinking survival on the return home: the T1 signed block ${thinkingSurvived ? 'REPLAYS' : 'does NOT replay'}`)
    check('both tool pairs (home-born and gpt-born) ride whole and paired', b.includes('toolu_hop_') && b.includes('"tool_use"') && b.includes('"tool_result"') && b.includes('hop-ok'))
  }
}

const ledgerPath = join(process.env.MERCURY_CONFIG_DIR!, 'switch-hop-ledger.json')
writeFileSync(ledgerPath, JSON.stringify({ captured }, null, 2))
console.log(`\n  ledger: ${ledgerPath} (${captured.length} captured bodies)`)

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
