import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'empty-stream-roads-'))
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
process.env.XAI_API_KEY = 'fixture-xai-key'
process.env.MERCURY_XAI_API_BASE = 'https://xai.fixture.invalid/v1'
process.env.MODEL_API_KEY = 'fixture-meta-key'
process.env.MERCURY_META_API_BASE = 'https://meta.fixture.invalid/v1'
process.env.MERCURY_COMPAT_BASE_URL = 'https://compat.fixture.invalid/v1'
process.env.MERCURY_COMPAT_MODELS = 'fixture-model'
process.env.MERCURY_COMPAT_LABEL = 'the fixture endpoint'
process.env.ANTHROPIC_API_KEY = 'fixture-anthropic-key'
process.env.MERCURY_BUSY_RETRY_SCALE = '0.1'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_MAX_RETRIES
delete process.env.MERCURY_DISABLE_NONSTREAMING_FALLBACK
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_MODEL', 'MERCURY_COMPAT_API_KEY']) delete process.env[name]
const access = 'ya29.fixture-empty-access'
writeFileSync(join(home, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'oauth', client: { clientId: 'fixture-client' }, tokens: { accessToken: access, refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const law = await import('../../src/services/providers/emptyStreamRetry.ts')
const idle = await import('../../src/services/providers/streamIdleBudget.ts')
const budget = await import('../../src/services/api/recoveryBudget.ts')
const spinner = await import('../../src/components/Spinner/liveCounterWords.ts')
const { geminiCallModel } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { compatChatCallModel } = await import('../../src/services/providers/openaicompat/compatChatCallModel.ts')
const { openaiCallModel } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { zaiCallModel } = await import('../../src/services/providers/zai/zaiCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { moonshotLaneProfile } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
const { huggingfaceLaneProfile } = await import('../../src/services/providers/huggingface/huggingfaceCallModel.ts')
const { openrouterLaneProfile } = await import('../../src/services/providers/openrouter/openrouterCallModel.ts')
const { xaiLaneProfile } = await import('../../src/services/providers/xai/xaiCallModel.ts')
const { metaLaneProfile } = await import('../../src/services/providers/meta/metaCallModel.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatCallModel } = await import('../../src/services/providers/openaicompat/compatCallModel.ts')
const { streamOpenrouterResponses } = await import('../../src/services/providers/openrouter/openrouterResponsesTransport.ts')
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { queryModelWithStreaming } = await import('../../src/services/providers/anthropic/streamCore.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
import type { Message } from '../../src/types/message.ts'
import type { CompatCallModelParams, CompatLaneProfile } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

let checks = 0
let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MARKER = 'ended the stream before its first event'
const REASON = 'an empty stream'
const TRIES = 3

console.log('── the law, pure')
check('three tries in all', law.EMPTY_STREAM_TRIES === 3)
const realRandom = Math.random
const waitAt = (r: number, scale?: number): number => {
  Math.random = () => r
  try {
    return scale === undefined ? law.emptyStreamRetryWaitMs() : law.emptyStreamRetryWaitMs(scale)
  } finally {
    Math.random = realRandom
  }
}
check("the wait is the capacity ladder's first rung (1 s) with its symmetric jitter: 750 ms at the low end, 1 s in the middle, 1250 ms at the top — never outside", waitAt(0, 1) === 750 && waitAt(0.5, 1) === 1000 && waitAt(0.999, 1) === 1250 && waitAt(0.25, 1) === 875, JSON.stringify([waitAt(0, 1), waitAt(0.25, 1), waitAt(0.5, 1), waitAt(0.999, 1)]))
check('the scale knob the busy ladder reads scales this wait the same way (0.1 → 75–125 ms)', waitAt(0, 0.1) === 75 && waitAt(0.5, 0.1) === 100 && waitAt(0.999, 0.1) === 125, JSON.stringify([waitAt(0, 0.1), waitAt(0.5, 0.1), waitAt(0.999, 0.1)]))
check('the env scale (0.1 in this proof) is the default scale', waitAt(0.5) === 100, String(waitAt(0.5)))
const empty = (code: string, extra: Record<string, unknown> = {}): boolean => law.isEmptyStreamFault({ code, retryable: true, ...extra } as never)
check('a stream that closed or broke before any event is an empty stream: no-finish, no-terminal-event, no-body, read-failed', empty('no-finish') && empty('no-terminal-event') && empty('no-body') && empty('read-failed'))
check('an HTTP refusal, a timeout, a silence, a fetch that never got headers, a malformed chunk, an in-stream fault and a cancel keep their own roads', !empty('no-finish', { status: 503 }) && !empty('http-503', { status: 503 }) && !empty('first-byte-timeout') && !empty('idle-timeout') && !empty('silent-after-headers') && !empty('fetch-failed') && !law.isEmptyStreamFault({ code: 'bad-json-chunk', retryable: false }) && !empty('no-finish', { inStream: true }) && !law.isEmptyStreamFault({ code: 'cancelled', retryable: false }))
check('the spent line: "<Provider> ended the stream before its first event 3 times in a row over N s"', law.emptyStreamSpentWords('Fixture', 2345) === `Fixture ${MARKER} 3 times in a row over 2 s`, law.emptyStreamSpentWords('Fixture', 2345))

console.log('── the words, pure: the notice, the spinner, the status row, the agent row')
const notice = law.emptyStreamRetryNotice({ provider: 'Fixture', detail: 'no-finish', attempt: 2, waitMs: 1000 })
check('the notice is the capacity retry notice: system/api_error, attempt 2 of 3, the wait as its delay', notice.type === 'system' && notice.subtype === 'api_error' && notice.retryAttempt === 2 && notice.maxRetries === TRIES && notice.retryInMs === 1000 && notice.error.message === `Fixture ${MARKER} (no-finish)`, JSON.stringify([notice.retryAttempt, notice.maxRetries, notice.retryInMs, notice.error.message]))
const wait = idle.retryNoticeWait(notice, 0)
check('the wait row is the retry row: kind retry, attempt 2 of 3, the reason "an empty stream"', wait.kind === 'retry' && wait.attempt === 2 && wait.of === TRIES && wait.reason === REASON && wait.delayMs === 1000, JSON.stringify(wait))
check('the status row reads "retrying — attempt 2 of 3 after an empty stream · in 1 s"', idle.requestWaitLine(wait) === 'retrying — attempt 2 of 3 after an empty stream · in 1 s', idle.requestWaitLine(wait))
const promise = spinner.liveCounterPromise(wait, 0)
check('the spinner says "attempt 2 of 3 after an empty stream" with the wait', promise !== null && promise.startsWith('attempt 2 of 3 after an empty stream') && / · in 1 ?s$/.test(promise), promise ?? '(null)')
const words = spinner.liveCounterWords({ replyChars: 0, thinkingChars: 0, wireOutputTokens: null, firstByteAtMs: null, wait, phase: 'waiting', sentAtMs: 0 }, 0)
check('the spinner\'s phase word is "retrying", as for the capacity retries', words.phase === spinner.RETRY_PHASE_WORD && words.promise === promise, JSON.stringify(words))
const third = idle.retryNoticeWait(law.emptyStreamRetryNotice({ provider: 'Fixture', detail: 'no-finish', attempt: 3, waitMs: 900 }), 0)
check('the second retry says "attempt 3 of 3"', idle.requestWaitLine(third) === 'retrying — attempt 3 of 3 after an empty stream · in 1 s', idle.requestWaitLine(third))
const facts = budget.recoveryNoticeFacts(notice)
check('an agent\'s row reads the same cause: "an empty stream", a fault, retry 2 of 3', facts !== null && facts.kind === 'fault' && facts.cause === REASON && facts.attempt === 2 && facts.of === TRIES, JSON.stringify(facts))
check('a capacity retry\'s words are untouched: a 529 still reads "a 529", a connection error still reads "a connection error"', idle.retryReasonWords(529) === 'a 529' && idle.retryReasonWords(undefined, 'socket hang up') === 'a connection error' && idle.retryReasonWords(undefined, 'no first byte from X after 2m (…)') === 'a first-byte timeout')

console.log('── every road, at the seam, against a stubbed wire')
const ANSWER = 'road answer'
const PARTIAL = 'the partial words'
const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(modelId: string, door?: (wait: unknown) => void, signal: AbortSignal = new AbortController().signal): CompatCallModelParams {
  return {
    messages: [user('Say hello.')], systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: [], signal,
    options: { model: modelId, querySource: 'main_thread', isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64, ...(door === undefined ? {} : { onWait: door }) } as never,
  }
}
type Item = { type: string; subtype?: string; retryInMs?: number; retryAttempt?: number; maxRetries?: number; recoveryTimeoutMs?: number; isApiErrorMessage?: boolean; error?: unknown; message?: { content: Array<{ type: string; text?: string }> } }
async function drain(generator: AsyncGenerator<unknown>): Promise<Item[]> {
  const out: Item[] = []
  for await (const item of generator) out.push(item as Item)
  return out
}
const notices = (items: Item[]) => items.filter(item => item.type === 'system' && item.subtype === 'api_error')
const lawNotices = (items: Item[]) => notices(items).filter(item => item.maxRetries === TRIES && String((item.error as { message?: string } | undefined)?.message ?? '').includes(MARKER))
const places = (items: Item[]): string => lawNotices(items).map(item => `${item.retryAttempt} of ${item.maxRetries}`).join(', ')
const redLines = (items: Item[]) => items.filter(item => item.type === 'assistant' && item.isApiErrorMessage === true).map(item => item.message?.content.map(block => block.text ?? '').join('') ?? '')
const answers = (items: Item[]) => items.filter(item => item.type === 'assistant' && item.isApiErrorMessage !== true).flatMap(item => item.message?.content.map(block => block.text ?? '') ?? []).filter(text => text !== '')
const rows = (door: unknown[]): string[] => door.filter(w => (w as { kind?: unknown } | null)?.kind === 'retry').map(w => idle.requestWaitLine(w as Parameters<typeof idle.requestWaitLine>[0]))
const sseBody = (chunks: unknown[], done = false): string => chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '')
const sse = (body: string): Response => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
const ndjson = (rows: unknown[]): Response => new Response(rows.map(row => `${JSON.stringify(row)}\n`).join(''), { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
type Hit = { url: string; atMs: number }
const hits: Hit[] = []
let emptiesBeforeAnswer = 0
let midAnswer = false
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.endsWith('/token')) return Response.json({ access_token: access, expires_in: 3600 })
  const chat = url.includes('/chat/completions')
  const responses = url.endsWith('/responses')
  const ollama = url.endsWith('/api/chat')
  const gemini = url.includes(':streamGenerateContent')
  if (method !== 'POST' || !(chat || responses || ollama || gemini)) return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] })
  hits.push({ url, atMs: Date.now() })
  const n = hits.length
  if (midAnswer && n === 1) {
    if (responses) return sse(sseBody([{ type: 'response.created', response: { id: 'resp_fixture' } }, { type: 'response.output_text.delta', delta: PARTIAL }]))
    if (chat) return sse(sseBody([{ choices: [{ delta: { role: 'assistant', content: PARTIAL }, finish_reason: null }] }]))
    if (ollama) return ndjson([{ model: 'llama-fixture', message: { role: 'assistant', content: PARTIAL }, done: false }])
    return sse(sseBody([{ candidates: [{ content: { role: 'model', parts: [{ text: PARTIAL }] } }] }]))
  }
  if (n <= emptiesBeforeAnswer) return ollama ? ndjson([]) : sse('')
  if (responses) {
    return sse(sseBody([
      { type: 'response.created', response: { id: 'resp_fixture' } },
      { type: 'response.output_text.delta', delta: ANSWER },
      { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ANSWER }] } },
      { type: 'response.completed', response: { id: 'resp_fixture', usage: { input_tokens: 12, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } } },
    ]))
  }
  if (chat) return sse(sseBody([{ choices: [{ delta: { content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }], true))
  if (ollama) return ndjson([{ model: 'llama-fixture', message: { role: 'assistant', content: ANSWER }, done: false }, { model: 'llama-fixture', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2 }])
  return sse(sseBody([
    { candidates: [{ content: { role: 'model', parts: [{ text: ANSWER }] } }] },
    { candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 } },
  ]))
}) as typeof fetch
function reset(opts: { empties?: number; mid?: boolean } = {}): void {
  hits.length = 0
  emptiesBeforeAnswer = opts.empties ?? 0
  midAnswer = opts.mid === true
}
type Road = { name: string; provider: string; model: string; call: (p: CompatCallModelParams) => AsyncGenerator<unknown>; code: string }
const localProfile: CompatLaneProfile = localLaneProfileFor({ id: 'llama-fixture', server: 'ollama', baseUrl: 'https://local.fixture.invalid/v1' })
const roads: Road[] = [
  { name: 'openai', provider: 'OpenAI', model: 'gpt-5.6-sol', call: p => openaiCallModel(p as never) as AsyncGenerator<unknown>, code: 'no-terminal-event' },
  { name: 'zai', provider: 'Z.AI', model: 'glm-5.2', call: p => zaiCallModel(p as never) as AsyncGenerator<unknown>, code: 'no-finish' },
  { name: 'deepseek', provider: 'DeepSeek', model: 'deepseek-chat', call: p => compatChatCallModel(deepseekLaneProfile, p), code: 'no-finish' },
  { name: 'moonshot', provider: 'Moonshot', model: 'kimi-k3', call: p => compatChatCallModel(moonshotLaneProfile, p), code: 'no-finish' },
  { name: 'huggingface', provider: 'Hugging Face', model: 'huggingface/org/model', call: p => compatChatCallModel(huggingfaceLaneProfile, p), code: 'no-finish' },
  { name: 'openrouter', provider: 'OpenRouter', model: 'openrouter/vendor/model', call: p => compatChatCallModel(openrouterLaneProfile, p), code: 'no-finish' },
  { name: 'xai', provider: 'xAI', model: 'grok-5', call: p => compatChatCallModel(xaiLaneProfile, p), code: 'no-finish' },
  { name: 'meta', provider: 'Meta', model: 'muse-spark', call: p => compatChatCallModel(metaLaneProfile, p), code: 'no-finish' },
  { name: 'gemini', provider: 'Gemini', model: 'gemini-3.5-flash', call: p => geminiCallModel(p), code: 'no-finish' },
  { name: 'local', provider: localProfile.providerLabel, model: 'local/llama-fixture', call: p => compatChatCallModel(localProfile, p), code: 'no-finish' },
  { name: 'openai-compat', provider: 'the fixture endpoint', model: 'compat/fixture-model', call: p => compatCallModel(p), code: 'no-finish' },
]
try {
  for (const road of roads) {
    console.log(`── ${road.provider}`)
    reset({ empties: 2 })
    const door: unknown[] = []
    const recovered = await drain(road.call(params(road.model, w => door.push(w))))
    check(`${road.name}: two empty streams then an answer — three requests, the answer, no red line`, hits.length === 3 && answers(recovered).includes(ANSWER) && redLines(recovered).length === 0, `${hits.length} requests, answers ${JSON.stringify(answers(recovered))}, red ${JSON.stringify(redLines(recovered))}`)
    check(`${road.name}: the two notices say attempt 2 of 3 and attempt 3 of 3 and name the empty stream (${road.code})`, places(recovered) === `2 of ${TRIES}, 3 of ${TRIES}` && lawNotices(recovered).every(item => (item.error as { message?: string }).message === `${road.provider} ${MARKER} (${road.code})`), `${places(recovered) || '(none)'} · ${JSON.stringify(lawNotices(recovered).map(item => (item.error as { message?: string }).message))}`)
    const waits = lawNotices(recovered).map(item => item.retryInMs ?? -1)
    check(`${road.name}: each wait is the scaled first rung (75–125 ms)`, waits.length === 2 && waits.every(ms => ms >= 75 && ms <= 125), JSON.stringify(waits))
    const gaps = hits.slice(1).map((hit, i) => hit.atMs - hits[i]!.atMs)
    check(`${road.name}: the wire shows the wait between the tries`, gaps.length === 2 && gaps.every(ms => ms >= 60), JSON.stringify(gaps))
    check(`${road.name}: the status row says "retrying — attempt 2 of 3 after an empty stream · in 1 s" then "attempt 3 of 3"`, JSON.stringify(rows(door)) === JSON.stringify(['retrying — attempt 2 of 3 after an empty stream · in 1 s', 'retrying — attempt 3 of 3 after an empty stream · in 1 s']), JSON.stringify(rows(door)))

    reset({ empties: Infinity })
    const spent = await drain(road.call(params(road.model)))
    const red = redLines(spent)
    check(`${road.name}: three empty streams — exactly three requests, never a fourth`, hits.length === TRIES, `${hits.length} requests`)
    check(`${road.name}: the turn ends with one red line in the spent ladder's register: "API Error: ${road.provider} ended the stream before its first event 3 times in a row over N s — ${road.provider} stream failed (${road.code}) — …"`, red.length === 1 && new RegExp(`^API Error: ${escape(road.provider)} ${escape(MARKER)} 3 times in a row over \\d+ s — ${escape(road.provider)} stream failed \\(${escape(road.code)}\\) — `).test(red[0] ?? '') && spent.some(item => item.type === 'assistant' && item.error === 'server_error'), red[0] ?? '(no red line)')
    check(`${road.name}: the two notices before the failure say attempt 2 of 3 and 3 of 3`, places(spent) === `2 of ${TRIES}, 3 of ${TRIES}`, places(spent) || '(none)')

    reset({ mid: true })
    const mid = await drain(road.call(params(road.model)))
    check(`${road.name}: a stream that dies AFTER its first event is not retried by this law — one request, the partial words stand, no attempt-of-3 notice`, hits.length === 1 && answers(mid).includes(PARTIAL) && lawNotices(mid).length === 0, `${hits.length} requests, answers ${JSON.stringify(answers(mid))}, law notices ${lawNotices(mid).length}`)
  }

  console.log('── the responses wire OpenRouter and the Grok subscription ride: its empty close is an empty stream under the law')
  reset({ empties: Infinity })
  {
    const events: Array<{ type: string; fault?: { kind: string; code: string; retryable: boolean; status?: number } }> = []
    for await (const event of streamOpenrouterResponses({ url: 'https://openrouter.fixture.invalid/api/v1/responses', request: { model: 'vendor/model', messages: [] }, signal: new AbortController().signal, idleTimeoutMs: 5000 }, JSON.stringify({ model: 'vendor/model', input: [], stream: true }), { model: 'vendor/model', items: [] })) events.push(event as never)
    const fault = events.find(event => event.type === 'stream-fault')?.fault
    check('the responses transport ends an empty body as a retryable no-terminal-event fault, and the law counts it as an empty stream', fault !== undefined && fault.code === 'no-terminal-event' && fault.retryable && law.isEmptyStreamFault(fault), JSON.stringify(fault))
  }

  console.log('── the Anthropic road, at the seam (the stream generator with a scripted wire)')
  const HOME_MODEL = 'claude-fable-5-1'
  const homeSse = (event: string, obj: unknown): string => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`
  const homeUsage = { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3 }
  const homeStart = (): string => homeSse('message_start', { type: 'message_start', message: { id: 'msg_fixture_home', type: 'message', role: 'assistant', model: HOME_MODEL, content: [], stop_reason: null, stop_sequence: null, usage: homeUsage } })
  const homeStream = (): Response => new Response([
    homeStart(),
    homeSse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    homeSse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } }),
    homeSse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    homeSse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: homeUsage }),
    homeSse('message_stop', { type: 'message_stop' }),
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture_home_stream' } })
  const homeJson = (): Response => Response.json({ id: 'msg_fixture_home_json', type: 'message', role: 'assistant', model: HOME_MODEL, content: [{ type: 'text', text: ANSWER }], stop_reason: 'end_turn', stop_sequence: null, usage: homeUsage }, { headers: { 'request-id': 'req_fixture_home_json' } })
  type HomeHit = { atMs: number; stream: boolean }
  function homeCall(script: { empties: number; mid?: boolean; cut?: boolean }, door?: (wait: unknown) => void): { generator: AsyncGenerator<unknown>; homeHits: HomeHit[] } {
    const homeHits: HomeHit[] = []
    const fetchOverride = (async (_input: unknown, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as { stream?: boolean }) : {}
      homeHits.push({ atMs: Date.now(), stream: body.stream === true })
      const n = homeHits.length
      if (script.mid === true && n === 1) return new Response(homeStart(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      if (n <= script.empties) {
        if (script.cut === true) {
          const readable = new ReadableStream<Uint8Array>({ start(sink) { setTimeout(() => sink.error(Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) })), 20) } })
          return new Response(readable, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return body.stream === true ? homeStream() : homeJson()
    }) as unknown as typeof fetch
    const generator = queryModelWithStreaming({
      messages: [user('Say hello.')],
      systemPrompt: asSystemPrompt(['Only answer the request.']),
      thinkingConfig: { type: 'disabled' } as never,
      tools: [],
      signal: new AbortController().signal,
      options: { model: HOME_MODEL, querySource: 'main_thread', isNonInteractiveSession: true, fetchOverride: fetchOverride as never, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64, skipCacheWrite: true, ...(door === undefined ? {} : { onWait: door }) } as never,
    }) as AsyncGenerator<unknown>
    return { generator, homeHits }
  }
  {
    const door: unknown[] = []
    const run = homeCall({ empties: 2 }, w => door.push(w))
    const recovered = await drain(run.generator)
    check('anthropic: two empty streams then an answer — three streamed requests, the answer streamed, no collected request, no red line', run.homeHits.length === 3 && run.homeHits.every(hit => hit.stream) && answers(recovered).includes(ANSWER) && redLines(recovered).length === 0, `${run.homeHits.map(hit => (hit.stream ? 'stream' : 'json')).join(',')} · answers ${JSON.stringify(answers(recovered))} · red ${JSON.stringify(redLines(recovered))}`)
    check('anthropic: the two notices say attempt 2 of 3 and 3 of 3 and read "Anthropic ended the stream before its first event (closed with no events)"', places(recovered) === `2 of ${TRIES}, 3 of ${TRIES}` && lawNotices(recovered).every(item => (item.error as { message?: string }).message === `Anthropic ${MARKER} (closed with no events)`), `${places(recovered) || '(none)'} · ${JSON.stringify(lawNotices(recovered).map(item => (item.error as { message?: string }).message))}`)
    check('anthropic: the status row says "retrying — attempt 2 of 3 after an empty stream · in 1 s" then "attempt 3 of 3"', JSON.stringify(rows(door)) === JSON.stringify(['retrying — attempt 2 of 3 after an empty stream · in 1 s', 'retrying — attempt 3 of 3 after an empty stream · in 1 s']), JSON.stringify(rows(door)))
    const gaps = run.homeHits.slice(1).map((hit, i) => hit.atMs - run.homeHits[i]!.atMs)
    check('anthropic: the wire shows the scaled wait between the tries', gaps.length === 2 && gaps.every(ms => ms >= 60), JSON.stringify(gaps))
  }
  {
    const run = homeCall({ empties: Infinity })
    let threw: unknown
    let spent: Item[] = []
    try {
      spent = await drain(run.generator)
    } catch (error) {
      threw = error
    }
    const red = redLines(spent)
    check('anthropic: three empty streams — exactly three streamed requests, never a fourth, no collected fallback', run.homeHits.length === TRIES && run.homeHits.every(hit => hit.stream), run.homeHits.map(hit => (hit.stream ? 'stream' : 'json')).join(','))
    check('anthropic: the turn ends with one red line in the register of the exhausted ladder: "API Error: Anthropic ended the stream before its first event 3 times in a row over N s — closed with no events; try again shortly"', threw === undefined && red.length === 1 && /^API Error: Anthropic ended the stream before its first event 3 times in a row over \d+ s — closed with no events; try again shortly$/.test(red[0] ?? ''), threw !== undefined ? `threw ${String(threw)}` : (red[0] ?? '(no red line)'))
    check('anthropic: the two notices before the failure say attempt 2 of 3 and 3 of 3', places(spent) === `2 of ${TRIES}, 3 of ${TRIES}`, places(spent) || '(none)')
  }
  {
    const run = homeCall({ empties: 1, cut: true })
    const cut = await drain(run.generator)
    check('anthropic: a connection cut before any event is a stream that ended before its first event: one retry notice naming the cut code, the answer streamed on the second request', run.homeHits.length === 2 && run.homeHits.every(hit => hit.stream) && places(cut) === `2 of ${TRIES}` && (lawNotices(cut)[0]?.error as { message?: string } | undefined)?.message === `Anthropic ${MARKER} (UND_ERR_SOCKET)` && answers(cut).includes(ANSWER), `${run.homeHits.length} requests · ${places(cut) || '(none)'} · ${JSON.stringify(lawNotices(cut).map(item => (item.error as { message?: string }).message))} · ${JSON.stringify(answers(cut))}`)
  }
  {
    const run = homeCall({ empties: 1, mid: true })
    const mid = await drain(run.generator)
    const recovery = notices(mid).filter(item => item.retryInMs === 0 && (item.recoveryTimeoutMs ?? 0) > 0)
    check("anthropic: a stream that dies AFTER its first event keeps today's road — the collected recovery with its notice (attempt 1 of 1), the answer, no attempt-of-3 notice", run.homeHits.length === 2 && run.homeHits[0]?.stream === true && run.homeHits[1]?.stream === false && recovery.length === 1 && recovery[0]?.retryAttempt === 1 && recovery[0].maxRetries === 1 && lawNotices(mid).length === 0 && answers(mid).includes(ANSWER), `${run.homeHits.map(hit => (hit.stream ? 'stream' : 'json')).join(',')} · recovery ${recovery.length} · law notices ${lawNotices(mid).length} · ${JSON.stringify(answers(mid))}`)
  }
} finally {
  globalThis.fetch = realFetch
  Math.random = realRandom
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-empty-stream-retry-roads: ALL LAWS HOLD' : `prove-empty-stream-retry-roads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
