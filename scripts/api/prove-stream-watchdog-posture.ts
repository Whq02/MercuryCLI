#!/usr/bin/env bun
// ============================================================================
//  scripts/api/prove-stream-watchdog-posture.ts — the idle watchdog's
//  per-cause retry posture, proven on a silent loopback fixture.
//
//  The incident: a switched session sat on "thinking" for 90s,
//  then one blanket rung — "retrying without streaming" — with no word about
//  where the silence came from. The posture now discriminates:
//
//    A  PRE-FIRST-EVENT silence (headers arrived, zero SSE events): one
//       STREAMING reissue first — zero events were consumed, so the reissue
//       is invisible, keeps the seat live, and rides the cache the first
//       attempt warmed. The notice states the wait is provider-side.
//    B  Pre-first-event silence that PERSISTS across the reissue: the
//       non-streaming recovery of last resort, with the cause in the notice.
//    C  MID-STREAM silence (events flowed, then quiet): no reissue — the
//       connection likely dropped; straight to non-streaming, the notice
//       names the event count and the cause.
//    D  Mid-stream silence AFTER a tool_use streamed: NO fallback at all
//       (re-issuing would double-run the tool — the inc-4258 veto); the
//       error surfaces typed.
//
//  MERCURY_STREAM_IDLE_TIMEOUT_MS shrinks the budget to prover scale.
//
//  Run: ~/.bun/bin/bun run scripts/api/prove-stream-watchdog-posture.ts
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
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'watchdog-posture-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1200'
process.env.MERCURY_MAX_RETRIES = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const fullSse = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'recovered' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
    `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })}`,
    `event: message_stop\n${sse({ type: 'message_stop' })}`,
  ].join('')
/** message_start + an open text block + one delta — then silence. */
const midStreamThenSilence = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half a thought…' } })}`,
  ].join('')
/** A COMPLETE local tool_use block — then silence (the inc-4258 shape). */
const toolUseThenSilence = (): string =>
  [
    `event: message_start\n${sse({ type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
    `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_wd', name: 'Bash', input: {} } })}`,
    `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } })}`,
    `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
  ].join('')
const nonStreamingBody = (): string =>
  JSON.stringify({ id: 'msg_ns', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'recovered without streaming' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } })

type StreamPlan = 'silent' | 'full' | 'mid-stream' | 'tool-then-silence'
let plan: StreamPlan[] = []
let planIndex = 0
const seen: Array<{ streaming: boolean; served: string }> = []
const holds = new Set<ServerResponse>()
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch {
      body = {}
    }
    if (body.stream !== true) {
      seen.push({ streaming: false, served: 'non-streaming' })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(nonStreamingBody())
      return
    }
    const step = plan[planIndex] ?? 'full'
    planIndex++
    seen.push({ streaming: true, served: step })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (step === 'full') {
      res.end(fullSse())
    } else if (step === 'mid-stream') {
      res.write(midStreamThenSilence())
      holds.add(res) // socket stays open, no further bytes
    } else if (step === 'tool-then-silence') {
      res.write(toolUseThenSilence())
      holds.add(res)
    } else {
      // Node buffers headers until the first body write — flush them so the
      // client sees a LIVE stream that then stays silent (the incident
      // shape; unflushed headers would instead exercise the SDK's own
      // request timeout, a different budget).
      res.flushHeaders()
      holds.add(res) // headers only — total silence
    }
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
console.log(' stream watchdog posture — per-cause recovery, stated causes')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

const text = (v: unknown): string => JSON.stringify(v) ?? ''

async function drive(): Promise<{ last: AssistantMessage | undefined; notices: string[]; threw: unknown; wallMs: number }> {
  const assistants: AssistantMessage[] = []
  const notices: string[] = []
  let threw: unknown
  const t0 = performance.now()
  try {
    for await (const item of routedCallModel({
      messages: [createUserMessage({ content: 'go' })] as never,
      systemPrompt: ['fixture'] as never,
      thinkingConfig: { type: 'disabled' } as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: 'claude-sonnet-5',
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'high',
      } as never,
    })) {
      const typed = item as { type?: string }
      if (typed.type === 'assistant') {
        const a = item as AssistantMessage
        if (a.isApiErrorMessage) notices.push(text(a.message.content))
        else assistants.push(a)
      }
      if (typed.type === 'system') notices.push(text(item))
    }
  } catch (error) {
    threw = error
  }
  return {
    last: assistants.at(-1),
    notices,
    threw,
    wallMs: performance.now() - t0,
  }
}

function resetFixture(nextPlan: StreamPlan[]): void {
  plan = nextPlan
  planIndex = 0
  seen.length = 0
  for (const r of holds) r.end()
  holds.clear()
}

// ============================================================================
section('A · pre-first-event silence → ONE streaming reissue heals the turn')
// ============================================================================
{
  resetFixture(['silent', 'full'])
  const o = await drive()
  check('the turn settled end_turn after the reissue', o.threw === undefined && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)} notices=${o.notices.join('|').slice(0, 300)}`)
  check('exactly TWO streaming requests, NO non-streaming request', seen.filter(s => s.streaming).length === 2 && seen.every(s => s.streaming), text(seen))
  check('the reissue notice states the cause and the action', o.notices.some(n => n.includes('no stream events within') && n.includes('reissuing the stream')), o.notices.join('|').slice(0, 300))
  check('the wait was ~one budget, not two (the reissue is prompt)', o.wallMs > 1_100 && o.wallMs < 4_000, `${o.wallMs.toFixed(0)}ms`)
}

// ============================================================================
section('B · silence persists across the reissue → non-streaming last resort')
// ============================================================================
{
  resetFixture(['silent', 'silent'])
  const o = await drive()
  check('the turn settled via the non-streaming fallback', o.threw === undefined && o.last?.message.stop_reason === 'end_turn' && text(o.last?.message.content).includes('recovered without streaming'), `threw=${String(o.threw)}`)
  check('two streaming attempts, then exactly one non-streaming request', seen.filter(s => s.streaming).length === 2 && seen.filter(s => !s.streaming).length === 1, text(seen))
  check('the last-resort notice names the persisted pre-event cause AND the wait ceiling', o.notices.some(n => n.includes('no first event, TWICE') && n.includes('waiting up to') && n.includes('esc abandons it')), o.notices.join('|').slice(0, 400))
}

// ============================================================================
section('C · mid-stream silence → NO reissue; non-streaming names the cause')
// ============================================================================
{
  resetFixture(['mid-stream'])
  const o = await drive()
  check('the turn settled via the non-streaming fallback', o.threw === undefined && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)}`)
  check('ONE streaming attempt only (mid-stream silence never reissues a stream)', seen.filter(s => s.streaming).length === 1 && seen.filter(s => !s.streaming).length === 1, text(seen))
  check('the notice names mid-stream silence, the event count, the likely cause, and the wait ceiling', o.notices.some(n => n.includes('mid-stream silence') && n.includes('event(s) arrived') && n.includes('connection likely dropped') && n.includes('waiting up to')), o.notices.join('|').slice(0, 400))
}

// ============================================================================
section('D · silence after a streamed tool_use → NO fallback (the double-run veto)')
// ============================================================================
{
  resetFixture(['tool-then-silence'])
  const o = await drive()
  check('no non-streaming request was made and no stream was reissued', seen.filter(s => s.streaming).length === 1 && seen.filter(s => !s.streaming).length === 0, text(seen))
  check('the failure surfaced typed (thrown or an API-error notice), never silence', o.threw !== undefined || o.notices.length > 0, `notices=${o.notices.length}`)
}

server.close()
for (const r of holds) r.end()
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
