#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'overload-every-family-'))
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
for (const name of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MERCURY_GEMINI_OAUTH_CLIENT_ID', 'MERCURY_GEMINI_OAUTH_CLIENT_SECRET', 'MERCURY_BUSY_RETRY_SCALE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_MODEL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_OVERLOAD_PROBE_SCALE']) delete process.env[name]
const access = 'ya29.fixture-busy-access'
writeFileSync(join(home, '.gemini-auth.json'), JSON.stringify({ version: 1, preferredSource: 'oauth', client: { clientId: 'fixture-client' }, tokens: { accessToken: access, refreshToken: 'fixture-refresh', accessTokenExpiresAtMs: Date.now() + 3600000 } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
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
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const lane = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const overload = await import('../../src/tasks/LocalAgentTask/agentOverload.ts')
const busyRetry = await import('../../src/services/providers/busyRetry.ts')
const { createAssistantAPIErrorMessage } = await import('../../src/utils/messages/factories.ts')
import type { Message } from '../../src/types/message.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${t}`)
}

const user = (content: unknown): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content } }) as Message
function params(modelId: string, querySource = 'agent:builtin:mercury-general'): CompatCallModelParams {
  return {
    messages: [user('Say hello.')], systemPrompt: asSystemPrompt(['Only answer the request.']), thinkingConfig: { type: 'disabled' }, tools: [], signal: new AbortController().signal,
    options: { model: modelId, querySource, agentId: 'a-review-lane', onWait: () => {}, isNonInteractiveSession: true, getToolPermissionContext: async () => getEmptyToolPermissionContext(), agents: [], hasAppendSystemPrompt: false, mcpTools: [], maxOutputTokensOverride: 64 } as never,
  }
}
let status = 503
let body: unknown = {}
let retryAfter: string | undefined
let requests = 0
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  if (url.endsWith('/token')) return Response.json({ access_token: access, expires_in: 3600 })
  const modelRoad = url.includes('/chat/completions') || url.endsWith('/responses') || url.includes(':streamGenerateContent')
  if (method !== 'POST' || !modelRoad) return Response.json({ data: [{ id: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high'], visibility: 'list', supported_in_api: true }] })
  requests++
  return Response.json(body, { status, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } })
}) as typeof fetch

type Row = { type?: string; isApiErrorMessage?: boolean; error?: string; busyRefusal?: { provider: string; retries: number; elapsedMs: number; status?: number; code?: string }; providerWaitEndsAtMs?: number; message?: { content: Array<{ text?: string }> } }
type Road = { name: string; model: string; call: (p: CompatCallModelParams) => AsyncGenerator<unknown>; status: number; body: unknown }
const localProfile = localLaneProfileFor({ id: 'llama-fixture', server: 'ollama', baseUrl: 'https://local.fixture.invalid/v1' })
const roads: Road[] = [
  { name: 'gemini', model: 'gemini-3.5-flash', call: p => geminiCallModel(p as never) as AsyncGenerator<unknown>, status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } } },
  { name: 'openai', model: 'gpt-5.6-sol', call: p => openaiCallModel(p as never) as AsyncGenerator<unknown>, status: 503, body: { error: { type: 'server_error', message: 'The requested model is temporarily overloaded.' } } },
  { name: 'zai', model: 'glm-5.2', call: p => zaiCallModel(p as never) as AsyncGenerator<unknown>, status: 429, body: { error: { code: '1305', message: 'The service may be temporarily overloaded, please try again later' } } },
  { name: 'deepseek', model: 'deepseek-chat', call: p => compatChatCallModel(deepseekLaneProfile, p), status: 503, body: { error: { message: 'The server is overloaded due to high traffic. Please retry your request after a brief wait.' } } },
  { name: 'moonshot', model: 'kimi-k3', call: p => compatChatCallModel(moonshotLaneProfile, p), status: 503, body: { error: { type: 'server_error', message: 'the engine is busy' } } },
  { name: 'huggingface', model: 'huggingface/org/model', call: p => compatChatCallModel(huggingfaceLaneProfile, p), status: 503, body: { error: 'Service Unavailable' } },
  { name: 'openrouter', model: 'openrouter/vendor/model', call: p => compatChatCallModel(openrouterLaneProfile, p), status: 503, body: { error: { code: 503, message: 'There is no available model provider that meets your routing requirements' } } },
  { name: 'openrouter-529', model: 'openrouter/vendor/model', call: p => compatChatCallModel(openrouterLaneProfile, p), status: 529, body: { error: { code: 529, message: 'Provider returned error: overloaded' } } },
  { name: 'local', model: 'local/llama-fixture', call: p => compatChatCallModel(localProfile, p), status: 503, body: { error: { message: 'Loading model', type: 'unavailable_error' } } },
  { name: 'openai-compat', model: 'compat/fixture-model', call: p => compatCallModel(p), status: 503, body: { error: { type: 'server_error', message: 'the endpoint is overloaded' } } },
]
const textOf = (row: Row | undefined): string => row === undefined ? '(no row)' : (row.message?.content.map(block => block.text ?? '').join('') ?? '')
async function lastRow(road: Road, querySource?: string, opts: { status?: number; body?: unknown; retryAfter?: string } = {}): Promise<{ last: Row | undefined; requests: number }> {
  process.env.MERCURY_BUSY_RETRY_SCALE = '0.01'
  status = opts.status ?? road.status
  body = opts.body ?? road.body
  retryAfter = opts.retryAfter
  requests = 0
  const items: Row[] = []
  for await (const item of road.call(params(road.model, querySource))) items.push(item as Row)
  const last = [...items].reverse().find(item => item.type === 'assistant' && item.isApiErrorMessage === true)
  return { last, requests }
}

