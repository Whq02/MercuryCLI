#!/usr/bin/env bun
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV

const SCRATCH_ROOT = process.env.MERCURY_CONFIG_DIR?.trim() || tmpdir()
mkdirSync(SCRATCH_ROOT, { recursive: true })
const HOME = mkdtempSync(join(SCRATCH_ROOT, 'wallet-identity-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of [
  'MERCURY_HOME',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_API_KEY_FILE_DESCRIPTOR',
  'MERCURY_API_UNIX_SOCKET',
  'MERCURY_OAUTH_CLIENT_ID',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'HF_TOKEN',
  'ZAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MERCURY_USER_EMAIL',
  'MERCURY_ACCOUNT_UUID',
  'MERCURY_ORGANIZATION_UUID',
  'MERCURY_HUGGINGFACE_OAUTH_CLIENT_ID',
  'MERCURY_MOONSHOT_OAUTH_CLIENT_ID',
  'MERCURY_GEMINI_OAUTH_CLIENT_SECRET',
  'MERCURY_DEMO',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
]) {
  delete process.env[key]
}

const CLAUDE_PROFILE_EMAIL = 'claude-profile@example.test'
const CLAUDE_RECEIPT_EMAIL = 'claude-receipt@example.test'
const TYPED_EMAIL = 'typed-by-operator@example.test'
const GPT_EMAIL = 'gpt-operator@example.test'
const HUB_USER = 'fixture-hub-user'
const OWNER_EXAMPLE_EMAIL = 'whq@example.test'
const GOOGLE_CLIENT_ID = 'fixture-identity-client.apps.googleusercontent.com'

const TOKENS = {
  claudeAccess1: 'fixture-claude-access-one-CA1Q',
  claudeRefresh1: 'fixture-claude-refresh-one-CR1Q',
  claudeAccess2: 'fixture-claude-access-two-CA2Q',
  claudeRefresh2: 'fixture-claude-refresh-two-CR2Q',
  claudeAccess3: 'fixture-claude-access-three-CA3Q',
  claudeRefresh3: 'fixture-claude-refresh-three-CR3Q',
  claudeAccess4: 'fixture-claude-access-four-CA4Q',
  claudeRefresh4: 'fixture-claude-refresh-four-CR4Q',
  claudeAccess5: 'fixture-claude-access-five-CA5Q',
  claudeRefresh5: 'fixture-claude-refresh-five-CR5Q',
  claudeEnvRefresh: 'fixture-claude-env-refresh-token-ER1Q',
  openaiAccess: 'fixture-openai-access-token-OA1Q',
  openaiRefresh: 'fixture-openai-refresh-token-OR1Q',
  googleAccess: 'fixture-google-access-token-GA1Q',
  googleRefresh: 'fixture-google-refresh-token-GR1Q',
  hubAccess1: 'hf_oauth_fixture_access_one_HA1Q',
  hubAccess2: 'hf_oauth_fixture_access_two_HA2Q',
  hubAccess3: 'hf_oauth_fixture_access_three_HA3Q',
  hubAccess4: 'hf_oauth_fixture_access_four_HA4Q',
  hubAccess5: 'hf_oauth_fixture_access_five_HA5Q',
  hubRefresh: 'hf_oauth_fixture_refresh_token_HR1Q',
  kimiAccess1: 'fixture-kimi-access-token-one-KA1Q',
  kimiAccess2: 'fixture-kimi-access-token-two-KA2Q',
  kimiRefresh: 'fixture-kimi-refresh-token-KR1Q',
}
const KEYS = {
  openaiEnv: 'sk-fixture-openai-env-key-0042',
  moonshotEnv: 'sk-fixture-moonshot-env-key-0077',
  openrouterMinted: 'sk-or-v1-fixture-minted-key-00MN',
}
const DEVICE_CODES = ['fixture-hf-device-code-identity', 'fixture-kimi-device-code-identity', 'fixture-openai-device-auth-id']

const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const idToken = (payload: Record<string, unknown>): string =>
  `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.${b64url('fixture-signature')}`
const OPENAI_NEST = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_fixture_identity', chatgpt_plan_type: 'plus' } }
const ID_TOKEN_WITH_EMAIL = idToken({ email: GPT_EMAIL, ...OPENAI_NEST })
const ID_TOKEN_WITHOUT_EMAIL = idToken({ ...OPENAI_NEST })

