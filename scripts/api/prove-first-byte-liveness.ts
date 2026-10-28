#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR ?? tmpdir(), 'first-byte-liveness-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

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
  console.log('\nTIMEOUT — the first-byte liveness proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const IDLE_MS = 1_500
const FENCE_MS = 300
const PING_EVERY_MS = 100
const THINK_BUDGETS = 7
const THINK_MS = IDLE_MS * THINK_BUDGETS
const MODEL = 'claude-sonnet-5'

type Plan = 'think' | 'no-headers' | 'full'
const plans: Plan[] = []
const seen: string[] = []
const holds = new Set<ServerResponse>()
const timers = new Set<ReturnType<typeof setInterval>>()
const sse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
const usage = { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 }
const head = (): string =>
  sse('message_start', { type: 'message_start', message: { id: 'msg_fx', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage } }) +
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
const ping = (): string => sse('ping', { type: 'ping' })
const tail = (): string =>
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }) +
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_fx' } }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }) +
  sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) +
  sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the answer after the long think' } }) +
  sse('content_block_stop', { type: 'content_block_stop', index: 1 }) +
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { ...usage, output_tokens: 9 } }) +
  sse('message_stop', { type: 'message_stop' })
const pingsSent: number[] = []

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  req.on('data', () => undefined)
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const plan = plans.shift() ?? 'full'
    seen.push(plan)
    if (plan === 'no-headers') {
      holds.add(res)
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (plan === 'full') {
      res.end(head() + tail())
      return
    }
    res.write(head())
    let sent = 0
    const started = Date.now()
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer)
        timers.delete(timer)
        return
      }
      sent++
      res.write(ping())
      if (Date.now() - started >= THINK_MS) {
        clearInterval(timer)
        timers.delete(timer)
        pingsSent.push(sent)
        res.end(tail())
      }
    }, PING_EVERY_MS)
    timers.add(timer)
  })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
