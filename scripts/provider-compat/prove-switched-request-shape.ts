#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-switched-request-shape.ts — the incident's
//  remaining suspect, attacked head-on: does the GPT→Anthropic conversion
//  emit ANY request shape a native conversation would not?
//
//  The wedge: a switched request authenticated, was accepted,
//  then produced ZERO events for 92s — on a 165 KB session GPT answered in
//  5s. With credentials ruled out (empirically) and cold-ingest weakened,
//  the leading theories are a black-holed connection or a REQUEST SHAPE the
//  server accepts-then-parks. This prover rebuilds the exact incident
//  transcript class — settled GPT turns (unsigned thinking, tool rounds),
//  a RECORDLESS interrupted partial (stop_reason null: the cancel path
//  never reaches the finish write-back), the operator interrupt line, the
//  /model switch breadcrumb, the pickup ask — runs it through the REAL
//  conversion (routedCallModel → the anthropic encoders), and structurally
//  DIFFS the captured wire body against a native-born conversation's body
//  under the same harness inputs (catalogue-level constants cancel out).
//
//    §A both requests capture and settle on the loopback
//    §B top-level key sets are IDENTICAL (no switched-only field)
//    §C the switched request's block-shape vocabulary ⊆ the native
//       vocabulary plus the two EXPLICITLY-ALLOWED extras (the interrupt
//       text, the healed synthetic tool_result) — nothing anomalous rides
//    §D no degenerate shapes anywhere in the switched body: no empty text,
//       no content:[], no thinking of any kind, no null-valued fields the
//       native body lacks, legal role alternation, paired tool ids
//    §E the shape digest is printed for the receipt/diff record
//
//  A FAIL here is the incident's smoking gun; a PASS pins the conversion
//  clean and moves the weight onto the transport (dead connection) theory.
//
//  Run: ~/.bun/bin/bun run scripts/provider-compat/prove-switched-request-shape.ts
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

delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'switched-shape-'))
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

const captured: Array<{ body: Body }> = []
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      try {
        captured.push({ body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body })
      } catch {
        captured.push({ body: {} })
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
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
})

console.log('============================================================')
console.log(' switched-request shape — the conversion, diffed against native')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage, createAssistantMessage, createUserInterruptionMessage } = await import('../../src/utils/messages.ts')
const { BashTool } = await import('../../src/tools/BashTool/BashTool.tsx')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
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

/** The incident class, GPT-born: settled turns with unsigned thinking +
 *  tool rounds; the STOPPED turn is RECORDLESS BY DESIGN (the cancel path
 *  never reaches the finish write-back — the lead's excerpt confirms no
 *  output record exists), so the tail is settled-assistant → the operator
 *  prompt that started the stopped turn → the interrupt line → the /model
 *  breadcrumb → the pickup ask (four user rows the normalizer must carry
 *  legally). */
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
    // …the turn this started was stopped and persisted NOTHING.
    createUserInterruptionMessage({ toolUse: false }) as Message,
    switchBreadcrumb(),
    createUserMessage({ content: 'pick up from gpt pls' }) as Message,
  ]
}

/** The same conversation born native (claude turns, signed thinking). */
function nativeHistory(): Message[] {
  return [
    createUserMessage({ content: 'plan the apollo migration' }) as Message,
    turn('claude-opus-5', [
      { type: 'thinking', thinking: 'inspect first', signature: 'sig-native-1' },
      { type: 'text', text: 'Looking at the services.', citations: null },
      { type: 'tool_use', id: 'toolu_1', name: BASH, input: { command: 'ls services/' } },
    ], 'tool_use'),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'auth\nbilling' }] as never }) as Message,
    turn('claude-opus-5', [
      { type: 'text', text: 'The plan takes shape: auth first, then billing.', citations: null },
    ], 'end_turn'),
    createUserMessage({ content: 'write the plan document now' }) as Message,
    createUserInterruptionMessage({ toolUse: false }) as Message,
    switchBreadcrumb(),
    createUserMessage({ content: 'pick up where you left off pls' }) as Message,
  ]
}

async function drive(history: Message[]): Promise<{ body: Body; threw: unknown; settled: boolean }> {
  const before = captured.length
  let threw: unknown
  const assistants: AssistantMessage[] = []
  try {
    for await (const item of routedCallModel({
      messages: history as never,
      systemPrompt: ['fixture system prompt'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [BashTool] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'claude-opus-5',
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'high',
      } as never,
    })) {
      const a = item as AssistantMessage
      if (a.type === 'assistant' && !a.isApiErrorMessage) assistants.push(a)
    }
  } catch (error) {
    threw = error
  }
  const settled = assistants.at(-1)?.message.stop_reason === 'end_turn'
  return { body: captured.slice(before).at(-1)?.body ?? {}, threw, settled }
}

