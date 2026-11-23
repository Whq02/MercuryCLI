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
delete process.env.MERCURY_MAX_RETRIES

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

type Mode = 'burst' | 'window' | 'endless'
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
    const refuse = mode !== 'burst' || nth === 1
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

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const bootstrap = await import('../../src/boot/process-state/processState.ts')
bootstrap.setIsInteractive(false)
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const { asSystemPrompt } = await import('../../src/engine/system-prompt/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const budget = await import('../../src/engine/requests/recoveryBudget.ts')

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

check('the retry budget is 20 minutes: a three-hour ask is the window, a one-second ask a burst', budget.providerWaitIsWindow(10_800_000) && !budget.providerWaitIsWindow(1_000), 'providerWaitIsWindow in src/engine/requests/recoveryBudget.ts must be true for a 10800000 ms ask and false for 1000 ms against the recovery budget (recoveryBudgetMs)')

for (const { road, model, label } of ROADS) {
  section(`${label} — (a) a burst 429 with a short Retry-After is waited out and the reply lands`)
  mode = 'burst'
  const burst = await drive(model)
  check(`${road}: two requests — the refusal, then the reply`, requestsOf(road, 'burst') === 2, `requests=${requestsOf(road, 'burst')} thrown=${burst.thrown} | the burst 429 must be retried once: look at the busy retry ladder in src/models/roads/busyRetry.ts and this road call model under src/models/roads/`)
  check(`${road}: the reply landed after the wait`, streamedText(burst).includes('the reply after busy') && apiErrorText(burst) === null, `${streamedText(burst).slice(0, 60)} | ${apiErrorText(burst)} | after the wait the retried request must stream the reply: look at the retry loop of this road call model under src/models/roads/`)
  check(`${road}: the wait the provider names is said at once — one retry notice of 1000 ms, attempt 1 of 10`, notices(burst).length === 1 && notices(burst)[0]?.retryInMs === 1000 && notices(burst)[0]?.retryAttempt === 1 && notices(burst)[0]?.maxRetries === 10, JSON.stringify(notices(burst).map(n => [n.retryInMs, n.retryAttempt, n.maxRetries])) + ' | expected one api_error notice [1000, 1, 10]: the notice is built from the busy retry step in src/models/roads/busyRetry.ts (nextBusyRetry)')
  const stamp = burst.yielded.find(e => e.type === 'assistant' && (e as { busyRecovery?: unknown }).busyRecovery !== undefined) as { busyRecovery?: { retries?: number; status?: number; detail?: string } } | undefined
  check(`${road}: the settled reply carries no recovery stamp — the wait was said when it began`, stamp === undefined, JSON.stringify(stamp?.busyRecovery) + ' | a reply that landed after a said wait must not carry busyRecovery: look at where this road stamps busyRecovery (busyRecoveryDetail in src/models/roads/busyRetry.ts)')
  check(`${road}: the ask was slept (a second or more between the refusal and the reply)`, burst.elapsedMs >= 1_000, `${burst.elapsedMs}ms | the road must sleep the Retry-After of 1 second before the retry: look at nextBusyRetry in src/models/roads/busyRetry.ts`)

  section(`${label} — (b) a 429 asking for three hours is the provider's window: one request, the row names the wait`)
  mode = 'window'
  const window = await drive(model)
  const text = apiErrorText(window)
  check(`${road}: ONE request, no retry, no notice`, requestsOf(road, 'window') === 1 && notices(window).length === 0, `requests=${requestsOf(road, 'window')} notices=${notices(window).length} | a Retry-After of three hours is the provider window and must not be retried: look at providerWaitIsWindow in src/engine/requests/recoveryBudget.ts and where this road uses it`)
  check(`${road}: the turn ended on the error row, at once`, text !== null && window.thrown === null && window.elapsedMs < 5_000, `${text} | ${window.thrown} | ${window.elapsedMs}ms | a window 429 must end the turn at once on an api error row without throwing: look at where this road turns the refusal into the row under src/models/roads/`)
  check(`${road}: the row names the provider's wait (the one wait formatter's 3 h 0 min on the Anthropic and compat roads; the OpenAI road's 10800 s)`, text !== null && (/3 h 0 min/.test(text) || /10800 s/.test(text)), `${text ?? '(none)'} | the row must state the wait the provider asked for: look at providerWaitWords in src/engine/requests/recoveryBudget.ts and the road that builds the row`)
  const row = window.yielded.find(e => e.type === 'assistant' && (e as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) as { error?: string } | undefined
  check(`${road}: the row is typed as the provider's refusal`, row?.error === 'rate_limit', JSON.stringify(row?.error) + ' | the window refusal row must carry error rate_limit: look at where this road types its 429 row under src/models/roads/')

  section(`${label} — (c) a 429 that names one second and never ends is retried ten times with MERCURY_MAX_RETRIES unset, each wait said, then the row`)
  mode = 'endless'
  const endless = await drive(model)
  const said = notices(endless)
  const lastText = apiErrorText(endless)
  check(`${road}: eleven requests — the refusal and ten retries`, requestsOf(road, 'endless') === 11, `requests=${requestsOf(road, 'endless')} thrown=${endless.thrown} | with MERCURY_MAX_RETRIES unset the road must retry ten times then stop: look at the retry limit in src/engine/requests/withRetry.ts and the busy ladder in src/models/roads/busyRetry.ts`)
  check(`${road}: ten retry notices, attempts 1 to 10 of 10, each the second the provider names`, said.length === 10 && said.every((n, i) => n.retryInMs === 1000 && n.retryAttempt === i + 1 && n.maxRetries === 10), JSON.stringify(said.map(n => [n.retryInMs, n.retryAttempt, n.maxRetries])) + ' | expected ten notices [1000, i, 10] with i from 1 to 10: look at nextBusyRetry in src/models/roads/busyRetry.ts')
  check(`${road}: every named second was waited (ten seconds or more) and then the turn ended on the provider's refusal, with no "stayed busy" head`, endless.elapsedMs >= 10_000 && endless.thrown === null && lastText !== null && !/stayed busy/.test(lastText), `${endless.elapsedMs}ms | ${lastText} | ${endless.thrown} | each named second must be slept, and the final row must be the provider refusal text, not a stayed busy head: look at busyRecoveryDetail in src/models/roads/busyRetry.ts and where this road ends the ladder`)
  const endlessRow = endless.yielded.find(e => e.type === 'assistant' && (e as { isApiErrorMessage?: boolean }).isApiErrorMessage === true) as { error?: string } | undefined
  check(`${road}: that row is typed as the provider's refusal`, endlessRow?.error === 'rate_limit', JSON.stringify(endlessRow?.error) + ' | the final refusal row must carry error rate_limit: look at where this road types its 429 row under src/models/roads/')
}

server.close()
console.log(failures === 0 ? '\nprove-recoverable-refusal-roads: all green' : `\nprove-recoverable-refusal-roads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
