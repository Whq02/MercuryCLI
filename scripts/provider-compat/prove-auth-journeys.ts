#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'


const HOME = mkdtempSync(join(tmpdir(), 'auth-journeys-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'ZAI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_COMPAT_API_KEY',
  'MERCURY_COMPAT_LABEL',
  'MERCURY_COMPAT_MODELS',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_LOCAL_API_KEY',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_GEMINI_OAUTH_CLIENT_ID',
  'MERCURY_GEMINI_OAUTH_CLIENT_SECRET',
  'MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID',
  'MERCURY_HUGGINGFACE_BILL_TO',
  'MERCURY_MOONSHOT_OAUTH_BASE',
  'MERCURY_MOONSHOT_OAUTH_CLIENT_ID',
]) {
  delete process.env[k]
}


process.env.MERCURY_GEMINI_API_BASE = 'https://gemini.fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = 'https://gauth.fixture.invalid/auth'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://gauth.fixture.invalid/token'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://openrouter.fixture.invalid/api/v1'
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://openrouter.fixture.invalid/auth'
process.env.MERCURY_HUGGINGFACE_HUB_BASE = 'https://hub.fixture.invalid'
process.env.MERCURY_HUGGINGFACE_API_BASE = 'https://hfrouter.fixture.invalid/v1'
process.env.MERCURY_MOONSHOT_API_BASE = 'https://moonshot.fixture.invalid/v1'
process.env.MERCURY_DEEPSEEK_API_BASE = 'https://deepseek.fixture.invalid'
process.env.MERCURY_OPENAI_AUTH_BASE = 'https://oai-auth.fixture.invalid'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'https://oai-chatgpt.fixture.invalid/codex'
process.env.MERCURY_OPENAI_API_BASE = 'https://oai-api.fixture.invalid/v1'


type WireScenario =
  | 'http-401'
  | 'http-429'
  | 'http-500'
  | 'malformed-json'
  | 'truncated-sse'
  | 'happy'
  | 'refuse-all'

const wire = {
  scenario: 'refuse-all' as WireScenario,
  chatHits: 0,
  lastAuth: undefined as string | undefined,
  lastBody: undefined as Record<string, unknown> | undefined,
  unpinned: [] as string[],
}

function sseBytes(payloads: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of payloads) controller.enqueue(enc.encode(p))
      controller.close()
    },
  })
}

const realFetch = globalThis.fetch

