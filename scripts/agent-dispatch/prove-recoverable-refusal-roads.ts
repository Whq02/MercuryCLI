#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.chdir(resolve(import.meta.dir, '..', '..'))
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'refusal-roads-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_RECOVERY_BUDGET_MINUTES

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

type Mode = 'burst' | 'window'
let mode: Mode = 'burst'
const requests: Array<{ road: string; nth: number; status: number }> = []
const counts = new Map<string, number>()
const RETRY_AFTER_BURST = '1'
const RETRY_AFTER_WINDOW = '10800'

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const road = path.includes('/openai/') ? 'openai' : path.includes('/zai/') ? 'zai' : 'openai-compat'
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] }))
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    const key = `${road}:${mode}`
    const nth = (counts.get(key) ?? 0) + 1
    counts.set(key, nth)
    const refuse = mode === 'window' || nth === 1
    if (refuse) {
      requests.push({ road, nth, status: 429 })
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': mode === 'window' ? RETRY_AFTER_WINDOW : RETRY_AFTER_BURST, connection: 'close' })
      res.end(JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'too many requests' } }))
      return
    }
    requests.push({ road, nth, status: 200 })
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' })
    if (road === 'openai') {
      res.write(sse({ type: 'response.created', response: { id: 'resp_fixture' } }))
      res.write(sse({ type: 'response.output_text.delta', delta: 'the reply after busy' }))
      res.write(sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the reply after busy' }] } }))
      res.end(sse({ type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } }))
      return
    }
    res.write(sse({ choices: [{ delta: { role: 'assistant' } }] }))
    res.write(sse({ choices: [{ delta: { content: 'the reply after busy' } }] }))
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }))
    res.end('data: [DONE]\n\n')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
Object.assign(process.env, {
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  OPENAI_API_KEY: 'fixture-openai-key',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  ZAI_API_KEY: 'fixture-zai-key',
  MERCURY_COMPAT_BASE_URL: `${base}/compat/v1`,
  MERCURY_COMPAT_MODELS: 'fixture-model',
  MERCURY_COMPAT_LABEL: 'the fixture endpoint',
})

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const budget = await import('../../src/services/api/recoveryBudget.ts')

type Row = Record<string, unknown>
type Drive = { yielded: Row[]; thrown: string | null; elapsedMs: number }
async function drive(model: string): Promise<Drive> {
  const abort = new AbortController()
  const yielded: Row[] = []
  let thrown: string | null = null
  const started = Date.now()
  try {
    const stream = routedCallModel({
      messages: [createUserMessage({ content: 'the operator asks for one line' })] as never,
      systemPrompt: asSystemPrompt(['You are the refusal fixture.']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: abort.signal,
      options: {
        getToolPermissionContext: () => Promise.resolve(getEmptyToolPermissionContext()),
        model,
        isNonInteractiveSession: true,
        hasAppendSystemPrompt: false,
        querySource: 'agent' as never,
        agents: [],
        mcpTools: [],
      },
    } as never)
    for await (const event of stream) yielded.push(event as Row)
  } catch (e) {
    thrown = String(e)
  }
  return { yielded, thrown, elapsedMs: Date.now() - started }
}
const notices = (d: Drive): Row[] => d.yielded.filter(e => e.type === 'system' && e.subtype === 'api_error')
const apiErrorText = (d: Drive): string | null => {
  for (const e of d.yielded) {
    if (e.type !== 'assistant' || (e as { isApiErrorMessage?: boolean }).isApiErrorMessage !== true) continue
    const content = (e as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const text = (block as { type?: string; text?: unknown }).type === 'text' ? (block as { text?: unknown }).text : undefined
      if (typeof text === 'string') return text
    }
  }
  return null
}
const streamedText = (d: Drive): string =>
  d.yielded
    .filter(e => e.type === 'stream_event')
    .map(e => {
      const ev = (e as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event
      return ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' ? (ev.delta.text ?? '') : ''
    })
    .join('')
const requestsOf = (road: string, m: Mode): number => counts.get(`${road}:${m}`) ?? 0

const ROADS: Array<{ road: string; model: string; label: string }> = [
  { road: 'openai', model: 'gpt-5.6-sol', label: 'the OpenAI road' },
  { road: 'zai', model: 'glm-5.2', label: 'the Z.AI road' },
  { road: 'openai-compat', model: 'compat/fixture-model', label: 'the OpenAI-compatible road' },
]

check('the retry budget is 20 minutes: a three-hour ask is the window, a one-second ask a burst', budget.providerWaitIsWindow(10_800_000) && !budget.providerWaitIsWindow(1_000))

for (const { road, model, label } of ROADS) {
  section(`${label} — (a) a burst 429 with a short Retry-After is waited out and the reply lands`)
  mode = 'burst'
  const burst = await drive(model)
  const notice = notices(burst)[0]
  check(`${road}: two requests — the refusal, then the reply`, requestsOf(road, 'burst') === 2, `requests=${requestsOf(road, 'burst')} thrown=${burst.thrown}`)
  check(`${road}: the reply landed after the wait`, streamedText(burst).includes('the reply after busy') && apiErrorText(burst) === null, `${streamedText(burst).slice(0, 60)} | ${apiErrorText(burst)}`)
  check(`${road}: ONE retry notice, carrying the provider's ask as the wait`, notices(burst).length === 1 && typeof notice?.retryInMs === 'number' && (notice.retryInMs as number) >= 1_000 && (notice.retryInMs as number) < 5_000, JSON.stringify(notices(burst).map(n => n.retryInMs)))
  const facts = notice === undefined ? null : budget.recoveryNoticeFacts(notice)
  check(`${road}: the notice reads as a refusal the provider asked for — what a dispatched agent's budget charges`, facts !== null && facts.kind === 'throttle' && facts.status === 429 && facts.providerDeclared === true && facts.cause === 'provider busy (HTTP 429)', JSON.stringify(facts))
  check(`${road}: the ask was slept (a second or more between the refusal and the reply)`, burst.elapsedMs >= 1_000, String(burst.elapsedMs))

  section(`${label} — (b) a 429 asking for three hours is the provider's window: one request, the row names the wait`)
  mode = 'window'
  const window = await drive(model)
  const text = apiErrorText(window)
  check(`${road}: ONE request, no retry, no notice`, requestsOf(road, 'window') === 1 && notices(window).length === 0, `requests=${requestsOf(road, 'window')} notices=${notices(window).length}`)
  check(`${road}: the turn ended on the error row, at once`, text !== null && window.thrown === null && window.elapsedMs < 5_000, `${text} | ${window.thrown} | ${window.elapsedMs}ms`)
  check(`${road}: the row names the provider's wait`, text !== null && (/3h/.test(text) || /10800/.test(text)), text ?? '(none)')
  const row = window.yielded.find(e => e.type === 'assistant' && (e as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) as { error?: string } | undefined
  check(`${road}: the row is typed as the provider's refusal`, row?.error === 'rate_limit', JSON.stringify(row?.error))
}

server.close()
console.log(failures === 0 ? '\nprove-recoverable-refusal-roads: all green' : `\nprove-recoverable-refusal-roads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
