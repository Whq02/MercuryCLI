#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { CompatCallModelParams } from '../../src/services/providers/openaicompat/compatChatCallModel.ts'
import type { AssistantMessage } from '../../src/types/message.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.BROWSER = '/usr/bin/true'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const k of ['MODEL_API_KEY', 'META_API_KEY', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[k]

let failures = 0
let passes = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passes++
  else failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const ACCOUNT_TOKEN = 'meta-oidc-account-token-fixture-0001'
const MINTED_KEY = 'LLM|987654321|muse-code-minted-key-fixture-abcdef'
const STORED_API_KEY = 'LLM|123456789|stored-payg-api-key-fixture-999999'

interface RecordedRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: string
}

const requests: RecordedRequest[] = []
let startReply: { status: number; body: Record<string, unknown> } = {
  status: 200,
  body: {
    device_code: 'dev-meta-001',
    user_code: 'MUSE-4321',
    verification_uri: 'https://auth.meta.com/device',
    verification_uri_complete: 'https://auth.meta.com/device?user_code=MUSE-4321',
    interval: 2,
    expires_in: 600,
  },
}
let pollQueue: Array<{ status: number; body: Record<string, unknown> } | 'drop'> = []
let keyReply: { status: number; body: unknown } = {
  status: 200,
  body: {
    api_key: MINTED_KEY,
    user_email: 'subscriber@example.com',
    user_id: 'uid-meta-42',
    is_subs_active: true,
    subs_tier_id: 'pro',
    subs_tier_name: 'Muse Code Pro',
    subs_usage: {
      window: {
        used_percent: 24,
        resets_at: '2026-10-14T10:00:00.000Z',
        window_duration_mins: 300,
      },
      weekly: {
        used_percent: 41,
        resets_at: '2026-10-20T00:00:00.000Z',
        window_duration_mins: 10080,
      },
    },
  },
}
let modelsStatus = 200
let chatStatus = 200

const sse = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const body = await req.text()
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    requests.push({ method: req.method, path: url.pathname, headers, body })
    if (url.pathname === '/oidc/device/authorization/') {
      return Response.json(startReply.body, { status: startReply.status })
    }
    if (url.pathname === '/oidc/device/token/') {
      const next = pollQueue.shift() ?? { status: 400, body: { error: 'authorization_pending' } }
      if (next === 'drop') return Response.error()
      return Response.json(next.body, { status: next.status })
    }
    if (url.pathname === '/muse-code/key') {
      return typeof keyReply.body === 'string'
        ? new Response(keyReply.body, { status: keyReply.status })
        : Response.json(keyReply.body, { status: keyReply.status })
    }
    if (url.pathname === '/v1/models') {
      if (modelsStatus !== 200) {
        return Response.json({ error: { message: 'invalid Muse Code key' } }, { status: modelsStatus })
      }
      return Response.json({ data: [{ id: 'muse-spark-1.3', created: 3, owned_by: 'meta' }] }, { status: 200 })
    }
    if (url.pathname === '/v1/chat/completions') {
      if (chatStatus !== 200) {
        return Response.json(
          { error: { message: 'invalid API key' } },
          { status: chatStatus, headers: { 'x-should-retry': 'false' } },
        )
      }
      const parsed = JSON.parse(body) as { model: string }
      const chunk = (delta: unknown, finish: string | null = null): string =>
        sse({
          id: 'meta-chat-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: parsed.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
      const stream =
        chunk({ role: 'assistant' }) +
        chunk({ content: 'MUSE-CODE-WIRE-OK' }) +
        chunk({}, 'stop') +
        sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) +
        'data: [DONE]\n\n'
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  },
})

