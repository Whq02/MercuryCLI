#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-switched-dispatch-parity.ts — the switch
//  wedge's pre-wire half, attacked at the ENGINE seam: after a GPT→Opus
//  mid-session switch, does the turn engine DISPATCH at all, and does the
//  outbound request — HEADERS AND OPTIONS included, not just the body —
//  byte-match a fresh session's?
//
//  Lane R's prove-switched-request-shape pinned the CONVERSION legal at the
//  routedCallModel layer (body shape only). The recurrence
//  plus the operator's controlled experiment — a FRESH Opus
//  session works in the same minute — narrows the wedge to SESSION-CARRIED
//  state. This prover drives the FULL runEventCore engine (production deps,
//  real provider router, real Anthropic client, loopback wire) over the
//  rebuilt incident transcript and a fresh-born one, and pins:
//
//    §A dispatch FIRES post-switch: the engine emits model_call_started and
//       the loopback receives the request within the drive
//    §B header parity: the switched request's header NAMES and load-bearing
//       VALUES (anthropic-version · anthropic-beta · content-type · accept ·
//       authorization) are IDENTICAL to the fresh session's
//    §C body option parity: model · stream · max_tokens · thinking ·
//       temperature · metadata keys · tool names · system block count and
//       cache_control placement all match
//    §D both drives settle end_turn (no engine-side park on either path)
//
//  A §A failure is the incident's pre-wire smoking gun; §B/§C failures name
//  the exact session-carried divergence the shape diff could not see.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-switched-dispatch-parity.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
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
  console.log('\nTIMEOUT — switched dispatch parity prover exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switched-dispatch-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Body = Record<string, unknown>
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const anthropicSse = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')

type Capture = { body: Body; headers: Record<string, string>; at: number }
const captured: Capture[] = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v ?? '')
      }
      try {
        captured.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body, headers, at: Date.now() })
      } catch {
        captured.push({ body: {}, headers, at: Date.now() })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(anthropicSse())
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
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
})

console.log('============================================================')
console.log(' switched dispatch parity — the ENGINE seam, headers included')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryEvents } = await import('../../src/query.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage, createUserInterruptionMessage } = await import(
  '../../src/utils/messages.ts'
)
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
type Message = import('../../src/types/message.ts').Message

const BASH = BashTool.name

function turn(model: string, blocks: unknown[], stopReason: string | null): Message {
  const m = createAssistantMessage({ content: blocks as never })
  m.message.model = model
  ;(m.message as { stop_reason: string | null }).stop_reason = stopReason as never
  return m as Message
}
const switchBreadcrumb = (): Message =>
  createUserMessage({
    content:
      '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-opus-5</command-args>',
    isMeta: true,
  }) as Message

/** The incident transcript class (prove-switched-request-shape's builder):
 *  settled GPT turns, a recordless stopped turn, the interrupt line, the
 *  /model breadcrumb, the pickup ask. */
function switchedHistory(): Message[] {
  return [
    createUserMessage({ content: 'plan the apollo migration' }) as Message,
    turn('gpt-5.6-sol', [
      { type: 'thinking', thinking: 'sol summary: inspect first', signature: '' },
      { type: 'text', text: 'Looking at the services.', citations: null },
      { type: 'tool_use', id: 'call_1', name: BASH, input: { command: 'ls services/' } },
    ], 'tool_use'),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'auth\nbilling' }] as never }) as Message,
    turn('gpt-5.6-sol', [
      { type: 'text', text: 'The plan takes shape: auth first, then billing.', citations: null },
    ], 'end_turn'),
    createUserMessage({ content: 'write the plan document now' }) as Message,
    createUserInterruptionMessage({ toolUse: false }) as Message,
    switchBreadcrumb(),
    createUserMessage({ content: 'DRIVE-MARK pick up from gpt pls' }) as Message,
  ]
}

/** A fresh Opus session asking the same thing with no history behind it. */
function freshHistory(): Message[] {
  return [createUserMessage({ content: 'DRIVE-MARK pick up from gpt pls' }) as Message]
}

function makeCtx(): Record<string, unknown> {
  let appState: Record<string, unknown> = {
    ...(getDefaultAppState() as unknown as Record<string, unknown>),
    effortValue: 'high',
  }
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      tools: [BashTool],
      mainLoopModel: 'claude-opus-5',
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
  events: string[]
  terminal: Record<string, unknown>
  request: Capture | undefined
  dispatchedAt: number | undefined
  threw: unknown
}

async function drive(history: Message[]): Promise<Drive> {
  const before = captured.length
  const events: string[] = []
  let terminal: Record<string, unknown> = {}
  let dispatchedAt: number | undefined
  let threw: unknown
  try {
    const gen = queryEvents({
      messages: history as never,
      systemPrompt: ['rig system prompt'] as never,
      userContext: {},
      systemContext: {},
      canUseTool: (async (_t: unknown, input: Record<string, unknown>) =>
        ({ behavior: 'allow', updatedInput: input, decisionReason: { type: 'other', reason: 'rig' } })) as never,
      toolUseContext: makeCtx() as never,
      querySource: 'sdk' as never,
    })
    let r = await gen.next()
    while (!r.done) {
      const kind = (r.value as { kind?: string }).kind ?? '?'
      events.push(kind)
      if (kind === 'model_call_started' && dispatchedAt === undefined) dispatchedAt = Date.now()
      r = await gen.next()
    }
    terminal = r.value as Record<string, unknown>
  } catch (error) {
    threw = error
  }
  // The MAIN request: the one carrying the drive marker (service side calls
  // never carry it).
  const request = captured
    .slice(before)
    .find(c => JSON.stringify(c.body).includes('DRIVE-MARK'))
  return { events, terminal, request, dispatchedAt, threw }
}