const state = {
  claudeAccess: TOKENS.claudeAccess1,
  claudeRefresh: TOKENS.claudeRefresh1,
  claudeReceipt: undefined as { uuid: string; email: string } | undefined,
  claudeProfile: undefined as { uuid: string; email: string } | undefined,
  claudeProfileBearers: [] as string[],
  openaiIdToken: ID_TOKEN_WITH_EMAIL,
  googleAnswers: [] as Record<string, unknown>[],
  hubAccess: TOKENS.hubAccess1,
  hubWhoami: 'ok' as 'ok' | 'down',
  kimiAccess: TOKENS.kimiAccess1,
  kimiAnswers: [] as Record<string, unknown>[],
}

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', chunk => chunks.push(chunk as Buffer))
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const auth = req.headers['authorization']
    const bearer = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : ''
    if (req.method === 'POST' && path === '/v1/oauth/token') {
      json(res, 200, {
        access_token: state.claudeAccess,
        refresh_token: state.claudeRefresh,
        expires_in: 3600,
        scope: 'user:inference user:profile',
        ...(state.claudeReceipt !== undefined
          ? {
              account: { uuid: state.claudeReceipt.uuid, email_address: state.claudeReceipt.email },
              organization: { uuid: 'org-fixture-identity' },
            }
          : {}),
      })
      return
    }
    if (req.method === 'GET' && path === '/api/oauth/profile') {
      state.claudeProfileBearers.push(bearer)
      if (state.claudeProfile === undefined) {
        json(res, 503, { error: { type: 'overloaded_error', message: 'fixture profile read refused' } })
        return
      }
      json(res, 200, {
        account: {
          uuid: state.claudeProfile.uuid,
          email: state.claudeProfile.email,
          display_name: 'Fixture Operator',
          created_at: '2025-01-01T00:00:00Z',
          has_claude_max: true,
        },
        organization: {
          uuid: 'org-fixture-identity',
          organization_type: 'claude_max',
          rate_limit_tier: 'default_claude_max_20x',
          billing_type: 'stripe_subscription',
          subscription_created_at: '2025-01-02T00:00:00Z',
        },
      })
      return
    }
    if (req.method === 'POST' && path === '/openai/deviceauth/usercode') {
      json(res, 200, { user_code: 'MERC-IDNT', device_auth_id: DEVICE_CODES[2], interval: 1 })
      return
    }
    if (req.method === 'POST' && path === '/openai/deviceauth/token') {
      json(res, 200, { authorization_code: 'fixture-openai-auth-code', code_verifier: 'fixture-openai-verifier' })
      return
    }
    if (req.method === 'POST' && path === '/openai/oauth/token') {
      json(res, 200, { id_token: state.openaiIdToken, access_token: TOKENS.openaiAccess, refresh_token: TOKENS.openaiRefresh })
      return
    }
    if (req.method === 'POST' && path === '/google/token') {
      const answer = {
        access_token: TOKENS.googleAccess,
        refresh_token: TOKENS.googleRefresh,
        expires_in: 3599,
        scope:
          'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language.retriever',
        token_type: 'Bearer',
      }
      state.googleAnswers.push(answer)
      json(res, 200, answer)
      return
    }
    if (req.method === 'POST' && path === '/hf/oauth/register') {
      json(res, 201, {
        client_id: 'fixture-hf-registered-client',
        client_id_issued_at: 1787368253,
        client_secret_expires_at: 0,
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        redirect_uris: [],
        client_name: 'Mercury',
        scope: 'openid profile inference-api',
        token_endpoint_auth_method: 'none',
      })
      return
    }
    if (req.method === 'POST' && path === '/hf/oauth/device') {
      json(res, 200, {
        device_code: DEVICE_CODES[0],
        user_code: 'HUBS-IDNT',
        verification_uri: 'https://hf.co/oauth/device',
        expires_in: 300,
      })
      return
    }
    if (req.method === 'POST' && path === '/hf/oauth/token') {
      json(res, 200, {
        access_token: state.hubAccess,
        token_type: 'bearer',
        expires_in: 28800,
        scope: 'openid profile inference-api',
        refresh_token: TOKENS.hubRefresh,
      })
      return
    }
    if (req.method === 'GET' && path === '/hf/api/whoami-v2') {
      if (state.hubWhoami === 'down') {
        json(res, 503, { error: 'fixture whoami unavailable' })
        return
      }
      json(res, 200, { type: 'user', name: HUB_USER, fullname: 'Fixture Hub User' })
      return
    }
    if (req.method === 'POST' && path === '/kimi/oauth/api/oauth/device_authorization') {
      json(res, 200, {
        device_code: DEVICE_CODES[1],
        user_code: 'KIMI-IDNT',
        verification_uri: 'https://kimi.fixture.test/activate',
        verification_uri_complete: 'https://kimi.fixture.test/activate?user_code=KIMI-IDNT',
        expires_in: 300,
        interval: 1,
      })
      return
    }
    if (req.method === 'POST' && path === '/kimi/oauth/api/oauth/token') {
      const answer = {
        access_token: state.kimiAccess,
        refresh_token: TOKENS.kimiRefresh,
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'kimi-code',
      }
      state.kimiAnswers.push(answer)
      json(res, 200, answer)
      return
    }
    if (req.method === 'GET' && path === '/kimi/coding/v1/usages') {
      json(res, 200, {
        usage: { used: '40', limit: '1000', resetTime: '2026-10-01T00:00:00Z' },
        limits: [
          { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: '1', limit: '100', resetTime: '2026-09-24T18:45:00Z' } },
        ],
      })
      return
    }
    if (req.method === 'POST' && path === '/openrouter/api/v1/auth/keys') {
      json(res, 200, { key: KEYS.openrouterMinted })
      return
    }
    json(res, 404, {})
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const BASE = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
const DEAD = 'http://127.0.0.1:1'
Object.assign(process.env, {
  MERCURY_CUSTOM_OAUTH_URL: BASE,
  ANTHROPIC_BASE_URL: BASE,
  MERCURY_OPENAI_AUTH_BASE: `${BASE}/openai`,
  MERCURY_OPENAI_API_BASE: DEAD,
  MERCURY_OPENAI_CHATGPT_BASE: DEAD,
  MERCURY_OPENROUTER_AUTH_BASE: DEAD,
  MERCURY_OPENROUTER_API_BASE: `${BASE}/openrouter/api/v1`,
  MERCURY_GEMINI_API_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: `${DEAD}/o/oauth2/v2/auth`,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: `${BASE}/google/token`,
  MERCURY_GEMINI_OAUTH_CLIENT_ID: GOOGLE_CLIENT_ID,
  MERCURY_HUGGINGFACE_HUB_BASE: `${BASE}/hf`,
  MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
  MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: `${BASE}/kimi/oauth`,
  MERCURY_MOONSHOT_CODING_BASE: `${BASE}/kimi/coding/v1`,
  MERCURY_ZAI_API_BASE: DEAD,
  MERCURY_DEEPSEEK_API_BASE: DEAD,
})

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const wallet = await import('../../src/services/wallet/wallet.ts')
const oauthClient = await import('../../src/services/oauth/client.ts')
const { createAnthropicLoginMachine } = await import('../../src/components/mercury-ui/screens/anthropicLoginModel.ts')
const openaiAccounts = await import('../../src/services/providers/openai/openaiAccounts.ts')
const geminiAccounts = await import('../../src/services/providers/gemini/geminiAccounts.ts')
const huggingfaceAccounts = await import('../../src/services/providers/huggingface/huggingfaceAccounts.ts')
const { runHuggingfaceDeviceLogin } = await import('../../src/services/providers/huggingface/huggingfaceLogin.ts')
const moonshotAccounts = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const { runKimiDeviceLogin } = await import('../../src/services/providers/moonshot/moonshotLogin.ts')
const openrouterAccounts = await import('../../src/services/providers/openrouter/openrouterAccounts.ts')
const accountSlots = await import('../../src/services/providers/accountSlots.ts')
const auth = await import('../../src/utils/auth.ts')
const scopeScan = await import('../../src/utils/accounts/scopeScan.ts')
const { stringWidth } = await import('../../src/ink/stringWidth.ts')
type WalletEntry = import('../../src/services/wallet/wallet.ts').WalletEntry
type AccountSlot = import('../../src/services/providers/accountSlots.ts').AccountSlot
type Composer = typeof import('../../src/services/wallet/walletIdentity.ts')

