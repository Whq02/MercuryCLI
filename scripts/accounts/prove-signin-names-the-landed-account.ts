#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR', 'MERCURY_HOME', 'MERCURY_AUTH_SCOPE_DIR', 'OPENAI_API_KEY']) {
  delete process.env[key]
}
const HOME = mkdtempSync(join(tmpdir(), 'signin-landed-account-'))
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CUSTOM_OAUTH_URL = 'http://127.0.0.1:9'

const FIRST_EMAIL = 'first-account@fixture.example'
const SECOND_EMAIL = 'second-account@fixture.example'
const FIRST_UUID = 'uuid-first-account'
const SECOND_UUID = 'uuid-second-account'

writeFileSync(
  join(HOME, '.mercury.json'),
  JSON.stringify({
    hasCompletedOnboarding: true,
    theme: 'dark',
    oauthAccount: {
      accountUuid: FIRST_UUID,
      emailAddress: FIRST_EMAIL,
      organizationUuid: 'org-first',
      organizationName: 'First Org',
      displayName: 'First Account',
      billingType: 'stripe_subscription',
      accountCreatedAt: '2025-01-01T00:00:00Z',
      subscriptionCreatedAt: '2025-01-01T00:00:00Z',
    },
  }),
)
writeFileSync(
  join(HOME, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fixture-first-access-token-0001',
      refreshToken: 'fixture-first-refresh-token-0001',
      expiresAt: 4102444800000,
      scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    },
  }),
  { mode: 0o600 },
)
writeFileSync(join(HOME, '.sign-ins.json'), JSON.stringify({ version: 1, signIns: { anthropic: { at: Date.now() - 60_000, kind: 'oauth' } } }), { mode: 0o600 })

const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { createAnthropicLoginMachine } = await import('../../src/components/mercury-ui/screens/anthropicLoginModel.js')
const { getOauthAccountInfo, getClaudeAIOAuthTokens } = await import('../../src/utils/auth.js')
const { signInLedgerEpoch, subscribeSignInEpoch } = await import('../../src/utils/accounts/signInLedger.js')
const { anthropicCredentialPresence } = await import('../../src/services/providers/providerUsage.js')
const { scanAccountScopes } = await import('../../src/utils/accounts/scopeScan.js')
const { sessionAccountWords } = await import('../../src/utils/accounts/sessionAccount.js')
const { getUsageCredentialEpoch } = await import('../../src/services/claudeAiLimits.js')

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
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

type Tokens = Parameters<NonNullable<Parameters<typeof createAnthropicLoginMachine>[2]>['saveTokens']>[0]