section('P1 every road driven to its spent busy ladder stamps the typed fact and pauses on the overload road')
const spent = new Map<string, Row | undefined>()
for (const road of roads) {
  const { last, requests: count } = await lastRow(road)
  spent.set(road.name, last)
  const stamp = last?.busyRefusal
  const paused = last !== undefined && lane.overloadPauseOf([last as Message], road.model)
  console.log(`    ${road.name.padEnd(15)} requests=${count} typed=${String(last?.error ?? '')} stamp=${JSON.stringify(stamp)} row="${textOf(last).slice(0, 110)}"`)
  check(`${road.name}: the spent row carries the busy stamp with the provider, six retries, the elapsed time and the wire's status`, stamp !== undefined && stamp.retries === 6 && stamp.elapsedMs >= 0 && stamp.status === road.status && typeof stamp.code === 'string' && stamp.provider.length > 0, JSON.stringify(stamp))
  check(`${road.name}: the lane pauses as 'provider overloaded' with the stamped status in its words`, paused !== null && paused !== false && paused.pause.why === 'provider overloaded' && paused.status === road.status && paused.pause.words.includes(`is overloaded (HTTP ${road.status}) — Mercury probes it for up to`), JSON.stringify(paused))
  check(`${road.name}: the ladder walked its six rungs (seven requests)`, count === 7, `${count} requests`)
}

section("P2 Z.AI's 1305 is the provider overloaded, not a spent window")
{
  const zai = spent.get('zai')
  check('the 1305 row is typed rate_limit and stamped', zai?.error === 'rate_limit' && zai.busyRefusal !== undefined, JSON.stringify(zai?.busyRefusal))
  check('usageWindowPauseOf declines it (a stamped row that asked for no wait is no window)', zai !== undefined && lane.usageWindowPauseOf([zai as Message], 'glm-5.2') === null)
  check('overloadPauseOf takes it', zai !== undefined && lane.overloadPauseOf([zai as Message], 'glm-5.2') !== null)
}