let composer: Composer | null = null
let composerMissing = ''
try {
  composer = (await import('../../src/services/wallet/walletIdentity.ts')) as Composer
} catch (error) {
  composerMissing = error instanceof Error ? error.message.split('\n')[0] ?? 'import failed' : String(error)
}

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => {
  console.log(`\n${'─'.repeat(76)}\n${title}`)
}
const painted: Array<{ step: string; lines: string[] }> = []
const entriesOf = (provider: string): WalletEntry[] => {
  wallet.resetWalletEntriesMemo()
  return wallet.walletEntries().filter(entry => entry.provider === provider)
}
const noComposer = (): string => `no identity composer on this tree (${composerMissing || 'src/services/wallet/walletIdentity.ts'})`
const expectLines = (label: string, family: string, expected: string[]): void => {
  wallet.resetWalletEntriesMemo()
  const got = composer?.familyIdentityLines(family)
  if (got !== undefined) painted.push({ step: label.split(' ')[0] ?? label, lines: got })
  check(label, got !== undefined && JSON.stringify(got) === JSON.stringify(expected), got === undefined ? noComposer() : JSON.stringify(got))
}
const sleepBeat = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const IDENTITY_KEYS = ['email', 'identity', 'account', 'username', 'name', 'id_token', 'idToken', 'userinfo', 'user']

function anthropicService(code: string): {
  startOAuthFlow: () => Promise<Record<string, unknown>>
  handleManualAuthCodeInput: () => void
  cleanup: () => void
} {
  return {
    async startOAuthFlow() {
      const response = await oauthClient.exchangeCodeForTokens(code, 'fixture-state', 'fixture-verifier', 0, true)
      const scopes = oauthClient.parseScopes(response.scope)
      const profile = await oauthClient.fetchProfileInfo(response.access_token)
      return {
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? null,
        expiresAt: Date.now() + response.expires_in * 1000,
        scopes,
        subscriptionType: profile?.subscriptionType ?? null,
        rateLimitTier: profile?.rateLimitTier ?? null,
        ...(profile?.profile === undefined ? {} : { profile: profile.profile }),
        ...(response.account !== undefined
          ? {
              tokenAccount: {
                uuid: response.account.uuid,
                emailAddress: response.account.email_address,
                ...(response.organization?.uuid === undefined ? {} : { organizationUuid: response.organization.uuid }),
              },
            }
          : {}),
      }
    },
    handleManualAuthCodeInput() {},
    cleanup() {},
  }
}

async function signInAnthropic(code: string): Promise<string> {
  let final = 'idle'
  const machine = createAnthropicLoginMachine(
    { onDone: () => {} },
    snapshot => {
      final = snapshot.flow.name
    },
    {
      createService: () => anthropicService(code),
      fetchRoles: async () => {},
      settings: () => ({}),
      shadowWarning: () => null,
      clipboard: async () => null,
      writeStdout: () => {},
      log: () => {},
      mintApiKey: async () => null,
      validateOrg: async () => ({ valid: true }),
      setTimer: (fn: () => void) => setTimeout(fn, 0),
      clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    } as never,
  )
  machine.start(true)
  for (let beat = 0; beat < 400 && final !== 'success' && final !== 'error'; beat++) await sleepBeat(5)
  machine.dispose()
  return final
}

console.log('============================================================')
console.log(' WALLET IDENTITY — which account each email sign-in is, as the provider reported it')
console.log('============================================================')

section('W1 the wallet enumerates every email sign-in family (Kimi device-code, Hugging Face)')
{
  const kimi = await runKimiDeviceLogin({ region: 'global', io: { fetchImpl: fetch, env: process.env }, sleep: async () => {} })
  check('W1 the Kimi device-code sign-in lands on the loopback fixture', kimi.ok === true, JSON.stringify(kimi))
  const kimiEntries = entriesOf('moonshot')
  check('W1 the wallet carries the Kimi sign-in as an entry', kimiEntries.some(entry => entry.id === 'moonshot:oauth' && entry.kind === 'oauth'), JSON.stringify(kimiEntries))
  check('W1 …with the region the sign-in was made in as its host', kimiEntries.find(entry => entry.id === 'moonshot:oauth')?.host === 'global', JSON.stringify(kimiEntries))
  const hub = await runHuggingfaceDeviceLogin({ io: { fetchImpl: fetch, env: process.env }, sleep: async () => {}, refreshCatalogue: async () => null })
  check('W1 the Hugging Face device-code sign-in lands on the loopback fixture', hub.ok === true && hub.username === HUB_USER, JSON.stringify(hub))
  const hubEntries = entriesOf('huggingface')
  const hubEntry = hubEntries.find(entry => entry.id === 'huggingface:oauth')
  check('W1 the wallet carries the Hugging Face sign-in as an entry', hubEntry?.kind === 'oauth', JSON.stringify(hubEntries))
  check('W1 …naming the account the whoami read reported', hubEntry?.identity?.name === HUB_USER && hubEntry.identity.source === 'profile', JSON.stringify(hubEntry?.identity))
}