function fixtureChatResponse(): Response {
  switch (wire.scenario) {
    case 'http-401':
      return new Response(
        JSON.stringify({ error: { message: 'Invalid API key provided', code: 'invalid_api_key' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )
    case 'http-429':
      return new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      })
    case 'http-500':
      return new Response('oops', { status: 500 })
    case 'malformed-json':
      return new Response(sseBytes(['data: {not json at all\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    case 'truncated-sse':
      return new Response(
        sseBytes([`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] })}\n\n`]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    case 'happy':
      return new Response(
        sseBytes([
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking…' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'the answer' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } })}\n\n`,
          'data: [DONE]\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    case 'refuse-all':
      throw new Error('auth-journeys prover: no wire scenario armed')
  }
}

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url)
  if (!u.includes('fixture.invalid')) {
    wire.unpinned.push(u)
    throw new Error(`auth-journeys prover: UNPINNED URL reached the wire: ${u}`)
  }
  if (u.includes('/chat/completions')) {
    wire.chatHits++
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>)
    wire.lastAuth = headers.get('authorization') ?? undefined
    try {
      wire.lastBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    } catch {
      wire.lastBody = undefined
    }
    return fixtureChatResponse()
  }
  if (u.endsWith('/key')) {
    return new Response(
      JSON.stringify({ data: { label: 'Mercury', usage: 1.25, limit: 10, limit_remaining: 8.75 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  if (u.includes('/models')) {
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch


const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { PROVIDER_ID_SPACES, declaredRouteOf, providerDisplayName } = await import(
  '../../src/services/providers/routeLaw.ts'
)
const { compatChatCallModel, compatDispatchModelId, compatFaultToTypedError } = await import(
  '../../src/services/providers/openaicompat/compatChatCallModel.ts'
)
const { moonshotLaneProfile } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { openrouterLaneProfile } = await import('../../src/services/providers/openrouter/openrouterCallModel.ts')
const { geminiLaneProfile } = await import('../../src/services/providers/gemini/geminiCallModel.ts')
const { huggingfaceLaneProfile } = await import('../../src/services/providers/huggingface/huggingfaceCallModel.ts')
const { localLaneProfileFor } = await import('../../src/services/providers/local/localCallModel.ts')
const { compatSlotLaneProfile } = await import('../../src/services/providers/openaicompat/compatCallModel.ts')
const { streamCompatChat } = await import('../../src/services/providers/openaicompat/compatChatClient.ts')
const { streamOpenaiResponses } = await import('../../src/services/providers/openai/openaiClient.ts')
const { streamZaiChat } = await import('../../src/services/providers/zai/zaiClient.ts')
const { openaiFaultToTypedError } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { openrouterLimitWindow, openrouterObservedKeyUsage, __resetOpenrouterUsageStateForTest } =
  await import('../../src/services/providers/openrouter/openrouterUsageState.ts')
const { geminiLimitWindow, __resetGeminiUsageStateForTest } = await import(
  '../../src/services/providers/gemini/geminiUsageState.ts'
)
const { huggingfaceLimitWindow, __resetHuggingfaceUsageStateForTest } = await import(
  '../../src/services/providers/huggingface/huggingfaceUsageState.ts'
)
const geminiAccounts = await import('../../src/services/providers/gemini/geminiAccounts.ts')
const openaiAccounts = await import('../../src/services/providers/openai/openaiAccounts.ts')
const moonshotAccounts = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const huggingfaceAccounts = await import('../../src/services/providers/huggingface/huggingfaceAccounts.ts')
const openrouterAccounts = await import('../../src/services/providers/openrouter/openrouterAccounts.ts')
const providerSecrets = await import('../../src/utils/router/providerSecrets.ts')
const { scanAccountScopes } = await import('../../src/utils/accounts/scopeScan.ts')
const envUtils = await import('../../src/utils/envUtils.ts')
const { deriveFamilySlotGroups, executeSlotRemoval, maskedKeyTail } = await import(
  '../../src/services/providers/accountSlots.ts'
)
const { providerSessionSpend, activeSourceUsage } = await import(
  '../../src/services/providers/providerUsage.ts'
)
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { addToTotalSessionCost } = await import('../../src/cost-tracker.ts')
const { getModelUsage, getUsageForModel } = await import('../../src/bootstrap/state.ts')
const { previewForSelection, reconfirmTransitionPlan } = await import(
  '../../src/services/providers/transitionPreview.ts'
)
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { API_ERROR_MESSAGE_PREFIX } = await import('../../src/services/api/errors.ts')
import type { Options } from '../../src/services/providers/anthropic/streamCore.ts'
import type { AssistantMessage, Message } from '../../src/types/message.ts'
import type { RouterModelSnapshot } from '../../src/utils/router/modelRegistry.ts'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'


let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const rejections: unknown[] = []
process.on('unhandledRejection', reason => {
  rejections.push(reason)
})

const SECRET_MARKER = 'SECRETBODY'
const laneKey = (lane: string, tail: string): string => `sk-${lane}-${SECRET_MARKER}-${tail}`

function callParams(model: string): CompatCallModelParams {
  return {
    messages: [],
    systemPrompt: asSystemPrompt(['You are the fixture.']),
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      model,
      querySource: 'repl_main_thread',
      isNonInteractiveSession: true,
      getToolPermissionContext: async () => ({}) as never,
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
    } as unknown as Options,
  }
}

async function drain(
  gen: AsyncGenerator<unknown, unknown>,
): Promise<{ yields: unknown[]; errors: AssistantMessage[]; assistants: AssistantMessage[] }> {
  const yields: unknown[] = []
  for await (const y of gen) yields.push(y)
  const assistants = yields.filter(
    (y): y is AssistantMessage => (y as { type?: string }).type === 'assistant',
  )
  const errors = assistants.filter(a => a.isApiErrorMessage === true)
  return { yields, errors, assistants }
}

function messageText(m: AssistantMessage): string {
  const content = m.message.content
  if (!Array.isArray(content)) return String(content)
  return content
    .map(b => ((b as { type?: string }).type === 'text' ? (b as { text: string }).text : ''))
    .join('')
}

section('S1 · the family roster derives from the route law (never hand-copied)')

const FAMILIES = ['anthropic', ...PROVIDER_ID_SPACES.map(space => space.route)] as const
check('the route law declares exactly the ten launch families', FAMILIES.length === 10)
check(
  'every family has a display name of its own (no fallthrough spelling)',
  FAMILIES.every(f => providerDisplayName(f) !== f || f === 'local'),
  FAMILIES.filter(f => providerDisplayName(f) === f).join(','),
)

const FAMILY_MODEL: Record<string, string> = {
  anthropic: 'claude-opus-5',
  zai: 'glm-4.7',
  openai: 'gpt-5.2',
  moonshot: 'kimi-k3',
  deepseek: 'deepseek-chat',
  'openai-compat': 'compat/fixture-vendor-model',
  openrouter: 'openrouter/qwen/qwen3-coder',
  gemini: 'gemini-3-pro',
  huggingface: 'huggingface/fixture-org/fixture-model:auto',
  local: 'local/llama-fixture',
}
check('the journey matrix covers every declared family', FAMILIES.every(f => FAMILY_MODEL[f] !== undefined))
for (const f of FAMILIES) {
  check(`route re-derivation: '${FAMILY_MODEL[f]}' → ${f}`, declaredRouteOf(FAMILY_MODEL[f]) === f)
}

section('S2 · the session ledger partitions by the routing law (no spend bleed)')

{
  const usage = (input: number, output: number) =>
    ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) as never
  for (const f of FAMILIES) {
    addToTotalSessionCost(0.01, usage(100, 10), compatDispatchModelId(FAMILY_MODEL[f]!))
  }
  for (const f of FAMILIES) {
    const spend = providerSessionSpend(f as never)
    check(
      `spend partition: ${f} counts exactly its own model`,
      spend.models === 1 && spend.inputTokens === 100,
      `models=${spend.models} input=${spend.inputTokens}`,
    )
  }
  const ledgerRoutes = Object.keys(getModelUsage()).map(id => declaredRouteOf(id) ?? 'unrecognised')
  check(
    'every ledger key routes to exactly one family (qualified ids persist qualified)',
    FAMILIES.every(f => ledgerRoutes.filter(r => r === f).length === 1),
  )
}

section('S3 · J4 credential-absent: the refusal names the attach route, no wire hit')

const laneProfiles: Record<string, { profile: typeof moonshotLaneProfile; envKey?: string; keyEnvVar?: string }> = {
  moonshot: { profile: moonshotLaneProfile, keyEnvVar: 'MOONSHOT_API_KEY' },
  deepseek: { profile: deepseekLaneProfile, keyEnvVar: 'DEEPSEEK_API_KEY' },
  openrouter: { profile: openrouterLaneProfile, keyEnvVar: 'OPENROUTER_API_KEY' },
  gemini: { profile: geminiLaneProfile, keyEnvVar: 'GEMINI_API_KEY' },
  huggingface: { profile: huggingfaceLaneProfile, keyEnvVar: 'HF_TOKEN' },
}

const ATTACH_ROUTE_WORDS: Record<string, string> = {
  moonshot: 'MOONSHOT_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: '/logins',
  gemini: '/logins',
  huggingface: '/logins',
  'openai-compat': 'MERCURY_COMPAT_BASE_URL',
}

for (const [lane, { profile }] of Object.entries(laneProfiles)) {
  wire.chatHits = 0
  const { errors } = await drain(compatChatCallModel(profile, callParams(FAMILY_MODEL[lane]!)))
  const text = errors.map(messageText).join('\n')
  check(
    `${lane}: absent credential → ONE honest refusal naming the attach route`,
    errors.length === 1 && text.includes(ATTACH_ROUTE_WORDS[lane]!) && text.startsWith(API_ERROR_MESSAGE_PREFIX),
    text.slice(0, 140),
  )
  check(`${lane}: the refusal never touches the wire`, wire.chatHits === 0)
}
{
  wire.chatHits = 0
  const { errors } = await drain(
    compatChatCallModel(compatSlotLaneProfile, callParams(FAMILY_MODEL['openai-compat']!)),
  )
  const text = errors.map(messageText).join('\n')
  check(
    'openai-compat: unconfigured slot → the refusal names MERCURY_COMPAT_BASE_URL',
    errors.length === 1 && text.includes(ATTACH_ROUTE_WORDS['openai-compat']!),
    text.slice(0, 140),
  )
  check('openai-compat: no wire hit', wire.chatHits === 0)
}

section('S4 · J4/J5/J6 fault matrix — EVERY compat-lane family, same scenarios, equal outcomes')

process.env.MOONSHOT_API_KEY = laneKey('moonshot', '1111')
process.env.DEEPSEEK_API_KEY = laneKey('deepseek', '2222')
process.env.OPENROUTER_API_KEY = laneKey('openrouter', '3333')
process.env.GEMINI_API_KEY = laneKey('gemini', '4444')
process.env.HF_TOKEN = laneKey('huggingface', '5555')
process.env.MERCURY_COMPAT_BASE_URL = 'https://compat.fixture.invalid/v1'

const localRecord = {
  id: 'llama-fixture',
  server: 'vllm',
  baseUrl: 'https://local.fixture.invalid/v1',
} as never

interface MatrixLane {
  family: string
  run(model: string): AsyncGenerator<unknown, unknown>
  wireModel: string
  bearer: string | undefined
}

const MATRIX: MatrixLane[] = [
  {
    family: 'moonshot',
    run: m => compatChatCallModel(moonshotLaneProfile, callParams(m)),
    wireModel: 'kimi-k3',
    bearer: `Bearer ${process.env.MOONSHOT_API_KEY}`,
  },
  {
    family: 'deepseek',
    run: m => compatChatCallModel(deepseekLaneProfile, callParams(m)),
    wireModel: 'deepseek-chat',
    bearer: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
  },
  {
    family: 'openrouter',
    run: m => compatChatCallModel(openrouterLaneProfile, callParams(m)),
    wireModel: 'qwen/qwen3-coder',
    bearer: `Bearer ${process.env.OPENROUTER_API_KEY}`,
  },
  {
    family: 'gemini',
    run: m => compatChatCallModel(geminiLaneProfile, callParams(m)),
    wireModel: 'gemini-3-pro',
    bearer: `Bearer ${process.env.GEMINI_API_KEY}`,
  },
  {
    family: 'huggingface',
    run: m => compatChatCallModel(huggingfaceLaneProfile, callParams(m)),
    wireModel: 'fixture-org/fixture-model:auto',
    bearer: `Bearer ${process.env.HF_TOKEN}`,
  },
  {
    family: 'local',
    run: m => compatChatCallModel(localLaneProfileFor(localRecord), callParams(m)),
    wireModel: 'llama-fixture',
    bearer: undefined,
  },
  {
    family: 'openai-compat',
    run: m => compatChatCallModel(compatSlotLaneProfile, callParams(m)),
    wireModel: 'fixture-vendor-model',
    bearer: undefined,
  },
]

for (const row of MATRIX) {
  const model = FAMILY_MODEL[row.family]!
  console.log(`\n  · ${row.family}`)

  wire.scenario = 'http-401'
  wire.chatHits = 0
  {
    const { errors } = await drain(row.run(model))
    const text = errors.map(messageText).join('\n')
    check(
      `${row.family}: 401 → ONE typed authentication_failed refusal`,
      errors.length === 1 && errors[0]!.error === 'authentication_failed',
      `errors=${errors.length} error=${errors[0]?.error}`,
    )
    check(`${row.family}: 401 is not retried (hits=1)`, wire.chatHits === 1, `hits=${wire.chatHits}`)
    check(
      `${row.family}: the key value never appears in the refusal`,
      !text.includes(SECRET_MARKER),
    )
    check(
      `${row.family}: the wire saw the family's credential${row.bearer === undefined ? ' (keyless dispatch)' : ''}`,
      wire.lastAuth === row.bearer,
      `auth=${wire.lastAuth ?? '(none)'}`,
    )
    check(
      `${row.family}: the wire model id is the vendor spelling`,
      wire.lastBody?.model === row.wireModel,
      `wire=${String(wire.lastBody?.model)}`,
    )
  }

  wire.scenario = 'http-429'
  wire.chatHits = 0
  {
    const { errors } = await drain(row.run(model))
    check(
      `${row.family}: 429 → typed rate_limit after exactly one retry`,
      errors.length === 1 && errors[0]!.error === 'rate_limit' && wire.chatHits === 2,
      `errors=${errors.length} error=${errors[0]?.error} hits=${wire.chatHits}`,
    )
    if (row.family === 'openrouter') check('openrouter: the 429 retry-after landed as a real limit window', openrouterLimitWindow().state === 'limited')
    if (row.family === 'gemini') check('gemini: the 429 retry-after landed as a real limit window', geminiLimitWindow().state === 'limited')
    if (row.family === 'huggingface') check('huggingface: the 429 landed as a limit window', huggingfaceLimitWindow().state === 'limited')
  }

  wire.scenario = 'http-500'
  wire.chatHits = 0
  {
    const { errors } = await drain(row.run(model))
    check(
      `${row.family}: 500 → typed server_error after exactly one retry`,
      errors.length === 1 && errors[0]!.error === 'server_error' && wire.chatHits === 2,
      `errors=${errors.length} error=${errors[0]?.error} hits=${wire.chatHits}`,
    )
  }

  wire.scenario = 'malformed-json'
  wire.chatHits = 0
  {
    const { errors } = await drain(row.run(model))
    check(
      `${row.family}: malformed SSE JSON → ONE typed fault, no retry`,
      errors.length === 1 && errors[0]!.error === 'server_error' && wire.chatHits === 1,
      `errors=${errors.length} hits=${wire.chatHits}`,
    )
  }

  wire.scenario = 'truncated-sse'
  wire.chatHits = 0
  {
    const { errors, assistants } = await drain(row.run(model))
    const settledText = assistants.filter(a => !a.isApiErrorMessage).map(messageText).join('')
    check(
      `${row.family}: truncated stream → partial text settles AND a typed fault follows`,
      settledText.includes('partial answer') && errors.length === 1 && errors[0]!.error === 'server_error',
      `text='${settledText.slice(0, 30)}' errors=${errors.length}`,
    )
  }

  wire.scenario = 'happy'
  wire.chatHits = 0
  {
    const ledgerRow = getUsageForModel(compatDispatchModelId(model))
    const before = {
      input: ledgerRow?.inputTokens ?? 0,
      output: ledgerRow?.outputTokens ?? 0,
      cached: ledgerRow?.cacheReadInputTokens ?? 0,
    }
    const { errors, assistants } = await drain(row.run(model))
    const settled = assistants.filter(a => !a.isApiErrorMessage)
    const after = getUsageForModel(compatDispatchModelId(model))
    check(
      `${row.family}: happy turn settles with no error message`,
      errors.length === 0 && settled.length > 0 && wire.chatHits === 1,
      `errors=${errors.length} settled=${settled.length} hits=${wire.chatHits}`,
    )
    check(
      `${row.family}: usage joins the ledger under the persisted id (inclusive wire → disjoint ledger)`,
      (after?.inputTokens ?? 0) - before.input === 5 &&
        (after?.cacheReadInputTokens ?? 0) - before.cached === 2 &&
        (after?.outputTokens ?? 0) - before.output === 3,
      `Δinput=${(after?.inputTokens ?? 0) - before.input} Δcached=${(after?.cacheReadInputTokens ?? 0) - before.cached}`,
    )
  }
}

check(
  'openrouter: the polled key-usage truth was observed through the response seam',
  openrouterObservedKeyUsage().usage !== null,
)

{
  wire.scenario = 'refuse-all'
  wire.chatHits = 0
  const { errors } = await drain(
    compatChatCallModel(
      {
        ...moonshotLaneProfile,
        resolveCredential: () => ({ apiKey: 'moonshot-transport-fixture-key' }),
        requestUrl: () => 'https://unpinned.example.com/chat/completions',
      },
      callParams('kimi-k3'),
    ),
  )
  check(
    'transport: a pre-HTTP failure (DNS/refused class) is a typed server_error, never a throw',
    errors.length === 1 && errors[0]!.error === 'server_error',
    `errors=${errors.length} error=${errors[0]?.error}`,
  )
  check(
    'the unpinned-URL guard fired on both bounded attempts (fails loud, never open)',
    wire.unpinned.length === 2,
    `unpinned=${wire.unpinned.length}`,
  )
  wire.unpinned = []
}

section('S5 · J2/J3 refresh discipline — single-flight; refusal drops tokens')

function b64url(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url')
}
function fakeJwt(expSecFromNow: number): string {
  return `h.${b64url({ exp: Math.floor(Date.now() / 1000) + expSecFromNow })}.s`
}
function jsonFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
  counter: { posts: number },
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    counter.posts += (init?.method ?? 'GET') === 'POST' ? 1 : 0
    const { status, body } = handler(String(url), init)
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

{
  geminiAccounts.__resetGeminiAccountsForTest()
  geminiAccounts.writeGeminiOauthClientConfig({ clientId: 'client-fixture' })
  writeFileSync(
    geminiAccounts.geminiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      client: { clientId: 'client-fixture' },
      tokens: { accessToken: 'at-old', refreshToken: 'rt-1', accessTokenExpiresAtMs: Date.now() - 1 },
    }),
  )
  const counter = { posts: 0 }
  const fetchImpl = jsonFetch(
    () => ({ status: 200, body: { access_token: 'at-new', refresh_token: 'rt-1', expires_in: 3600 } }),
    counter,
  )
  const [a, b] = await Promise.all([
    geminiAccounts.currentGeminiTokens({ fetchImpl }),
    geminiAccounts.currentGeminiTokens({ fetchImpl }),
  ])
  check(
    'gemini: concurrent refreshes collapse to ONE token POST (never a double-refresh)',
    counter.posts === 1 && a?.accessToken === 'at-new' && b?.accessToken === 'at-new',
    `posts=${counter.posts}`,
  )
  const third = await geminiAccounts.currentGeminiTokens({ fetchImpl })
  check(
    'gemini: a fresh set answers from disk with zero further network',
    counter.posts === 1 && third?.accessToken === 'at-new',
    `posts=${counter.posts}`,
  )
}

{
  geminiAccounts.__resetGeminiAccountsForTest()
  writeFileSync(
    geminiAccounts.geminiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      client: { clientId: 'client-fixture' },
      tokens: { accessToken: 'at-old', refreshToken: 'rt-dead', accessTokenExpiresAtMs: Date.now() - 1 },
    }),
  )
  const counter = { posts: 0 }
  const fetchImpl = jsonFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }), counter)
  const result = await geminiAccounts.currentGeminiTokens({ fetchImpl })
  check(
    'gemini: invalid_grant drops the tokens (the honest signed-out state)',
    result === undefined && !geminiAccounts.geminiOauthConnected(),
  )
  check(
    'gemini: the operator client config SURVIVES the drop (infrastructure, not a credential)',
    geminiAccounts.geminiOauthClientConfig()?.clientId === 'client-fixture',
  )
  const auth = await geminiAccounts.resolveGeminiRequestAuth({ fetchImpl, env: { ...process.env, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined } as NodeJS.ProcessEnv })
  check('gemini: the next resolution refuses honestly (undefined, no zombie token)', auth === undefined)
}

{
  geminiAccounts.__resetGeminiAccountsForTest()
  writeFileSync(
    geminiAccounts.geminiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      client: { clientId: 'client-fixture' },
      tokens: { accessToken: 'at-stale', refreshToken: 'rt-1', accessTokenExpiresAtMs: Date.now() - 1 },
    }),
  )
  const counter = { posts: 0 }
  const fetchImpl = jsonFetch(() => ({ status: 500, body: {} }), counter)
  const result = await geminiAccounts.currentGeminiTokens({ fetchImpl })
  check(
    'gemini: a transient 5xx keeps the stored tokens (attempt-and-map, never a drop)',
    result?.accessToken === 'at-stale' && geminiAccounts.geminiOauthConnected(),
  )
}

{
  openaiAccounts.__resetOpenaiAccountsForTest()
  writeFileSync(
    openaiAccounts.openaiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'at-old',
        refreshToken: 'rt-1',
        accessTokenExpiresAtMs: Date.now() - 1,
      },
    }),
  )
  const counter = { posts: 0 }
  const fetchImpl = jsonFetch(
    () => ({
      status: 200,
      body: { id_token: '', access_token: fakeJwt(3600), refresh_token: 'rt-2' },
    }),
    counter,
  )
  const [a, b] = await Promise.all([
    openaiAccounts.currentSubscriptionTokens({ fetchImpl }),
    openaiAccounts.currentSubscriptionTokens({ fetchImpl }),
  ])
  check(
    'openai: concurrent refreshes collapse to ONE token POST; the rotation is adopted',
    counter.posts === 1 && a?.refreshToken === 'rt-2' && b?.refreshToken === 'rt-2',
    `posts=${counter.posts}`,
  )
  const file = JSON.parse(readFileSync(openaiAccounts.openaiAuthPathForDisplay(), 'utf8')) as {
    tokens?: { refreshToken?: string }
  }
  check('openai: the rotated refresh token is persisted', file.tokens?.refreshToken === 'rt-2')
}

