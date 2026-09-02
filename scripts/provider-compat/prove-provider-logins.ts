#!/usr/bin/env bun
// ============================================================================
//  scripts/provider-compat/prove-provider-logins.ts — the /logins card's
//  Kimi (Moonshot), GLM (Z.AI) and DeepSeek legs END TO END: each leg's
//  driver (the exact code the connect surface runs) against ONE loopback
//  fixture through the REAL fetch path, the stored credential read back by
//  the REAL owners (slots · presences · usage · usability), then a REAL
//  routedCallModel turn dispatched on it — everything real short of a real
//  sign-in. Scratch config home; every endpoint base the run could reach is
//  pinned (an unpinned base fails open to real credentials); no network.
//
//    §0 the card and the vocabulary: nine rows, the vendors' names, the
//       /logins <family> words (kimi · glm · deepseek).
//    §1 Kimi device-code sign-in: start → pending → slow-down → authorized;
//       tokens + region stored (mode 600); the fresh bearer proven on the
//       coding base (GET /usages — the plan windows decode); the board,
//       the presences, the usage shape and the main-loop identity read the
//       sign-in; a turn rides the REGION CODING BASE with the bearer, never
//       the platform base; refresh-on-401 retries once on the new bearer;
//       a failed refresh says so; cancel · expiry · denial settle typed.
//    §2 Moonshot key: a refused key is never stored; a confirmed key stores
//       with its balance; the sign-in outranks it until disconnected (the
//       region stays remembered); a turn then rides the platform base; an
//       env key outranks everything and its refusal never claims a refresh;
//       a dead platform stores the key unverified.
//    §3 GLM key: a Coding Plan key stores WITH its plan and the lane
//       resolves key + base as one record (the Coding Plan base); the slot
//       and the presence name the plan; a turn dispatches with the key; a
//       general key clears the plan.
//    §4 DeepSeek key: a refused key is never stored; a confirmed key stores
//       with its balance; a turn dispatches with the key.
//
//  Run:  ~/.bun/bin/bun run scripts/provider-compat/prove-provider-logins.ts
// ============================================================================
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
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

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
const HOME = mkdtempSync(join(tmpdir(), 'provider-logins-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'ZAI_API_KEY', 'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN',
  'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_BASE_URL', 'MERCURY_LOCAL_API_KEY',
  'MERCURY_MOONSHOT_OAUTH_CLIENT_ID',
]) {
  delete process.env[key]
}

// ── the fixture ─────────────────────────────────────────────────────────────
const KIMI_ACCESS_1 = 'kimi-access-fixture-000000000001'
const KIMI_ACCESS_2 = 'kimi-access-fixture-000000000002'
const KIMI_REFRESH = 'kimi-refresh-fixture-00000000001'
const MOON_KEY = 'sk-moonshot-fixture-key-000001'
const ZAI_KEY = 'zai-fixture-coding-key-000001'
const ZAI_KEY_2 = 'zai-fixture-general-key-00002'
const DS_KEY = 'sk-deepseek-fixture-key-000001'
const USAGES_BODY = {
  usage: { used: '40', limit: '1000', resetTime: '2026-08-30T00:00:00Z' },
  limits: [
    { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: '1', limit: '100', resetTime: '2026-08-23T12:00:00Z' } },
    { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { used: '40', limit: '1000', resetTime: '2026-08-30T00:00:00Z', name: 'weekly' } },
  ],
  boosterWallet: { balance: '0', monthlyChargeLimit: '0', monthlyUsed: '0', monthlyChargeLimitEnabled: false },
}

type Hit = { path: string; bearer: string | undefined; body: string }
let hits: Hit[] = []
let tokenPosts: Hit[] = []
let deviceStarts = 0
/** The token endpoint's answers to the device grant, in order (the last repeats). */
let deviceLadder: Array<'pending' | 'slow_down' | 'ok' | 'access_denied'> = ['ok']
let deviceLadderAt = 0
let deviceExpiresIn = 300
let refreshAnswer: { status: number; body: unknown } = { status: 200, body: { access_token: KIMI_ACCESS_2, refresh_token: KIMI_REFRESH, expires_in: 3600 } }
let chatAnswers: Array<'ok' | { status: number; body: unknown }> = ['ok']
let validBearers = new Set<string>([KIMI_ACCESS_1, KIMI_ACCESS_2, MOON_KEY, ZAI_KEY, ZAI_KEY_2, DS_KEY])

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const chatOk = (): string =>
  [
    sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'settled' }, finish_reason: null }] }),
    sse({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }),
    'data: [DONE]\n\n',
  ].join('')