const secondProfile = {
  account: { uuid: SECOND_UUID, email: SECOND_EMAIL, display_name: 'Second Account', created_at: '2025-06-01T00:00:00Z' },
  organization: { uuid: 'org-second', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x', billing_type: 'stripe_subscription', subscription_created_at: '2025-06-01T00:00:00Z' },
}

function tokensOf(over: Partial<Tokens> = {}): Tokens {
  return {
    accessToken: 'fixture-second-access-token-0002',
    refreshToken: 'fixture-second-refresh-token-0002',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
    subscriptionType: 'max',
    rateLimitTier: 'default_claude_max_5x',
    ...over,
  } as Tokens
}

async function signIn(tokens: Tokens, over: Partial<NonNullable<Parameters<typeof createAnthropicLoginMachine>[2]>> = {}): Promise<{ label: string | null; flow: string; message?: string }> {
  let snap: { accountLabel: string | null; flow: { name: string; message?: string } } = { accountLabel: null, flow: { name: 'idle' } }
  const machine = createAnthropicLoginMachine(
    { onDone: () => {} },
    next => {
      snap = next as typeof snap
    },
    {
      createService: () => ({
        startOAuthFlow: async (urlCallback: (url: string) => void) => {
          urlCallback('http://127.0.0.1:9/oauth/authorize')
          return tokens
        },
        handleManualAuthCodeInput: () => {},
        cleanup: () => {},
      }),
      shadowWarning: () => null,
      settings: () => ({}),
      clipboard: async () => null,
      writeStdout: () => {},
      log: () => {},
      setTimer: (fn: () => void) => setTimeout(fn, 0),
      clearTimer: (handle: unknown) => clearTimeout(handle as never),
      ...over,
    } as never,
  )
  machine.start(true)
  await settle()
  await settle()
  return { label: snap.accountLabel, flow: snap.flow.name, ...(snap.flow.message !== undefined ? { message: snap.flow.message } : {}) }
}

const storedOnFile = (): { emailAddress?: string; accountUuid?: string } | undefined =>
  (JSON.parse(readFileSync(join(HOME, '.mercury.json'), 'utf8')) as { oauthAccount?: { emailAddress?: string; accountUuid?: string } }).oauthAccount

section('§0 the receipt words and the roles read')
{
  const { loginSuccessReceipt } = await import('../../src/utils/accounts/loginReceipt.js')
  check('the transcript receipt names the account that signed in', loginSuccessReceipt(SECOND_EMAIL) === `Login successful — signed in as ${SECOND_EMAIL}`, loginSuccessReceipt(SECOND_EMAIL))
  check('with no account on file the receipt is the bare line', loginSuccessReceipt(null) === 'Login successful' && loginSuccessReceipt('') === 'Login successful')
}

section('§1 the estate before the switch: the first account is stored and signed in')
check('the stored account is the first one', getOauthAccountInfo()?.emailAddress === FIRST_EMAIL && getOauthAccountInfo()?.accountUuid === FIRST_UUID)
check('the presence names the first account', anthropicCredentialPresence().identity === FIRST_EMAIL, JSON.stringify(anthropicCredentialPresence()))
const epochBefore = signInLedgerEpoch()
const usageEpochBefore = getUsageCredentialEpoch()

section('§2 a sign-in as the second account, driven through the real machine over the real stores')
const seenAtWake: string[] = []
const unsubscribe = subscribeSignInEpoch(() => {
  seenAtWake.push(getOauthAccountInfo()?.emailAddress ?? 'nobody')
})
const first = await signIn(tokensOf({ profile: secondProfile, tokenAccount: { uuid: SECOND_UUID, emailAddress: SECOND_EMAIL, organizationUuid: 'org-second' } } as Partial<Tokens>))
await settle()
unsubscribe()
check('the machine settled on success', first.flow === 'success', JSON.stringify(first))
check('the receipt names the account that just signed in', first.label === SECOND_EMAIL, String(first.label))
check('the credential on file is the one the sign-in landed', getClaudeAIOAuthTokens()?.accessToken === 'fixture-second-access-token-0002')
check('the stored account is the one that signed in, from the profile the exchange returned', getOauthAccountInfo()?.emailAddress === SECOND_EMAIL && getOauthAccountInfo()?.accountUuid === SECOND_UUID, JSON.stringify(getOauthAccountInfo()))
check('the display name and billing facts of the profile ride the stored account', getOauthAccountInfo()?.displayName === 'Second Account' && getOauthAccountInfo()?.organizationUuid === 'org-second' && getOauthAccountInfo()?.billingType === 'stripe_subscription', JSON.stringify(getOauthAccountInfo()))
check('the config file on disk carries the account that signed in', storedOnFile()?.emailAddress === SECOND_EMAIL && storedOnFile()?.accountUuid === SECOND_UUID, JSON.stringify(storedOnFile()))
check('the sign-in epoch moved exactly once for the landed credential', signInLedgerEpoch() === epochBefore + 1, `${epochBefore} → ${signInLedgerEpoch()}`)
check('a surface woken by the sign-in epoch already reads the account that signed in', seenAtWake.length === 1 && seenAtWake[0] === SECOND_EMAIL, JSON.stringify(seenAtWake))
check('the usage store saw the credential switch before the receipt was composed', getUsageCredentialEpoch() > usageEpochBefore, `${usageEpochBefore} → ${getUsageCredentialEpoch()}`)

section('§2b the in-app sign-in reads the account\'s roles with the landed token, so /status keeps the organisation after a switch')
{
  const rolesSeen: string[] = []
  const roles = await signIn(tokensOf({ accessToken: 'fixture-roles-access-token-0004', profile: secondProfile, tokenAccount: { uuid: SECOND_UUID, emailAddress: SECOND_EMAIL, organizationUuid: 'org-second' } } as Partial<Tokens>), { fetchRoles: async (token: string) => { rolesSeen.push(token) } } as never)
  check('the sign-in settled on success', roles.flow === 'success', JSON.stringify(roles))
  check('the roles were read once, with the token that landed', rolesSeen.length === 1 && rolesSeen[0] === 'fixture-roles-access-token-0004', JSON.stringify(rolesSeen))
  const logged: unknown[] = []
  const refused = await signIn(tokensOf({ accessToken: 'fixture-roles-access-token-0005', profile: secondProfile, tokenAccount: { uuid: SECOND_UUID, emailAddress: SECOND_EMAIL, organizationUuid: 'org-second' } } as Partial<Tokens>), { fetchRoles: async () => { throw new Error('roles are not this token\'s to read') }, log: (error: unknown) => { logged.push(error) } } as never)
  check('a roles read the token is not entitled to is logged and the sign-in still lands', refused.flow === 'success' && refused.label === SECOND_EMAIL && logged.length === 1, JSON.stringify({ refused, logged: logged.map(String) }))
  const modelSource = readFileSync(join(import.meta.dir, '../../src/components/mercury-ui/screens/anthropicLoginModel.ts'), 'utf8')
  check('the live deps read the roles through the one oauth owner, after the account is stored, only for a token with the profile scope, without holding the success', modelSource.includes('fetchRoles: fetchAndStoreUserRoles,') && modelSource.includes('if (landed !== undefined) deps.storeAccount(landed)') && modelSource.includes('fetchRoles(tokens.accessToken, origin)') && modelSource.indexOf('if (landed !== undefined) deps.storeAccount(landed)') < modelSource.indexOf('fetchRoles(tokens.accessToken, origin)') && modelSource.includes('tokens.scopes.includes(CLAUDE_AI_PROFILE_SCOPE)') && modelSource.includes('isCurrent: () => !disposed && gen === generation'))
}

section('§3 every surface that names the account reads the sign-in, with no /accounts in between')
check('the presence owner names the account that signed in', anthropicCredentialPresence().identity === SECOND_EMAIL, JSON.stringify(anthropicCredentialPresence()))
check('the logins roster row reads the account that signed in from the scope file', scanAccountScopes()[0]?.email === SECOND_EMAIL && scanAccountScopes()[0]?.authed === true, JSON.stringify(scanAccountScopes()[0]))
const chip = sessionAccountWords('claude-opus-5')
check('the face chip names the account that signed in', chip.state === 'email' && chip.text === SECOND_EMAIL && chip.family === 'anthropic', JSON.stringify(chip))

section('§4 a sign-in whose result carries no account names nobody, never the stored snapshot')
const bare = await signIn(tokensOf({ accessToken: 'fixture-third-access-token-0003' }))
check('the machine settled on success', bare.flow === 'success', JSON.stringify(bare))
check('the receipt carries no email rather than the earlier account', bare.label === null, String(bare.label))
check('the stored account is left as it was', getOauthAccountInfo()?.emailAddress === SECOND_EMAIL, JSON.stringify(getOauthAccountInfo()))

section('§5 a save that failed stores no account and names nobody')
const refused = await signIn(
  tokensOf({ accessToken: 'fixture-fourth-access-token-0004', profile: { ...secondProfile, account: { ...secondProfile.account, uuid: 'uuid-fourth', email: 'fourth-account@fixture.example' } } } as Partial<Tokens>),
  { saveTokens: () => ({ success: false, warning: 'Failed to save credentials to secure storage' }) } as never,
)
check('a failed save lands the error flow', refused.flow === 'error' && (refused.message ?? '').includes('secure storage'), JSON.stringify(refused))
check('the failed save stored no account and named nobody', refused.label === null && getOauthAccountInfo()?.emailAddress === SECOND_EMAIL, JSON.stringify(getOauthAccountInfo()))
check('the credential on file is still the one saved before the refused save', getClaudeAIOAuthTokens()?.accessToken === 'fixture-third-access-token-0003', String(getClaudeAIOAuthTokens()?.accessToken))

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