{
  openaiAccounts.__resetOpenaiAccountsForTest()
  writeFileSync(
    openaiAccounts.openaiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      preferredSource: 'chatgpt-subscription',
      tokens: {
        idToken: '',
        accessToken: 'at-old',
        refreshToken: 'rt-revoked',
        accessTokenExpiresAtMs: Date.now() - 1,
      },
    }),
  )
  const counter = { posts: 0 }
  const fetchImpl = jsonFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }), counter)
  const result = await openaiAccounts.currentSubscriptionTokens({ fetchImpl })
  check(
    'openai: invalid_grant refuses — no zombie set returned',
    result === undefined && counter.posts === 1,
    `posts=${counter.posts}`,
  )
  const blanked = JSON.parse(readFileSync(openaiAccounts.openaiAuthPathForDisplay(), 'utf8')) as {
    preferredSource?: string
    tokens?: { refreshToken?: string; accessToken?: string }
  }
  check(
    'openai: the dead refreshToken is BLANKED on disk; the rest of the record survives',
    blanked.tokens?.refreshToken === '' &&
      blanked.tokens?.accessToken === 'at-old' &&
      blanked.preferredSource === 'chatgpt-subscription',
  )
  check(
    'openai: the subscription reads disconnected (the honest signed-out state the /logins refusal reports)',
    openaiAccounts.subscriptionConnected() === false &&
      openaiAccounts.openaiSubscriptionRef() === undefined,
  )
  const again = await openaiAccounts.currentSubscriptionTokens({ fetchImpl })
  const requestAuth = await openaiAccounts.resolveOpenaiRequestAuth({ fetchImpl })
  check(
    'openai: told once — the next resolution refuses with ZERO further wire POSTs',
    again === undefined && requestAuth === undefined && counter.posts === 1,
    `posts=${counter.posts}`,
  )
  writeFileSync(
    openaiAccounts.openaiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      tokens: { idToken: '', accessToken: 'at-old', refreshToken: 'rt-revoked', accessTokenExpiresAtMs: Date.now() - 1 },
    }),
  )
  const resurrected = await openaiAccounts.currentSubscriptionTokens({ fetchImpl })
  check(
    'openai: a resurrected dead token is never re-presented (the known-dead set)',
    resurrected === undefined && counter.posts === 1,
    `posts=${counter.posts}`,
  )
}