Object.assign(process.env, {
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_STREAM_IDLE_TIMEOUT_MS: String(IDLE_MS),
  MERCURY_SILENT_AFTER_HEADERS_MS: String(FENCE_MS),
  MERCURY_MAX_RETRIES: '1',
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const idle = await import('../../src/services/providers/streamIdleBudget.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type SystemAPIErrorMessage = import('../../src/types/message.ts').SystemAPIErrorMessage

const warmHistory = (): unknown[] => {
  const earlier = createAssistantMessage({ content: [{ type: 'text', text: 'an earlier reply' }] } as never) as AssistantMessage
  ;(earlier.message as { model: string }).model = MODEL
  return [createUserMessage({ content: 'first' }), earlier, createUserMessage({ content: 'go' })]
}

async function drive(): Promise<{ last: AssistantMessage | undefined; notices: SystemAPIErrorMessage[]; errors: string[]; threw: unknown; wallMs: number; waits: unknown[] }> {
  const assistants: AssistantMessage[] = []
  const notices: SystemAPIErrorMessage[] = []
  const errors: string[] = []
  const waits: unknown[] = []
  let threw: unknown
  const t0 = performance.now()
  try {
    for await (const item of routedCallModel({
      messages: warmHistory() as never,
      systemPrompt: ['fixture'] as never,
      thinkingConfig: { type: 'enabled', budgetTokens: 1024 } as never,
      tools: [] as never,
      signal: new AbortController().signal,
      options: {
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        model: MODEL,
        isNonInteractiveSession: true,
        querySource: 'agent:builtin:test',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        effortValue: 'max',
        onWait: (wait: unknown) => waits.push(wait),
      } as never,
    })) {
      const typed = item as { type?: string; subtype?: string }
      if (typed.type === 'assistant') {
        const a = item as AssistantMessage
        if (a.isApiErrorMessage) errors.push(JSON.stringify(a.message.content))
        else assistants.push(a)
      }
      if (typed.type === 'system' && typed.subtype === 'api_error') notices.push(item as SystemAPIErrorMessage)
    }
  } catch (error) {
    threw = error
  }
  return { last: assistants.at(-1), notices, errors, threw, wallMs: performance.now() - t0, waits }
}
const noticeWords = (notices: SystemAPIErrorMessage[]): string => notices.map(n => n.error?.message ?? '').join(' | ')
const replyText = (m: AssistantMessage | undefined): string => (m?.message.content ?? []).map(b => (b as { type: string; text?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : '').join('')

section(`L1 · headers and message_start at once, then only ping events for ${THINK_BUDGETS} idle budgets, then the thinking's end and the reply: the turn completes, nothing is cut, nothing retried`)
{
  plans.push('think')
  seen.length = 0
  const o = await drive()
  check('the reply arrived whole after the long think and the turn settled end_turn', o.threw === undefined && o.errors.length === 0 && o.last?.message.stop_reason === 'end_turn' && replyText(o.last) === 'the answer after the long think', `threw=${String(o.threw)} errors=${o.errors.join('|').slice(0, 200)} text=${replyText(o.last)}`)
  check('exactly one request reached the edge: no reissue, no fallback', seen.join(',') === 'think', seen.join(','))
  check('no retry notice of any kind — the first-byte line never fired on a live stream', o.notices.length === 0, noticeWords(o.notices).slice(0, 300))
  check(`the edge sent pings for the whole think (${pingsSent[0] ?? 0} pings over ${THINK_MS} ms) and the turn lasted at least that long`, (pingsSent[0] ?? 0) >= THINK_BUDGETS * (IDLE_MS / PING_EVERY_MS) * 0.9 && o.wallMs >= THINK_MS, `${o.wallMs.toFixed(0)} ms`)
  const firstByteWaits = o.waits.filter(w => (w as { kind?: string } | null)?.kind === 'first-byte')
  const cleared = o.waits.some(w => w === null)
  check('the status row promised the first-byte budget once and cleared it when the headers landed', firstByteWaits.length === 1 && cleared, JSON.stringify(o.waits).slice(0, 200))
}

section('L2 · the edge accepts the request and never answers: the typed first-byte line fires once at the budget with its existing words, the retry is answered')
{
  plans.push('no-headers', 'full')
  seen.length = 0
  const o = await drive()
  const line = idle.firstByteTimeoutLine({ kind: 'first-byte', cold: false, promptTokens: 1, model: 'Sonnet 5', budgetMs: IDLE_MS, sinceMs: 0, attempt: 1 })
  check('the turn settled on the retry', o.threw === undefined && o.last?.message.stop_reason === 'end_turn', `threw=${String(o.threw)}`)
  check('two requests: the one that never answered, then the one that did', seen.join(',') === 'no-headers,full', seen.join(','))
  check(`exactly one notice, the typed line as it stands: ${JSON.stringify(line)}`, o.notices.length === 1 && noticeWords(o.notices) === line, noticeWords(o.notices).slice(0, 300))
  check('the notice carries no HTTP status: a transport wait, not a provider answer', o.notices[0]?.errorDetail?.status === undefined || o.notices[0]?.errorDetail?.status === null, JSON.stringify(o.notices[0]?.errorDetail ?? null).slice(0, 200))
  check('the budget fired at its number, not long after', o.wallMs >= IDLE_MS && o.wallMs < IDLE_MS * 4, `${o.wallMs.toFixed(0)} ms`)
  const retryWait = o.notices[0] !== undefined ? idle.retryNoticeWait(o.notices[0]) : null
  check('the status row reads the wait as a first-byte timeout', retryWait !== null && retryWait.reason === 'a first-byte timeout', retryWait !== null ? retryWait.reason : 'no notice')
}

for (const t of timers) clearInterval(t)
for (const r of holds) r.destroy()
server.closeAllConnections()
server.close()
console.log('\n' + '='.repeat(60))
console.log(` ${checks} checks, ${failures} failures`)
console.log('='.repeat(60))
process.exit(failures > 0 ? 1 : 0)