process.env.MERCURY_META_API_BASE = `http://127.0.0.1:${server.port}/v1`

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const accounts = await import('../../src/services/providers/meta/metaAccounts.ts')
const login = await import('../../src/services/providers/meta/metaLogin.ts')
const catalogue = await import('../../src/services/providers/meta/metaCatalogue.ts')
const slots = await import('../../src/services/providers/accountSlots.ts')
const screen = await import('../../src/components/BootLoginsScreen.tsx')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const { asSystemPrompt } = await import('../../src/utils/systemPromptType.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const repoRoot = join(import.meta.dir, '..', '..')

async function runChat(model = 'muse-spark-1.3'): Promise<AssistantMessage[]> {
  const params: CompatCallModelParams = {
    messages: [createUserMessage({ content: 'hello muse' })],
    tools: [],
    systemPrompt: asSystemPrompt(['Fixture system']),
    thinkingConfig: { type: 'disabled' },
    signal: new AbortController().signal,
    options: {
      model,
      querySource: 'main_thread',
      isNonInteractiveSession: true,
      getToolPermissionContext: async () => ({}),
      agents: [],
      hasAppendSystemPrompt: false,
      mcpTools: [],
    } as never,
  }
  const out: AssistantMessage[] = []
  for await (const event of routedCallModel(params as never)) {
    if (event.type === 'assistant') out.push(event as AssistantMessage)
  }
  return out
}

try {
  console.log('── 1. Card rows & one device-code engine across two skins ──')
  check(
    'the Meta card offers Sign in with Meta first and the API key second',
    login.META_CONNECT_ROWS[0]?.label === 'Sign in with Meta — a Muse Code subscription, a device code in your browser' &&
      login.META_CONNECT_ROWS[0]?.value === 'device' &&
      login.META_CONNECT_ROWS[1]?.value === 'key',
    JSON.stringify(login.META_CONNECT_ROWS),
  )
  check(
    'the Boot logins face offers the exact same two rows in the same order',
    JSON.stringify(screen.loginsPickOptions('meta')) === JSON.stringify(login.META_CONNECT_ROWS),
  )
  const metaConnectSrc = readFileSync(join(repoRoot, 'src/components/MetaConnect.tsx'), 'utf8')
  const bootLoginsSrc = readFileSync(join(repoRoot, 'src/components/BootLoginsScreen.tsx'), 'utf8')
  check(
    'both skins drive runMetaDeviceLogin and storeMetaApiKeyLogin without copying poll or mint logic',
    metaConnectSrc.includes('runMetaDeviceLogin') &&
      metaConnectSrc.includes('storeMetaApiKeyLogin') &&
      bootLoginsSrc.includes('runMetaDeviceLogin') &&
      bootLoginsSrc.includes('storeMetaApiKeyLogin') &&
      !metaConnectSrc.includes('pollMetaDeviceToken') &&
      !bootLoginsSrc.includes('pollMetaDeviceToken'),
  )
  check(
    'production endpoints match the verified Meta OIDC and key mint contract',
    accounts.MUSE_CODE_OAUTH_CLIENT_ID === '1031625952748946' &&
      accounts.META_API_VERSION === '1.0.0' &&
      accounts.metaDeviceAuthUrl({} as NodeJS.ProcessEnv) === 'https://auth.meta.com/oidc/device/authorization/' &&
      accounts.metaDeviceTokenUrl({} as NodeJS.ProcessEnv) === 'https://auth.meta.com/oidc/device/token/' &&
      accounts.metaMuseCodeKeyUrl({} as NodeJS.ProcessEnv) === 'https://api.meta.ai/muse-code/key',
  )

  console.log('── 2. Device authorization, poll (pending + slow_down), token & key mint ──')
  requests.length = 0
  pollQueue = [
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'slow_down' } },
    { status: 200, body: { access_token: ACCOUNT_TOKEN } },
  ]
  const sleeps: number[] = []
  const events: string[] = []
  const nowMs = 1_760_000_000_000
  const outcome = await login.runMetaDeviceLogin({
    io: { now: () => nowMs },
    sleep: async ms => {
      sleeps.push(ms)
    },
    onEvent: e => {
      events.push(e.phase === 'waiting' ? `waiting:${e.polls}:${e.start.userCode}` : e.phase)
    },
  })
  check('device sign-in succeeds and settles with receipt', outcome.ok === true, outcome.receipt)
  check(
    'events progress starting → waiting (code shown before first poll, then per poll) → finishing',
    events.join(' ') === 'starting waiting:0:MUSE-4321 waiting:1:MUSE-4321 waiting:2:MUSE-4321 finishing',
    events.join(' '),
  )
  check(
    'slow_down increases the poll interval by 5 seconds per RFC 8628',
    JSON.stringify(sleeps) === JSON.stringify([2000, 2000, 7000]),
    JSON.stringify(sleeps),
  )
  const authReq = requests[0]
  const pollReq = requests[1]
  const keyReq = requests[4]
  check(
    'device authorization sends client_id=1031625952748946, Accept: application/json, and x-api-version: 1.0.0',
    authReq?.method === 'POST' &&
      authReq.path === '/oidc/device/authorization/' &&
      authReq.headers['accept'] === 'application/json' &&
      authReq.headers['x-api-version'] === '1.0.0' &&
      authReq.body === 'client_id=1031625952748946',
    JSON.stringify(authReq),
  )
  check(
    'token poll sends client_id, device_code, and device_code grant with x-api-version: 1.0.0',
    pollReq?.method === 'POST' &&
      pollReq.path === '/oidc/device/token/' &&
      pollReq.headers['accept'] === 'application/json' &&
      pollReq.headers['x-api-version'] === '1.0.0' &&
      pollReq.body.includes('client_id=1031625952748946') &&
      pollReq.body.includes('device_code=dev-meta-001') &&
      pollReq.body.includes('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code'),
    JSON.stringify(pollReq),
  )
  check(
    'key mint sends ONE POST /muse-code/key with Bearer <account token>, x-api-version: 1.0.0, and {"onboard":true}',
    requests.filter(r => r.path === '/muse-code/key').length === 1 &&
      keyReq?.method === 'POST' &&
      keyReq.headers['authorization'] === `Bearer ${ACCOUNT_TOKEN}` &&
      keyReq.headers['x-api-version'] === '1.0.0' &&
      keyReq.body === '{"onboard":true}',
    JSON.stringify(keyReq),
  )

  console.log('── 3. Stored grant mode 600, e-mail, tier, usage windows, and wire key resolution ──')
  const authPath = accounts.metaAuthPathForDisplay()
  const grant = accounts.readMetaMuseCodeGrant()
  check(
    'grant is stored auth-scoped at .meta-auth.json with mode 600',
    authPath.startsWith(proofHome) &&
      authPath.endsWith('.meta-auth.json') &&
      (statSync(authPath).mode & 0o777) === 0o600,
    authPath,
  )
  check(
    'stored grant holds the account token, minted key, e-mail, tier, and both usage windows',
    grant?.accessToken === ACCOUNT_TOKEN &&
      grant.apiKey === MINTED_KEY &&
      grant.email === 'subscriber@example.com' &&
      grant.tierId === 'pro' &&
      grant.tierName === 'Muse Code Pro' &&
      grant.usage?.window?.usedPercent === 24 &&
      grant.usage.window.windowDurationMins === 300 &&
      grant.usage.window.resetsAtMs === Date.parse('2026-10-14T10:00:00.000Z') &&
      grant.usage?.weekly?.usedPercent === 41 &&
      grant.usage.weekly.windowDurationMins === 10080 &&
      grant.usage.weekly.resetsAtMs === Date.parse('2026-10-20T00:00:00.000Z') &&
      grant.observedAtMs === nowMs,
    JSON.stringify(grant),
  )
  check(
    'resolveMetaApiKey returns the MINTED key (never the account token)',
    accounts.resolveMetaApiKey()?.key === MINTED_KEY &&
      accounts.resolveMetaApiKey()?.source === 'muse-code' &&
      accounts.resolveMetaApiKey()?.key !== ACCOUNT_TOKEN,
  )
  check(
    'receipt names e-mail, tier, and usage windows without leaking the account token or minted key',
    outcome.receipt.includes('subscriber@example.com') &&
      outcome.receipt.includes('Muse Code Pro') &&
      outcome.receipt.includes('window 24%') &&
      outcome.receipt.includes('weekly 41%') &&
      !outcome.receipt.includes(ACCOUNT_TOKEN) &&
      !outcome.receipt.includes(MINTED_KEY),
    outcome.receipt,
  )
  const metaSlots = slots.deriveFamilySlotGroups().find(g => g.family.id === 'meta')?.slots ?? []
  check(
    '/accounts slot shows the Muse Code sign-in with tier and e-mail, never a secret',
    metaSlots.length === 1 &&
      metaSlots[0]?.id === 'meta:muse-code' &&
      metaSlots[0].active === true &&
      metaSlots[0].identity.includes('Muse Code Pro') &&
      metaSlots[0].identity.includes('subscriber@example.com') &&
      !JSON.stringify(metaSlots).includes(ACCOUNT_TOKEN) &&
      !JSON.stringify(metaSlots).includes(MINTED_KEY),
    JSON.stringify(metaSlots),
  )

  console.log('── 4. Row 3: The wire unchanged & refused minted key never falls through ──')
  secrets.writeStoredMetaApiKey(STORED_API_KEY)
  accounts.writePreferredMetaSource('muse-code')
  catalogue.__resetMetaCatalogueForTest()
  requests.length = 0
  const okTurn = await runChat('muse-spark-1.3')
  const chatReq = requests.find(r => r.path === '/v1/chat/completions')
  check(
    'chat turn rides /v1/chat/completions with the minted Muse Code key, never the account token or stored API key',
    okTurn.some(m => JSON.stringify(m).includes('MUSE-CODE-WIRE-OK')) &&
      chatReq?.headers['authorization'] === `Bearer ${MINTED_KEY}` &&
      !requests.some(r => r.headers['authorization'] === `Bearer ${ACCOUNT_TOKEN}`) &&
      !requests.some(r => r.headers['authorization'] === `Bearer ${STORED_API_KEY}`),
    JSON.stringify(chatReq?.headers),
  )
  for (const status of [401, 403] as const) {
    chatStatus = status
    requests.length = 0
    const refusedChat = await runChat('muse-spark-1.3')
    check(
      `HTTP ${status} on /v1/chat/completions says "the Muse Code key was refused — /logins signs in with Meta again" and never falls through to the stored API key`,
      refusedChat.some(
        m =>
          m.isApiErrorMessage &&
          m.error === 'authentication_failed' &&
          JSON.stringify(m).includes('the Muse Code key was refused — /logins signs in with Meta again'),
      ) &&
        !requests.some(r => r.headers['authorization'] === `Bearer ${STORED_API_KEY}`) &&
        accounts.resolveMetaAccount()?.kind === 'muse-code',
      JSON.stringify(refusedChat),
    )
  }
  chatStatus = 200
  modelsStatus = 401
  await catalogue.refreshMetaCatalogue({ force: true })
  requests.length = 0
  const refusedModels = await runChat('muse-spark-1.3')
  check(
    'HTTP 401 on /v1/models says "the Muse Code key was refused — /logins signs in with Meta again" before inference and never falls through',
    refusedModels.some(
      m =>
        m.isApiErrorMessage &&
        m.error === 'authentication_failed' &&
        JSON.stringify(m).includes('the Muse Code key was refused — /logins signs in with Meta again'),
    ) && requests.length === 0,
    JSON.stringify(refusedModels),
  )
  modelsStatus = 200
  catalogue.__resetMetaCatalogueForTest()

  console.log('── 5. Row 3: require_payment and refused token at key mint store nothing as active ──')
  accounts.disconnectMetaMuseCode()
  secrets.writeStoredMetaApiKey(null)
  const savedKeyReply = keyReply
  pollQueue = [{ status: 200, body: { access_token: ACCOUNT_TOKEN } }]
  keyReply = {
    status: 200,
    body: {
      require_payment: true,
      is_subs_active: false,
      action_url: 'https://www.meta.ai/muse-code/subscribe',
      message: 'Active subscription required',
    },
  }
  const paymentRequired = await login.runMetaDeviceLogin({ sleep: async () => {} })
  check(
    'require_payment at sign-in says so in Meta words with the page to visit and stores nothing as active',
    !paymentRequired.ok &&
      paymentRequired.code === 'require-payment' &&
      paymentRequired.receipt.includes('require_payment') &&
      paymentRequired.receipt.includes('Active subscription required') &&
      paymentRequired.receipt.includes('https://www.meta.ai/muse-code/subscribe') &&
      paymentRequired.receipt.includes('nothing stored as active') &&
      accounts.readMetaMuseCodeGrant() === undefined &&
      accounts.resolveMetaAccount() === undefined,
    paymentRequired.receipt,
  )
  pollQueue = [{ status: 200, body: { access_token: ACCOUNT_TOKEN } }]
  keyReply = {
    status: 200,
    body: {
      require_payment: true,
      require_payment_action_url: 'https://www.meta.ai/muse-code/billing',
    },
  }
  const paymentAltUrl = await login.runMetaDeviceLogin({ sleep: async () => {} })
  check(
    'require_payment_action_url is also surfaced and stores nothing as active',
    !paymentAltUrl.ok &&
      paymentAltUrl.code === 'require-payment' &&
      paymentAltUrl.receipt.includes('https://www.meta.ai/muse-code/billing') &&
      accounts.readMetaMuseCodeGrant() === undefined,
    paymentAltUrl.receipt,
  )
  await login.storeMetaApiKeyLogin(STORED_API_KEY)
  pollQueue = [{ status: 200, body: { access_token: ACCOUNT_TOKEN } }]
  keyReply = {
    status: 403,
    body: { error: { message: 'OAuth token rejected by Muse Code' } },
  }
  const refusedMint = await login.runMetaDeviceLogin({ sleep: async () => {} })
  check(
    'a refused token at /muse-code/key stores no Muse Code grant and leaves an existing active API key untouched',
    !refusedMint.ok &&
      refusedMint.code === 'refused' &&
      refusedMint.receipt.includes('HTTP 403') &&
      refusedMint.receipt.includes('OAuth token rejected by Muse Code') &&
      !refusedMint.receipt.includes(ACCOUNT_TOKEN) &&
      accounts.readMetaMuseCodeGrant() === undefined &&
      accounts.resolveMetaAccount()?.kind === 'api-key',
    refusedMint.receipt,
  )
  secrets.writeStoredMetaApiKey(null)
  keyReply = savedKeyReply

  console.log('── 6. Cancel, expired_token, access_denied, and clock expiry ──')
  let cancelFlag = false
  pollQueue = [{ status: 400, body: { error: 'authorization_pending' } }]
  const cancelled = await login.runMetaDeviceLogin({
    sleep: async () => {
      cancelFlag = true
    },
    cancelled: () => cancelFlag,
  })
  check(
    'cancelling during the poll settles cancelled and stores nothing',
    !cancelled.ok && cancelled.code === 'cancelled' && accounts.readMetaMuseCodeGrant() === undefined,
    cancelled.receipt,
  )
  pollQueue = [{ status: 400, body: { error: 'expired_token' } }]
  const expiredToken = await login.runMetaDeviceLogin({ sleep: async () => {} })
  check(
    'expired_token from the poll endpoint settles expired and stores nothing',
    !expiredToken.ok && expiredToken.code === 'expired' && accounts.readMetaMuseCodeGrant() === undefined,
    expiredToken.receipt,
  )
  pollQueue = [{ status: 400, body: { error: 'access_denied' } }]
  const deniedToken = await login.runMetaDeviceLogin({ sleep: async () => {} })
  check(
    'access_denied from the poll endpoint settles denied and stores nothing',
    !deniedToken.ok && deniedToken.code === 'denied' && accounts.readMetaMuseCodeGrant() === undefined,
    deniedToken.receipt,
  )
  let clock = 1_000_000
  const expired = await login.runMetaDeviceLogin({
    io: { now: () => clock },
    sleep: async () => {
      clock += 700_000
    },
  })
  check(
    'poll past expiry settles expired and stores nothing',
    !expired.ok && expired.code === 'expired' && accounts.readMetaMuseCodeGrant() === undefined,
    expired.receipt,
  )

  console.log(`\n${passes} passed, ${failures} failed`)
} finally {
  server.stop(true)
  rmSync(proofHome, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