section('P3 controls: what is NOT an overload keeps its road')
{
  const zaiRoad = roads.find(road => road.name === 'zai')!
  const { last: rate1302 } = await lastRow(zaiRoad, undefined, { status: 429, body: { error: { code: '1302', message: 'Too many requests, please slow down' } } })
  check('Z.AI 1302 (a real rate limit): no stamp, the window road', rate1302 !== undefined && rate1302.busyRefusal === undefined && lane.usageWindowPauseOf([rate1302 as Message], 'glm-5.2') !== null && lane.overloadPauseOf([rate1302 as Message], 'glm-5.2') === null, JSON.stringify(rate1302?.busyRefusal))
  const geminiRoad = roads.find(road => road.name === 'gemini')!
  const { last: exhausted } = await lastRow(geminiRoad, undefined, { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota reached' } } })
  check('Gemini RESOURCE_EXHAUSTED: no stamp, no overload pause', exhausted !== undefined && exhausted.busyRefusal === undefined && lane.overloadPauseOf([exhausted as Message], 'gemini-3.5-flash') === null)
  const { last: askedRate } = await lastRow(geminiRoad, undefined, { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota reached' } }, retryAfter: '1' })
  check('a 429 that rode the ladder on its Retry-After is not a busy provider: no stamp (isBusyRefusal keys the stamp, never takesBusyLadder)', askedRate !== undefined && askedRate.busyRefusal === undefined, JSON.stringify(askedRate?.busyRefusal))
  const anthropicRow = createAssistantAPIErrorMessage({ content: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_fixture"}', error: 'unknown' }) as Message
  const firstParty = lane.overloadPauseOf([anthropicRow], 'claude-fable-5-1')
  check("the first-party 529 row still pauses by its words, status 529", firstParty !== null && firstParty.status === 529 && firstParty.pause.words.includes('(HTTP 529)'), JSON.stringify(firstParty))
  const handBuilt = createAssistantAPIErrorMessage({ content: 'API Error: the fixture endpoint stayed busy through 6 retries over 1 s — the fixture endpoint stream failed (http-503) — the endpoint is overloaded', error: 'server_error' }) as Message
  check("a hand-built 'stayed busy through' row with no stamp does NOT pause (no string road)", lane.overloadPauseOf([handBuilt], 'compat/fixture-model') === null)
  const asked = { ...(spent.get('gemini') as Row), providerWaitEndsAtMs: Date.now() + 60_000 } as unknown as Message
  check('a stamped row that states its wait keeps the stated-wait road (the guard stays first)', lane.overloadPauseOf([asked], 'gemini-3.5-flash') === null && lane.usageWindowPauseOf([asked], 'gemini-3.5-flash') !== null)
  const fact = (busyRetry as { busyRefusalFact?: typeof busyRetry.busyRefusalFact }).busyRefusalFact
  check('the stamp is minted by the busy answer alone', fact !== undefined && fact('X', busyRetry.openBusyRetryLadder(0), { code: 'http-429', status: 429, retryable: true }, 10) === null && fact('X', busyRetry.openBusyRetryLadder(0), { code: 'http-503', status: 503, retryable: true }, 10)?.status === 503)
}

section('P4 the words: the stamped status rides the calm line; the first-party line is byte-identical')
{
  check('the first-party pause words are unchanged', overload.overloadPauseWords('Fable 5.1', 1) === 'Fable 5.1 is overloaded (HTTP 529) — Mercury probes it for up to 1h and resumes the agent when it answers')
  check('the first-party notice line is unchanged', overload.overloadNoticeWords('lane', 'Fable 5.1', 1) === 'Agent "lane" paused — Fable 5.1 is overloaded (HTTP 529); its work so far is kept and rides below; Mercury probes the provider for up to 1h and resumes the agent by itself when it answers — a message resumes it sooner; the crew view stops it')
  check('a stamped 503 names 503', overload.overloadPauseWords('Gemini 3.5 Flash', 1, 503).startsWith('Gemini 3.5 Flash is overloaded (HTTP 503) — ') && overload.overloadNoticeWords('lane', 'Gemini 3.5 Flash', 1, 503).includes('is overloaded (HTTP 503);'))
  check('a stamp without a status names none', overload.overloadPauseWords('Kimi', 1, null) === 'Kimi is overloaded — Mercury probes it for up to 1h and resumes the agent when it answers' && overload.overloadNoticeWords('lane', 'Kimi', 1, null).includes('Kimi is overloaded; its work'))
  const zai = spent.get('zai')
  const zaiPause = zai !== undefined ? lane.overloadPauseOf([zai as Message], 'glm-5.2') : null
  check("Z.AI's line names the status the wire sent (429), never 529", zaiPause !== null && zaiPause.status === 429 && zaiPause.pause.words.includes('(HTTP 429)') && !zaiPause.pause.words.includes('529'), zaiPause?.pause.words)
}

section('P5 an overload probe is one request per road (never a rung of the ladder)')
for (const road of roads) {
  const { requests: count } = await lastRow(road, 'overload_probe')
  check(`${road.name}: a probe-shaped call against the busy wire sends exactly one request`, count === 1, `${count} requests`)
}

console.log(failures === 0 ? '\nprove-overload-pause-every-family: ALL LAWS HOLD' : `\nprove-overload-pause-every-family: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