{
  openaiAccounts.__resetOpenaiAccountsForTest()
  writeFileSync(
    openaiAccounts.openaiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      tokens: { idToken: '', accessToken: 'at-doomed', refreshToken: 'rt-doomed', accessTokenExpiresAtMs: Date.now() - 1 },
    }),
  )
  const counter = { posts: 0 }
  const fetchImpl = jsonFetch(() => {
    writeFileSync(
      openaiAccounts.openaiAuthPathForDisplay(),
      JSON.stringify({
        version: 1,
        tokens: { idToken: '', accessToken: 'at-newlogin', refreshToken: 'rt-newlogin' },
      }),
    )
    return { status: 400, body: { error: 'invalid_grant' } }
  }, counter)
  const adopted = await openaiAccounts.currentSubscriptionTokens({ fetchImpl })
  const onDisk = JSON.parse(readFileSync(openaiAccounts.openaiAuthPathForDisplay(), 'utf8')) as {
    tokens?: { refreshToken?: string }
  }
  check(
    'openai: a concurrent login is adopted and NEVER clobbered by the verdict on the old token',
    adopted?.refreshToken === 'rt-newlogin' &&
      onDisk.tokens?.refreshToken === 'rt-newlogin' &&
      openaiAccounts.subscriptionConnected() === true,
  )
}

