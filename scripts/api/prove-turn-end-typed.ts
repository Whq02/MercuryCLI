#!/usr/bin/env bun
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
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'turn-end-typed-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_STREAM_IDLE_TIMEOUT_MS = '1500'
process.env.MERCURY_MAX_RETRIES = '1'
process.env.OPENAI_API_KEY = 'sk-test-turn-end-typed'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const BUDGET_MS = 1500

const guard = setTimeout(() => {
  console.log('\nTIMEOUT — the typed-end prover exceeded 180s')
  process.exit(1)
}, 180_000)
guard.unref?.()

const REPLY_TEXT = 'the reply stands here after its last item'
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const named = (event: string, obj: unknown): string => `event: ${event}\n${sse(obj)}`

type Arm = 'hold-after-settle' | 'close-after-settle' | 'hold-after-end' | 'mid-item-silence' | 'keepalive-after-settle' | 'complete'
let arm: Arm = 'complete'
let holdHeaders = false
const calls = { openai: 0, anthropic: 0 }
const holds = new Set<ServerResponse>()
const keepalives = new Set<ReturnType<typeof setInterval>>()

function responsesBody(res: ServerResponse): void {
  const rid = 'resp_typed'
  const itemId = 'msg_typed'
  res.write(sse({ type: 'response.created', response: { id: rid } }))
  res.write(sse({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', content: [] } }))
  res.write(sse({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: REPLY_TEXT.slice(0, 12) }))
  if (arm === 'mid-item-silence') {
    holds.add(res)
    return
  }
  res.write(sse({ type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: REPLY_TEXT.slice(12) }))
  res.write(sse({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: itemId, role: 'assistant', content: [{ type: 'output_text', text: REPLY_TEXT }] } }))
  const end = sse({ type: 'response.completed', response: { id: rid, usage: { input_tokens: 21, output_tokens: 9 } } })
  if (arm === 'close-after-settle') return void res.end()
  if (arm === 'hold-after-settle') return void holds.add(res)
  if (arm === 'keepalive-after-settle') {
    holds.add(res)
    const t = setInterval(() => {
      if (res.destroyed) return clearInterval(t)
      res.write(': keepalive\n\n')
    }, 100)
    keepalives.add(t)
    return
  }
  if (arm === 'hold-after-end') {
    res.write(end)
    holds.add(res)
    return
  }
  res.end(end)
}

function messagesBody(res: ServerResponse): void {
  res.write(named('message_start', { type: 'message_start', message: { id: 'msg_typed_a', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }))
  res.write(named('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
  res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY_TEXT.slice(0, 12) } }))
  if (arm === 'mid-item-silence') {
    holds.add(res)
    return
  }
  res.write(named('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY_TEXT.slice(12) } }))
  res.write(named('content_block_stop', { type: 'content_block_stop', index: 0 }))
  const end =
    named('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 21, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 } }) +
    named('message_stop', { type: 'message_stop' })
  if (arm === 'close-after-settle') return void res.end()
  if (arm === 'hold-after-settle') return void holds.add(res)
  if (arm === 'hold-after-end') {
    res.write(end)
    holds.add(res)
    return
  }
  res.end(end)
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', visibility: 'public', supported_in_api: true, priority: 1, context_window: 400_000, input_modalities: ['text', 'image'] }] }))
      return
    }
    if (req.method === 'POST' && path.endsWith('/responses')) {
      calls.openai++
      if (holdHeaders) {
        holds.add(res)
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      responsesBody(res)
      return
    }
    if (req.method === 'POST' && path.endsWith('/v1/messages')) {
      calls.anthropic++
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'msg_ns', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'reissued without streaming' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      messagesBody(res)
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
console.log(' the typed end — a turn ends on facts, on every road')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { isContinuableStreamFaultText } = await import('../../src/services/api/errors.ts')
const budget = await import('../../src/services/providers/streamIdleBudget.ts')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage

const textOf = (m: AssistantMessage | undefined): string => {
  const content = m?.message.content
  if (!Array.isArray(content)) return ''
  return content.map(b => ((b as { type?: string; text?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : '')).join('')
}

async function drive(model: string, nextArm: Arm): Promise<{ last: AssistantMessage | undefined; errors: string[]; wallMs: number; threw: unknown }> {
  arm = nextArm
  for (const res of holds) res.destroy()
  holds.clear()
  const assistants: AssistantMessage[] = []
  const errors: string[] = []
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
        model,
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
        if (a.isApiErrorMessage) errors.push(textOf(a))
        else assistants.push(a)
      }
      if (typed.type === 'system') errors.push(JSON.stringify(item))
    }
  } catch (error) {
    threw = error
  }
  return { last: assistants.at(-1), errors, wallMs: Math.round(performance.now() - t0), threw }
}

function pinTypedEnd(label: string, r: Awaited<ReturnType<typeof drive>>, reason: 'silent-after-last-item' | 'closed-after-last-item', provider: string): void {
  check(`${label}: the reply stands`, textOf(r.last) === REPLY_TEXT, `text=${JSON.stringify(textOf(r.last))} threw=${String(r.threw ?? '')}`)
  check(`${label}: settled as end_turn`, r.last?.message.stop_reason === 'end_turn', `stop_reason=${String(r.last?.message.stop_reason)}`)
  check(`${label}: the typed end names its reason`, r.last?.streamEnd?.reason === reason, `streamEnd=${JSON.stringify(r.last?.streamEnd)}`)
  check(`${label}: the typed end names its provider`, r.last?.streamEnd?.provider === provider, `streamEnd=${JSON.stringify(r.last?.streamEnd)}`)
  check(`${label}: no fault marker, no error row`, r.errors.length === 0, r.errors.join(' | ').slice(0, 300))
  check(`${label}: the call did not throw`, r.threw === undefined, String(r.threw ?? ''))
}

section('T1 — OpenAI: the body held open after the text item settled')
{
  calls.openai = 0
  const r = await drive('gpt-5.6-sol', 'hold-after-settle')
  pinTypedEnd('T1', r, 'silent-after-last-item', 'OpenAI')
  check('T1: the end came at the budget, not before and not much after', r.wallMs >= BUDGET_MS - 100 && r.wallMs < BUDGET_MS + 4000, `wall=${r.wallMs}ms budget=${BUDGET_MS}ms`)
  check('T1: the silence is the budget', r.last?.streamEnd?.reason === 'silent-after-last-item' && r.last.streamEnd.silentMs === BUDGET_MS, JSON.stringify(r.last?.streamEnd))
  check('T1: exactly one request (no reissue)', calls.openai === 1, `calls=${calls.openai}`)
}

section('T2 — OpenAI: the body closed without response.completed')
{
  calls.openai = 0
  const r = await drive('gpt-5.6-sol', 'close-after-settle')
  pinTypedEnd('T2', r, 'closed-after-last-item', 'OpenAI')
  check('T2: the end came at once (no budget waited)', r.wallMs < BUDGET_MS - 200, `wall=${r.wallMs}ms`)
  check('T2: exactly one request', calls.openai === 1, `calls=${calls.openai}`)
}

section('T3 — OpenAI: the body held open BEHIND response.completed')
{
  calls.openai = 0
  const r = await drive('gpt-5.6-sol', 'hold-after-end')
  check('T3: the reply stands', textOf(r.last) === REPLY_TEXT, textOf(r.last))
  check('T3: end_turn from the end event, no typed end', r.last?.message.stop_reason === 'end_turn' && r.last.streamEnd === undefined, JSON.stringify(r.last?.streamEnd))
  check('T3: the end event ended the turn inside the budget', r.wallMs < BUDGET_MS - 200, `wall=${r.wallMs}ms`)
  check('T3: no error row', r.errors.length === 0, r.errors.join(' | ').slice(0, 200))
}

section('T4 — OpenAI: silence MID-item keeps the fault road')
{
  calls.openai = 0
  const r = await drive('gpt-5.6-sol', 'mid-item-silence')
  check('T4: the partial text settled', textOf(r.last) === REPLY_TEXT.slice(0, 12), textOf(r.last))
  check('T4: the continuable fault marker composed (the bounded recovery keys on it)', r.errors.some(e => isContinuableStreamFaultText(e)), r.errors.join(' | ').slice(0, 300))
  check('T4: the typed end never fired', r.last?.streamEnd === undefined, JSON.stringify(r.last?.streamEnd))
}

section('T5 — Anthropic: the body held open after content_block_stop')
{
  calls.anthropic = 0
  const r = await drive('claude-sonnet-5', 'hold-after-settle')
  pinTypedEnd('T5', r, 'silent-after-last-item', 'Anthropic')
  check('T5: the end came at the budget', r.wallMs >= BUDGET_MS - 100 && r.wallMs < BUDGET_MS + 4000, `wall=${r.wallMs}ms`)
  check('T5: exactly one request — no non-streaming fallback of a finished reply', calls.anthropic === 1, `calls=${calls.anthropic}`)
}

section('T6 — Anthropic: the body closed without message_stop')
{
  calls.anthropic = 0
  const r = await drive('claude-sonnet-5', 'close-after-settle')
  pinTypedEnd('T6', r, 'closed-after-last-item', 'Anthropic')
  check('T6: the end came at once', r.wallMs < BUDGET_MS - 200, `wall=${r.wallMs}ms`)
  check('T6: exactly one request', calls.anthropic === 1, `calls=${calls.anthropic}`)
}

section('T7 — Anthropic: the body held open behind message_stop')
{
  calls.anthropic = 0
  const r = await drive('claude-sonnet-5', 'hold-after-end')
  check('T7: the reply stands', textOf(r.last) === REPLY_TEXT, textOf(r.last))
  check('T7: end_turn from the end event, no typed end', r.last?.message.stop_reason === 'end_turn' && r.last.streamEnd === undefined, JSON.stringify(r.last?.streamEnd))
  check('T7: the loop left at message_stop — inside the budget', r.wallMs < BUDGET_MS - 200, `wall=${r.wallMs}ms`)
  check('T7: exactly one request', calls.anthropic === 1, `calls=${calls.anthropic}`)
  check('T7: no error row', r.errors.length === 0, r.errors.join(' | ').slice(0, 200))
}

section('T8 — the owner: the law table, the words, the watchdog')
{
  const law = budget.typedStreamEndOf
  check('idle timeout behind a standing tail ⇒ silent-after-last-item', law({ fault: { kind: 'timeout', code: 'idle-timeout' }, provider: 'X', tailStands: true, silentMs: 90_000 })?.reason === 'silent-after-last-item')
  check('no terminal event behind a standing tail ⇒ closed-after-last-item', law({ fault: { kind: 'truncated-stream', code: 'no-terminal-event' }, provider: 'X', tailStands: true, silentMs: 0 })?.reason === 'closed-after-last-item')
  check('no finish (chat completions) behind a standing tail ⇒ closed-after-last-item', law({ fault: { kind: 'truncated-stream', code: 'no-finish' }, provider: 'X', tailStands: true, silentMs: 0 })?.reason === 'closed-after-last-item')
  check('a tail that does not stand keeps its road', law({ fault: { kind: 'timeout', code: 'idle-timeout' }, provider: 'X', tailStands: false, silentMs: 1 }) === null)
  check('a transport fault keeps its road', law({ fault: { kind: 'transport-error', code: 'read-failed' }, provider: 'X', tailStands: true, silentMs: 1 }) === null)
  check('the receipt says the silence and that the reply stands', budget.streamEndReceiptLine({ reason: 'silent-after-last-item', provider: 'OpenAI', silentMs: 90_000 }) === 'the OpenAI stream went silent 90 s after its last item; the reply stands')
  check('the receipt says the close and that the reply stands', budget.streamEndReceiptLine({ reason: 'closed-after-last-item', provider: 'Anthropic' }) === 'the Anthropic stream closed without its end event after its last item; the reply stands')
  check('one budget on every road', budget.streamIdleTimeoutMsForRoute('openai') === budget.streamIdleTimeoutMs() && budget.streamIdleTimeoutMsForRoute('anthropic') === budget.streamIdleTimeoutMs())

  const warnings: number[] = []
  let fired: { silentMs: number; activity: number } | null = null
  const wd = budget.createStreamIdleWatchdog({ timeoutMs: 400, onWarning: ms => warnings.push(ms), onFire: fire => (fired = fire) })
  wd.noteActivity()
  wd.noteActivity()
  const pending = new Promise<never>(() => {})
  let guardError: unknown
  const guarded = wd.guard(pending).catch(e => (guardError = e))
  await new Promise(resolve => setTimeout(resolve, 260))
  check('the watchdog warned at half the budget, once', warnings.length === 1 && warnings[0]! >= 200, JSON.stringify(warnings))
  check('the budget still stands at half', wd.fired() === null)
  await new Promise(resolve => setTimeout(resolve, 260))
  await guarded
  check('the watchdog fired at the budget with its facts', fired !== null && (fired as { silentMs: number; activity: number }).silentMs >= 400 && (fired as { activity: number }).activity === 2, JSON.stringify(fired))
  check('the guard lost the pending read to the typed error', guardError instanceof budget.StreamIdleTimeoutError, String(guardError))
  const quiet = budget.createStreamIdleWatchdog({ timeoutMs: 200, onFire: () => check('a stopped watchdog never fires', false) })
  quiet.stop()
  await new Promise(resolve => setTimeout(resolve, 260))
  check('stop() stood the watchdog down', quiet.fired() === null)
}

section('T9 — the first-byte budget on the three compat clients (a fetch that never answers)')
{
  const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.ts')
  const { streamZaiChat } = await import('../../src/services/providers/zai/zaiClient.ts')
  const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
  const neverAnswers: typeof fetch = (_url, init) =>
    new Promise((_, reject) => {
      const signal = (init as { signal?: AbortSignal } | undefined)?.signal
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true })
    })
  type Road = { name: string; run: (onWait: (w: unknown) => void) => AsyncGenerator<{ type: string; fault?: { kind: string; code: string; message: string; retryable: boolean } }> }
  const roads: Road[] = [
    {
      name: 'OpenAI',
      run: onWait =>
        streamOpenaiResponses({
          baseUrl: `${base}/openai/v1`,
          headers: { authorization: 'Bearer x' },
          request: { model: 'gpt-5.6-sol', input: 'go' } as never,
          fetchImpl: neverAnswers,
          idleTimeoutMs: 400,
          firstByte: { cold: false, promptTokens: 10, model: 'GPT-5.6 Sol', onWait: onWait as never },
        }) as never,
    },
    {
      name: 'Z.AI',
      run: onWait =>
        streamZaiChat({
          apiKey: 'x',
          baseUrl: `${base}/zai/v4`,
          request: { model: 'glm-5.2', messages: [{ role: 'user', content: 'go' }] } as never,
          fetchImpl: neverAnswers,
          idleTimeoutMs: 400,
          firstByte: { cold: false, promptTokens: 10, model: 'GLM 5.2', onWait: onWait as never },
        } as never) as never,
    },
    {
      name: 'compat',
      run: onWait =>
        streamCompatChat({
          apiKey: 'x',
          url: `${base}/v1/chat/completions`,
          request: { model: 'a-compat-model', messages: [{ role: 'user', content: 'go' }] } as never,
          fetchImpl: neverAnswers,
          idleTimeoutMs: 400,
          firstByte: { cold: false, promptTokens: 10, model: 'A Compat Model', onWait: onWait as never },
        } as never) as never,
    },
  ]
  for (const road of roads) {
    const waits: unknown[] = []
    const events: Array<{ type: string; fault?: { kind: string; code: string; message: string; retryable: boolean } }> = []
    const t0 = performance.now()
    for await (const ev of road.run(w => waits.push(w))) events.push(ev)
    const wallMs = Math.round(performance.now() - t0)
    const fault = events.find(e => e.type === 'stream-fault')?.fault
    check(`${road.name}: the fetch that never answers ends at the budget`, wallMs >= 350 && wallMs < 2000, `wall=${wallMs}ms events=${JSON.stringify(events).slice(0, 200)}`)
    check(`${road.name}: the typed first-byte fault, retryable`, fault?.kind === 'timeout' && fault.code === 'first-byte-timeout' && fault.retryable === true, JSON.stringify(fault))
    check(`${road.name}: the line names the wait and the budget`, fault !== undefined && /^no first byte from .+ after 1 s \(the request was accepted and nothing arrived\)$/.test(fault.message), fault?.message)
    const first = waits[0] as { kind?: string; budgetMs?: number; model?: string } | undefined
    check(`${road.name}: the wait was published first with the budget that fires`, first?.kind === 'first-byte' && first.budgetMs === 400 && typeof first.model === 'string', JSON.stringify(waits))
    check(`${road.name}: the wait was never cleared (the headers never came)`, !waits.includes(null), JSON.stringify(waits))
  }
  const cold = budget.firstByteBudgetMs({ cold: true, promptTokens: 50_000, idleMs: 400 })
  check('a cold prefix earns its ingest allowance under the same owner', cold === 400 + 50 * budget.COLD_INGEST_MS_PER_1K_TOKENS, String(cold))
}

section('T10 — the OpenAI road end to end: headers never answered')
{
  calls.openai = 0
  arm = 'complete'
  holdHeaders = true
  const r = await drive('gpt-5.6-sol', 'complete')
  holdHeaders = false
  check('T10: the road ended inside the budget and its one retry — never the fifty-minute ceiling', r.wallMs < 4 * BUDGET_MS + 4000, `wall=${r.wallMs}ms`)
  check('T10: the terminal error row carries the typed first-byte line', r.errors.some(e => /no first byte from GPT-5\.6 Sol after/.test(e)), r.errors.join(' | ').slice(0, 300))
  check('T10: no reply was minted', r.last === undefined, String(JSON.stringify(r.last?.message.content) ?? '').slice(0, 100))
  check('T10: the request reached the fixture (once, then the bounded retry)', calls.openai >= 1 && calls.openai <= 2, `calls=${calls.openai}`)
}

section('T11 — liveness on the Responses client is a decoded event, never a byte')
{
  calls.openai = 0
  arm = 'keepalive-after-settle'
  const r = await drive('gpt-5.6-sol', 'keepalive-after-settle')
  check('T11: comment keepalives never counted — the typed end came at the budget', r.last?.streamEnd?.reason === 'silent-after-last-item', JSON.stringify(r.last?.streamEnd))
  check('T11: the reply stands', textOf(r.last) === REPLY_TEXT, textOf(r.last))
  check('T11: the end came at the budget, not at the fifty-minute ceiling', r.wallMs >= BUDGET_MS - 100 && r.wallMs < BUDGET_MS + 4000, `wall=${r.wallMs}ms`)
}

for (const res of holds) res.destroy()
for (const t of keepalives) clearInterval(t)
holds.clear()
server.close()
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