// --- the shape vocabulary ---------------------------------------------------
type Shape = string
function shapeOfValue(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length === 0 ? 'array:EMPTY' : 'array'
  if (typeof v === 'object') return Object.keys(v as object).length === 0 ? 'object:EMPTY' : 'object'
  if (typeof v === 'string') return v.length === 0 ? 'string:EMPTY' : 'string'
  return typeof v
}
function blockShapes(body: Body): Set<Shape> {
  const out = new Set<Shape>()
  const messages = (body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.add(`${m.role}/plainstring${m.content.length === 0 ? ':EMPTY' : ''}`)
      continue
    }
    if (!Array.isArray(m.content)) {
      out.add(`${m.role}/content=${shapeOfValue(m.content)}`)
      continue
    }
    if (m.content.length === 0) out.add(`${m.role}/content:EMPTYARRAY`)
    for (const raw of m.content as Array<Record<string, unknown>>) {
      const type = String(raw.type ?? 'UNTYPED')
      const keys = Object.keys(raw).sort()
      const facts = keys.map(k => `${k}=${shapeOfValue(raw[k])}`).join(',')
      out.add(`${m.role}/${type}{${facts}}`)
    }
  }
  return out
}
function degenerates(body: Body): string[] {
  const out: string[] = []
  const text = JSON.stringify(body)
  const messages = (body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
  let previousRole = ''
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === previousRole) out.push(`role repeat at ${i} (${m.role})`)
    previousRole = m.role
    if (Array.isArray(m.content)) {
      if (m.content.length === 0) out.push(`content:[] at ${i}`)
      for (const raw of m.content as Array<Record<string, unknown>>) {
        if (raw.type === 'text' && String(raw.text ?? '').length === 0) out.push(`empty text at ${i}`)
        if (raw.type === 'thinking' || raw.type === 'redacted_thinking') out.push(`thinking rode the switched wire at ${i}`)
        if (raw.type === 'tool_use' && shapeOfValue(raw.input) === 'object:EMPTY') out.push(`empty tool_use.input at ${i}`)
      }
    }
  }
  if (text.includes('"signature":""')) out.push('empty signature in body')
  return out
}

// ============================================================================
section('§A both requests capture and settle')
// ============================================================================
const switched = await drive(switchedHistory())
const native = await drive(nativeHistory())
check('the SWITCHED request dispatched and the turn settled', switched.threw === undefined && switched.settled && Object.keys(switched.body).length > 0, `threw=${String(switched.threw)}`)
check('the NATIVE request dispatched and the turn settled', native.threw === undefined && native.settled && Object.keys(native.body).length > 0, `threw=${String(native.threw)}`)

// ============================================================================
section('§B top-level key parity')
// ============================================================================
{
  const sKeys = Object.keys(switched.body).sort().join(',')
  const nKeys = Object.keys(native.body).sort().join(',')
  check('top-level key sets are IDENTICAL (no switched-only field)', sKeys === nKeys, `switched={${sKeys}} native={${nKeys}}`)
  check('system block shape matches (count + kinds)', JSON.stringify((switched.body.system as unknown[])?.length) === JSON.stringify((native.body.system as unknown[])?.length))
  check('model and stream flags match', switched.body.model === native.body.model && switched.body.stream === native.body.stream)
}

// ============================================================================
section('§C the block-shape vocabulary — switched ⊆ native + allowed extras')
// ============================================================================
{
  const switchedShapes = blockShapes(switched.body)
  const nativeShapes = blockShapes(native.body)
  // Both histories carry the same interrupt/breadcrumb/pickup rows, so a
  // switched conversation is granted NO extra shapes at all.
  const extras = [...switchedShapes].filter(s => !nativeShapes.has(s))
  check(
    'no switched-only block shape exists (the conversion invents NOTHING)',
    extras.length === 0,
    `switched-only shapes: ${extras.join(' | ')}`,
  )
}

// ============================================================================
section('§D degenerate-shape scan of the switched body')
// ============================================================================
{
  const found = degenerates(switched.body)
  check('no degenerate shapes ride the switched wire', found.length === 0, found.join(' | '))
  const messages = (switched.body.messages as Array<{ role: string; content: unknown }> | undefined) ?? []
  const useIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const raw of m.content as Array<Record<string, unknown>>) {
      if (raw.type === 'tool_use') useIds.add(String(raw.id))
      if (raw.type === 'tool_result') resultIds.add(String(raw.tool_use_id))
    }
  }
  check('every tool id pairs both ways', [...useIds].every(id => resultIds.has(id)) && [...resultIds].every(id => useIds.has(id)), `uses=${[...useIds].join(',')} results=${[...resultIds].join(',')}`)
  check('the stopped turn\'s PROMPT survives (its partial is recordless by design)', JSON.stringify(switched.body).includes('write the plan document now'))
  check('the interrupt line and the pickup ask ride as ordinary user text', JSON.stringify(switched.body).includes('[Request interrupted by user]') && JSON.stringify(switched.body).includes('pick up from gpt pls'))
}

// ============================================================================
section('§E the shape digest (for the receipt)')
// ============================================================================
{
  const shapes = [...blockShapes(switched.body)].sort()
  console.log('  switched-request block vocabulary:')
  for (const s of shapes) console.log(`    · ${s}`)
  const messages = (switched.body.messages as unknown[] | undefined) ?? []
  console.log(`  · messages=${messages.length} bytes=${JSON.stringify(switched.body).length}`)
  check('digest printed', shapes.length > 0)
}

server.close()
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