section('A Anthropic — the profile read and the token-exchange receipt, as the sign-in machine lands them')
{
  state.claudeAccess = TOKENS.claudeAccess1
  state.claudeRefresh = TOKENS.claudeRefresh1
  state.claudeReceipt = { uuid: 'claude-uuid-one', email: CLAUDE_PROFILE_EMAIL }
  state.claudeProfile = { uuid: 'claude-uuid-one', email: CLAUDE_PROFILE_EMAIL }
  const first = await signInAnthropic('fixture-claude-code-one')
  check('A1 the claude.ai sign-in settles over the loopback exchange and profile read', first === 'success', first)
  check('A1 …and the profile was read with the fresh bearer', state.claudeProfileBearers.at(-1) === TOKENS.claudeAccess1)
  const entry = entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')
  check('A1 the Claude entry names the profile account, source profile', entry?.identity?.email === CLAUDE_PROFILE_EMAIL && entry.identity.source === 'profile', JSON.stringify(entry))
  expectLines('A1 the Claude row: the profile email, the kind', 'anthropic', [`Claude account · ${CLAUDE_PROFILE_EMAIL} (subscription)`])

  state.claudeAccess = TOKENS.claudeAccess2
  state.claudeRefresh = TOKENS.claudeRefresh2
  state.claudeReceipt = { uuid: 'claude-uuid-two', email: CLAUDE_RECEIPT_EMAIL }
  state.claudeProfile = undefined
  const second = await signInAnthropic('fixture-claude-code-two')
  check('A2 a sign-in whose profile read failed still settles', second === 'success', second)
  const receiptEntry = entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')
  check('A2 the Claude entry names the receipt account, source receipt', receiptEntry?.identity?.email === CLAUDE_RECEIPT_EMAIL && receiptEntry.identity.source === 'receipt', JSON.stringify(receiptEntry))
  expectLines('A2 the Claude row: the receipt email', 'anthropic', [`Claude account · ${CLAUDE_RECEIPT_EMAIL} (subscription)`])
  auth.dropCredentialMemos()
  const restartedEntry = entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')
  check('A2 after a restart (every credential memo dropped) the receipt stored with the credential still names the account', restartedEntry?.identity?.email === CLAUDE_RECEIPT_EMAIL && restartedEntry.identity.source === 'receipt' && restartedEntry.label === `Claude account (${CLAUDE_RECEIPT_EMAIL})`, JSON.stringify(restartedEntry))

  oauthClient.storeOAuthAccountInfo({
    accountUuid: 'claude-uuid-one',
    emailAddress: CLAUDE_PROFILE_EMAIL,
    organizationUuid: 'org-fixture-identity',
    displayName: 'Fixture Operator',
  })
  const staleEntry = entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')
  check('W3 a stale recorded account never outranks the receipt stored beside the credential', staleEntry?.identity?.email === CLAUDE_RECEIPT_EMAIL, JSON.stringify(staleEntry?.identity))
  expectLines('A3 the Claude row still names the credential\'s own account', 'anthropic', [`Claude account · ${CLAUDE_RECEIPT_EMAIL} (subscription)`])

  process.env.MERCURY_USER_EMAIL = TYPED_EMAIL
  oauthClient.storeOAuthAccountInfo({ accountUuid: 'typed-uuid', emailAddress: TYPED_EMAIL, organizationUuid: 'typed-org' })
  state.claudeAccess = TOKENS.claudeAccess3
  state.claudeRefresh = TOKENS.claudeRefresh3
  state.claudeReceipt = undefined
  state.claudeProfile = undefined
  const third = await signInAnthropic('fixture-claude-code-three')
  check('A4 a sign-in that reported no account settles', third === 'success', third)
  const typedEntry = entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')
  check('A4 an address the operator typed (MERCURY_USER_EMAIL) is never claimed as the provider\'s word', typedEntry !== undefined && typedEntry.identity?.source === undefined, JSON.stringify(typedEntry?.identity))
  check('A4 …nor carried in the wallet\'s public identity (no email; the label names the scope, not the typed address)', typedEntry !== undefined && typedEntry.identity?.email === undefined && typedEntry.label === 'Claude account (primary)', JSON.stringify(typedEntry))
  expectLines('A4 the Claude row paints the sign-in kind alone, never the typed address', 'anthropic', ['Claude account · subscription'])

  delete process.env.MERCURY_USER_EMAIL
  wallet.resetWalletEntriesMemo()
  const unpinnedTypedEntry = entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')
  check('A4b removing the env does not turn a persisted typed address into provider identity', unpinnedTypedEntry?.identity?.source === undefined, JSON.stringify(unpinnedTypedEntry?.identity))
  expectLines('A4b the row still withholds the unproven identity after the env is gone', 'anthropic', ['Claude account · subscription'])
  check('A4b the typed address is still recorded on disk (the fallback the wallet must not read)', scopeScan.readScopeIdentity(scopeScan.scopeIdentityFile(HOME)).email === TYPED_EMAIL, JSON.stringify(scopeScan.readScopeIdentity(scopeScan.scopeIdentityFile(HOME))))
  check('A4b …and the wallet\'s public identity carries none of it (no email, no source; the label names the scope)', unpinnedTypedEntry !== undefined && unpinnedTypedEntry.identity?.email === undefined && unpinnedTypedEntry.label === 'Claude account (primary)' && !JSON.stringify(unpinnedTypedEntry).includes(TYPED_EMAIL), JSON.stringify(unpinnedTypedEntry))
  auth.dropCredentialMemos()
  const restartedTypedEntry = entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')
  check('A4b after a restart (every credential memo dropped, the env still gone) the typed record is still never identity', restartedTypedEntry !== undefined && restartedTypedEntry.identity?.source === undefined && restartedTypedEntry.identity?.email === undefined && !JSON.stringify(restartedTypedEntry).includes(TYPED_EMAIL), JSON.stringify(restartedTypedEntry))
  expectLines('A4b …and the row after the restart paints the sign-in kind alone', 'anthropic', ['Claude account · subscription'])
}

