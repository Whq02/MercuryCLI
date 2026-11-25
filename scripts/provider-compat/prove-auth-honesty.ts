#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

const honestyRefusalWhere = 'the refusal text is built in src/models/roads/openaicompat/chat-call-model/faults.ts and the family call model under src/models/roads/ (routedCallModel in callModelRouter.ts picks the family)'
const honestyRefreshWhere = 'the one forced refresh on a 401 and its refusal text live in the family call model under src/models/roads/ (geminiCallModel.ts, openai/openaiCallModel.ts) and its accounts file'

delete process.env.NODE_ENV
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'auth-honesty-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

type Reject = { status: number; body: unknown }
let answers: Array<Reject | 'ok'> = ['ok']
type Hit = { path: string; bearer: string | undefined }
let hits: Hit[] = []
let tokenPosts: Array<{ path: string; body: string }> = []
let tokenAnswer: { status: number; body: unknown } = { status: 200, body: {} }

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const chatOk = (): string =>
  [
    sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'settled' }, finish_reason: null }] }),
    sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }),
    'data: [DONE]\n\n',
  ].join('')
const responsesOk = (): string =>
  [
    sse({ type: 'response.created', response: { id: 'resp_ok' } }),
    sse({ type: 'response.output_text.delta', delta: 'settled' }),
    sse({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'settled' }] } }),
    sse({ type: 'response.completed', response: { id: 'resp_ok', usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } }),
  ].join('')