for (const [faultLabel, faultResponse] of [
  ['a network throw', null],
  ['HTTP 500 (even with a verdict-shaped body)', { status: 500, body: { error: 'invalid_grant' } }],
  ['HTTP 400 WITHOUT the invalid_grant verdict', { status: 400, body: { error: 'temporarily_unavailable' } }],
] as const) {
  openaiAccounts.__resetOpenaiAccountsForTest()
  writeFileSync(
    openaiAccounts.openaiAuthPathForDisplay(),
    JSON.stringify({
      version: 1,
      tokens: { idToken: '', accessToken: 'at-stale', refreshToken: 'rt-1', accessTokenExpiresAtMs: Date.now() - 1 },
    }),
  )
  const counter = { posts: 0 }
  let arm: 'fault' | 'recover' = 'fault'
  const fetchImpl = jsonFetch(() => {
    if (arm === 'fault') {
      if (faultResponse === null) throw new Error('network down')
      return faultResponse
    }
    return { status: 200, body: { id_token: '', access_token: fakeJwt(3600), refresh_token: 'rt-2' } }
  }, counter)
  const kept = await openaiAccounts.currentSubscriptionTokens({ fetchImpl })
  const diskAfterFault = JSON.parse(readFileSync(openaiAccounts.openaiAuthPathForDisplay(), 'utf8')) as {
    tokens?: { refreshToken?: string }
  }
  check(
    `openai: ${faultLabel} keeps the stored set on disk (stale returned, attempt-and-map)`,
    kept?.accessToken === 'at-stale' && diskAfterFault.tokens?.refreshToken === 'rt-1' && counter.posts === 1,
    `posts=${counter.posts}`,
  )
  arm = 'recover'
  openaiAccounts.__resetOpenaiAccountsForTest()
  const recovered = await openaiAccounts.currentSubscriptionTokens({ fetchImpl })
  check(
    `openai: after ${faultLabel} the next call RETRIES and adopts the rotation`,
    recovered?.refreshToken === 'rt-2' && counter.posts === 2,
    `posts=${counter.posts}`,
  )
}

{
  const polls = { denied: 0, pending: 0 }
  const deviceFetch = (handler: (url: string) => Response): typeof fetch =>
    (async (url: unknown) => handler(String(url))) as typeof fetch
  const denied = await openaiAccounts.beginOpenaiDeviceConnect({
    pollIntervalMsOverride: 1,
    fetchImpl: deviceFetch(url => {
      if (url.endsWith('/deviceauth/usercode')) {
        return Response.json({ user_code: 'ABCD-1234', device_auth_id: 'dev-1', interval: 1 })
      }
      polls.denied++
      return Response.json({ error: 'access_denied' }, { status: 403 })
    }),
  })
  let refusal: Error | undefined
  try {
    await denied.result
  } catch (error) {
    refusal = error as Error
  }
  check(
    'openai: a DENIED device approval ends the flow immediately with the honest refusal',
    polls.denied === 1 &&
      refusal !== undefined &&
      refusal.message.includes('denied') &&
      refusal.message.includes('access_denied'),
    `polls=${polls.denied} message=${refusal?.message ?? '(resolved)'}`,
  )
  const approved = await openaiAccounts.beginOpenaiDeviceConnect({
    pollIntervalMsOverride: 1,
    fetchImpl: deviceFetch(url => {
      if (url.endsWith('/deviceauth/usercode')) {
        return Response.json({ user_code: 'ABCD-1234', device_auth_id: 'dev-2', interval: 1 })
      }
      if (url.endsWith('/deviceauth/token')) {
        polls.pending++
        if (polls.pending === 1) return new Response('', { status: 428 })
        return Response.json({ authorization_code: 'code-1', code_verifier: 'ver-1' })
      }
      return Response.json({ id_token: '', access_token: fakeJwt(3600), refresh_token: 'rt-dev' })
    }),
  })
  const ref = await approved.result
  check(
    'openai: the pending statuses still poll through to an authorized exchange',
    polls.pending === 2 && ref.kind === 'chatgpt-subscription',
    `polls=${polls.pending}`,
  )
}