section('A5 the provenance rule itself: only the credential\'s own profile or receipt names a Claude account')
{
  const ownAccount = (wallet as { anthropicCredentialAccount?: (credential: unknown) => unknown }).anthropicCredentialAccount
  const scopeEntry = (wallet as { anthropicScopeEntry?: (scope: unknown, credential: unknown) => WalletEntry }).anthropicScopeEntry
  const missing = 'no anthropicCredentialAccount / anthropicScopeEntry on this tree'
  const profileAndReceipt = {
    profile: { account: { email: ' profile@example.test ', uuid: 'uuid-profile' }, organization: { uuid: 'org-p' } },
    tokenAccount: { uuid: 'uuid-receipt', emailAddress: 'receipt@example.test' },
  }
  const receiptOnly = { tokenAccount: { uuid: 'uuid-receipt', emailAddress: 'receipt@example.test' } }
  const blankProfile = { profile: { account: { email: '   ', uuid: 'uuid-blank' }, organization: { uuid: 'org-b' } }, tokenAccount: receiptOnly.tokenAccount }
  const malformed = { profile: { account: { email: 42 } }, tokenAccount: { emailAddress: ['x@example.test'] } }
  check('A5 the profile read outranks the receipt, trimmed, source profile', typeof ownAccount === 'function' && JSON.stringify(ownAccount(profileAndReceipt)) === JSON.stringify({ email: 'profile@example.test', uuid: 'uuid-profile', source: 'profile' }), typeof ownAccount === 'function' ? JSON.stringify(ownAccount(profileAndReceipt)) : missing)
  check('A5 a receipt alone names the account, source receipt', typeof ownAccount === 'function' && JSON.stringify(ownAccount(receiptOnly)) === JSON.stringify({ email: 'receipt@example.test', uuid: 'uuid-receipt', source: 'receipt' }), typeof ownAccount === 'function' ? JSON.stringify(ownAccount(receiptOnly)) : missing)
  check('A5 a blank profile email falls to the receipt', typeof ownAccount === 'function' && (ownAccount(blankProfile) as { source?: string } | undefined)?.source === 'receipt', typeof ownAccount === 'function' ? JSON.stringify(ownAccount(blankProfile)) : missing)
  check('A5 nothing reported (no credential, an empty one, malformed fields) names nobody', typeof ownAccount === 'function' && [undefined, null, {}, malformed].every(credential => ownAccount(credential) === undefined), missing)
  const typedScope = { name: 'primary', dir: HOME, isCurrent: true, hasConfig: true, authed: true, foreignHarness: false, email: TYPED_EMAIL, uuid: 'typed-uuid' }
  const bare = scopeEntry?.(typedScope, {})
  check('A5 the current scope with a credential that reported nothing: no email, no source, the label names the scope — its recorded address is never read', bare !== undefined && bare.identity?.email === undefined && bare.identity?.source === undefined && bare.label === 'Claude account (primary)' && !JSON.stringify(bare).includes(TYPED_EMAIL), bare === undefined ? missing : JSON.stringify(bare))
  check('A5 …while its usage-owner key stays the recorded account id (unchanged — usage ownership does not move)', bare !== undefined && bare.identity?.accountId === 'typed-uuid', bare === undefined ? missing : JSON.stringify(bare?.identity))
  const named = scopeEntry?.(typedScope, receiptOnly)
  check('A5 the current scope with a receipt names the receipt, never the recorded address', named !== undefined && named.identity?.email === 'receipt@example.test' && named.identity.source === 'receipt' && named.label === 'Claude account (receipt@example.test)' && named.identity.accountId === 'uuid-receipt', named === undefined ? missing : JSON.stringify(named))
  const otherScope = { ...typedScope, name: 'b', dir: join(HOME, 'other-scope'), isCurrent: false, uuid: 'uuid-b' }
  const other = scopeEntry?.(otherScope, profileAndReceipt)
  check('A5 a non-current scope never borrows the current credential and never upgrades its own recorded address', other !== undefined && other.id === 'anthropic:oauth:b' && other.identity?.email === undefined && other.identity?.source === undefined && other.label === 'Claude account (b)' && !JSON.stringify(other).includes(TYPED_EMAIL) && !JSON.stringify(other).includes('profile@example.test'), other === undefined ? missing : JSON.stringify(other))
}

section('A6 an env refresh-token sign-in never wears the previous sign-in\'s receipt')
{
  state.claudeAccess = TOKENS.claudeAccess4
  state.claudeRefresh = TOKENS.claudeRefresh4
  state.claudeReceipt = { uuid: 'claude-uuid-four', email: CLAUDE_RECEIPT_EMAIL }
  state.claudeProfile = { uuid: 'claude-uuid-four', email: CLAUDE_RECEIPT_EMAIL }
  const fourth = await signInAnthropic('fixture-claude-code-four')
  check('A6 the previous account signs in with its profile and receipt', fourth === 'success' && entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')?.identity?.email === CLAUDE_RECEIPT_EMAIL, fourth)
  const scopes = ['user:inference', 'user:profile']
  const sameGrant = await oauthClient.refreshOAuthToken(TOKENS.claudeRefresh4, { scopes })
  check('A6 a refresh of the stored grant keeps the receipt that grant\'s sign-in stored', sameGrant.tokenAccount?.emailAddress === CLAUDE_RECEIPT_EMAIL, JSON.stringify(sameGrant.tokenAccount))
  state.claudeAccess = TOKENS.claudeAccess5
  state.claudeRefresh = TOKENS.claudeRefresh5
  state.claudeReceipt = undefined
  state.claudeProfile = undefined
  const signInGrant = (oauthClient as { refreshSignInGrant?: typeof oauthClient.refreshOAuthToken }).refreshSignInGrant
  const envTokens = await (signInGrant ?? oauthClient.refreshOAuthToken)(TOKENS.claudeEnvRefresh, { scopes })
  check('A6 the env refresh-token sign-in grant carries no receipt from the credential it replaces', typeof signInGrant === 'function' && envTokens.accessToken === TOKENS.claudeAccess5 && envTokens.tokenAccount === undefined, typeof signInGrant === 'function' ? JSON.stringify(envTokens.tokenAccount) : `no refreshSignInGrant on this tree; the refresh carried ${JSON.stringify(envTokens.tokenAccount)}`)
  const landed = auth.saveOAuthTokensIfNeeded(envTokens)
  const envEntry = entriesOf('anthropic').find(e => e.id === 'anthropic:oauth:primary')
  check('A6 the landed env sign-in never names the previous account (its credential reported none)', landed.success && envEntry !== undefined && envEntry.identity?.email === undefined && envEntry.identity?.source === undefined && !envEntry.label.includes(CLAUDE_RECEIPT_EMAIL), JSON.stringify(envEntry))
  expectLines('A6 the row paints the sign-in kind alone', 'anthropic', ['Claude account · subscription'])
  const authSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'handlers', 'auth.ts'), 'utf8')
  check('A6 the env fast path of `auth login` builds its tokens through refreshSignInGrant, never the stored-grant refresh', authSource.includes('await refreshSignInGrant(envRefreshToken') && !authSource.includes('refreshOAuthToken('), 'src/cli/handlers/auth.ts')
}

