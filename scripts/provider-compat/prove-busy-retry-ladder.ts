import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'busy-retry-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_HOME = home
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_RECOVERY_BUDGET_MINUTES = '1'
process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://gemini.fixture.invalid/token'
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_BUSY_RETRY_SCALE']) delete process.env[name]
const access = 'ya29.fixture-busy-access'
writeFileSync(join(home, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'oauth', client: { clientId: 'fixture-client' }, tokens: { accessToken: access, refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const busy = await import('../../src/services/providers/busyRetry.ts')
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
import type { Message } from '../../src/types/message.ts'
import type { CompatCallModelParams, CompatLaneProfile } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

let checks = 0
let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail}` : ''}`)
}

console.log('── the ladder, pure')
const ladder = busy.openBusyRetryLadder(0, 1)
check('the rungs are 1 s, 2 s, 4 s, 8 s, 16 s and 30 s, the budget their sum and the quiet window 30 s', JSON.stringify(ladder.rungsMs) === JSON.stringify([1000, 2000, 4000, 8000, 16000, 30000]) && ladder.budgetMs === 61000 && ladder.quietMs === 30000)
const steps: Array<ReturnType<typeof busy.nextBusyRetry>> = []
let clock = 0
for (let i = 0; i < 7; i++) {
  const step = busy.nextBusyRetry(ladder, undefined, clock)
  steps.push(step)
  if (step !== null) clock += step.waitMs + 500
}
check('six retries on the rungs, then the ladder is spent', steps.slice(0, 6).every((step, i) => step !== null && step.waitMs === ladder.rungsMs[i]) && steps[6] === null)
check('every rung names its true place: attempt n of 6', steps.slice(0, 6).every((step, i) => step?.attempt === i + 1 && step.of === 6))
check('the waits that begin inside the quiet window are quiet; the one that begins past it is not', steps.slice(0, 5).every(step => step?.quiet === true) && steps[5]?.quiet === false, JSON.stringify(steps.map(step => step?.quiet)))
const asked = busy.openBusyRetryLadder(0, 1)
const askedStep = busy.nextBusyRetry(asked, 120000, 0)
check("a provider's own ask larger than the rung is the wait, charged whole, and names itself the last retry", askedStep?.waitMs === 120000 && askedStep.attempt === 1 && askedStep.of === 1 && busy.nextBusyRetry(asked, undefined, 130000) === null)
const shortAsks = busy.openBusyRetryLadder(0, 1)
const shortWaits: number[] = []
for (let i = 0; i < 7; i++) {
  const step = busy.nextBusyRetry(shortAsks, 5000, i * 6000)
  if (step === null) break
  shortWaits.push(step.waitMs)
}
check('short asks ride in place of the small rungs and the last rung is clipped to the budget', JSON.stringify(shortWaits) === JSON.stringify([5000, 5000, 5000, 8000, 16000, 22000]) && shortAsks.spentMs === 61000)
const scaled = busy.openBusyRetryLadder(0, 0.01)
check('the scale seam shrinks every rung and the quiet window alike', JSON.stringify(scaled.rungsMs) === JSON.stringify([10, 20, 40, 80, 160, 300]) && scaled.quietMs === 300 && scaled.budgetMs === 610)
check('unset, empty, zero and negative scales read as 1', busy.busyRetryScale() === 1 && (process.env.MERCURY_BUSY_RETRY_SCALE = '') === '' && busy.busyRetryScale() === 1 && (process.env.MERCURY_BUSY_RETRY_SCALE = '0') === '0' && busy.busyRetryScale() === 1 && (process.env.MERCURY_BUSY_RETRY_SCALE = '-2') === '-2' && busy.busyRetryScale() === 1)
delete process.env.MERCURY_BUSY_RETRY_SCALE
check('a busy refusal is a 503, a 529, or the UNAVAILABLE or overloaded word, before content and retryable', busy.isBusyRefusal({ code: 'api-UNAVAILABLE', status: 503, retryable: true }) && busy.isBusyRefusal({ code: 'http-529', status: 529, retryable: true }) && busy.isBusyRefusal({ code: 'api-UNAVAILABLE', retryable: true }) && busy.isBusyRefusal({ code: 'api-overloaded_error', status: 500, retryable: true }))
check('a 429, a 500, a 502 and a non-retryable 503 are not busy refusals', !busy.isBusyRefusal({ code: 'api-RESOURCE_EXHAUSTED', status: 429, retryable: true }) && !busy.isBusyRefusal({ code: 'http-500', status: 500, retryable: true }) && !busy.isBusyRefusal({ code: 'http-502', status: 502, retryable: true }) && !busy.isBusyRefusal({ code: 'api-UNAVAILABLE', status: 503, retryable: false }))
check('the expansion names the status, the code, the words, every wait and which request was answered', busy.busyRecoveryDetail({ provider: 'Gemini', status: 503, code: 'api-UNAVAILABLE', message: 'busy words', waitsMs: [1000, 2000] }) === 'Gemini answered HTTP 503 (api-UNAVAILABLE): busy words — retried after 1 s and 2 s, and the third request was answered.')