const nativeOk = (): string =>
  [
    sse({ candidates: [{ content: { role: 'model', parts: [{ text: 'settled' }] } }] }),
    sse({ candidates: [{ content: { role: 'model', parts: [{ text: '', thoughtSignature: 'fixture-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 12 } }),
  ].join('')
const OPENAI_MODELS_BODY = {
  models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', supported_reasoning_levels: [{ effort: 'high', description: 'high' }], default_reasoning_level: 'high', visibility: 'list', priority: 1, context_window: 272_000, input_modalities: ['text'], supported_in_api: true }],
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const bodyText = Buffer.concat(chunks).toString('utf8')
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(path.startsWith('/openai/') ? OPENAI_MODELS_BODY : path.startsWith('/moonshot/') ? { object: 'list', data: [{ id: 'kimi-k3', object: 'model', owned_by: 'moonshot', created: 1 }] } : { object: 'list', data: [{ id: 'fixture-local', object: 'model', owned_by: 'fixture' }] }))
      return
    }
    if (req.method === 'POST' && path.endsWith('/oauth/token')) {
      tokenPosts.push({ path, body: bodyText })
      res.writeHead(tokenAnswer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(tokenAnswer.body))
      return
    }
    if (req.method === 'POST' && (path.endsWith('/chat/completions') || path.endsWith('/responses') || path.endsWith(':streamGenerateContent'))) {
      const auth = req.headers['authorization']
      hits.push({ path, bearer: typeof auth === 'string' ? auth : undefined })
      const answer = answers[Math.min(hits.length - 1, answers.length - 1)] ?? 'ok'
      if (answer === 'ok') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(path.endsWith('/responses') ? responsesOk() : path.endsWith(':streamGenerateContent') ? nativeOk() : chatOk())
        return
      }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
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

const KEYS = {
  MERCURY_COMPAT_API_KEY: 'compat-secret-7d1',
  MOONSHOT_API_KEY: 'moonshot-secret-7d2',
  DEEPSEEK_API_KEY: 'deepseek-secret-7d3',
  OPENROUTER_API_KEY: 'openrouter-secret-7d4',
  GEMINI_API_KEY: 'gemini-secret-7d5',
  HF_TOKEN: 'hf-secret-7d6',
  ZAI_API_KEY: 'zai-secret-7d7',
  OPENAI_API_KEY: 'openai-secret-7d8',
  MERCURY_LOCAL_API_KEY: 'local-secret-7d9',
}
Object.assign(process.env, KEYS, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_LOCAL_BASE_URL: base,
  MERCURY_COMPAT_BASE_URL: `${base}/v1`,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/moonshot/oauth`,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
  MERCURY_OPENROUTER_API_BASE: `${base}/openrouter/api/v1`,
  MERCURY_OPENROUTER_AUTH_BASE: `${base}/openrouter/auth`,
  MERCURY_GEMINI_API_BASE: `${base}/gemini/v1beta`,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${base}/gemini/oauth/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${base}/gemini/oauth/token`,
  MERCURY_HUGGINGFACE_API_BASE: `${base}/hf/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: `${base}/hf/hub`,
  MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID: 'hf-client-fixture',
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  MERCURY_OPENAI_API_BASE: `${base}/openai/v1`,
  MERCURY_OPENAI_CHATGPT_BASE: `${base}/openai/chatgpt`,
  MERCURY_OPENAI_AUTH_BASE: `${base}/openai/auth`,
})

console.log('============================================================')
console.log(' auth honesty + credential recovery — every family, loopback')
console.log('============================================================')

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/models/roads/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { createUserMessage } = await import('../../src/engine/messages/messages.ts')
const geminiAccounts = await import('../../src/models/roads/gemini/geminiAccounts.ts')
const hfAccounts = await import('../../src/models/roads/huggingface/huggingfaceAccounts.ts')
const openaiAccounts = await import('../../src/models/roads/openai/openaiAccounts.ts')
type AssistantMessage = import('../../src/engine/message-shapes/message.ts').AssistantMessage

async function drive(model: string): Promise<{ errors: AssistantMessage[]; settled: AssistantMessage[]; text: string; threw: unknown }> {
  hits = []
  tokenPosts = []
  const assistants: AssistantMessage[] = []
  let threw: unknown
  try {
    for await (const item of routedCallModel({
      messages: [createUserMessage({ content: 'say hi' })] as never,
      systemPrompt: ['fixture system prompt'] as never,
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
      if ((item as { type?: string }).type === 'assistant') assistants.push(item as AssistantMessage)
    }
  } catch (error) {
    threw = error
  }
  const errors = assistants.filter(a => a.isApiErrorMessage)
  const settled = assistants.filter(a => !a.isApiErrorMessage)
  const text = errors.map(e => (e.message.content[0] as { text?: string } | undefined)?.text ?? '').join('\n')
  return { errors, settled, text, threw }
}

type Family = {
  family: string
  model: string
  label: string
  remedy: string[]
  secret: string
  reject401: Reject
  reject402?: Reject
}
const FAMILIES: Family[] = [
  { family: 'openai (API key)', model: 'gpt-5.6-sol', label: 'OpenAI', remedy: ['OPENAI_API_KEY', '/logins'], secret: KEYS.OPENAI_API_KEY, reject401: { status: 401, body: { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } } } },
  { family: 'zai', model: 'glm-5.2', label: 'Z.AI', remedy: ['ZAI_API_KEY', '/logins zai'], secret: KEYS.ZAI_API_KEY, reject401: { status: 401, body: { error: { code: 1001, message: 'Authentication failed' } } }, reject402: { status: 429, body: { error: { code: 1113, message: 'insufficient balance' } } } },
  { family: 'moonshot', model: 'kimi-k3', label: 'Moonshot', remedy: ['MOONSHOT_API_KEY', '/logins moonshot'], secret: KEYS.MOONSHOT_API_KEY, reject401: { status: 401, body: { error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } } }, reject402: { status: 402, body: { error: { message: 'insufficient balance', type: 'insufficient_balance_error' } } } },
  { family: 'deepseek', model: 'deepseek-v4-pro', label: 'DeepSeek', remedy: ['DEEPSEEK_API_KEY', '/logins deepseek'], secret: KEYS.DEEPSEEK_API_KEY, reject401: { status: 401, body: { error: { message: 'Authentication Fails', type: 'authentication_error', code: 'invalid_request_error' } } }, reject402: { status: 402, body: { error: { message: 'Insufficient Balance', type: 'invalid_request_error', code: 'invalid_request_error' } } } },
  { family: 'openai-compat', model: 'compat/fixture-model', label: 'Custom endpoint', remedy: ['MERCURY_COMPAT_API_KEY'], secret: KEYS.MERCURY_COMPAT_API_KEY, reject401: { status: 401, body: { error: { message: 'invalid api key', type: 'invalid_request_error' } } } },
  { family: 'openrouter', model: 'openrouter/fixture/model', label: 'OpenRouter', remedy: ['/logins', 'OPENROUTER_API_KEY'], secret: KEYS.OPENROUTER_API_KEY, reject401: { status: 401, body: { error: { code: 401, message: 'No auth credentials found' } } }, reject402: { status: 402, body: { error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits', metadata: {} } } } },
  { family: 'gemini (API key)', model: 'gemini-3-pro', label: 'Gemini', remedy: ['GEMINI_API_KEY', '/logins'], secret: KEYS.GEMINI_API_KEY, reject401: { status: 400, body: { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } } } },
  { family: 'huggingface (HF_TOKEN)', model: 'huggingface/fixture-org/fixture-model', label: 'Hugging Face', remedy: ['HF_TOKEN', '/logins'], secret: KEYS.HF_TOKEN, reject401: { status: 401, body: { error: 'Invalid username or password.' } }, reject402: { status: 402, body: { error: 'You have exceeded your monthly included credits for Inference Providers.' } } },
  { family: 'local', model: 'local/fixture-local', label: 'local', remedy: ['MERCURY_LOCAL_API_KEY'], secret: KEYS.MERCURY_LOCAL_API_KEY, reject401: { status: 401, body: { error: { message: 'Unauthorized', type: 'invalid_request_error' } } } },
]

section('§1 · a rejected credential: typed, provider-named, remedy-carrying, on every family')
for (const f of FAMILIES) {
  answers = [f.reject401]
  const o = await drive(f.model)
  const e = o.errors[0]
  const vendorWords = typeof (f.reject401.body as { error?: { message?: string } | string }).error === 'string'
    ? ((f.reject401.body as { error: string }).error)
    : ((f.reject401.body as { error: { message: string } }).error.message)
  check(
    `${f.family}: ONE typed authentication_failed refusal, no throw, no settled turn`,
    o.threw === undefined && o.errors.length === 1 && e?.error === 'authentication_failed' && o.settled.length === 0,
    `threw=${String(o.threw)} errors=${o.errors.length} class=${e?.error} text=${o.text.slice(0, 160)} — ${honestyRefusalWhere}`,
  )
  check(`${f.family}: the refusal names the provider and quotes the wire's words`, /rejected the .*credential/.test(o.text) && o.text.includes(vendorWords) && o.text.toLowerCase().includes(f.label.toLowerCase()), `${o.text.slice(0, 200)} — ${honestyRefusalWhere}`)
  check(`${f.family}: the refusal carries the exact remedy (${f.remedy.join(' · ')})`, f.remedy.every(r => o.text.includes(r)), `${o.text.slice(0, 240)} — the refusal must carry every remedy listed; ${honestyRefusalWhere}`)
  check(`${f.family}: the key value never appears`, !o.text.includes(f.secret), `the refusal text leaks the key; ${honestyRefusalWhere}`)
  check(`${f.family}: a key that cannot change is not retried (one wire hit)`, hits.length === 1, `hits=${hits.length} — a rejected API key must not be retried; ${honestyRefusalWhere}`)
  check(`${f.family}: no refresh was attempted (no token POST)`, tokenPosts.length === 0, `token POSTs=${tokenPosts.length} — an API-key family must not try a token refresh on a 401; ${honestyRefreshWhere}`)
}

section('§2 · an exhausted balance: typed billing_error with the top-up remedy')
for (const f of FAMILIES.filter(f => f.reject402)) {
  answers = [f.reject402!]
  const o = await drive(f.model)
  check(`${f.family}: typed billing_error`, o.errors.length === 1 && o.errors[0]?.error === 'billing_error', `class=${o.errors[0]?.error} text=${o.text.slice(0, 160)} — a 402 or exhausted-balance answer must map to billing_error; ${honestyRefusalWhere}`)
  check(`${f.family}: the refusal says out of credit and names a top-up / credits remedy`, o.text.includes('out of credit') && /top up|credits|balance/i.test(o.text) && o.text.toLowerCase().includes(f.label.toLowerCase()), `${o.text.slice(0, 240)} — ${honestyRefusalWhere}`)
}

section('§3 · refresh-on-401 for the OAuth families (one forced refresh, one retry, new bearer)')
const now = Date.now()
{
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  geminiAccounts.writeGeminiOauthClientConfig({ clientId: 'client-fixture' })
  writeFileSync(geminiAccounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1, client: { clientId: 'client-fixture' }, preferredSource: 'oauth', tokens: { accessToken: 'gemini-at-old', refreshToken: 'gemini-rt', accessTokenExpiresAtMs: now + 3_600_000 } }))
  tokenAnswer = { status: 200, body: { access_token: 'gemini-at-new', refresh_token: 'gemini-rt', expires_in: 3600 } }
  answers = [{ status: 401, body: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } }, 'ok']
  const o = await drive('gemini-3-pro')
  check('gemini OAuth: the turn SETTLES after the refresh (no error message)', o.errors.length === 0 && o.settled.length > 0, `${o.text.slice(0, 200)} — ${honestyRefreshWhere}`)
  check('gemini OAuth: two wire hits, the retry carrying the NEW bearer', hits.length === 2 && hits[0]?.bearer === 'Bearer gemini-at-old' && hits[1]?.bearer === 'Bearer gemini-at-new', `${JSON.stringify(hits)} — ${honestyRefreshWhere}`)
  check('gemini OAuth: exactly ONE token POST to the pinned Google token endpoint', tokenPosts.length === 1 && tokenPosts[0]?.path === '/gemini/oauth/token' && tokenPosts[0].body.includes('grant_type=refresh_token'), `${JSON.stringify(tokenPosts)} — ${honestyRefreshWhere}`)
  writeFileSync(geminiAccounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1, client: { clientId: 'client-fixture' }, preferredSource: 'oauth', tokens: { accessToken: 'gemini-at-stale', refreshToken: 'gemini-rt', accessTokenExpiresAtMs: now + 3_600_000 } }))
  tokenAnswer = { status: 500, body: {} }
  answers = [{ status: 401, body: { error: { code: 401, message: 'invalid credentials', status: 'UNAUTHENTICATED' } } }]
  const failed = await drive('gemini-3-pro')
  check('gemini OAuth: a failed refresh surfaces ONE typed refusal that says the refresh was attempted', failed.errors.length === 1 && failed.errors[0]?.error === 'authentication_failed' && failed.text.includes('refresh was attempted') && failed.text.includes('/logins'), `${failed.text.slice(0, 240)} — ${honestyRefreshWhere}`)
  check('gemini OAuth: no second wire hit with the same refused token', hits.length === 1 && tokenPosts.length === 1, `hits=${hits.length} tokenPosts=${tokenPosts.length} — ${honestyRefreshWhere}`)
  process.env.GEMINI_API_KEY = KEYS.GEMINI_API_KEY
  writeFileSync(geminiAccounts.geminiAuthPathForDisplay(), JSON.stringify({ version: 1, client: { clientId: 'client-fixture' } }))
}
{
  delete process.env.HF_TOKEN
  hfAccounts.writeHuggingfaceTokens({ accessToken: 'hf-at-old', refreshToken: 'hf-rt', accessTokenExpiresAtMs: now + 3_600_000 })
  tokenAnswer = { status: 200, body: { access_token: 'hf-at-new', refresh_token: 'hf-rt', expires_in: 3600 } }
  answers = [{ status: 401, body: { error: 'Invalid username or password.' } }, 'ok']
  const o = await drive('huggingface/fixture-org/fixture-model')
  check('huggingface OAuth: the turn SETTLES after the refresh', o.errors.length === 0 && o.settled.length > 0, `${o.text.slice(0, 200)} — ${honestyRefreshWhere}`)
  check('huggingface OAuth: two wire hits, the retry carrying the NEW bearer', hits.length === 2 && hits[0]?.bearer === 'Bearer hf-at-old' && hits[1]?.bearer === 'Bearer hf-at-new', `${JSON.stringify(hits)} — ${honestyRefreshWhere}`)
  check('huggingface OAuth: exactly ONE token POST to the pinned Hub token endpoint', tokenPosts.length === 1 && tokenPosts[0]?.path === '/hf/hub/oauth/token', `${JSON.stringify(tokenPosts)} — ${honestyRefreshWhere}`)
  process.env.HF_TOKEN = KEYS.HF_TOKEN
  answers = [{ status: 401, body: { error: 'Invalid username or password.' } }]
  const keyed = await drive('huggingface/fixture-org/fixture-model')
  check('huggingface HF_TOKEN: the env key is refused once, no refresh, remedy names HF_TOKEN', keyed.errors.length === 1 && hits.length === 1 && tokenPosts.length === 0 && keyed.text.includes('HF_TOKEN'), `hits=${hits.length} tokenPosts=${tokenPosts.length} — an env HF_TOKEN must be refused once with no refresh and a remedy naming HF_TOKEN; ${honestyRefusalWhere}`)
  hfAccounts.writeHuggingfaceTokens(null)
}
{
  delete process.env.OPENAI_API_KEY
  const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const fakeJwt = (expSecFromNow: number): string => `h.${b64url({ exp: Math.floor(Date.now() / 1000) + expSecFromNow })}.s`
  const oldAccess = fakeJwt(3600)
  writeFileSync(openaiAccounts.openaiAuthPathForDisplay(), JSON.stringify({ version: 1, preferredSource: 'chatgpt-subscription', tokens: { idToken: '', accessToken: oldAccess, refreshToken: 'rt-1', accessTokenExpiresAtMs: now + 3_600_000 } }))
  const newAccess = fakeJwt(7200)
  tokenAnswer = { status: 200, body: { id_token: '', access_token: newAccess, refresh_token: 'rt-2' } }
  answers = [{ status: 401, body: { error: { message: 'Invalid token', type: 'invalid_request_error', code: 'invalid_token' } } }, 'ok']
  const o = await drive('gpt-5.6-sol')
  check('openai subscription: the turn SETTLES after the refresh', o.errors.length === 0 && o.settled.length > 0, `${o.text.slice(0, 200)} — ${honestyRefreshWhere}`)
  check('openai subscription: two /responses hits on the ChatGPT base, the retry carrying the NEW bearer', hits.length === 2 && hits.every(h => h.path === '/openai/chatgpt/responses') && hits[0]?.bearer === `Bearer ${oldAccess}` && hits[1]?.bearer === `Bearer ${newAccess}`, `${JSON.stringify(hits.map(h => h.path))} — ${honestyRefreshWhere}`)
  check('openai subscription: exactly ONE token POST to the pinned issuer', tokenPosts.length === 1 && tokenPosts[0]?.path === '/openai/auth/oauth/token', `${JSON.stringify(tokenPosts.map(t => t.path))} — ${honestyRefreshWhere}`)
  answers = [{ status: 401, body: { error: { message: 'Invalid token', code: 'invalid_token' } } }]
  tokenAnswer = { status: 500, body: {} }
  writeFileSync(openaiAccounts.openaiAuthPathForDisplay(), JSON.stringify({ version: 1, preferredSource: 'chatgpt-subscription', tokens: { idToken: '', accessToken: oldAccess, refreshToken: 'rt-1', accessTokenExpiresAtMs: now + 3_600_000 } }))
  const failed = await drive('gpt-5.6-sol')
  check('openai subscription: a failed refresh surfaces ONE typed refusal naming /logins and the attempted refresh', failed.errors.length === 1 && failed.errors[0]?.error === 'authentication_failed' && failed.text.includes('/logins') && failed.text.includes('refresh was attempted'), `${failed.text.slice(0, 240)} — ${honestyRefreshWhere}`)
  process.env.OPENAI_API_KEY = KEYS.OPENAI_API_KEY
  writeFileSync(openaiAccounts.openaiAuthPathForDisplay(), JSON.stringify({ version: 1 }))
}

section('§4 · readiness derivations tell the truth the dispatch would tell')
{
  const { resolveProviderUsability } = await import('../../src/models/roads/providerUsability.ts')
  const { writeStoredZaiApiKey } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
  const { deriveFamilySlotGroups } = await import('../../src/models/roads/accountSlots.ts')
  const { __resetLaneBillingStateForTest } = await import('../../src/models/roads/laneBillingState.ts')
  __resetLaneBillingStateForTest()
  delete process.env.ZAI_API_KEY
  writeStoredZaiApiKey('stored-zai-key-fixture')
  const storedOnly = resolveProviderUsability().zai
  check('zai usability: a stored key with no env pin reads USABLE (the resolver truth, not an env-only read)', storedOnly.usable === true && storedOnly.credential === 'api-key' && storedOnly.blockers.length === 0, `${JSON.stringify(storedOnly)} — resolveProviderUsability in src/models/roads/providerUsability.ts must read the stored key, not only the environment`)
  writeStoredZaiApiKey(null)
  const none = resolveProviderUsability().zai
  check('zai usability: no key anywhere reads unusable with the attach route named', none.usable === false && none.blockers.some(b => b.includes('ZAI_API_KEY')), `${JSON.stringify(none)} — resolveProviderUsability in src/models/roads/providerUsability.ts must report unusable and name ZAI_API_KEY`)
  process.env.ZAI_API_KEY = KEYS.ZAI_API_KEY
  check('zai usability: the env pin reads usable', resolveProviderUsability().zai.usable === true, 'resolveProviderUsability in src/models/roads/providerUsability.ts must read an env ZAI_API_KEY as usable')

  const hfSlot = (oauth: { accessToken: string; refreshToken?: string; accessTokenExpiresAtMs?: number }) =>
    deriveFamilySlotGroups(undefined, {
      huggingfaceEnvKey: () => undefined,
      huggingfaceStoredKey: () => undefined,
      huggingfaceOauth: () => oauth,
      huggingfaceOauthIdentity: () => undefined,
      huggingfaceStoredKeyIdentity: () => undefined,
    } as never)
      .flatMap(g => g.slots)
      .find(s => s.id === 'huggingface:oauth')
  const expired = hfSlot({ accessToken: 'hf-expired', accessTokenExpiresAtMs: Date.now() - 1 })
  check('hf slot: expired + no refresh token ⇒ signedIn false, inactive, the note routes to /logins', expired !== undefined && expired.signedIn === false && expired.active === false && (expired.stateNote ?? '').includes('/logins'), `${JSON.stringify(expired)} — deriveFamilySlotGroups in src/models/roads/accountSlots.ts`)
  const refreshable = hfSlot({ accessToken: 'hf-expired', refreshToken: 'rt', accessTokenExpiresAtMs: Date.now() - 1 })
  check('hf slot: expired WITH a refresh token stays signed in (the dispatch resolver refreshes it)', refreshable?.signedIn === true && refreshable.active === true && refreshable.stateNote === undefined, `${JSON.stringify(refreshable)} — deriveFamilySlotGroups in src/models/roads/accountSlots.ts`)
  const fresh = hfSlot({ accessToken: 'hf-fresh', accessTokenExpiresAtMs: Date.now() + 3_600_000 })
  check('hf slot: a fresh token is signed in and active', fresh?.signedIn === true && fresh.active === true, `${JSON.stringify(fresh)} — deriveFamilySlotGroups in src/models/roads/accountSlots.ts`)
}

section('§5 · the ANTHROPIC lane: an OBSERVED-expired claude.ai sign-in fails fast and says so (item 11)')
{
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  const savedEnvBearer = process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_AUTH_TOKEN
  const { mkdirSync, readFileSync } = await import('node:fs')
  const home = process.env.MERCURY_CONFIG_DIR!
  mkdirSync(home, { recursive: true })
  const credsPath = join(home, '.credentials.json')
  const { isAnthropicOAuthSignInExpired, __resetKnownDeadRefreshTokensForTest } = await import('../../src/models/sign-in/credentials/auth.js')
const { clearOAuthTokenCache } = await import('../../src/models/sign-in/lifecycle/oauthLifecycle.js')
  const { isRetryableError } = await import('../../src/engine/requests/withRetry.js')
  const { getAssistantMessageFromError } = await import('../../src/engine/requests/apiErrorRows.js')
  const { anthropicCredentialPresence } = await import('../../src/models/roads/providerUsage.js')
  const { APIError } = await import('../../src/engine/request-parts/sdkErrors.js')
  const seed = (oauth: Record<string, unknown> | null): void => {
    __resetKnownDeadRefreshTokensForTest()
    clearOAuthTokenCache()
    writeFileSync(credsPath, JSON.stringify(oauth === null ? {} : { claudeAiOauth: oauth }))
    clearOAuthTokenCache()
  }
  const err401 = new APIError(
    401,
    { type: 'error', error: { type: 'authentication_error', message: 'OAuth token expired' } },
    'OAuth token expired',
    undefined as never,
  )
  const textOf = (m: { message: { content: unknown } }): string => JSON.stringify(m.message.content)

  seed({ accessToken: 'at-dead', refreshToken: '', expiresAt: Date.now() - 60_000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null })
  check('dead sign-in: the estate observes it (isAnthropicOAuthSignInExpired)', isAnthropicOAuthSignInExpired() === true, 'isAnthropicOAuthSignInExpired in src/models/sign-in/credentials/auth.ts must be true for an expired token with no refresh token')
  check('dead sign-in: a 401 is NOT retryable — fail fast, no backoff ladder', isRetryableError(err401) === false, 'isRetryableError in src/engine/requests/withRetry.ts must not retry a 401 when the sign-in is observed expired')
  const deadLine = textOf(getAssistantMessageFromError(err401, 'claude-opus-5') as never)
  check('dead sign-in: the ATTRIBUTED line names the reconnect', deadLine.includes('Anthropic sign-in expired') && deadLine.includes('/logins'), `${deadLine.slice(0, 200)} — getAssistantMessageFromError in src/engine/requests/apiErrorRows.ts must name the expired sign-in and /logins`)
  const deadPresence = anthropicCredentialPresence()
  check('dead sign-in: the presence owner carries expired (the /model row reads it)', deadPresence.expired === true, `${JSON.stringify(deadPresence)} — anthropicCredentialPresence in src/models/roads/providerUsage.ts must carry expired`)

  seed({ accessToken: 'at-old', refreshToken: 'rt-alive', expiresAt: Date.now() - 60_000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null })
  check('refreshable: NOT observed-expired', isAnthropicOAuthSignInExpired() === false, 'isAnthropicOAuthSignInExpired in src/models/sign-in/credentials/auth.ts must stay false while a refresh token exists')
  check('refreshable: a 401 never enters the backoff ladder; credential recovery is separate', isRetryableError(err401) === false, 'isRetryableError in src/engine/requests/withRetry.ts must not retry a 401')
  check('refreshable: no expired flag on the presence owner', anthropicCredentialPresence().expired === undefined, 'anthropicCredentialPresence in src/models/roads/providerUsage.ts must not set expired while a refresh token exists')

  seed(null)
  check('no oauth: predicate inert', isAnthropicOAuthSignInExpired() === false, 'isAnthropicOAuthSignInExpired in src/models/sign-in/credentials/auth.ts must be false with no claude.ai sign-in stored')
  const genericLine = textOf(getAssistantMessageFromError(err401, 'claude-opus-5') as never)
  check('no oauth: the generic 401 text stands (no false attribution)', !genericLine.includes('sign-in expired'), `${genericLine.slice(0, 200)} — getAssistantMessageFromError in src/engine/requests/apiErrorRows.ts must not blame an expired sign-in when none is stored`)

  seed({ accessToken: 'at-dead', refreshToken: '', expiresAt: Date.now() - 60_000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null })
  clearOAuthTokenCache()
  const { authChecks } = await import('../../src/platform/health/sections/auth.ts')
  const { anthropicSignInWords } = await import('../../src/models/roads/anthropicRefusal.ts')
  const expiredRow = await (await authChecks()).find(row => row.id === 'auth-anthropic')?.run()
  check('health AUTH row: expired branch present (warn on the observed or checked state, the one line as the fix)', expiredRow?.status === 'warn' && expiredRow.evidence.endsWith('— sign-in expired') && expiredRow.fix === anthropicSignInWords(), `${JSON.stringify(expiredRow)} — the auth-anthropic row in authChecks, src/platform/health/sections/auth.ts`)
  seed({ accessToken: 'at-dead', refreshToken: '', expiresAt: Date.now() - 60_000, scopes: ['user:inference'], subscriptionType: 'pro', rateLimitTier: null })
  process.env.ANTHROPIC_AUTH_TOKEN = 'env-shadow-token'
  clearOAuthTokenCache()
  check('env-shadowed: the expiry attribution stands down (the shadow owns the 401)', isAnthropicOAuthSignInExpired() === false, 'isAnthropicOAuthSignInExpired in src/models/sign-in/credentials/auth.ts must be false while ANTHROPIC_AUTH_TOKEN is set')
  delete process.env.ANTHROPIC_AUTH_TOKEN

  process.env.ANTHROPIC_AUTH_TOKEN = savedEnvBearer
  delete process.env.MERCURY_CREDENTIAL_STORE
}

server.close()
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