section('O OpenAI ChatGPT — the id_token email claim, captured at the token exchange')
{
  state.openaiIdToken = ID_TOKEN_WITH_EMAIL
  const started = await openaiAccounts.beginOpenaiDeviceConnect({ fetchImpl: fetch, env: process.env, pollIntervalMsOverride: 1, maxWaitMs: 10_000 })
  const ref = await started.result
  check('O1 the ChatGPT device sign-in settles on the loopback fixture', ref.kind === 'chatgpt-subscription', JSON.stringify(ref))
  const subscription = entriesOf('openai').find(entry => entry.kind === 'subscription-oauth')
  check('O1 the ChatGPT entry names the id_token email, source receipt', subscription?.identity?.email === GPT_EMAIL && subscription.identity.source === 'receipt' && subscription.identity.plan === 'plus', JSON.stringify(subscription))
  expectLines('O1 the ChatGPT row: the email, the kind', 'openai', [`ChatGPT account · ${GPT_EMAIL} (subscription)`])

  process.env.OPENAI_API_KEY = KEYS.openaiEnv
  const before = entriesOf('openai').find(entry => entry.kind === 'subscription-oauth')
  expectLines('O2 two accounts: the active sign-in first, the key by its masked tail', 'openai', [
    `ChatGPT account · ${GPT_EMAIL} (subscription)`,
    'also OpenAI API key (env) · …0042',
  ])
  openaiAccounts.writePreferredOpenaiSource('api-key')
  const after = entriesOf('openai').find(entry => entry.kind === 'subscription-oauth')
  check('W2 a ChatGPT sign-in shadowed by the preferred key keeps its email', after?.identity?.email === GPT_EMAIL, JSON.stringify(after))
  check('W2 …and keeps its entry id (ids are stable, whatever the preference)', before !== undefined && after !== undefined && before.id === after.id, `${before?.id} → ${after?.id}`)
  expectLines('O3 the key active: the key first, the sign-in named by its email', 'openai', [
    'OpenAI API key (env) · …0042',
    `also ChatGPT account · ${GPT_EMAIL} (subscription)`,
  ])
  openaiAccounts.writePreferredOpenaiSource(null)
  delete process.env.OPENAI_API_KEY

  state.openaiIdToken = ID_TOKEN_WITHOUT_EMAIL
  const again = await openaiAccounts.beginOpenaiDeviceConnect({ fetchImpl: fetch, env: process.env, pollIntervalMsOverride: 1, maxWaitMs: 10_000 })
  await again.result
  expectLines('O4 an id_token without the email claim paints the kind, never the previous email', 'openai', ['ChatGPT account · subscription'])
}

section('G Google (Gemini OAuth) — the grant carries no identity today')
{
  const handles = geminiAccounts.beginGeminiBrowserConnect({ fetchImpl: fetch, env: process.env, skipBrowserOpen: true, loopbackPort: 0 })
  const stateParam = new URL(handles.authorizeUrl).searchParams.get('state') ?? ''
  const scope = new URL(handles.authorizeUrl).searchParams.get('scope') ?? ''
  handles.completeWithRedirect(`http://127.0.0.1:1457/oauth2/callback?code=fixture-google-code&state=${stateParam}`)
  const ref = await handles.result
  check('G1 the Google sign-in settles on the loopback token endpoint', ref.kind === 'oauth', JSON.stringify(ref))
  check('G1 the flow asks for no openid/email scope — Google is never asked who the account is', !/\b(openid|email|userinfo)\b/.test(scope), scope)
  check('G1 the token answer the flow reads carries no id_token and no account', state.googleAnswers.length > 0 && state.googleAnswers.every(answer => !('id_token' in answer)))
  const stored = readJson(geminiAccounts.geminiAuthPathForDisplay())
  const tokens = (stored.tokens ?? {}) as Record<string, unknown>
  check('G1 nothing identity-shaped is stored beside the Google credential', IDENTITY_KEYS.every(key => !(key in stored) && !(key in tokens)), JSON.stringify(Object.keys(tokens)))
  const entry = entriesOf('gemini').find(e => e.kind === 'oauth')
  check('G1 the Google entry claims no account', entry !== undefined && entry.identity?.email === undefined && entry.identity?.source === undefined, JSON.stringify(entry))
  expectLines('G1 the Google row paints the sign-in kind alone', 'gemini', ['Google account · oauth'])
}