const switched = await drive(switchedHistory())
const fresh = await drive(freshHistory())

// ── §A ──────────────────────────────────────────────────────────────────────
section('§A dispatch fires post-switch — the engine seam AND the wire')
check('the switched drive threw nothing', switched.threw === undefined, String(switched.threw))
check(
  'the engine DISPATCHED: model_call_started emitted on the switched run',
  switched.events.includes('model_call_started'),
  switched.events.slice(0, 12).join('→'),
)
check('the model permit was granted (no capacity park)', switched.events.includes('model_permit'))
check('the switched request REACHED the wire', switched.request !== undefined)
check('the fresh request reached the wire (control)', fresh.request !== undefined)

// ── §B ──────────────────────────────────────────────────────────────────────
section('§B header parity — names and load-bearing values')
if (switched.request && fresh.request) {
  // Volatile per-request entries excluded from the NAME diff.
  const VOLATILE = new Set([
    'content-length',
    'x-stainless-retry-count',
    'request-id',
    'x-request-id',
    'traceparent',
    'x-stainless-timeout',
    'connection',
    'host',
  ])
  const names = (c: Capture): string =>
    Object.keys(c.headers)
      .filter(k => !VOLATILE.has(k))
      .sort()
      .join(',')
  check(
    'header NAME sets are identical (no switched-only header)',
    names(switched.request) === names(fresh.request),
    `switched={${names(switched.request)}} fresh={${names(fresh.request)}}`,
  )
  for (const k of ['anthropic-version', 'anthropic-beta', 'content-type', 'accept', 'authorization', 'user-agent']) {
    const s = switched.request.headers[k]
    const f = fresh.request.headers[k]
    check(`'${k}' value matches (${s === undefined ? 'absent on both' : 'present'})`, s === f, `switched='${s}' fresh='${f}'`)
  }
}

// ── §C ──────────────────────────────────────────────────────────────────────
section('§C body option parity — everything except the history itself')
if (switched.request && fresh.request) {
  const s = switched.request.body
  const f = fresh.request.body
  const sKeys = Object.keys(s).sort().join(',')
  const fKeys = Object.keys(f).sort().join(',')
  check('top-level key sets are identical', sKeys === fKeys, `switched={${sKeys}} fresh={${fKeys}}`)
  for (const k of ['model', 'stream', 'max_tokens', 'temperature']) {
    check(`'${k}' matches`, JSON.stringify(s[k]) === JSON.stringify(f[k]), `switched=${JSON.stringify(s[k])} fresh=${JSON.stringify(f[k])}`)
  }
  check(
    "'thinking' matches (both absent or both equal)",
    JSON.stringify(s.thinking) === JSON.stringify(f.thinking),
    `switched=${JSON.stringify(s.thinking)} fresh=${JSON.stringify(f.thinking)}`,
  )
  const metaKeys = (b: Body): string => Object.keys((b.metadata as object) ?? {}).sort().join(',')
  check('metadata key sets match', metaKeys(s) === metaKeys(f), `switched={${metaKeys(s)}} fresh={${metaKeys(f)}}`)
  const toolNames = (b: Body): string =>
    ((b.tools as Array<{ name?: string }> | undefined) ?? []).map(t => String(t.name)).sort().join(',')
  check('tool catalogues match', toolNames(s) === toolNames(f), `switched={${toolNames(s)}} fresh={${toolNames(f)}}`)
  const systemShape = (b: Body): string => {
    const sys = (b.system as Array<Record<string, unknown>> | undefined) ?? []
    return sys.map(blk => `${String(blk.type)}${blk.cache_control ? '+cc' : ''}`).join('|')
  }
  check('system block count + cache_control placement match', systemShape(s) === systemShape(f), `switched=${systemShape(s)} fresh=${systemShape(f)}`)
  const lastMessageCc = (b: Body): string => {
    const msgs = (b.messages as Array<{ content?: unknown }> | undefined) ?? []
    let marks = 0
    for (const m of msgs) {
      if (!Array.isArray(m.content)) continue
      for (const blk of m.content as Array<Record<string, unknown>>) if (blk.cache_control) marks++
    }
    return String(marks)
  }
  check(
    'message-side cache_control mark COUNT matches',
    lastMessageCc(s) === lastMessageCc(f),
    `switched=${lastMessageCc(s)} fresh=${lastMessageCc(f)}`,
  )
}

// ── §D ──────────────────────────────────────────────────────────────────────
section('§D both drives settle — no engine-side park on either path')
check('switched terminal: completed', switched.terminal.reason === 'completed', JSON.stringify(switched.terminal))
check('fresh terminal: completed', fresh.terminal.reason === 'completed', JSON.stringify(fresh.terminal))
check(
  'the switched event ladder ran whole (run_started→…→run_terminal)',
  switched.events[0] === 'run_started' && switched.events.at(-1) === 'run_terminal',
  switched.events.join('→'),
)

server.close()
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
