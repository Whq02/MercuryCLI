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
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://gemini.fixture.invalid/token'
process.env.OPENAI_API_KEY = 'fixture-openai-key'
process.env.MERCURY_OPENAI_API_BASE = 'https://openai.fixture.invalid/v1'
process.env.ZAI_API_KEY = 'fixture-zai-key'
process.env.MERCURY_ZAI_API_BASE = 'https://zai.fixture.invalid/v4'
process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-key'
process.env.MERCURY_DEEPSEEK_API_BASE = 'https://deepseek.fixture.invalid'
process.env.MOONSHOT_API_KEY = 'fixture-moonshot-key'
process.env.MERCURY_MOONSHOT_API_BASE = 'https://moonshot.fixture.invalid/v1'
process.env.HF_TOKEN = 'fixture-hf-token'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'https://huggingface.fixture.invalid/v1'
process.env.OPENROUTER_API_KEY = 'fixture-openrouter-key'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://openrouter.fixture.invalid/api/v1'
process.env.MERCURY_COMPAT_BASE_URL = 'https://compat.fixture.invalid/v1'
process.env.MERCURY_COMPAT_MODELS = 'fixture-model'
process.env.MERCURY_COMPAT_LABEL = 'the fixture endpoint'
process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_MAX_RETRIES
delete process.env.MERCURY_DISABLE_NONSTREAMING_FALLBACK
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_BUSY_RETRY_SCALE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_MODEL', 'MERCURY_COMPAT_API_KEY']) delete process.env[name]
const access = 'ya29.fixture-busy-access'
writeFileSync(join(home, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'oauth', client: { clientId: 'fixture-client' }, tokens: { accessToken: access, refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const busy = await import('../../src/services/providers/busyRetry.ts')
const budgetModule = await import('../../src/services/api/recoveryBudget.ts')
const agentModule = (await import('../../src/tools/AgentTool/runAgent.ts')) as { makeRecoveryAccountant?: (args: { budget: unknown; cut: (cutting: { declaredMs: number; honoredMs: number }) => void; words?: (line: string | null) => void }) => { wait: (facts: unknown, loud: boolean) => { honoredMs: number; spent: boolean }; spoke: () => void; end: () => void; standing: () => boolean } }
const heldNoticeOf = (busy as { heldBusyRetryNotice?: (wait: unknown) => { retryInMs?: number; retryAttempt?: number; maxRetries?: number; subtype?: string } | null }).heldBusyRetryNotice ?? ((): null => null)
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { moonshotLaneProfile } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
const { huggingfaceLaneProfile } = await import('../../src/services/providers/huggingface/huggingfaceCallModel.ts')
const { openrouterLaneProfile } = await import('../../src/services/providers/openrouter/openrouterCallModel.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatCallModel } = await import('../../src/services/providers/openaicompat/compatCallModel.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const retrySeam = await import('../../src/services/api/withRetry.ts')
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
check("every road's documented busy status is a busy refusal: OpenAI's 503, DeepSeek's 503, OpenRouter's 503, Google's 503 UNAVAILABLE, Z.AI's 1305, and a vendor's unavailable or overloaded word on any status", busy.isBusyRefusal({ code: 'openai-server_error', status: 503, retryable: true }) && busy.isBusyRefusal({ code: 'http-503', status: 503, retryable: true }) && busy.isBusyRefusal({ code: 'zai-1305', status: 429, retryable: true }) && busy.isBusyRefusal({ code: 'openai-service_unavailable', retryable: true }) && busy.isBusyRefusal({ code: 'api-unavailable_error', status: 503, retryable: true }) && busy.isBusyRefusal({ code: 'api-engine_overloaded_error', status: 429, retryable: true }))
check("a rate limit (Z.AI's 1302, OpenAI's rate_limit_exceeded, a bare 429), Z.AI's network error and a first-byte timeout are not busy refusals", !busy.isBusyRefusal({ code: 'zai-1302', status: 429, retryable: true }) && !busy.isBusyRefusal({ code: 'openai-rate_limit_exceeded', status: 429, retryable: true }) && !busy.isBusyRefusal({ code: 'http-429', status: 429, retryable: true }) && !busy.isBusyRefusal({ code: 'zai-1234', status: 500, retryable: true }) && !busy.isBusyRefusal({ code: 'first-byte-timeout', retryable: true }))
check('the ladder is taken by a busy refusal and by a rate limit that names a wait; a rate limit without one and a fault with one keep the single retry', busy.takesBusyLadder?.({ code: 'http-429', status: 429, retryable: true, retryAfterMs: 2000 }, 'rate_limit') === true && busy.takesBusyLadder?.({ code: 'http-429', status: 429, retryable: true }, 'rate_limit') === false && busy.takesBusyLadder?.({ code: 'http-503', status: 503, retryable: true }, 'server_error') === true && busy.takesBusyLadder?.({ code: 'http-500', status: 500, retryable: true, retryAfterMs: 2000 }, 'server_error') === false && busy.takesBusyLadder?.({ code: 'http-503', status: 503, retryable: false }, 'server_error') === false)
check('the expansion names the status, the code, the words, every wait and which request was answered', busy.busyRecoveryDetail({ provider: 'Gemini', status: 503, code: 'api-UNAVAILABLE', message: 'busy words', waitsMs: [1000, 2000] }) === 'Gemini answered HTTP 503 (api-UNAVAILABLE): busy words — retried after 1 s and 2 s, and the third request was answered.')

console.log('── the ladder on the Gemini road, against a recording fixture')
const model = 'gemini-3.5-flash'
const overloadReason = 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
const ANSWER = 'road answer'
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(signal: AbortSignal = new AbortController().signal, modelId = model, door?: { agentId?: string; onWait: (wait: unknown) => void }): CompatCallModelParams {
  return {
    messages: [user('Say hello.')], systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: [], signal,
    options: { model: modelId, querySource: 'repl_main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64, ...(door === undefined ? {} : { onWait: door.onWait, ...(door.agentId !== undefined ? { agentId: door.agentId } : {}) }) } as never,
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
const answered = (items: Item[], text: string) => items.some(item => item.type === 'assistant' && item.message?.content.some(block => block.text === text))
const sse = (chunks: unknown[], done = false): Response => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } })
type Hit = { url: string; atMs: number }
const hits: Hit[] = []
let refusalsBeforeAnswer = Infinity
let retryAfter: string | undefined
let status = 503
let body: unknown = { error: { code: 503, status: 'UNAVAILABLE', message: overloadReason } }
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.endsWith('/token')) return Response.json({ access_token: access, expires_in: 3600 })
  const modelRoad = url.includes('/chat/completions') || url.endsWith('/responses') || url.includes(':streamGenerateContent')
  if (method !== 'POST' || !modelRoad) return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] })
  hits.push({ url, atMs: Date.now() })
  if (hits.length <= refusalsBeforeAnswer) return Response.json(body, { status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } })
  if (url.endsWith('/responses')) {
    return sse([
      { type: 'response.created', response: { id: 'resp_fixture' } },
      { type: 'response.output_text.delta', delta: ANSWER },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ANSWER }] } },
      { type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } },
    ])
  }
  if (url.includes('/chat/completions')) return sse([{ choices: [{ delta: { content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }], true)
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
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
type Road = {
  name: string
  provider: string
  model: string
  call: (p: CompatCallModelParams) => AsyncGenerator<unknown>
  busy: { status: number; body: unknown; code: string; message: string; typed: string; tail: string }
  rate: { status: number; body: unknown }
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
  check('a refusal that clears on the third request answers with no notice and no red line', hits.length === 3 && notices(recovered).length === 0 && redLines(recovered).length === 0 && answered(recovered, 'native answer'), `${hits.length} requests, ${notices(recovered).length} notices, ${redLines(recovered).length} red lines`)
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
  check('a 429 without a wait keeps the one-retry road: two requests, one notice of 400 ms as attempt 1 of 1', hits.length === 2 && notices(rate).length === 1 && notices(rate)[0]?.retryInMs === 400 && notices(rate)[0]?.retryAttempt === 1 && notices(rate)[0]?.maxRetries === 1 && rate.some(item => item.type === 'assistant' && item.error === 'rate_limit'), `${hits.length} requests, ${JSON.stringify(notices(rate).map(n => [n.retryInMs, n.retryAttempt, n.maxRetries]))}`)

  reset('0.01', { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota reached' } }, refusals: 1, retryAfter: '1' })
  const rateAsked = await drain(geminiCallModel(params()))
  const rateAskedWait = hits.length === 2 ? hits[1]!.atMs - hits[0]!.atMs : -1
  check("a 429 with a wait rides the ladder: the ask slept whole and quietly, the second request answered, one stamp naming 1 retry", hits.length === 2 && rateAskedWait >= 990 && notices(rateAsked).length === 0 && redLines(rateAsked).length === 0 && answered(rateAsked, 'native answer') && stamped(rateAsked)[0]?.busyRecovery?.retries === 1, `${hits.length} requests, ${rateAskedWait} ms, ${notices(rateAsked).length} notices, ${redLines(rateAsked)[0] ?? ''}`)

  const localProfile: CompatLaneProfile = localLaneProfileFor({ id: 'llama-fixture', server: 'ollama', baseUrl: 'https://local.fixture.invalid/v1' })
  const roads: Road[] = [
    { name: 'openai', provider: 'OpenAI', model: 'gpt-5.6-sol', call: p => openaiCallModel(p as never) as AsyncGenerator<unknown>, busy: { status: 503, body: { error: { type: 'server_error', message: 'The requested model is temporarily overloaded.' } }, code: 'openai-server_error', message: 'The requested model is temporarily overloaded.', typed: 'server_error', tail: 'OpenAI stream failed (openai-server_error) — ' }, rate: { status: 429, body: { error: { type: 'rate_limit_exceeded', message: 'Rate limit reached for requests' } } } },
    { name: 'zai', provider: 'Z.AI', model: 'glm-5.2', call: p => zaiCallModel(p as never) as AsyncGenerator<unknown>, busy: { status: 429, body: { error: { code: '1305', message: 'The service may be temporarily overloaded, please try again later' } }, code: 'zai-1305', message: 'The service may be temporarily overloaded, please try again later', typed: 'rate_limit', tail: 'Z.AI is rate-limiting this account (zai-1305: ' }, rate: { status: 429, body: { error: { code: '1302', message: 'Rate limit reached for requests' } } } },
    { name: 'deepseek', provider: 'DeepSeek', model: 'deepseek-chat', call: p => compatChatCallModel(deepseekLaneProfile, p), busy: { status: 503, body: { error: { message: 'The server is overloaded due to high traffic. Please retry your request after a brief wait.' } }, code: 'http-503', message: 'The server is overloaded due to high traffic. Please retry your request after a brief wait.', typed: 'server_error', tail: 'DeepSeek stream failed (http-503) — ' }, rate: { status: 429, body: { error: { message: 'You are sending requests too quickly.', type: 'rate_limit_error', code: 'rate_limit_reached' } } } },
    { name: 'moonshot', provider: 'Moonshot', model: 'kimi-k3', call: p => compatChatCallModel(moonshotLaneProfile, p), busy: { status: 503, body: { error: { type: 'server_error', message: 'the engine is busy' } }, code: 'api-server_error', message: 'the engine is busy', typed: 'server_error', tail: 'Moonshot stream failed (api-server_error) — ' }, rate: { status: 429, body: { error: { type: 'rate_limit_reached_error', message: 'Your request reached rate limit' } } } },
    { name: 'huggingface', provider: 'Hugging Face', model: 'huggingface/org/model', call: p => compatChatCallModel(huggingfaceLaneProfile, p), busy: { status: 503, body: { error: 'Service Unavailable' }, code: 'http-503', message: 'Service Unavailable', typed: 'server_error', tail: 'Hugging Face stream failed (http-503) — ' }, rate: { status: 429, body: { error: 'Rate limit reached' } } },
    { name: 'openrouter', provider: 'OpenRouter', model: 'openrouter/vendor/model', call: p => compatChatCallModel(openrouterLaneProfile, p), busy: { status: 503, body: { error: { code: 503, message: 'There is no available model provider that meets your routing requirements' } }, code: 'http-503', message: 'There is no available model provider that meets your routing requirements', typed: 'server_error', tail: 'OpenRouter stream failed (http-503) — ' }, rate: { status: 429, body: { error: { code: 429, message: 'You are being rate limited' } } } },
    { name: 'local', provider: localProfile.providerLabel, model: 'local/llama-fixture', call: p => compatChatCallModel(localProfile, p), busy: { status: 503, body: { error: { message: 'Loading model', type: 'unavailable_error' } }, code: 'api-unavailable_error', message: 'Loading model', typed: 'server_error', tail: `${localProfile.providerLabel} stream failed (api-unavailable_error) — ` }, rate: { status: 429, body: { error: { message: 'too many requests', type: 'rate_limit_error' } } } },
    { name: 'openai-compat', provider: 'the fixture endpoint', model: 'compat/fixture-model', call: p => compatCallModel(p), busy: { status: 503, body: { error: { type: 'server_error', message: 'the endpoint is overloaded' } }, code: 'api-server_error', message: 'the endpoint is overloaded', typed: 'server_error', tail: 'the fixture endpoint stream failed (api-server_error) — ' }, rate: { status: 429, body: { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'too many requests' } } } },
  ]
  for (const road of roads) {
    console.log(`── the ladder on the ${road.provider} road`)
    reset('0.01', { status: road.busy.status, body: road.busy.body })
    const roadSpent = await drain(road.call(params(undefined, road.model)))
    const roadNotices = notices(roadSpent)
    const roadRed = redLines(roadSpent)
    check(`${road.name}: a busy refusal that never clears is retried six times on the scaled rungs: seven requests`, hits.length === 7, `${hits.length} requests`)
    check(`${road.name}: the five retries inside the quiet window mint no notice; the sixth mints one with its true wait and place`, roadNotices.length === 1 && roadNotices[0]?.retryInMs === 300 && roadNotices[0].retryAttempt === 6 && roadNotices[0].maxRetries === 6, JSON.stringify(roadNotices.map(notice => [notice.retryInMs, notice.retryAttempt, notice.maxRetries])))
    check(`${road.name}: the spent ladder ends the turn with one red line naming ${road.provider} and how long it stayed busy, the wire's words as its tail`, roadRed.length === 1 && new RegExp(`^API Error: ${escape(road.provider)} stayed busy through 6 retries over \\d+ s — ${escape(road.busy.tail)}`).test(roadRed[0] ?? '') && (roadRed[0] ?? '').includes(road.busy.message) && roadSpent.some(item => item.type === 'assistant' && item.error === road.busy.typed), roadRed[0] ?? '(no red line)')
    check(`${road.name}: no recovery stamp rides a spent ladder`, stamped(roadSpent).length === 0)
    const roadWaits = hits.slice(1).map((hit, i) => hit.atMs - hits[i]!.atMs)
    check(`${road.name}: the waits between requests grow with the rungs`, roadWaits.length === 6 && roadWaits.every((wait, i) => wait >= [10, 20, 40, 80, 160, 300][i]! - 2) && roadWaits[5]! > roadWaits[0]!, JSON.stringify(roadWaits))

    reset('0.6', { status: road.busy.status, body: road.busy.body, refusals: 2 })
    const roadRecovered = await drain(road.call(params(undefined, road.model)))
    const roadMarks = stamped(roadRecovered)
    const roadStamp = roadMarks[0]?.busyRecovery
    const roadFirstAnswer = roadRecovered.find(item => item.type === 'assistant')
    check(`${road.name}: a refusal that clears on the third request answers with no notice and no red line`, hits.length === 3 && notices(roadRecovered).length === 0 && redLines(roadRecovered).length === 0 && answered(roadRecovered, ANSWER), `${hits.length} requests, ${notices(roadRecovered).length} notices, ${redLines(roadRecovered).length} red lines`)
    check(`${road.name}: the first settled answer carries one recovery stamp naming ${road.provider}, 2 retries and the seconds`, roadMarks.length === 1 && roadMarks[0] === roadFirstAnswer && roadStamp?.provider === road.provider && roadStamp.retries === 2 && roadStamp.elapsedMs >= 1800 && roadStamp.status === road.busy.status && roadStamp.code === road.busy.code, JSON.stringify(roadStamp))
    check(`${road.name}: the stamp's detail carries the wire's words, both waits and the request that answered`, new RegExp(`^${escape(road.provider)} answered HTTP ${road.busy.status} \\(${escape(road.busy.code)}\\): ${escape(road.busy.message)} — retried after 1 s and 1 s, and the third request was answered\\.$`).test(roadStamp?.detail ?? ''), roadStamp?.detail ?? '')

    reset('1', { status: road.busy.status, body: road.busy.body })
    const roadController = new AbortController()
    const roadStopAt = Date.now()
    setTimeout(() => roadController.abort(), 100)
    const roadStopped = await drain(road.call(params(roadController.signal, road.model)))
    const roadStoppedAfterMs = Date.now() - roadStopAt
    check(`${road.name}: the operator's stop ends the first wait at once: one request, no red line, the road silent, well inside the 1 s rung`, hits.length === 1 && redLines(roadStopped).length === 0 && notices(roadStopped).length === 0 && roadStoppedAfterMs < 1000, `${hits.length} requests, ${roadStoppedAfterMs} ms`)

    reset('0.01', { status: road.busy.status, body: road.busy.body })
    const agentDoor: unknown[] = []
    const heldRun = await drain(road.call(params(undefined, road.model, { agentId: 'agent-held', onWait: wait => agentDoor.push(wait) })))
    const held = agentDoor.map(heldNoticeOf).filter(notice => notice !== null)
    check(`${road.name}: on an agent's road each of the five quiet retries hands its held notice through the wait door — attempt n of 6 with the rung as its wait — and the loud sixth mints the notice and hands nothing`, held.length === 5 && held.every((notice, i) => notice?.subtype === 'api_error' && notice.retryInMs === [10, 20, 40, 80, 160][i] && notice.retryAttempt === i + 1 && notice.maxRetries === 6) && notices(heldRun).length === 1 && hits.length === 7, `${held.length} held, ${JSON.stringify(held.map(notice => [notice?.retryInMs, notice?.retryAttempt, notice?.maxRetries]))}, ${notices(heldRun).length} notices, ${hits.length} requests`)
    reset('0.01', { status: road.busy.status, body: road.busy.body })
    const mainDoor: unknown[] = []
    await drain(road.call(params(undefined, road.model, { onWait: wait => mainDoor.push(wait) })))
    check(`${road.name}: the main chat's door (no agent) receives no held notice — the quiet window stays silent on every channel`, mainDoor.every(wait => heldNoticeOf(wait) === null) && hits.length === 7, `${mainDoor.filter(wait => heldNoticeOf(wait) !== null).length} held on the main door`)

    reset('0.01', { status: road.rate.status, body: road.rate.body })
    const roadRate = await drain(road.call(params(undefined, road.model)))
    check(`${road.name}: a rate limit without a wait keeps the one-retry road: two requests, one notice of 400 ms as attempt 1 of 1, the rate-limit line`, hits.length === 2 && notices(roadRate).length === 1 && notices(roadRate)[0]?.retryInMs === 400 && notices(roadRate)[0]?.retryAttempt === 1 && notices(roadRate)[0]?.maxRetries === 1 && roadRate.some(item => item.type === 'assistant' && item.error === 'rate_limit') && redLines(roadRate).length === 1 && !/stayed busy/.test(redLines(roadRate)[0] ?? ''), `${hits.length} requests, ${JSON.stringify(notices(roadRate).map(n => [n.retryInMs, n.retryAttempt, n.maxRetries]))}, ${redLines(roadRate)[0] ?? ''}`)

    reset('0.01', { status: road.rate.status, body: road.rate.body, refusals: 1, retryAfter: '1' })
    const roadRateAsked = await drain(road.call(params(undefined, road.model)))
    const roadRateAskedWait = hits.length === 2 ? hits[1]!.atMs - hits[0]!.atMs : -1
    check(`${road.name}: a rate limit with a wait rides the ladder: the ask slept whole and quietly, the second request answered, one stamp naming 1 retry`, hits.length === 2 && roadRateAskedWait >= 990 && notices(roadRateAsked).length === 0 && redLines(roadRateAsked).length === 0 && answered(roadRateAsked, ANSWER) && stamped(roadRateAsked)[0]?.busyRecovery?.retries === 1, `${hits.length} requests, ${roadRateAskedWait} ms, ${notices(roadRateAsked).length} notices, ${redLines(roadRateAsked)[0] ?? ''}`)
  }

  console.log('── the ladder on the home road (the first-party wire): HTTP 529 overloaded_error')
  const HOME_MODEL = 'claude-fable-5-1'
  const HOME_ANSWER = 'home answer'
  const OVERLOADED_BODY = (n: number): string => JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: `req_fixture_529_${n}` })
  const homeSse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
  const homeUsage = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
  const homeStreamAnswer = (): Response =>
    new Response(
      [
        homeSse('message_start', { type: 'message_start', message: { id: 'msg_fixture_home', type: 'message', role: 'assistant', model: HOME_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: homeUsage } }),
        homeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        homeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: HOME_ANSWER } }),
        homeSse('content_block_stop', { type: 'content_block_stop', index: 0 }),
        homeSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: homeUsage }),
        homeSse('message_stop', { type: 'message_stop' }),
      ].join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture_home_stream' } },
    )
  const homeMidStreamOverload = (): Response =>
    new Response(
      homeSse('message_start', { type: 'message_start', message: { id: 'msg_fixture_cut', type: 'message', role: 'assistant', model: HOME_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: homeUsage } }) +
        homeSse('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_fixture_mid_stream' }),
      { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture_mid_stream' } },
    )
  const homeJsonAnswer = (): Response =>
    Response.json({ id: 'msg_fixture_home_json', type: 'message', role: 'assistant', model: HOME_MODEL, content: [{ type: 'text', text: HOME_ANSWER }], stop_reason: 'end_turn', stop_sequence: null, usage: homeUsage }, { headers: { 'request-id': 'req_fixture_home_json' } })
  type HomeHit = { atMs: number; stream: boolean }
  type HomeScript = { refusals: number; midStream?: boolean; retryAfter?: string }
  function homeFetch(script: HomeScript, homeHits: HomeHit[]): typeof fetch {
    return (async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { stream?: boolean }) : {}
      homeHits.push({ atMs: Date.now(), stream: body.stream === true })
      const n = homeHits.length
      if (script.midStream === true && n === 1) return homeMidStreamOverload()
      const refused = script.midStream === true ? n - 1 <= script.refusals : n <= script.refusals
      if (refused) return new Response(OVERLOADED_BODY(n), { status: 529, headers: { 'content-type': 'application/json', 'request-id': `req_fixture_529_${n}`, ...(script.retryAfter === undefined ? {} : { 'retry-after': script.retryAfter }) } })
      return body.stream === true ? homeStreamAnswer() : homeJsonAnswer()
    }) as unknown as typeof fetch
  }
  function homeCall(script: HomeScript, opts: { querySource?: string; signal?: AbortSignal; door?: { agentId?: string; onWait: (wait: unknown) => void }; model?: string; fallbackModel?: string } = {}): { generator: AsyncGenerator<unknown>; homeHits: HomeHit[] } {
    const homeHits: HomeHit[] = []
    const generator = queryModelWithStreaming({
      messages: [user('Say hello.')],
      systemPrompt: asSystemPrompt(['Only answer the request.']),
      thinkingConfig: { type: 'disabled' } as never,
      tools: [],
      signal: opts.signal ?? new AbortController().signal,
      options: {
        model: opts.model ?? HOME_MODEL,
        ...(opts.fallbackModel === undefined ? {} : { fallbackModel: opts.fallbackModel }),
        querySource: opts.querySource ?? 'repl_main_thread',
        isNonInteractiveSession: true,
        fetchOverride: homeFetch(script, homeHits) as never,
        getToolPermissionContext: async () => getEmptyToolPermissionContext(),
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        maxOutputTokensOverride: 64,
        skipCacheWrite: true,
        ...(opts.door === undefined ? {} : { onWait: opts.door.onWait, ...(opts.door.agentId !== undefined ? { agentId: opts.door.agentId } : {}) }),
      } as never,
    }) as AsyncGenerator<unknown>
    return { generator, homeHits }
  }
  const homeWaits = (homeHits: HomeHit[]): number[] => homeHits.slice(1).map((hit, i) => hit.atMs - homeHits[i]!.atMs)
  const foreground = (retrySeam as { isForegroundQuerySource?: (source: string) => boolean }).isForegroundQuerySource ?? ((): undefined => undefined)
  check("the retry seam counts every sub-agent source as foreground — a resumed built-in agent's turn included — and a background summary as not", foreground('agent:builtin:mercury-general') === true && foreground('agent:custom') === true && foreground('repl_main_thread') === true && foreground('sdk') === true && foreground('agent_summary') === false && foreground('generate_session_title') === false)

  reset('0.01')
  {
    const run = homeCall({ refusals: Infinity })
    const spentHome = await drain(run.generator)
    const spentHomeNotices = notices(spentHome)
    const spentHomeRed = redLines(spentHome)
    check('home: a 529 that never clears is retried six times on the scaled rungs: seven requests', run.homeHits.length === 7, `${run.homeHits.length} requests`)
    check('home: the five retries that begin inside the quiet window mint no notice; the sixth mints one with its true wait and place', spentHomeNotices.length === 1 && spentHomeNotices[0]?.retryInMs === 300 && spentHomeNotices[0].retryAttempt === 6 && spentHomeNotices[0].maxRetries === 6, JSON.stringify(spentHomeNotices.map(notice => [notice.retryInMs, notice.retryAttempt, notice.maxRetries])))
    check("home: the spent ladder ends the turn with one red line carrying the wire's 529 answer, its words unchanged", spentHomeRed.length === 1 && /^API Error: 529 \{"type":"error","error":\{"type":"overloaded_error","message":"Overloaded"\}/.test(spentHomeRed[0] ?? ''), spentHomeRed[0] ?? '(no red line)')
    const waits = homeWaits(run.homeHits)
    check('home: the waits between requests grow with the rungs', waits.length === 6 && waits.every((wait, i) => wait >= [10, 20, 40, 80, 160, 300][i]! - 2) && waits[5]! > waits[0]!, JSON.stringify(waits))
  }
  reset('0.01')
  {
    const run = homeCall({ refusals: Infinity }, { querySource: 'agent:builtin:mercury-general' })
    const resumedSpent = await drain(run.generator)
    check("home: a resumed built-in sub-agent's turn (source agent:builtin:<type>) rides the same ladder instead of dying on its first 529: seven requests, one red line", run.homeHits.length === 7 && redLines(resumedSpent).length === 1 && notices(resumedSpent).length === 1, `${run.homeHits.length} requests, ${notices(resumedSpent).length} notices, ${redLines(resumedSpent).length} red lines`)
  }
  reset('0.6')
  {
    const run = homeCall({ refusals: 2 })
    const recoveredHome = await drain(run.generator)
    check('home: a 529 that clears on the third request answers with no notice and no red line', run.homeHits.length === 3 && notices(recoveredHome).length === 0 && redLines(recoveredHome).length === 0 && answered(recoveredHome, HOME_ANSWER), `${run.homeHits.length} requests, ${notices(recoveredHome).length} notices, ${redLines(recoveredHome).length} red lines`)
  }
  reset('0.01')
  {
    const run = homeCall({ refusals: 3, midStream: true })
    const midStream = await drain(run.generator)
    const midNotices = notices(midStream)
    const fallbackNotices = midNotices.filter(notice => notice.retryInMs === 0 && (notice as { recoveryTimeoutMs?: number }).recoveryTimeoutMs !== undefined && (notice as { recoveryTimeoutMs?: number }).recoveryTimeoutMs! > 0)
    check("home: an overloaded_error inside the stream (no HTTP status) takes the non-streamed recovery — one notice with a ceiling, attempt 1 of 1 — and the recovery's 529s ride the quiet ladder: five requests, no retry notice, the answer", run.homeHits.length === 5 && run.homeHits[0]?.stream === true && run.homeHits.slice(1).every(hit => !hit.stream) && fallbackNotices.length === 1 && fallbackNotices[0]?.retryAttempt === 1 && fallbackNotices[0].maxRetries === 1 && midNotices.filter(notice => notice.retryInMs > 0).length === 0 && redLines(midStream).length === 0 && answered(midStream, HOME_ANSWER), `${run.homeHits.length} requests (${run.homeHits.map(hit => (hit.stream ? 'stream' : 'json')).join(',')}), notices ${JSON.stringify(midNotices.map(notice => [notice.retryInMs, notice.retryAttempt, notice.maxRetries]))}, red ${redLines(midStream).length}`)
  }
  reset('1')
  {
    const controller = new AbortController()
    const stopAt = Date.now()
    setTimeout(() => controller.abort(), 100)
    const run = homeCall({ refusals: Infinity }, { signal: controller.signal })
    const stoppedHome = await drain(run.generator)
    const stoppedAfterMs = Date.now() - stopAt
    check("home: the operator's stop ends the first wait at once: one request, no red line, the road silent, well inside the 1 s rung", run.homeHits.length === 1 && redLines(stoppedHome).length === 0 && notices(stoppedHome).length === 0 && stoppedAfterMs < 1000, `${run.homeHits.length} requests, ${stoppedAfterMs} ms`)
  }
  reset('0.01')
  {
    const agentDoor: unknown[] = []
    const run = homeCall({ refusals: Infinity }, { door: { agentId: 'agent-held', onWait: wait => agentDoor.push(wait) } })
    const heldHome = await drain(run.generator)
    const held = agentDoor.map(heldNoticeOf).filter(notice => notice !== null)
    check("home: on an agent's road each of the five quiet retries hands its held notice through the wait door — attempt n of 6 with the rung as its wait — and the loud sixth mints the notice and hands nothing", held.length === 5 && held.every((notice, i) => notice?.subtype === 'api_error' && notice.retryInMs === [10, 20, 40, 80, 160][i] && notice.retryAttempt === i + 1 && notice.maxRetries === 6) && notices(heldHome).length === 1 && run.homeHits.length === 7, `${held.length} held, ${JSON.stringify(held.map(notice => [notice?.retryInMs, notice?.retryAttempt, notice?.maxRetries]))}, ${notices(heldHome).length} notices, ${run.homeHits.length} requests`)
  }
  reset('0.01')
  {
    const mainDoor: unknown[] = []
    const run = homeCall({ refusals: Infinity }, { door: { onWait: wait => mainDoor.push(wait) } })
    await drain(run.generator)
    check("home: the main chat's door (no agent) receives no held notice — the quiet window stays silent on every channel", mainDoor.every(wait => heldNoticeOf(wait) === null) && run.homeHits.length === 7, `${mainDoor.filter(wait => heldNoticeOf(wait) !== null).length} held on the main door`)
  }
  reset('0.01')
  {
    const run = homeCall({ refusals: 1, retryAfter: '1' })
    const askedHome = await drain(run.generator)
    const askedWait = run.homeHits.length === 2 ? run.homeHits[1]!.atMs - run.homeHits[0]!.atMs : -1
    check("home: a Retry-After on the 529 inside the budget is honoured whole in place of the rung, quietly, and the second request answers", run.homeHits.length === 2 && askedWait >= 990 && notices(askedHome).length === 0 && redLines(askedHome).length === 0 && answered(askedHome, HOME_ANSWER), `${run.homeHits.length} requests, ${askedWait} ms, ${notices(askedHome).length} notices`)
  }

  console.log('── the three-strikes door on the home road: an Opus model on an API key')
  const DOOR_MODEL = 'claude-opus-5'
  reset('0.01')
  {
    const run = homeCall({ refusals: 3 }, { model: DOOR_MODEL })
    const cleared = await drain(run.generator)
    check('door: three 529s in a row on an Opus model with an API key do not end the turn — the ladder runs first and the fourth request answers, no red line', run.homeHits.length === 4 && redLines(cleared).length === 0 && answered(cleared, HOME_ANSWER), `${run.homeHits.length} requests, ${redLines(cleared)[0] ?? 'no red line'}`)
  }
  reset('0.01')
  {
    const run = homeCall({ refusals: Infinity }, { model: DOOR_MODEL })
    const spentDoor = await drain(run.generator)
    check("door: a 529 that never clears walks every rung, and only then does the door end the turn with the repeated-overload line: seven requests, one red line in the door's words", run.homeHits.length === 7 && redLines(spentDoor).length === 1 && /Repeated API overload errors \(529\)/.test(redLines(spentDoor)[0] ?? ''), `${run.homeHits.length} requests, ${redLines(spentDoor)[0] ?? 'no red line'}`)
  }
  reset('0.01')
  {
    const run = homeCall({ refusals: Infinity }, { model: DOOR_MODEL, fallbackModel: 'claude-sonnet-5' })
    let fallback: unknown = null
    try {
      await drain(run.generator)
    } catch (error) {
      fallback = error
    }
    check('door: with a fallback model named, the spent ladder votes the fallback — seven requests, then the fallback signal', run.homeHits.length === 7 && fallback instanceof retrySeam.FallbackTriggeredError, `${run.homeHits.length} requests, ${fallback === null ? 'no signal' : String((fallback as Error).message).slice(0, 80)}`)
  }
  reset('0.6')
  {
    const run = homeCall({ refusals: 2 }, { model: 'claude-sonnet-5' })
    const other = await drain(run.generator)
    check('door: a model the door does not count keeps the plain ladder — a 529 that clears on the third request answers with no red line', run.homeHits.length === 3 && redLines(other).length === 0 && answered(other, HOME_ANSWER), `${run.homeHits.length} requests`)
  }

  console.log("── the agent's budget bounds the quiet ladder: a six-second budget ends it in about six seconds on every road with the quiet branch")
  check('runAgent exports the recovery accountant the door and the loop share', typeof agentModule.makeRecoveryAccountant === 'function')
  type BoundedRun = { name: string; run: (signal: AbortSignal, door: (wait: unknown) => void) => Promise<{ items: Item[]; requests: number }> }
  const boundedRuns: BoundedRun[] = [
    ...roads.filter(r => r.name === 'openai' || r.name === 'zai' || r.name === 'deepseek').map(road => ({
      name: road.name,
      run: async (signal: AbortSignal, door: (wait: unknown) => void) => {
        reset('1', { status: road.busy.status, body: road.busy.body })
        const items = await drain(road.call(params(signal, road.model, { agentId: 'agent-bound', onWait: door })))
        return { items, requests: hits.length }
      },
    })),
    {
      name: 'home',
      run: async (signal: AbortSignal, door: (wait: unknown) => void) => {
        reset('1')
        const home = homeCall({ refusals: Infinity }, { signal, door: { agentId: 'agent-bound', onWait: door } })
        const items = await drain(home.generator)
        return { items, requests: home.homeHits.length }
      },
    },
  ]
  for (const road of boundedRuns) {
    const controller = new AbortController()
    const budget = budgetModule.makeRecoveryBudget(6_000)
    const words: Array<string | null> = []
    let cut: unknown = null
    const accountant = agentModule.makeRecoveryAccountant?.({ budget, cut: cutting => { cut = new budgetModule.RecoveryBudgetSpentError(budget, cutting); controller.abort(cut) }, words: line => words.push(line) })
    const door = (wait: unknown): void => {
      const heldNotice = heldNoticeOf(wait)
      if (heldNotice === null || accountant === undefined) return
      const facts = budgetModule.recoveryNoticeFacts(heldNotice)
      if (facts !== null) accountant.wait(facts, false)
    }
    const startedAt = Date.now()
    const bounded = await road.run(controller.signal, door)
    const elapsedMs = Date.now() - startedAt
    check(`${road.name}: a 1 s, a 2 s and a 4 s quiet wait, the third cut at the budget — three requests and the ladder over after about six seconds, not sixty-one`, bounded.requests === 3 && elapsedMs >= 5_800 && elapsedMs < 9_000 && cut instanceof budgetModule.RecoveryBudgetSpentError, `${bounded.requests} requests, ${elapsedMs} ms, cut=${cut === null ? 'none' : String((cut as Error).message).slice(0, 80)}`)
    const spent = cut as { waits?: number; message?: string } | null
    check(`${road.name}: the cut counts the three quiet waits against the six-second budget, and nothing was painted — no notice, no words`, spent !== null && spent.waits === 3 && /6s retry budget is spent/.test(spent.message ?? '') && words.length === 0 && notices(bounded.items).length === 0, `waits=${spent?.waits} words=${words.length} notices=${notices(bounded.items).length} ${spent?.message ?? ''}`)
  }
} finally {
  globalThis.fetch = realFetch
  delete process.env.MERCURY_BUSY_RETRY_SCALE
}
console.log('── every road takes the one ladder; the lanes keep their yield union')
const { readFileSync } = await import('node:fs')
const source = (name: string): string => readFileSync(new URL(`../../src/services/providers/${name}`, import.meta.url), 'utf8')
for (const name of ['deepseek/deepseekCallModel.ts', 'huggingface/huggingfaceCallModel.ts', 'local/localCallModel.ts', 'moonshot/moonshotCallModel.ts', 'openaicompat/compatCallModel.ts', 'openrouter/openrouterCallModel.ts', 'gemini/geminiCallModel.ts']) {
  check(`${name} keeps its yield union and asks for no ladder of its own`, !source(name).includes('busyRetry') && source(name).includes('): AsyncGenerator<StreamEvent | AssistantMessage | SystemAPIErrorMessage, void> {'))
}
check('callModelRouter.ts takes no ladder', !source('callModelRouter.ts').includes('busyRetry'))
for (const name of ['openaicompat/compatChatCallModel.ts', 'openai/openaiCallModel.ts', 'zai/zaiCallModel.ts']) {
  const text = source(name)
  check(`${name} opens the one ladder and sleeps every retry wait through the abortable sleep`, text.includes('openBusyRetryLadder(') && text.includes('takesBusyLadder(') && text.includes('await sleep(step.waitMs, signal)') && text.includes('await sleep(delayMs, signal)') && !text.includes('setTimeout(resolve, delayMs)'))
}
check('no profile seam decides the ladder: every lane rides it', !source('openaicompat/compatChatCallModel.ts').includes('busyRetry?:') && !source('openaicompat/compatChatCallModel.ts').includes('profile.busyRetry'))
for (const name of ['openaicompat/compatChatCallModel.ts', 'openai/openaiCallModel.ts', 'zai/zaiCallModel.ts']) {
  const text = source(name)
  check(`${name} hands a quiet step's held notice through the wait door only on an agent's road`, text.includes("else if (options.agentId !== undefined) options.onWait?.(heldBusyRetryWait(step, notice))"))
}
const retrySource = readFileSync(new URL('../../src/services/api/withRetry.ts', import.meta.url), 'utf8')
check('the home road\'s retry seam opens the one ladder for an overload and hands a quiet step\'s held notice through its door', retrySource.includes('openBusyRetryLadder(') && retrySource.includes('nextBusyRetry(') && retrySource.includes('heldBusyRetryWait(step, notice)') && retrySource.includes('await sleep(step.waitMs, options.signal)'))
const streamSource = readFileSync(new URL('../../src/services/providers/anthropic/streamCore.ts', import.meta.url), 'utf8')
check('the home road binds that door to the wait door only on an agent\'s road, on the streamed attempt and on every non-streamed recovery', streamSource.includes("options.agentId !== undefined ? (wait: HeldBusyRetryWait): void => options.onWait?.(wait) : undefined") && streamSource.split('onHeldWait: heldWaitDoor').length === 4)
const agentSource = readFileSync(new URL('../../src/tools/AgentTool/runAgent.ts', import.meta.url), 'utf8')
check("runAgent's door charges a held notice through the accountant and forwards it to no row", agentSource.includes('const heldNotice = heldBusyRetryNotice(wait)') && agentSource.includes('accountant.wait(facts, false)') && agentSource.includes('accountant.wait(notice, true)'))
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
