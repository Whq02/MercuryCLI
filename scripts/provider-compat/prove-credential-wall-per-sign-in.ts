#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'prove-wall-per-sign-in-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = HOME
delete process.env.NODE_ENV
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENROUTER_API_KEY', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[key]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { observedCredentialWall, credentialWallLineForModel } = await import('../../src/services/providers/credentialWall.ts')
const { clearOAuthTokenCache, __resetKnownDeadRefreshTokensForTest, isAnthropicOAuthSignInExpired } = await import('../../src/utils/auth.ts')
const pockets = await import('../../src/utils/accounts/signInPockets.ts')
const ledger = await import('../../src/utils/accounts/signInLedger.ts')
const { APIError } = await import('@anthropic-ai/sdk')
const { getAssistantMessageFromError, API_ERROR_MESSAGE_PREFIX } = await import('../../src/services/api/errors.ts')
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(true)

const ALICE = 'alice@home.example'
const BOB = 'bob@work.example'
const pocketBob = join(HOME, 'sign-ins', 'anthropic', BOB)
mkdirSync(pocketBob, { recursive: true })

const live = (who: string): Record<string, unknown> => ({
  accessToken: `${who}-access`,
  refreshToken: `${who}-refresh`,
  expiresAt: Date.now() + 3_600_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
  rateLimitTier: null,
  profile: { account: { uuid: `uuid-${who}`, email: who === 'alice' ? ALICE : BOB } },
})
const dead = (who: string): Record<string, unknown> => ({ ...live(who), refreshToken: '' })

writeFileSync(join(HOME, '.credentials.json'), JSON.stringify({ claudeAiOauth: live('alice'), mcpOAuth: { srv: { accessToken: 'mcp-token' } } }))
writeFileSync(join(pocketBob, '.credentials.json'), JSON.stringify({ claudeAiOauth: dead('bob') }))
writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-alice', emailAddress: ALICE } }))
writeFileSync(join(pocketBob, '.mercury.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-bob', emailAddress: BOB } }))
ledger.recordSignInEntry('anthropic', ALICE, 'oauth', undefined, { home: HOME })
ledger.recordSignInEntry('anthropic', BOB, 'oauth', BOB, { home: HOME })

const textOf = (m: { message: { content: unknown } }): string =>
  (m.message.content as Array<{ type?: string; text?: string }>).map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
const revoked401 = new APIError(401, { type: 'error', error: { type: 'authentication_error', message: 'OAuth access token has been revoked' } }, undefined, undefined as never)
const fresh = (): void => {
  clearOAuthTokenCache()
  __resetKnownDeadRefreshTokensForTest()
}

console.log('============================================================')
console.log(' PROVIDER-COMPAT — the credential wall per sign-in: a dead identity never blocks the other, and the wall names its own')
console.log('============================================================')

console.log('§1 — bob (a pocket, dead) is walled by his own name; alice is not walled')
{
  pockets.setSessionSignIn('anthropic', { identity: BOB, dir: pocketBob, kind: 'subscription' })
  fresh()
  check('the observed wall for anthropic reads bob\'s dead grant', observedCredentialWall('anthropic') === 'sign-in' && isAnthropicOAuthSignInExpired())
  const line = credentialWallLineForModel('claude-opus-5')
  check('the row receipt carries the wall line', line !== undefined && /Anthropic sign-in expired/.test(line), line)
  const painted = textOf(getAssistantMessageFromError(revoked401, 'claude-opus-5') as never)
  check('the transcript row names bob as the walled account', painted.startsWith(`${API_ERROR_MESSAGE_PREFIX}: Anthropic sign-in expired`) && painted.includes(`account ${BOB}`), painted)
  check('the row names the other sign-in and the way to spend it', painted.includes(`also signed in: ${ALICE}`) && painted.includes(`/logins use ${ALICE}`), painted)
  check('no brace, no envelope word, no token in the row', !/[{}"]/.test(painted) && !painted.includes('bob-access') && !painted.includes('bob-refresh'))
  pockets.setSessionSignIn('anthropic', { identity: ALICE, dir: null, kind: 'subscription' })
  fresh()
  check('with alice chosen there is no observed wall', observedCredentialWall('anthropic') === undefined && !isAnthropicOAuthSignInExpired())
  check('alice\'s row receipt carries no wall', credentialWallLineForModel('claude-opus-5') === undefined)
}

console.log('§2 — the wire refusing alice names alice and offers bob, never the other way round')
{
  pockets.setSessionSignIn('anthropic', { identity: ALICE, dir: null, kind: 'subscription' })
  fresh()
  const painted = textOf(getAssistantMessageFromError(revoked401, 'claude-opus-5') as never)
  check('the walled account is alice', painted.includes(`account ${ALICE}`) && !painted.includes(`account ${BOB}`), painted)
  check('the other sign-in offered is bob', painted.includes(`also signed in: ${BOB}`) && painted.includes(`/logins use ${BOB}`), painted)
}

console.log('§3 — identity hidden: the wall names no address and still says another sign-in exists')
{
  const { setSessionSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  const { getInitialSettings } = await import('../../src/utils/settings/settings.ts')
  setSessionSettingsCache({ settings: { ...getInitialSettings(), view: { ...(getInitialSettings().view ?? {}), accountIdentity: false } }, errors: [] })
  pockets.setSessionSignIn('anthropic', { identity: BOB, dir: pocketBob, kind: 'subscription' })
  fresh()
  const painted = textOf(getAssistantMessageFromError(revoked401, 'claude-opus-5') as never)
  check('no address in the row under hidden identity', !painted.includes(ALICE) && !painted.includes(BOB), painted)
  check('the row still says another sign-in is stored', painted.includes('another sign-in of this family is stored'), painted)
}

console.log(failures === 0 ? '\n✅ CREDENTIAL WALL PER SIGN-IN GREEN' : `\n❌ CREDENTIAL WALL PER SIGN-IN RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