section('H Hugging Face — the whoami read at sign-in, bound to the grant it described')
{
  expectLines('H1 the Hub row: the username the whoami read reported', 'huggingface', [`Hugging Face account · ${HUB_USER} (device-code)`])
  state.hubAccess = TOKENS.hubAccess2
  state.hubWhoami = 'down'
  const unverified = await runHuggingfaceDeviceLogin({ io: { fetchImpl: fetch, env: process.env }, sleep: async () => {}, refreshCatalogue: async () => null })
  check('H2 a re-sign-in whose whoami did not answer still lands', unverified.ok === true && huggingfaceAccounts.huggingfaceStoredTokens()?.accessToken === TOKENS.hubAccess2, JSON.stringify(unverified))
  check('H2 the new grant never wears the previous account\'s name', huggingfaceAccounts.huggingfaceOauthIdentity() === undefined, JSON.stringify(huggingfaceAccounts.huggingfaceOauthIdentity()))
  expectLines('H2 the Hub row paints the sign-in kind alone', 'huggingface', ['Hugging Face account · device-code'])

  state.hubAccess = TOKENS.hubAccess3
  state.hubWhoami = 'ok'
  const verified = await runHuggingfaceDeviceLogin({ io: { fetchImpl: fetch, env: process.env }, sleep: async () => {}, refreshCatalogue: async () => null })
  check('H3 a verified sign-in records the name again', verified.ok === true && huggingfaceAccounts.huggingfaceOauthIdentity()?.username === HUB_USER)
  state.hubAccess = TOKENS.hubAccess4
  let reads = 0
  const cancelled = await runHuggingfaceDeviceLogin({
    io: { fetchImpl: fetch, env: process.env },
    sleep: async () => {},
    refreshCatalogue: async () => null,
    cancelled: () => ++reads >= 3,
  })
  check('H4 an approval that landed after cancel is stored', cancelled.ok === true && 'settledAfterCancel' in cancelled && huggingfaceAccounts.huggingfaceStoredTokens()?.accessToken === TOKENS.hubAccess4, JSON.stringify(cancelled))
  check('H4 …and never wears the name the earlier grant reported', huggingfaceAccounts.huggingfaceOauthIdentity() === undefined, JSON.stringify(huggingfaceAccounts.huggingfaceOauthIdentity()))
  expectLines('H4 the Hub row paints the sign-in kind alone', 'huggingface', ['Hugging Face account · device-code'])
}

section('K Kimi — the device-code grant carries no account name today')
{
  check('K1 the token answers the flow reads carry no account field', state.kimiAnswers.length > 0 && state.kimiAnswers.every(answer => IDENTITY_KEYS.every(key => !(key in answer))))
  const stored = readJson(moonshotAccounts.moonshotAuthPathForDisplay())
  const tokens = (stored.tokens ?? {}) as Record<string, unknown>
  check('K1 nothing identity-shaped is stored beside the Kimi credential', IDENTITY_KEYS.every(key => !(key in stored) && !(key in tokens)), JSON.stringify(Object.keys(stored)))
  const entry = entriesOf('moonshot').find(e => e.id === 'moonshot:oauth')
  check('K1 the Kimi entry claims no account', entry !== undefined && entry.identity === undefined, JSON.stringify(entry))
  expectLines('K1 the Kimi row paints the sign-in kind and host alone', 'moonshot', ['Kimi account · device-code, global'])
  state.kimiAccess = TOKENS.kimiAccess2
  const mainland = await runKimiDeviceLogin({ region: 'mainland-cn', io: { fetchImpl: fetch, env: process.env }, sleep: async () => {} })
  check('K2 a mainland-China sign-in lands', mainland.ok === true, JSON.stringify(mainland))
  expectLines('K2 the Kimi row names the mainland host', 'moonshot', ['Kimi account · device-code, mainland China'])
  process.env.MOONSHOT_API_KEY = KEYS.moonshotEnv
  expectLines('K3 an env key outranks the sign-in: the key first, the sign-in after', 'moonshot', [
    'MOONSHOT_API_KEY (env) · …0077',
    'also Kimi account · device-code, mainland China',
  ])
  delete process.env.MOONSHOT_API_KEY
}

section('L /accounts and the Logins chip (which reads the slot words) speak the composer\'s words — never a token fragment')
{
  const FIXTURE_PROVIDERS = [
    { id: 'moonshot', available: true, description: { account: { kind: 'provider-oauth', label: 'Kimi account' } } },
    { id: 'huggingface', available: true, description: { account: { kind: 'provider-oauth', label: 'Hugging Face account' } } },
  ] as unknown as Parameters<typeof accountSlots.deriveFamilySlotGroups>[0]
  const slotOf = (id: string): AccountSlot | undefined =>
    accountSlots.deriveFamilySlotGroups(FIXTURE_PROVIDERS).flatMap(group => group.slots).find(slot => slot.id === id)
  const fragments = Object.values(TOKENS).map(token => token.slice(-4))
  const clean = (text: string | undefined): boolean => text !== undefined && fragments.every(fragment => !text.includes(fragment))
  const composed = (entryId: string): string | undefined => {
    wallet.resetWalletEntriesMemo()
    const entry = wallet.walletEntries().find(e => e.id === entryId)
    return composer !== null && entry !== undefined ? composer.entryIdentity(entry).shown : undefined
  }
  const kimi = slotOf('moonshot:oauth')
  check('L1 the Kimi sign-in slot names the kind and host, never a token fragment', kimi?.identity === 'Kimi account · device-code, mainland China' && clean(kimi.identity), JSON.stringify(kimi?.identity))
  check('L1 …the same words the composer paints for that sign-in', kimi !== undefined && kimi.identity === composed('moonshot:oauth'), `${JSON.stringify(kimi?.identity)} vs ${JSON.stringify(composed('moonshot:oauth'))}`)
  const unnamed = slotOf('huggingface:oauth')
  check('L2 a Hub sign-in slot with no reported name paints the kind alone, never a token fragment', unnamed?.identity === 'Hugging Face account · device-code' && clean(unnamed.identity), JSON.stringify(unnamed?.identity))
  state.hubAccess = TOKENS.hubAccess5
  const named = await runHuggingfaceDeviceLogin({ io: { fetchImpl: fetch, env: process.env }, sleep: async () => {}, refreshCatalogue: async () => null })
  check('L3 a verified Hub sign-in lands', named.ok === true && named.username === HUB_USER, JSON.stringify(named))
  const hub = slotOf('huggingface:oauth')
  check('L3 the Hub sign-in slot names the whoami account and the kind, never a token fragment', hub?.identity === `Hugging Face account · ${HUB_USER} (device-code)` && clean(hub.identity), JSON.stringify(hub?.identity))
  check('L3 …the same words the composer paints for that sign-in', hub !== undefined && hub.identity === composed('huggingface:oauth'), `${JSON.stringify(hub?.identity)} vs ${JSON.stringify(composed('huggingface:oauth'))}`)
}

