#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of [
  'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY',
  'MERCURY_API_UNIX_SOCKET', 'MERCURY_CLIENT_CERT', 'MERCURY_CLIENT_KEY',
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN',
  'MERCURY_API_KEY_FILE_DESCRIPTOR', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_PROVIDER_HEADERS', 'MERCURY_WIRE_DUMP', 'MERCURY_BARE', 'MERCURY_PROVIDER_BETAS',
  'MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'MERCURY_ENTRYPOINT', 'MERCURY_EXTRA_BODY', 'MERCURY_EXTRA_METADATA',
  'MERCURY_ANTHROPIC_CLIENT_CONTRACT', 'MERCURY_RECOVERY_BUDGET_MINUTES', 'MERCURY_MAX_RETRIES',
  'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN',
]) delete process.env[key]
delete process.env.NODE_ENV
const home = mkdtempSync(join(tmpdir(), 'count-busy-retry-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-not-a-real-key'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.01'
process.env.DEBUG = '1'

const realRandom = Math.random
Math.random = () => 0.5
let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) failures++
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const show = (value: unknown): string => JSON.stringify(value)

type Scripted = { status: number; headers?: Record<string, string>; body: unknown }
type Hit = { atMs: number; path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }
let script: Scripted[] = []
const hits: Hit[] = []
const answer = (res: ServerResponse, scripted: Scripted): void => {
  res.writeHead(scripted.status, { 'content-type': 'application/json', ...(scripted.headers ?? {}) })
  res.end(JSON.stringify(scripted.body))
}
const origin = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    hits.push({ atMs: Date.now(), path: (req.url ?? '').split('?')[0]!, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>, headers: req.headers })
    answer(res, script.shift() ?? { status: 200, body: { input_tokens: 1 } })
  })
})
const refusal429 = (headers?: Record<string, string>, message = 'Error'): Scripted => ({ status: 429, ...(headers ? { headers } : {}), body: { type: 'error', error: { type: 'rate_limit_error', message } } })
const counted = (input_tokens: number): Scripted => ({ status: 200, body: { input_tokens } })
const created = (usage: Record<string, number>): Scripted => ({ status: 200, body: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', usage } })
const debugLines = (): string[] => {
  const dir = join(home, 'debug')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.txt')).flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n'))
}
async function leg<T>(plan: Scripted[], run: () => Promise<T>): Promise<{ result: T | 'threw'; error?: unknown; hits: Hit[]; lines: string[]; elapsedMs: number }> {
  script = [...plan]
  const before = hits.length
  const linesBefore = debugLines().length
  const started = Date.now()
  let result: T | 'threw'
  let error: unknown
  try {
    result = await run()
  } catch (caught) {
    result = 'threw'
    error = caught
  }
  return { result, error, hits: hits.slice(before), lines: debugLines().slice(linesBefore).filter(line => line.includes('count_tokens')), elapsedMs: Date.now() - started }
}