{
  moonshotAccounts.writeMoonshotTokens({ accessToken: 'at-x', refreshToken: 'rt-x' })
  const counter = { posts: 0 }
  const io = {
    fetchImpl: jsonFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }), counter),
    env: {
      ...process.env,
      MERCURY_MOONSHOT_OAUTH_BASE: 'https://moonshot-oauth.fixture.invalid',
      MERCURY_MOONSHOT_OAUTH_CLIENT_ID: 'client-fixture',
    } as NodeJS.ProcessEnv,
  }
  const result = await moonshotAccounts.refreshMoonshotTokens(io)
  check(
    'moonshot: a refused refresh drops the stored tokens',
    result === undefined && moonshotAccounts.moonshotStoredTokens() === undefined,
  )
}

{
  huggingfaceAccounts.__resetHuggingfaceAccountsForTest()
  huggingfaceAccounts.writeHuggingfaceTokens({ accessToken: 'hf_at', refreshToken: 'hf_rt' })
  const io = {
    fetchImpl: jsonFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }), { posts: 0 }),
    env: {
      ...process.env,
      MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'client-fixture',
    } as NodeJS.ProcessEnv,
  }
  const result = await huggingfaceAccounts.refreshHuggingfaceTokens(io)
  check(
    'huggingface: a refused refresh drops the stored tokens',
    result === undefined && huggingfaceAccounts.huggingfaceStoredTokens() === undefined,
  )
  huggingfaceAccounts.__resetHuggingfaceAccountsForTest()
  huggingfaceAccounts.writeHuggingfaceTokens({ accessToken: 'hf_at2', refreshToken: 'hf_rt2' })
  const failIo = {
    fetchImpl: (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch,
    env: {
      ...process.env,
      MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'client-fixture',
    } as NodeJS.ProcessEnv,
  }
  const kept = await huggingfaceAccounts.refreshHuggingfaceTokens(failIo)
  check(
    'huggingface: a transport failure keeps the stored tokens (no false sign-out)',
    kept === undefined && huggingfaceAccounts.huggingfaceStoredTokens()?.accessToken === 'hf_at2',
  )
  huggingfaceAccounts.writeHuggingfaceTokens(null)
}

{
  huggingfaceAccounts.__resetHuggingfaceAccountsForTest()
  huggingfaceAccounts.writeHuggingfaceTokens({
    accessToken: 'hf_at_expired',
    refreshToken: 'hf_rt_live',
    accessTokenExpiresAtMs: Date.now() - 60_000,
  })
  providerSecrets.writeStoredHuggingfaceApiKey(laneKey('hfpaste', 'BBBB'))
  const hfEnv = {
    ...process.env,
    HF_TOKEN: undefined,
    MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'client-fixture',
  } as NodeJS.ProcessEnv
  const transportIo = {
    fetchImpl: (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch,
    env: hfEnv,
  }
  const cred = await huggingfaceAccounts.resolveHuggingfaceDispatchCredential(transportIo)
  check(
    'huggingface: expired oauth + transport-failed refresh + a paste ⇒ the dispatch REFUSES (never the unreported paste)',
    cred === undefined,
  )
  check(
    'huggingface: the surfaces still report the OAuth identity and its store survived the transient fault',
    huggingfaceAccounts.resolveHuggingfaceAccount(hfEnv)?.kind === 'oauth' &&
      huggingfaceAccounts.huggingfaceStoredTokens()?.refreshToken === 'hf_rt_live',
  )
  const refusedIo = {
    fetchImpl: jsonFetch(() => ({ status: 400, body: { error: 'invalid_grant' } }), { posts: 0 }),
    env: hfEnv,
  }
  const cred2 = await huggingfaceAccounts.resolveHuggingfaceDispatchCredential(refusedIo)
  check(
    'huggingface: a REFUSED refresh drops the store and the dispatch falls to the paste',
    cred2?.apiKey === laneKey('hfpaste', 'BBBB') &&
      huggingfaceAccounts.huggingfaceStoredTokens() === undefined,
  )
  check(
    'huggingface: the surfaces move WITH the drop (one truth on both sides)',
    huggingfaceAccounts.resolveHuggingfaceAccount(hfEnv)?.keySource === 'stored',
  )
  providerSecrets.writeStoredHuggingfaceApiKey(null)
}

section('S6 · J1/J7/J10 — slots: masked tails only, env pins win, removal routes, files mode 600')

providerSecrets.writeStoredZaiApiKey(laneKey('zai-stored', 'aa11'))
providerSecrets.writeStoredMoonshotApiKey(laneKey('moonshot-stored', 'bb22'))
providerSecrets.writeStoredDeepseekApiKey(laneKey('deepseek-stored', 'cc33'))
providerSecrets.writeStoredOpenrouterApiKey(laneKey('openrouter-stored', 'dd44'))
providerSecrets.writeStoredGeminiApiKey(laneKey('gemini-stored', 'ee55'))
providerSecrets.writeStoredCompatApiKey(laneKey('compat-stored', 'ff66'))
providerSecrets.writeStoredHuggingfaceApiKey(laneKey('hf-stored', 'aa77'))
providerSecrets.writeStoredLocalApiKey(laneKey('local-stored', 'bb88'))
providerSecrets.writeStoredOpenaiApiKey(laneKey('openai-stored', 'cc99'))
moonshotAccounts.writeMoonshotTokens({ accessToken: laneKey('moonshot-oauth', 'dd00') })
openrouterAccounts.disconnectOpenrouterOauthKey()
geminiAccounts.writePreferredGeminiSource(null)

const fixtureProviders = FAMILIES.map(id => ({
  id,
  available: true,
  transport: 'native',
  description: {
    transport: 'native',
    capabilities: [],
    roles: [],
    account: { kind: 'none', label: '' },
    catalogue: [],
    catalogueSource: 'static-pin',
  },
})) as unknown as RouterModelSnapshot['providers']

const slotReads = {
  familyReads: {
    claudeSubscriber: () => false,
    subscriptionType: () => null,
    anthropicApiKeyPresent: () => false,
  },
  scanScopes: () => [],
  anthropicApiKey: () => ({ key: null, source: 'none' as const }),
}

{
  const groups = deriveFamilySlotGroups(fixtureProviders, slotReads)
  const flat = groups.flatMap(g => g.slots)
  const serialized = JSON.stringify(groups)
  check(
    'slots: NO slot field ever carries a key body (masked tails only)',
    !serialized.includes(SECRET_MARKER),
  )
  check(
    'slots: every seeded family shows its stored-key slot',
    ['zai', 'moonshot', 'deepseek', 'openrouter', 'gemini', 'openai-compat', 'huggingface', 'local'].every(
      family => flat.some(s => s.family === family && s.id.endsWith(':stored-key')),
    ) &&
      flat.some(s => s.id === 'openai:api-key'),
  )
  const moonshotSlots = flat.filter(s => s.family === 'moonshot')
  const envSlot = moonshotSlots.find(s => s.id === 'moonshot:env-key')
  const storedSlot = moonshotSlots.find(s => s.id === 'moonshot:stored-key')
  check(
    'slots: the env pin wins the active flag; the stored key is shadow-noted',
    envSlot?.active === true && storedSlot?.active === false && storedSlot?.stateNote?.includes('env pin') === true,
    JSON.stringify({ env: envSlot?.active, stored: storedSlot?.stateNote }),
  )
  check(
    'slots: the masked tail is the last four, never more',
    envSlot?.identity.includes('…1111') === true && !envSlot.identity.includes(SECRET_MARKER),
    envSlot?.identity,
  )
  const envRemoval = executeSlotRemoval(envSlot!)
  check(
    'removal: an env pin is refused honestly (the shell owns it)',
    envRemoval.mutated === false && envRemoval.note.includes('unset it in your shell'),
  )
  const storedRemoval = executeSlotRemoval(storedSlot!)
  check(
    'removal: the stored key clears through its OWNING store',
    storedRemoval.mutated === true && providerSecrets.readStoredMoonshotApiKey() === undefined,
  )
  const oauthSlot = flat.find(s => s.id === 'moonshot:oauth')
  check(
    'slots: the moonshot OAuth identity names the Kimi sign-in and its region, shadowed under the env pin',
    oauthSlot?.identity.includes('Kimi account (device-code sign-in') === true &&
      oauthSlot.active === false &&
      oauthSlot.stateNote?.includes('env pin') === true,
    JSON.stringify({ identity: oauthSlot?.identity, active: oauthSlot?.active, note: oauthSlot?.stateNote }),
  )
}

for (const [name, path] of [
  ['.provider-secrets.json', providerSecrets.providerSecretsPathForDisplay()],
  ['.gemini-auth.json', geminiAccounts.geminiAuthPathForDisplay()],
  ['.moonshot-auth.json', join(HOME, '.moonshot-auth.json')],
  ['.openai-auth.json', openaiAccounts.openaiAuthPathForDisplay()],
  ['.huggingface-auth.json', huggingfaceAccounts.huggingfaceAuthPathForDisplay()],
  ['.openrouter-auth.json', openrouterAccounts.openrouterAuthPathForDisplay()],
] as const) {
  let mode = -1
  try {
    mode = statSync(path).mode & 0o777
  } catch {
  }
  check(`hygiene: ${name} is mode 600`, mode === 0o600, `mode=${mode.toString(8)}`)
}
check("hygiene: maskedKeyTail refuses short values (nothing to mask ⇒ '')", maskedKeyTail('short') === '')

{
  const universe = scanAccountScopes()
  check(
    'universe: exactly ONE scope — the resolved config home, current, role-named',
    universe.length === 1 &&
      universe[0]!.dir === HOME &&
      universe[0]!.isCurrent === true &&
      universe[0]!.name === 'primary',
    JSON.stringify(universe.map(u => ({ name: u.name, dir: u.dir }))),
  )
  const scanOwnerSrc = readFileSync(join(import.meta.dir, '../../src/utils/accounts/scopeScan.ts'), 'utf8')
  check(
    'universe: the scan cannot enumerate siblings (no readdir, no account- roster pattern)',
    !scanOwnerSrc.includes('readdirSync') && !scanOwnerSrc.includes("account-'"),
  )
  const claudeHome = join(HOME, '.claude')
  mkdirSync(claudeHome, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = claudeHome
  ;(envUtils.getMercuryHome as unknown as { cache: { clear(): void } }).cache.clear()
  const claudeScan = scanAccountScopes()
  check(
    'universe: a claude-family resolved home is the one row, marked claudeFamily (honesty, never billable)',
    claudeScan.length === 1 && claudeScan[0]!.claudeFamily === true && claudeScan[0]!.dir === claudeHome,
    JSON.stringify(claudeScan),
  )
  process.env.MERCURY_CONFIG_DIR = HOME
  ;(envUtils.getMercuryHome as unknown as { cache: { clear(): void } }).cache.clear()
  const slotsSrc = readFileSync(join(import.meta.dir, '../../src/services/providers/accountSlots.ts'), 'utf8')
  const walletSrc = readFileSync(join(import.meta.dir, '../../src/services/wallet/wallet.ts'), 'utf8')
  check(
    'universe: board derivation and wallet consume the ONE scan owner',
    slotsSrc.includes('scanAccountScopes') && walletSrc.includes('scanAccountScopes'),
  )
}

section('S7 · J8 — the transition confirm is stale-safe for EVERY route (the deadlock class)')

const thinkingHistory: Message[] = [
  {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'pondering', signature: 'sig-native' },
        { type: 'text', text: 'answer', citations: null },
      ],
    },
  } as unknown as Message,
]