section('R OpenRouter — an OAuth-minted KEY keeps its masked tail; no identity line')
{
  const handles = openrouterAccounts.beginOpenrouterConnect({ fetchImpl: fetch, env: process.env, mode: 'headless', skipBrowserOpen: true, loopbackPort: 0 })
  handles.completeWithRedirect('fixture-openrouter-code')
  const ref = await handles.result
  check('R1 the minted key lands through the loopback exchange', ref.kind === 'oauth-key', JSON.stringify(ref))
  const entry = entriesOf('openrouter').find(e => e.id === 'openrouter:oauth-key')
  check('R1 the minted-key entry carries only its masked tail', entry?.keyTail === '…00MN' && entry.identity === undefined, JSON.stringify(entry))
  const identity = composer !== null && entry !== undefined ? composer.entryIdentity(entry) : undefined
  check('R1 the key is spelled by its label and masked tail', identity?.shown === 'OpenRouter (OAuth-minted key) · …00MN' && identity.kind === 'api-key' && identity.source === 'none', identity === undefined ? noComposer() : JSON.stringify(identity))
  expectLines('R1 a key-only family has no identity line', 'openrouter', [])
  expectLines('R1 a family the wallet does not custody has no identity line', 'zai', [])
}

section('S every composed identity names the provider\'s word and nothing secret')
{
  wallet.resetWalletEntriesMemo()
  const entries = wallet.walletEntries()
  const families = ['anthropic', 'openai', 'gemini', 'moonshot', 'huggingface', 'openrouter']
  const views = composer !== null ? families.map(family => composer!.familyIdentity(family as never)) : []
  const lines = composer !== null ? families.flatMap(family => composer!.familyIdentityLines(family)) : []
  const serialized = JSON.stringify(entries) + JSON.stringify(views) + lines.join('\n')
  const material = [...Object.values(TOKENS), ...Object.values(KEYS), ...DEVICE_CODES, ID_TOKEN_WITH_EMAIL, ID_TOKEN_WITHOUT_EMAIL, GOOGLE_CLIENT_ID]
  const leaked = material.filter(secret => serialized.includes(secret))
  check('S1 no token, key, device code, id_token or client id rides any entry, view or line', leaked.length === 0, leaked.join(' '))
  const signIns = views.flatMap(view => [...(view.active !== undefined ? [view.active] : []), ...view.others]).filter(identity => identity.kind !== 'api-key')
  const fragments = Object.values(TOKENS).map(token => token.slice(-4))
  const carrying = signIns.filter(identity => fragments.some(fragment => identity.shown.includes(fragment)))
  check('S2 no sign-in identity carries a token fragment (masked tails are for API keys alone)', composer !== null && signIns.length > 0 && carrying.length === 0, composer === null ? noComposer() : carrying.map(identity => identity.shown).join(' · '))
}

section('F the line fits its surface: the owner\'s example shape, never past the width')
{
  const kimiWithAccount = {
    id: 'moonshot:oauth',
    provider: 'moonshot',
    kind: 'oauth',
    label: 'Kimi account (device-code sign-in · global (kimi.ai))',
    host: 'global',
    identity: { email: OWNER_EXAMPLE_EMAIL, source: 'receipt' },
    custodian: 'moonshot-accounts',
  } as WalletEntry
  const reads = { entries: () => [kimiWithAccount], active: () => kimiWithAccount }
  const full = composer?.familyIdentityLines('moonshot', { reads })
  check('F1 a reported account reads family · account (kind, host)', JSON.stringify(full) === JSON.stringify([`Kimi account · ${OWNER_EXAMPLE_EMAIL} (device-code, global)`]), full === undefined ? noComposer() : JSON.stringify(full))
  const owner = composer?.familyIdentityLines('moonshot', { reads, width: 42 })
  check('F2 at 42 columns the account elides and the kind and host stay — the owner\'s example byte for byte', JSON.stringify(owner) === JSON.stringify(['Kimi account · whq@… (device-code, global)']), owner === undefined ? noComposer() : JSON.stringify(owner))
  const gptSubscription = {
    id: 'openai:oauth:acct_fix',
    provider: 'openai',
    kind: 'subscription-oauth',
    label: 'ChatGPT plus subscription',
    identity: { email: GPT_EMAIL, plan: 'plus', source: 'receipt' },
    custodian: 'openai-accounts',
  } as WalletEntry
  const gptKey = {
    id: 'openai:api-key:env',
    provider: 'openai',
    kind: 'api-key',
    label: 'OpenAI API key (env)',
    keyTail: '…0042',
    custodian: 'openai-accounts',
  } as WalletEntry
  const pair = { entries: () => [gptSubscription, gptKey], active: () => gptKey }
  const pairLines = composer?.familyIdentityLines('openai', { reads: pair, width: 44 })
  check(
    'F3 narrow: the key keeps its masked tail, the sign-in keeps its kind',
    JSON.stringify(pairLines) === JSON.stringify(['OpenAI API key (env) · …0042', 'also ChatGPT account · gpt-o… (subscription)']),
    pairLines === undefined ? noComposer() : JSON.stringify(pairLines),
  )
  wallet.resetWalletEntriesMemo()
  let within = composer !== null
  for (let width = 0; width <= 90 && composer !== null; width++) {
    for (const line of composer.familyIdentityLines('moonshot', { reads, width })) within &&= stringWidth(line) <= width
    for (const line of composer.familyIdentityLines('openai', { reads: pair, width })) within &&= stringWidth(line) <= width
    for (const family of ['anthropic', 'openai', 'gemini', 'moonshot', 'huggingface']) {
      for (const line of composer.familyIdentityLines(family, { width })) within &&= stringWidth(line) <= width
    }
  }
  check('F4 every line at every width from 0 to 90 stays inside the width', within, composer === null ? noComposer() : '')
}

delete process.env.MERCURY_USER_EMAIL
server.close()
rmSync(HOME, { recursive: true, force: true })

console.log(`\n${'─'.repeat(76)}\nthe composed identity lines, step by step`)
for (const { step, lines } of painted) console.log(`  ${step.padEnd(4)} ${lines.length > 0 ? lines.join('  |  ') : '(no identity line)'}`)
console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ WALLET IDENTITY: ${failures} of ${checks} check(s) FAILED`)
  process.exit(1)
}
console.log(`✅ WALLET IDENTITY PROVEN (${checks} checks)`)
process.exit(0)