const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const body = Buffer.concat(chunks).toString('utf8')
    const auth = req.headers['authorization']
    const bearer = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : undefined
    if (req.method === 'POST' && path === '/kimi/oauth/api/oauth/device_authorization') {
      deviceStarts++
      hits.push({ path, bearer, body })
      json(res, 200, {
        device_code: 'kimi-device-code-1',
        user_code: 'KIMI-FIXT',
        verification_uri: `${base}/kimi/activate`,
        verification_uri_complete: `${base}/kimi/activate?user_code=KIMI-FIXT`,
        expires_in: deviceExpiresIn,
        interval: 1,
      })
      return
    }
    if (req.method === 'POST' && path === '/kimi/oauth/api/oauth/token') {
      tokenPosts.push({ path, bearer, body })
      const params = new URLSearchParams(body)
      if (params.get('grant_type') === 'refresh_token') {
        json(res, refreshAnswer.status, refreshAnswer.body)
        return
      }
      const step = deviceLadder[Math.min(deviceLadderAt, deviceLadder.length - 1)] ?? 'ok'
      deviceLadderAt++
      if (step === 'ok') {
        json(res, 200, { access_token: KIMI_ACCESS_1, refresh_token: KIMI_REFRESH, expires_in: 3600, token_type: 'Bearer', scope: 'kimi-code' })
        return
      }
      if (step === 'access_denied') {
        json(res, 400, { error: 'access_denied', error_description: 'The user declined' })
        return
      }
      json(res, 400, { error: step === 'pending' ? 'authorization_pending' : 'slow_down' })
      return
    }
    if (req.method === 'GET' && path === '/kimi/coding/v1/usages') {
      hits.push({ path, bearer, body })
      if (!bearer || !validBearers.has(bearer)) return json(res, 401, { error: 'unauthorized' })
      json(res, 200, USAGES_BODY)
      return
    }
    if (req.method === 'GET' && path === '/moonshot/v1/users/me/balance') {
      hits.push({ path, bearer, body })
      if (bearer !== MOON_KEY) return json(res, 401, { error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } })
      json(res, 200, { code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: '0x0', status: true })
      return
    }
    if (req.method === 'GET' && path === '/deepseek/user/balance') {
      hits.push({ path, bearer, body })
      if (bearer !== DS_KEY) return json(res, 401, { error: { message: 'Authentication Fails', type: 'authentication_error' } })
      json(res, 200, { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '42.50', granted_balance: '0.00', topped_up_balance: '42.50' }] })
      return
    }
    if (req.method === 'POST' && path.endsWith('/chat/completions')) {
      hits.push({ path, bearer, body })
      const answer = chatAnswers[Math.min(hits.filter(h => h.path.endsWith('/chat/completions')).length - 1, chatAnswers.length - 1)] ?? 'ok'
      if (answer === 'ok') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(chatOk())
        return
      }
      json(res, answer.status, answer.body)
      return
    }
    json(res, 404, {})
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const port = typeof address === 'object' && address ? address.port : 0
const base = `http://127.0.0.1:${port}`
const dead = 'http://127.0.0.1:9'