for (const f of FAMILIES) {
  if (f === 'openai') continue
  const plan = previewForSelection(thinkingHistory, 'claude-opus-5', FAMILY_MODEL[f]!)
  if (f === 'anthropic') {
    check('anthropic target: native carry needs no choice', plan.needsChoice === false)
    continue
  }
  const verdict = reconfirmTransitionPlan(plan, thinkingHistory)
  check(
    `${f} target: lossy switch presents a choice AND the confirm verdict is ok (no refresh deadlock)`,
    plan.needsChoice === true && verdict.ok === true,
    `needsChoice=${plan.needsChoice} ok=${verdict.ok}${!verdict.ok ? ` reason=${(verdict as { reason?: string }).reason}` : ''}`,
  )
}

section('S8 · J1/J5 usage + usability surfaces — honest shapes, one vocabulary')

{
  const spend = () => ({ inputTokens: 0, outputTokens: 0, costUSD: 0, models: 0 })
  const keyLaneShape = (family: string, model: string, reads: Record<string, unknown>) => {
    const usage = activeSourceUsage({ model, reads: { ...reads, spend } as never })
    check(
      `usage: ${family} credentialed → api-spend shape, 'API usage', tier 'API billing'`,
      usage.shape === 'api-spend' && usage.label === 'API usage' && usage.tier === 'API billing',
      JSON.stringify({ shape: usage.shape, label: usage.label, tier: usage.tier }),
    )
  }
  keyLaneShape('zai', FAMILY_MODEL.zai!, { zaiKeyPresent: () => true })
  keyLaneShape('openrouter', FAMILY_MODEL.openrouter!, {
    openrouterKeyPresent: () => true,
    openrouterObserved: () => ({ usage: null }),
    openrouterLimited: () => ({ state: 'clear' as const }),
  })
  keyLaneShape('moonshot', FAMILY_MODEL.moonshot!, {
    laneCredentialed: () => true,
    moonshotBalance: () => null,
  })
  keyLaneShape('deepseek', FAMILY_MODEL.deepseek!, {
    laneCredentialed: () => true,
    deepseekBalance: () => null,
  })
  keyLaneShape('openai-compat', FAMILY_MODEL['openai-compat']!, { laneCredentialed: () => true })

  const geminiOauth = activeSourceUsage({
    model: FAMILY_MODEL.gemini!,
    reads: {
      geminiAccount: () => ({ provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }),
      geminiLimited: () => ({ state: 'clear' as const }),
      spend,
    } as never,
  })
  check(
    "usage: gemini OAuth → tier 'Google sign-in' (a sign-in states no billing tier)",
    geminiOauth.sourceKind === 'oauth' && geminiOauth.tier === 'Google sign-in',
  )
  const uncredentialed = activeSourceUsage({
    model: FAMILY_MODEL.deepseek!,
    reads: { laneCredentialed: () => false, spend } as never,
  })
  check(
    "usage: an uncredentialed lane is the honest 'none' shape naming its provider",
    uncredentialed.shape === 'none' && uncredentialed.label === 'DeepSeek usage',
  )

  const usability = resolveProviderUsability({
    anthropicApiKey: () => null,
    anthropicSubscriber: () => false,
    anthropicLimitStatus: () => 'allowed',
    gptSeat: () => ({ state: 'disabled', why: 'no-account', reason: 'no OpenAI account — /logins' }),
    zaiKeyPresent: () => false,
    moonshotAccount: () => undefined,
    deepseekKeyPresent: () => false,
    compatConfigured: () => false,
    huggingfaceAccount: () => undefined,
    localServerPresent: () => false,
    openrouterKeyPresent: () => true,
    geminiAccount: () => ({ kind: 'oauth' }),
  })
  check(
    'usability: openrouter presence comes from its OWNING resolver (the fold tombstone is dead)',
    usability.openrouter.usable === true && usability.openrouter.credential === 'api-key',
  )
  check(
    'usability: gemini OAuth reads as a usable oauth credential',
    usability.gemini.usable === true && usability.gemini.credential === 'oauth',
  )
  check(
    'usability: NO lane answers the runtime-pending tombstone',
    !JSON.stringify(usability).includes('folds in from the provider-auth lane'),
  )
  const absent = resolveProviderUsability({
    ...({
      anthropicApiKey: () => null,
      anthropicSubscriber: () => false,
      anthropicLimitStatus: () => 'allowed',
      gptSeat: () => ({ state: 'disabled', why: 'no-account', reason: 'no OpenAI account — /logins' }),
      zaiKeyPresent: () => false,
      moonshotAccount: () => undefined,
      deepseekKeyPresent: () => false,
      compatConfigured: () => false,
      huggingfaceAccount: () => undefined,
      localServerPresent: () => false,
    } as never as Parameters<typeof resolveProviderUsability>[0]),
    openrouterKeyPresent: () => false,
    geminiAccount: () => undefined,
  })
  check(
    'usability: absent openrouter/gemini credentials name the attach route',
    absent.openrouter.blockers[0]!.includes('/logins') && absent.gemini.blockers[0]!.includes('/logins'),
  )
}