try {
  const port = await new Promise<number>(resolve => {
    origin.listen(0, '127.0.0.1', () => {
      const address = origin.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  ;(await import('../../src/utils/config.js')).enableConfigs()
  const { setMainLoopModelOverride } = await import('../../src/bootstrap/state.js')
  const { COUNT_RETRY_BUDGET_MS, countMessagesTokensWithAPI, countTokensViaHaikuFallback } = await import('../../src/services/tokenEstimation.js')
  const { BUSY_RETRY_RUNGS_MS, openBusyRetryLadder, nextBusyRetryWithinBudget } = await import('../../src/services/providers/busyRetry.js')
  const { getCLISyspromptPrefix } = await import('../../src/constants/system.js')
  const { getAnthropicClientContractVersion } = await import('../../src/constants/oauth.js')
  setMainLoopModelOverride('claude-sonnet-5-5')
  const messages = [{ role: 'user', content: 'Count me.' }]
  const scale = 0.01
  const rungs = BUSY_RETRY_RUNGS_MS.map(ms => Math.round(ms * scale))
  const budgetMs = Math.round(COUNT_RETRY_BUDGET_MS * scale)
  let retriesInBudget = 0
  for (let sum = 0; retriesInBudget < rungs.length && sum + rungs[retriesInBudget]! <= budgetMs; retriesInBudget++) sum += rungs[retriesInBudget]!

  console.log('the ladder')
  {
    const ladder = openBusyRetryLadder(0, 1, COUNT_RETRY_BUDGET_MS)
    check(`a count's ladder is the busy ladder capped at its own ${COUNT_RETRY_BUDGET_MS / 1000} s budget, under the ladder's whole`, ladder.budgetMs === COUNT_RETRY_BUDGET_MS && ladder.budgetMs < BUSY_RETRY_RUNGS_MS.reduce((a, b) => a + b, 0), ladder)
    check('the uncapped ladder is unchanged: the rungs\' whole sum', openBusyRetryLadder(0, 1).budgetMs === BUSY_RETRY_RUNGS_MS.reduce((a, b) => a + b, 0))
    const steps: number[] = []
    for (let step = nextBusyRetryWithinBudget(ladder, undefined, 0); step !== null; step = nextBusyRetryWithinBudget(ladder, undefined, 0)) steps.push(step.waitMs)
    check('within the budget the rungs ride in order and stop at the budget: 1 s, 2 s, 4 s, 8 s', show(steps) === show([1000, 2000, 4000, 8000]) && ladder.spentMs === COUNT_RETRY_BUDGET_MS, steps)
    const fresh = openBusyRetryLadder(0, 1, COUNT_RETRY_BUDGET_MS)
    check('an ask past what is left is never honoured: the step is null and nothing is spent', nextBusyRetryWithinBudget(fresh, COUNT_RETRY_BUDGET_MS + 1, 0) === null && fresh.spentMs === 0 && fresh.waitsMs.length === 0)
    check('an ask within what is left rides whole in place of the rung', nextBusyRetryWithinBudget(fresh, 5000, 0)?.waitMs === 5000 && fresh.spentMs === 5000)
  }

  console.log('\nthe count endpoint on a busy wire')
  {
    const a = await leg([refusal429(), counted(41)], () => countMessagesTokensWithAPI(messages, []))
    check('a burst 429 then 200: the exact count comes back (base: null after the SDK\'s one silent retry)', a.result === 41, a)
    check('two requests reached the count endpoint', a.hits.length === 2 && a.hits.every(hit => hit.path === '/v1/messages/count_tokens'), a.hits.map(hit => hit.path))
    check(`the wait between them was the first rung (${rungs[0]} ms here)`, a.hits.length === 2 && a.hits[1]!.atMs - a.hits[0]!.atMs >= rungs[0]! - 2, a.hits.length === 2 ? a.hits[1]!.atMs - a.hits[0]!.atMs : null)
    check(`the debug log names the refusal and the wait: retry 1 of ${retriesInBudget}`, a.lines.some(line => /count_tokens: HTTP 429: 429 .*rate_limit_error.* — waiting \d+ s before retry 1 of \d+/.test(line) && line.includes(`retry 1 of ${retriesInBudget}`)), a.lines)
  }
  {
    const b = await leg(Array.from({ length: 12 }, () => refusal429()), () => countMessagesTokensWithAPI(messages, []))
    check('a 429 that never clears: the count is unknown (null) — the caller keeps its estimate', b.result === null, b.result)
    check(`the ladder stopped at the count's budget: ${1 + retriesInBudget} requests, never the SDK's own retries on top`, b.hits.length === 1 + retriesInBudget, b.hits.length)
    check(`the whole stall stayed inside the budget plus a small allowance (${budgetMs} ms here)`, b.elapsedMs < budgetMs + 700, b.elapsedMs)
    check(`the debug log says the budget is spent after ${retriesInBudget} retries`, b.lines.some(line => line.includes(`retry budget is spent after ${retriesInBudget} retries`) && line.includes('the caller keeps its estimate')), b.lines)
  }
  {
    const c = await leg([refusal429({ 'retry-after': '30' })], () => countMessagesTokensWithAPI(messages, []))
    check('a retry-after past the count\'s budget is not slept: one request, null at once', c.result === null && c.hits.length === 1 && c.elapsedMs < 1_000, { hits: c.hits.length, elapsedMs: c.elapsedMs })
    check('the debug log names the ask and the budget', c.lines.some(line => line.includes('retry budget is spent after 0 retries') && line.includes('the provider asked for 30 s')), c.lines)
  }
  {
    const d = await leg([refusal429({ 'retry-after': '7200' })], () => countMessagesTokensWithAPI(messages, []))
    check('a retry-after the length of a usage window is not retried: one request, null at once', d.result === null && d.hits.length === 1 && d.elapsedMs < 1_000, { hits: d.hits.length, elapsedMs: d.elapsedMs })
    check('the debug log names it a window, not a burst', d.lines.some(line => line.includes('not retried') && line.includes('its usage window, not a burst')), d.lines)
  }
  {
    const e = await leg([refusal429({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(Math.floor(Date.now() / 1000) + 600) })], () => countMessagesTokensWithAPI(messages, []))
    check('a spent usage window is not retried: one request, null at once', e.result === null && e.hits.length === 1 && e.elapsedMs < 1_000, { hits: e.hits.length, elapsedMs: e.elapsedMs })
    check('the debug log says the window is spent', e.lines.some(line => line.includes('not retried: the usage window is spent')), e.lines)
  }
  {
    const f = await leg([{ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }], () => countMessagesTokensWithAPI(messages, []))
    check('an overload is not retried by a count: one request, null at once', f.result === null && f.hits.length === 1 && f.elapsedMs < 1_000, { hits: f.hits.length, elapsedMs: f.elapsedMs })
    check('the debug log says why', f.lines.some(line => line.includes('not retried: an overload is not retried by a count')), f.lines)
  }
  {
    const g = await leg([{ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'Internal server error' } } }, counted(23)], () => countMessagesTokensWithAPI(messages, []))
    check('a 500 then 200 rides the same ladder: the exact count comes back after two requests', g.result === 23 && g.hits.length === 2, { result: g.result, hits: g.hits.length })
  }

  console.log('\nthe create probe on the same wire')
  {
    const h = await leg([refusal429(), created({ input_tokens: 37, output_tokens: 1, cache_creation_input_tokens: 5, cache_read_input_tokens: 7 })], () => countTokensViaHaikuFallback(messages, []))
    check('a burst 429 then 200: the full prompt size comes back (input plus both cache fields)', h.result === 49, h.result)
    check('two requests reached the create endpoint', h.hits.length === 2 && h.hits.every(hit => hit.path === '/v1/messages'), h.hits.map(hit => hit.path))
    const body = h.hits[1]?.body ?? {}
    const system = body.system as Array<{ type: string; text: string }> | undefined
    check('the probe carries no anthropic_beta body field (base: the first-party wire refused it 400, "Extra inputs are not permitted")', !Object.hasOwn(body, 'anthropic_beta') && !Object.hasOwn(body, 'betas'), Object.keys(body))
    check('the probe opens with the attribution line the first-party door reads, then the CLI prefix (base: no system prompt at all)', Array.isArray(system) && system.length === 2 && system[0]!.text.startsWith(`x-anthropic-billing-header: cc_version=${getAnthropicClientContractVersion()}.`) && system[1]!.text === getCLISyspromptPrefix({ isNonInteractive: false, hasAppendSystemPrompt: false }), system?.map(block => block.text.slice(0, 60)))
    check('the probe carries the session metadata and the small-fast model at one token', typeof (body.metadata as { user_id?: unknown } | undefined)?.user_id === 'string' && body.model === 'claude-haiku-4-5-20251001' && body.max_tokens === 1, { metadata: body.metadata, model: body.model, max_tokens: body.max_tokens })
    check('the debug log names the create probe\'s wait', h.lines.some(line => line.includes('count_tokens (create probe): HTTP 429') && line.includes('waiting')), h.lines)
  }
  {
    const i = await leg([{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'anthropic_beta: Extra inputs are not permitted' } } }], () => countTokensViaHaikuFallback(messages, []))
    check('a 400 is not retried and the probe throws it (its contract): one request', i.result === 'threw' && i.hits.length === 1 && (i.error as { status?: number } | undefined)?.status === 400, { result: i.result, hits: i.hits.length })
    check('the debug log names the refusal as not retryable', i.lines.some(line => line.includes('count_tokens (create probe): HTTP 400') && line.includes('not retried: not a retryable refusal')), i.lines)
  }
} finally {
  Math.random = realRandom
  if (origin.listening) await new Promise<void>(resolve => origin.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL COUNT BUSY-RETRY PROOFS PASS' : `\nFAIL — ${failures} count busy-retry check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