Object.assign(process.env, {
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_AUTH_TOKEN: 'fixture-token',
  MERCURY_OPENAI_API_BASE: dead,
  MERCURY_OPENAI_CHATGPT_BASE: dead,
  MERCURY_OPENAI_AUTH_BASE: dead,
  MERCURY_OPENROUTER_API_BASE: dead,
  MERCURY_OPENROUTER_AUTH_BASE: dead,
  MERCURY_GEMINI_API_BASE: dead,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: dead,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: dead,
  MERCURY_HUGGINGFACE_API_BASE: `${dead}/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: dead,
  MERCURY_MOONSHOT_API_BASE: `${base}/moonshot/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${base}/kimi/oauth`,
  MERCURY_MOONSHOT_CODING_BASE: `${base}/kimi/coding/v1`,
  MERCURY_ZAI_API_BASE: `${base}/zai/v4`,
  MERCURY_DEEPSEEK_API_BASE: `${base}/deepseek`,
})

console.log('============================================================')
console.log(' /logins — Kimi · GLM · DeepSeek legs, end to end on loopback')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const moonshotAccounts = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const moonshotLogin = await import('../../src/services/providers/moonshot/moonshotLogin.ts')
const moonshotUsage = await import('../../src/services/providers/moonshot/moonshotUsageState.ts')
const { storeZaiApiKeyLogin } = await import('../../src/services/providers/zai/zaiLogin.ts')
const { zaiChatCompletionsUrl } = await import('../../src/services/providers/zai/zaiClient.ts')
const { storeDeepseekApiKeyLogin } = await import('../../src/services/providers/deepseek/deepseekLogin.ts')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const { resolveZaiDispatch } = await import('../../src/utils/router/providerDiscovery.ts')
const { deriveFamilySlotGroups, executeSlotRemoval, mainLoopIdentity } = await import('../../src/services/providers/accountSlots.ts')
const { providerFamilyPresences, activeSourceUsage } = await import('../../src/services/providers/providerUsage.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const { parseFamilyFocus } = await import('../../src/commands/login/login.tsx')
type AssistantMessage = import('../../src/types/message.ts').AssistantMessage
type LoginEvent = import('../../src/services/providers/moonshot/moonshotLogin.ts').KimiDeviceLoginEvent

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
const chatHits = (): Hit[] => hits.filter(h => h.path.endsWith('/chat/completions'))
const noSleep = async (): Promise<void> => {}
const allText = (): string => JSON.stringify(deriveFamilySlotGroups()) + JSON.stringify(providerFamilyPresences())

section('§0 · the card and the vocabulary')
{
  const card = readFileSync(join(import.meta.dir, '../../src/components/ConsoleOAuthFlow.tsx'), 'utf8')
  // The rows live at THE row owner (loginFamilyRows.ts — shared with the
  // first-run walk); the card is pinned to derive from it.
  const { loginFamilyRows } = await import('../../src/components/loginFamilyRows.ts')
  const rows = loginFamilyRows({ engineLegs: true })
  check('the owner carries the Kimi row as a device-code sign-in OR API key', rows.some(r => r.label === 'Kimi (Moonshot) — device-code sign-in or API key' && r.value === 'moonshot'))
  check('the owner carries the GLM row as API key only (honest asymmetry)', rows.some(r => r.label === 'GLM (Z.AI) — API key (general or GLM Coding Plan)' && r.value === 'zai'))
  check('the owner carries the DeepSeek row as API key only', rows.some(r => r.label === 'DeepSeek — API key' && r.value === 'deepseek'))
  check('nine family rows on one screen: the card derives rows AND count from the owner list', rows.length === 9 && card.includes('loginFamilyRows({ engineLegs: onOpenaiDone !== undefined })') && card.includes('visibleOptionCount={idleRows.length}'))
  check('/logins <family> knows the vendors\' names', parseFamilyFocus('kimi') === 'moonshot' && parseFamilyFocus('moonshot') === 'moonshot' && parseFamilyFocus('glm') === 'zai' && parseFamilyFocus('z.ai') === 'zai' && parseFamilyFocus('zai') === 'zai' && parseFamilyFocus('deepseek') === 'deepseek')
  const command = readFileSync(join(import.meta.dir, '../../src/commands/login/index.ts'), 'utf8')
  check('the command names the three families and the words', command.includes('Kimi · GLM · DeepSeek') && command.includes('kimi|glm|deepseek'))
  check(
    '/logins <family> knows the WHOLE household vocabulary',
    parseFamilyFocus('anthropic') === 'claudeai' && parseFamilyFocus('claude') === 'claudeai' &&
      parseFamilyFocus('chatgpt') === 'openai' && parseFamilyFocus('gpt') === 'openai' &&
      parseFamilyFocus('console') === 'console' && parseFamilyFocus('openrouter') === 'openrouter' &&
      parseFamilyFocus('google') === 'gemini' && parseFamilyFocus('hf') === 'huggingface' &&
      parseFamilyFocus('HuggingFace') === 'huggingface' && parseFamilyFocus(undefined) === undefined &&
      parseFamilyFocus('unknown-word') === undefined,
  )
  // Re-pinned: the Anthropic machine — the console arm's
  // mint included — moved WHOLE to anthropicLoginModel (one machine, many
  // skins; the Boot face's logins layer consumes the same one). The law is
  // unchanged: the creating-key transition mints through the client seam;
  // the card is the skin that paints it.
  const machine = readFileSync(
    join(import.meta.dir, '../../src/components/mercury-ui/screens/anthropicLoginModel.ts'),
    'utf8',
  )
  check(
    'the console arm MINTS the usage-based key (the creating-key transition is live, in the ONE machine)',
    machine.includes('if (!deps.usesClaudeAiAuth(tokens.scopes)) {') &&
      machine.includes('deps.mintApiKey(tokens.accessToken)') &&
      machine.includes("setFlow({ name: 'creating-key' })") &&
      machine.includes('mintApiKey: accessToken => createAndStoreApiKey(accessToken)') &&
      card.includes("case 'creating-key':"),
  )
  const container = readFileSync(join(import.meta.dir, '../../src/commands/login/login.tsx'), 'utf8')
  check(
    'the /logins container owns no blanket esc/← (each leg owns its keys)',
    !container.includes('useInput'),
  )
}

section('§1 · the Kimi device-code sign-in, end to end')
{
  const events: LoginEvent[] = []
  deviceLadder = ['pending', 'slow_down', 'ok']
  deviceLadderAt = 0
  hits = []
  tokenPosts = []
  const outcome = await moonshotLogin.runKimiDeviceLogin({ region: 'global', sleep: noSleep, onEvent: e => events.push(e) })
  check('the sign-in settles ok', outcome.ok === true, outcome.receipt)
  const startHit = hits.find(h => h.path === '/kimi/oauth/api/oauth/device_authorization')
  check('start hit the pinned OAuth host with the published client id', startHit?.body === `client_id=${moonshotAccounts.KIMI_OAUTH_CLIENT_ID}`, startHit?.body)
  const waiting = events.filter((e): e is Extract<LoginEvent, { phase: 'waiting' }> => e.phase === 'waiting')
  check('the surface saw starting → waiting (the code + URL) → finishing', events[0]?.phase === 'starting' && waiting[0]?.start.userCode === 'KIMI-FIXT' && waiting[0]?.start.verificationUriComplete === `${base}/kimi/activate?user_code=KIMI-FIXT` && events[events.length - 1]?.phase === 'finishing', JSON.stringify(events.map(e => e.phase)))
  check('three device-grant polls walked pending → slow-down → authorized (the surface saw two waits)', tokenPosts.length === 3 && tokenPosts.every(p => new URLSearchParams(p.body).get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') && waiting.at(-1)?.polls === 2, `posts=${tokenPosts.length} lastPolls=${waiting.at(-1)?.polls}`)
  const stored = moonshotAccounts.moonshotStoredTokens()
  check('tokens + region persisted, mode 600', stored?.accessToken === KIMI_ACCESS_1 && stored.refreshToken === KIMI_REFRESH && moonshotAccounts.moonshotStoredRegion() === 'global' && (statSync(moonshotAccounts.moonshotAuthPathForDisplay()).mode & 0o777) === 0o600)
  const usagesHit = hits.find(h => h.path === '/kimi/coding/v1/usages')
  check('the fresh bearer was proven on the CODING base through GET /usages', usagesHit?.bearer === KIMI_ACCESS_1, JSON.stringify(usagesHit))
  check('the plan windows decoded (5h · wk · quota)', outcome.ok && outcome.usage?.windows.length === 2 && outcome.usage.quota?.used === 40 && outcome.usage.quota.limit === 1000 && outcome.usage.windows[0]?.windowMinutes === 300 && outcome.usage.windows[1]?.name === 'weekly', JSON.stringify(outcome.ok ? outcome.usage : null))
  check('the receipt names the region, the usage and the coding base — never the token', outcome.receipt.includes('global (kimi.ai)') && outcome.receipt.includes('usage 40/1000 (4%)') && outcome.receipt.includes(`${base}/kimi/coding/v1`) && !outcome.receipt.includes(KIMI_ACCESS_1) && !outcome.receipt.includes(KIMI_REFRESH), outcome.receipt)

  // The real owners read the sign-in as ONE truth.
  const groups = deriveFamilySlotGroups()
  const kimiSlot = groups.find(g => g.family.id === 'moonshot')?.slots.find(s => s.id === 'moonshot:oauth')
  check('/accounts: the Kimi slot is the active source, named by region, tail-masked', kimiSlot?.active === true && kimiSlot.signedIn && kimiSlot.identity.includes('global (kimi.ai)') && kimiSlot.identity.includes('…0001'), JSON.stringify(kimiSlot))
  const presences = providerFamilyPresences()
  const moonshotPresence = presences.find(p => (p.id as string) === 'moonshot')
  check('the presence owner reads the Kimi sign-in (the adapter account)', moonshotPresence?.credentialed === true && moonshotPresence.credentialLabel?.startsWith('Kimi account (device-code sign-in') === true, JSON.stringify(moonshotPresence))
  const identity = mainLoopIdentity({ model: 'kimi-k3', presences })
  check('the main-loop identity on a Kimi model names the sign-in', identity.route === 'moonshot' && identity.text.includes('Kimi account (device-code sign-in') && identity.basis === 'credential-present', identity.text)
  // reads: {} — the live owners, bypassing the rail's two-second cache.
  const usage = activeSourceUsage({ model: 'kimi-k3', reads: {} })
  check('the usage owner meters the plan windows on the oauth source', usage.shape === 'subscription-windows' && usage.sourceKind === 'oauth' && usage.tier === 'Kimi sign-in' && usage.windows.map(w => w.label).join(',') === '5h,wk,quota' && usage.windows[0]?.usedPct === 1, JSON.stringify(usage))
  const usability = resolveProviderUsability().moonshot
  check('usability reads the sign-in as a usable oauth credential', usability.usable && usability.credential === 'oauth', JSON.stringify(usability))
  check('no secret rides any derived surface', !allText().includes(KIMI_ACCESS_1) && !allText().includes(KIMI_REFRESH))

  // A REAL turn rides the region coding base with the bearer.
  chatAnswers = ['ok']
  const turn = await drive('kimi-k3')
  check('a turn on the sign-in SETTLES', turn.threw === undefined && turn.errors.length === 0 && turn.settled.length > 0, turn.text.slice(0, 200))
  check('…on the CODING base with the sign-in bearer — never the platform base', chatHits().length === 1 && chatHits()[0]?.path === '/kimi/coding/v1/chat/completions' && chatHits()[0]?.bearer === KIMI_ACCESS_1, JSON.stringify(chatHits()))
  check('the usage line: the profile re-read the meter after the response (TTL-bounded)', moonshotUsage.kimiObservedManagedUsage() !== null)

  // Refresh-on-401: one forced refresh, one retry on the NEW bearer.
  chatAnswers = [{ status: 401, body: { error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } } }, 'ok']
  refreshAnswer = { status: 200, body: { access_token: KIMI_ACCESS_2, refresh_token: KIMI_REFRESH, expires_in: 3600 } }
  const recovered = await drive('kimi-k3')
  check('a rejected bearer earns ONE refresh and the turn settles on the retry', recovered.errors.length === 0 && recovered.settled.length > 0, recovered.text.slice(0, 200))
  check('two wire hits on the coding base, old bearer then new', chatHits().length === 2 && chatHits()[0]?.bearer === KIMI_ACCESS_1 && chatHits()[1]?.bearer === KIMI_ACCESS_2 && chatHits().every(h => h.path === '/kimi/coding/v1/chat/completions'), JSON.stringify(chatHits().map(h => [h.path, h.bearer])))
  check('exactly ONE refresh POST to the pinned OAuth token path', tokenPosts.length === 1 && tokenPosts[0]?.path === '/kimi/oauth/api/oauth/token' && new URLSearchParams(tokenPosts[0].body).get('grant_type') === 'refresh_token', JSON.stringify(tokenPosts))
  check('the rotated bearer persisted', moonshotAccounts.moonshotStoredTokens()?.accessToken === KIMI_ACCESS_2)
  chatAnswers = [{ status: 401, body: { error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } } }]
  refreshAnswer = { status: 500, body: {} }
  const failed = await drive('kimi-k3')
  check('a failed refresh surfaces ONE typed refusal that says so and names /logins moonshot', failed.errors.length === 1 && failed.errors[0]?.error === 'authentication_failed' && failed.text.includes('refresh was attempted') && failed.text.includes('/logins moonshot') && chatHits().length === 1, failed.text.slice(0, 240))
  refreshAnswer = { status: 200, body: { access_token: KIMI_ACCESS_2, refresh_token: KIMI_REFRESH, expires_in: 3600 } }
  chatAnswers = ['ok']

  // Cancel · expiry · denial settle typed, nothing stored.
  moonshotAccounts.writeMoonshotTokens(null)
  deviceLadder = ['pending']
  deviceLadderAt = 0
  let polled = 0
  const cancelled = await moonshotLogin.runKimiDeviceLogin({ region: 'global', sleep: noSleep, cancelled: () => polled++ > 0 })
  check('cancel between polls settles typed with nothing stored', cancelled.ok === false && cancelled.code === 'cancelled' && moonshotAccounts.moonshotStoredTokens() === undefined, cancelled.receipt)
  deviceExpiresIn = 0
  const expired = await moonshotLogin.runKimiDeviceLogin({ region: 'global', sleep: noSleep })
  check('an expired code settles typed', expired.ok === false && expired.code === 'expired', expired.receipt)
  deviceExpiresIn = 300
  deviceLadder = ['access_denied']
  deviceLadderAt = 0
  const denied = await moonshotLogin.runKimiDeviceLogin({ region: 'mainland-cn', sleep: noSleep })
  check('a denial settles typed; the region choice is still remembered', denied.ok === false && denied.code === 'denied' && moonshotAccounts.moonshotStoredRegion() === 'mainland-cn', denied.receipt)
  deviceLadder = ['ok']
  deviceLadderAt = 0
  const again = await moonshotLogin.runKimiDeviceLogin({ region: 'global', sleep: noSleep })
  check('a fresh sign-in lands again (global)', again.ok === true && moonshotAccounts.moonshotStoredRegion() === 'global')
}

section('§2 · the Moonshot key leg beside the sign-in')
{
  hits = []
  const refused = await moonshotLogin.storeMoonshotApiKeyLogin('sk-moonshot-wrong-key-000000')
  check('a refused key is NEVER stored and the note says so', refused.ok === false && refused.stored === false && refused.receipt.includes('refused this key (HTTP 401)') && secrets.readStoredMoonshotApiKey() === undefined, refused.receipt)
  check('…after a balance probe on the platform base', hits.some(h => h.path === '/moonshot/v1/users/me/balance' && h.bearer === 'sk-moonshot-wrong-key-000000'))
  const confirmed = await moonshotLogin.storeMoonshotApiKeyLogin(MOON_KEY)
  check('a confirmed key stores with its balance, and says the sign-in outranks it', confirmed.ok && confirmed.stored && confirmed.receipt.includes('balance USD 49.58894') && confirmed.receipt.includes('the Kimi sign-in outranks the stored key') && secrets.readStoredMoonshotApiKey() === MOON_KEY && !confirmed.receipt.includes(MOON_KEY), confirmed.receipt)
  const withBoth = deriveFamilySlotGroups().find(g => g.family.id === 'moonshot')
  check('/accounts: the sign-in stays active and the stored key is shadow-noted', withBoth?.slots.find(s => s.id === 'moonshot:oauth')?.active === true && withBoth.slots.find(s => s.id === 'moonshot:stored-key')?.stateNote === 'shadowed — the Kimi sign-in wins', JSON.stringify(withBoth?.slots.map(s => [s.id, s.active, s.stateNote])))
  const removal = executeSlotRemoval(withBoth!.slots.find(s => s.id === 'moonshot:oauth')!)
  check('⌫ on the Kimi slot disconnects through the owning store and keeps the region', removal.mutated && removal.note.includes('region') && moonshotAccounts.moonshotStoredTokens() === undefined && moonshotAccounts.moonshotStoredRegion() === 'global', removal.note)
  const keyTurn = await drive('kimi-k3')
  check('a turn now rides the PLATFORM base with the stored key (no refresh route)', keyTurn.errors.length === 0 && keyTurn.settled.length > 0 && chatHits().length === 1 && chatHits()[0]?.path === '/moonshot/v1/chat/completions' && chatHits()[0]?.bearer === MOON_KEY && tokenPosts.length === 0, JSON.stringify(chatHits()))
  const keyUsage = activeSourceUsage({ model: 'kimi-k3', reads: {} })
  check('the usage owner reads the key as API billing with the stated balance', keyUsage.shape === 'api-spend' && keyUsage.sourceKind === 'api-key' && keyUsage.balance?.display === 'USD 49.58894', JSON.stringify(keyUsage))
  process.env.MOONSHOT_API_KEY = 'sk-moonshot-env-key-0000000'
  chatAnswers = [{ status: 401, body: { error: { message: 'Invalid Authentication', type: 'invalid_authentication_error' } } }]
  const envTurn = await drive('kimi-k3')
  check('an env key outranks the store, rides the platform base, and its refusal never claims a refresh', envTurn.errors.length === 1 && chatHits()[0]?.bearer === 'sk-moonshot-env-key-0000000' && chatHits()[0]?.path === '/moonshot/v1/chat/completions' && tokenPosts.length === 0 && envTurn.text.includes('MOONSHOT_API_KEY') && envTurn.text.includes('/logins moonshot') && !envTurn.text.includes('refresh was attempted') && !envTurn.text.includes('sk-moonshot-env-key'), envTurn.text.slice(0, 240))
  delete process.env.MOONSHOT_API_KEY
  chatAnswers = ['ok']
  process.env.MERCURY_MOONSHOT_API_BASE = `${dead}/moonshot/v1`
  const unverified = await moonshotLogin.storeMoonshotApiKeyLogin(MOON_KEY)
  check('a dead platform stores the key UNVERIFIED with the fault named', unverified.ok && unverified.stored && unverified.receipt.includes('UNVERIFIED') && secrets.readStoredMoonshotApiKey() === MOON_KEY, unverified.receipt)
  process.env.MERCURY_MOONSHOT_API_BASE = `${base}/moonshot/v1`
}

section('§3 · the GLM (Z.AI) key leg — the plan travels with the key')
{
  const coding = storeZaiApiKeyLogin(ZAI_KEY, 'coding')
  check('a Coding Plan key stores WITH its plan; the receipt names the Coding Plan base', coding.ok && coding.stored && secrets.readStoredZaiApiKey() === ZAI_KEY && secrets.readStoredZaiKeyPlan() === 'coding' && coding.receipt.includes('GLM Coding Plan key stored') && coding.receipt.includes('api.z.ai/api/coding/paas/v4') && !coding.receipt.includes(ZAI_KEY), coding.receipt)
  const dispatch = resolveZaiDispatch()
  check('the lane resolves key + plan as ONE record', dispatch?.key === ZAI_KEY && dispatch.source === 'stored' && dispatch.plan === 'coding', JSON.stringify({ ...dispatch, key: '…' }))
  check('the plan picks the production base (coding ≠ general)', zaiChatCompletionsUrl({} as NodeJS.ProcessEnv, 'coding') === 'https://api.z.ai/api/coding/paas/v4/chat/completions' && zaiChatCompletionsUrl({} as NodeJS.ProcessEnv, 'general') === 'https://api.z.ai/api/paas/v4/chat/completions')
  const zaiSlot = deriveFamilySlotGroups().find(g => g.family.id === 'zai')?.slots.find(s => s.id === 'zai:stored-key')
  check('/accounts names the plan on the slot', zaiSlot?.identity.startsWith('GLM Coding Plan key') === true && zaiSlot.kindLabel === 'Coding Plan key' && zaiSlot.active === true, JSON.stringify(zaiSlot))
  const zaiPresence = providerFamilyPresences().find(p => (p.id as string) === 'zai')
  check('the presence owner names the plan (the adapter account)', zaiPresence?.credentialed === true && zaiPresence.credentialLabel === 'GLM Coding Plan key (stored, auth-scoped)', JSON.stringify(zaiPresence))
  const turn = await drive('glm-5.2')
  check('a turn dispatches with the stored key on the pinned base', turn.errors.length === 0 && turn.settled.length > 0 && chatHits().length === 1 && chatHits()[0]?.path === '/zai/v4/chat/completions' && chatHits()[0]?.bearer === ZAI_KEY, JSON.stringify(chatHits()))
  const general = storeZaiApiKeyLogin(ZAI_KEY_2, 'general')
  check('a general key clears the plan', general.ok && secrets.readStoredZaiKeyPlan() === undefined && resolveZaiDispatch()?.plan === 'general' && general.receipt.includes('Z.AI API key (general) stored'), general.receipt)
  // An env ZAI_API_KEY outranks the store on the WIRE, and its refusal
  // names the env var and /logins zai — never a refresh (no route exists).
  process.env.ZAI_API_KEY = 'zai-fixture-env-key-000003'
  chatAnswers = [{ status: 401, body: { error: { message: 'invalid key', code: 1002 } } }]
  const envTurn = await drive('glm-5.2')
  check('an env Z.AI key outranks the stored one on the wire', chatHits().length === 1 && chatHits()[0]?.bearer === 'zai-fixture-env-key-000003' && chatHits()[0]?.path === '/zai/v4/chat/completions', JSON.stringify(chatHits().map(h => [h.path, h.bearer])))
  check('…and its refusal names ZAI_API_KEY + /logins zai, never a refresh', envTurn.errors.length === 1 && envTurn.text.includes('ZAI_API_KEY') && envTurn.text.includes('/logins zai') && !envTurn.text.includes('refresh was attempted') && !envTurn.text.includes('zai-fixture-env-key'), envTurn.text.slice(0, 240))
  delete process.env.ZAI_API_KEY
  chatAnswers = ['ok']
  secrets.writeStoredZaiApiKey(null)
  check('clearing the key clears the plan with it', secrets.readStoredZaiApiKey() === undefined && secrets.readStoredZaiKeyPlan() === undefined)
}

section('§4 · the DeepSeek key leg')
{
  hits = []
  const refused = await storeDeepseekApiKeyLogin('sk-deepseek-wrong-key-000000')
  check('a refused key is NEVER stored', refused.ok === false && refused.stored === false && refused.receipt.includes('refused this key (HTTP 401)') && secrets.readStoredDeepseekApiKey() === undefined, refused.receipt)
  const confirmed = await storeDeepseekApiKeyLogin(DS_KEY)
  check('a confirmed key stores with its balance', confirmed.ok && confirmed.stored && confirmed.receipt.includes('balance USD 42.50') && secrets.readStoredDeepseekApiKey() === DS_KEY && !confirmed.receipt.includes(DS_KEY), confirmed.receipt)
  check('…after a balance probe with the key', hits.some(h => h.path === '/deepseek/user/balance' && h.bearer === DS_KEY))
  const slot = deriveFamilySlotGroups().find(g => g.family.id === 'deepseek')?.slots.find(s => s.id === 'deepseek:stored-key')
  check('/accounts: the DeepSeek key is its active slot', slot?.active === true && slot.identity.includes('…0001'), JSON.stringify(slot))
  const turn = await drive('deepseek-v4-pro')
  check('a turn dispatches with the stored key', turn.errors.length === 0 && turn.settled.length > 0 && chatHits().length === 1 && chatHits()[0]?.path === '/deepseek/chat/completions' && chatHits()[0]?.bearer === DS_KEY, JSON.stringify(chatHits()))
  const usage = activeSourceUsage({ model: 'deepseek-v4-pro', reads: {} })
  check('the usage owner reads the key with the provider-stated balance', usage.shape === 'api-spend' && usage.balance?.display === 'USD 42.50', JSON.stringify(usage))
  // An env DEEPSEEK_API_KEY outranks the store on the WIRE, and its refusal
  // names the env var and /logins deepseek — never a refresh.
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-env-key-000002'
  chatAnswers = [{ status: 401, body: { error: { message: 'Authentication Fails', type: 'authentication_error' } } }]
  const envTurn = await drive('deepseek-v4-pro')
  check('an env DeepSeek key outranks the stored one on the wire', chatHits().length === 1 && chatHits()[0]?.bearer === 'sk-deepseek-env-key-000002' && chatHits()[0]?.path === '/deepseek/chat/completions', JSON.stringify(chatHits().map(h => [h.path, h.bearer])))
  check('…and its refusal names DEEPSEEK_API_KEY + /logins deepseek, never a refresh', envTurn.errors.length === 1 && envTurn.text.includes('DEEPSEEK_API_KEY') && envTurn.text.includes('/logins deepseek') && !envTurn.text.includes('refresh was attempted') && !envTurn.text.includes('sk-deepseek-env-key'), envTurn.text.slice(0, 240))
  delete process.env.DEEPSEEK_API_KEY
  chatAnswers = ['ok']
  check('no secret rides any derived surface', !allText().includes(DS_KEY) && !allText().includes(MOON_KEY))
}

server.close()
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(60))
console.log(failures === 0 ? `PROVIDER LOGINS: ALL GREEN (${checks} checks)` : `❌ ${failures} of ${checks} checks FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