section('S9 · J6 — the deadline family covers every transport (compat · openai · zai)')

{
  const neverCloses = (): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start() {
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  const stallFetch = (async () => neverCloses()) as typeof fetch

  const compatEvents: { fault?: { kind: string; code: string; retryable: boolean } }[] = []
  for await (const e of streamCompatChat({
    apiKey: 'k',
    url: 'https://x.fixture.invalid/chat/completions',
    request: { model: 'm', messages: [] },
    fetchImpl: stallFetch,
    idleTimeoutMs: 40,
  })) {
    if (e.type === 'stream-fault') compatEvents.push({ fault: e.fault })
  }
  const openaiEvents: { fault?: { kind: string; code: string; retryable: boolean } }[] = []
  for await (const e of streamOpenaiResponses({
    baseUrl: 'https://oai-api.fixture.invalid/v1',
    headers: { authorization: 'Bearer k' },
    request: { model: 'm', input: [] } as never,
    fetchImpl: stallFetch,
    idleTimeoutMs: 40,
  })) {
    if (e.type === 'stream-fault') openaiEvents.push({ fault: (e as { fault: never }).fault })
  }
  const zaiEvents: { fault?: { kind: string; code: string; retryable: boolean } }[] = []
  for await (const e of streamZaiChat({
    apiKey: 'k',
    request: { model: 'glm-4.7', messages: [] } as never,
    fetchImpl: stallFetch,
    idleTimeoutMs: 40,
  })) {
    if ((e as { type: string }).type === 'stream-fault') {
      zaiEvents.push({ fault: (e as { fault: never }).fault })
    }
  }
  const idleFault = (events: { fault?: { kind: string; code: string; retryable: boolean } }[]) =>
    events.some(e => e.fault?.kind === 'timeout' && e.fault.code === 'idle-timeout' && e.fault.retryable)
  check('deadline: the compat transport has the idle watchdog (typed, retryable)', idleFault(compatEvents))
  check('deadline: the openai transport has the idle watchdog (typed, retryable)', idleFault(openaiEvents))
  check('deadline: the zai transport has the idle watchdog (typed, retryable)', idleFault(zaiEvents))

  check(
    "vocabulary: 401 is authentication_failed on BOTH mappers (the same 401, the same word)",
    compatFaultToTypedError({ kind: 'http-error', code: 'http-401' }) === 'authentication_failed' &&
      openaiFaultToTypedError({ kind: 'http-error' as never, code: 'http-401' }) === 'authentication_failed',
  )
  check(
    'vocabulary: a compat 429 is rate_limit; an idle stall is server_error on both',
    compatFaultToTypedError({ kind: 'http-error', code: 'http-429' }) === 'rate_limit' &&
      compatFaultToTypedError({ kind: 'timeout', code: 'idle-timeout' }) === 'server_error' &&
      openaiFaultToTypedError({ kind: 'timeout' as never, code: 'idle-timeout' }) === 'server_error',
  )
  check(
    'vocabulary: a 4xx request fault is invalid_request on the compat mapper',
    compatFaultToTypedError({ kind: 'http-error', code: 'http-404' }) === 'invalid_request',
  )
}

section('S10 · residue — no unpinned URL, no unhandled rejection, scratch home only')

__resetOpenrouterUsageStateForTest()
__resetGeminiUsageStateForTest()
__resetHuggingfaceUsageStateForTest()
globalThis.fetch = realFetch
await new Promise(resolve => setTimeout(resolve, 50))
check('no URL outside the fixture space ever reached the wire', wire.unpinned.length === 0, wire.unpinned.join(' '))
check(
  'no unhandled rejection escaped the journeys',
  rejections.length === 0,
  rejections.map(r => String(r)).join(' | ').slice(0, 200),
)
check('the scratch home holds the whole estate (no stray writes)', HOME.includes('auth-journeys-proof-'))

console.log(`\n${failures === 0 ? 'ALL GREEN' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