console.log('── the ladder on the Gemini road, against a recording fixture')
const model = 'gemini-3.5-flash'
const overloadReason = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(signal: AbortSignal = new AbortController().signal, modelId = model): CompatCallModelParams {
  return {
    messages: [user('Say hello.')], systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: [], signal,
    options: { model: modelId, querySource: 'repl_main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never,
  }
}
type Stamp = { provider: string; retries: number; elapsedMs: number; status?: number; code?: string; detail: string }
type Item = { type: string; subtype?: string; retryInMs?: number; retryAttempt?: number; maxRetries?: number; isApiErrorMessage?: boolean; error?: string; message?: { content: Array<{ type: string; text?: string }> }; event?: { type: string }; busyRecovery?: Stamp }
async function drain(generator: AsyncGenerator<unknown>): Promise<Item[]> {
  const out: Item[] = []
  for await (const item of generator) out.push(item as Item)
  return out
}
const notices = (items: Item[]) => items.filter(item => item.type === 'system' && item.subtype === 'api_error')
const stamped = (items: Item[]) => items.filter(item => item.type === 'assistant' && item.busyRecovery !== undefined)
const redLines = (items: Item[]) => items.filter(item => item.type === 'assistant' && item.isApiErrorMessage === true).map(item => item.message?.content.map(block => block.text ?? '').join('') ?? '')
const sse = (chunks: unknown[]): Response => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
type Hit = { url: string; atMs: number }
const hits: Hit[] = []
let refusalsBeforeAnswer = Infinity
let retryAfter: string | undefined
let status = 503
let body: unknown = { error: { code: 503, status: 'UNAVAILABLE', message: overloadReason } }
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  hits.push({ url, atMs: Date.now() })
  if (url.endsWith('/token')) return Response.json({ access_token: access, expires_in: 3600 })
  if (hits.length <= refusalsBeforeAnswer) return Response.json(body, { status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } })
  if (url.includes('/chat/completions')) return sse([{ choices: [{ delta: { content: 'compat answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }])
  void init
  return sse([
    { candidates: [{ content: { role: 'model', parts: [{ text: 'native answer' }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
  ])
}) as typeof fetch
function reset(scale: string, opts: { refusals?: number; retryAfter?: string; status?: number; body?: unknown } = {}): void {
  hits.length = 0
  process.env.MERCURY_BUSY_RETRY_SCALE = scale
  refusalsBeforeAnswer = opts.refusals ?? Infinity
  retryAfter = opts.retryAfter
  status = opts.status ?? 503
  body = opts.body ?? { error: { code: 503, status: 'UNAVAILABLE', message: overloadReason } }
}
try {
  reset('0.01')
  const spent = await drain(geminiCallModel(params()))
  const spentNotices = notices(spent)
  const spentRed = redLines(spent)
  check('a 503 that never clears is retried six times on the scaled rungs: seven requests', hits.length === 7, `${hits.length} requests`)
  check('the five retries that begin inside the quiet window mint no notice; the sixth mints one with its true wait and place', spentNotices.length === 1 && spentNotices[0]?.retryInMs === 300 && spentNotices[0].retryAttempt === 6 && spentNotices[0].maxRetries === 6, JSON.stringify(spentNotices.map(notice => [notice.retryInMs, notice.retryAttempt, notice.maxRetries])))
  check("the spent ladder ends the turn with one red line that says how long Gemini stayed busy and keeps the wire's words as its tail", spentRed.length === 1 && /^API Error: Gemini stayed busy through 6 retries over \d+ s — Gemini stream failed \(api-UNAVAILABLE\) — /.test(spentRed[0] ?? '') && (spentRed[0] ?? '').endsWith(overloadReason) && spent.some(item => item.type === 'assistant' && item.error === 'server_error'), spentRed[0] ?? '(no red line)')
  check('no recovery stamp rides a spent ladder', stamped(spent).length === 0)
  const waits = hits.slice(1).map((hit, i) => hit.atMs - hits[i]!.atMs)
  check('the waits between requests grow with the rungs', waits.length === 6 && waits.every((wait, i) => wait >= [10, 20, 40, 80, 160, 300][i]! - 2) && waits[5]! > waits[0]!, JSON.stringify(waits))

  reset('0.6', { refusals: 2 })
  const recovered = await drain(geminiCallModel(params()))
  const marks = stamped(recovered)
  const stamp = marks[0]?.busyRecovery
  const firstAnswer = recovered.find(item => item.type === 'assistant')
  check('a refusal that clears on the third request answers with no notice and no red line', hits.length === 3 && notices(recovered).length === 0 && redLines(recovered).length === 0 && recovered.some(item => item.type === 'assistant' && item.message?.content.some(block => block.text === 'native answer')), `${hits.length} requests, ${notices(recovered).length} notices, ${redLines(recovered).length} red lines`)
  check('the first settled answer carries one recovery stamp naming the provider, the retries and the seconds; later blocks carry none', marks.length === 1 && marks[0] === firstAnswer && stamp?.provider === 'Gemini' && stamp.retries === 2 && stamp.elapsedMs >= 1800 && stamp.status === 503 && stamp.code === 'api-UNAVAILABLE', JSON.stringify(stamp))
  check("the stamp's detail carries Google's words, both waits and the request that answered", /^Gemini answered HTTP 503 \(api-UNAVAILABLE\): This model is currently experiencing high demand\. .* — retried after 1 s and 1 s, and the third request was answered\.$/.test(stamp?.detail ?? ''), stamp?.detail ?? '')

  reset('1')
  const controller = new AbortController()
  const stopAt = Date.now()
  setTimeout(() => controller.abort(), 100)
  const stopped = await drain(geminiCallModel(params(controller.signal)))
  const stoppedAfterMs = Date.now() - stopAt
  check("the operator's stop ends the first wait at once: one request, no red line, the road silent, well inside the 1 s rung", hits.length === 1 && redLines(stopped).length === 0 && notices(stopped).length === 0 && stoppedAfterMs < 1000, `${hits.length} requests, ${stoppedAfterMs} ms`)

  reset('0.01', { retryAfter: '1' })
  const askedRun = await drain(geminiCallModel(params()))
  const askedWait = hits.length === 2 ? hits[1]!.atMs - hits[0]!.atMs : -1
  check("a Retry-After inside the budget is honoured whole in place of the rung, spends the budget, and the next refusal ends the turn", hits.length === 2 && askedWait >= 990 && notices(askedRun).length === 0 && /stayed busy through 1 retry over 1 s/.test(redLines(askedRun)[0] ?? ''), `${hits.length} requests, ${askedWait} ms, ${redLines(askedRun)[0] ?? ''}`)

  reset('0.01', { retryAfter: '600' })
  const windowRun = await drain(geminiCallModel(params()))
  check('a provider wait outside the retry budget is still not slept or retried', hits.length === 1 && redLines(windowRun).length === 1 && !/stayed busy/.test(redLines(windowRun)[0] ?? ''), `${hits.length} requests`)

  reset('0.01', { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota reached' } } })
  const rate = await drain(geminiCallModel(params()))
  check('a 429 keeps the one-retry road: two requests, one notice of 400 ms as attempt 1 of 1', hits.length === 2 && notices(rate).length === 1 && notices(rate)[0]?.retryInMs === 400 && notices(rate)[0]?.retryAttempt === 1 && notices(rate)[0]?.maxRetries === 1 && rate.some(item => item.type === 'assistant' && item.error === 'rate_limit'), `${hits.length} requests, ${JSON.stringify(notices(rate).map(n => [n.retryInMs, n.retryAttempt, n.maxRetries]))}`)

  const plain: CompatLaneProfile = {
    lane: 'deepseek',
    providerLabel: 'DeepSeek',
    resolveCredential: () => ({ apiKey: 'fixture-deepseek-key' }),
    credentialHint: 'no DeepSeek credential detected.',
    requestUrl: () => 'https://gemini.fixture.invalid/deepseek/chat/completions',
    wireModelId: id => id,
    buildExtras: () => ({}),
  }
  reset('0.01')
  const other = await drain(compatChatCallModel(plain, params(undefined, 'deepseek-chat')))
  check('a lane whose profile takes no ladder keeps the one-retry road byte for byte: two requests, one notice of 400 ms as attempt 1 of 1, the plain red line', hits.length === 2 && notices(other).length === 1 && notices(other)[0]?.retryInMs === 400 && notices(other)[0]?.retryAttempt === 1 && notices(other)[0]?.maxRetries === 1 && redLines(other).length === 1 && (redLines(other)[0] ?? '').startsWith('API Error: DeepSeek stream failed (api-UNAVAILABLE) — ') && stamped(other).length === 0, `${hits.length} requests, ${JSON.stringify(notices(other).map(n => [n.retryInMs, n.retryAttempt, n.maxRetries]))}, ${redLines(other)[0] ?? ''}`)
} finally {
  globalThis.fetch = realFetch
  delete process.env.MERCURY_BUSY_RETRY_SCALE
}
console.log('── the other lanes and the router, untouched')
const { readFileSync } = await import('node:fs')
const untouched = ['deepseek/deepseekCallModel.ts', 'huggingface/huggingfaceCallModel.ts', 'local/localCallModel.ts', 'moonshot/moonshotCallModel.ts', 'openaicompat/compatCallModel.ts', 'openrouter/openrouterCallModel.ts', 'callModelRouter.ts', 'zai/zaiCallModel.ts', 'openai/openaiCallModel.ts']
for (const name of untouched) {
  const source = readFileSync(new URL(`../../src/services/providers/${name}`, import.meta.url), 'utf8')
  const delegating = !name.startsWith('zai/') && !name.startsWith('openai/') && name !== 'callModelRouter.ts'
  check(`${name} takes no ladder and keeps its yield union`, !source.includes('busyRetry') && !source.includes('BusyRecovery') && (!delegating || source.includes('): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {')))
}
const profiles = readFileSync(new URL('../../src/services/providers/gemini/geminiCallModel.ts', import.meta.url), 'utf8')
check('only the Gemini lane profile asks for the ladder', (profiles.match(/busyRetry: true/g) ?? []).length === 1 && readFileSync(new URL('../../src/services/providers/openaicompat/compatChatCallModel.ts', import.meta.url), 'utf8').includes("if (profile.busyRetry === true && outcome.retryEligible && isBusyRefusal(outcome.fault) && !providerWaitIsWindow(askedMs)) {"))
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
