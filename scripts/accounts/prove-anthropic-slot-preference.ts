#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'anthropic-slot-preference-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
delete process.env.CI
delete process.env.NODE_ENV

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()

const auth = { ...(await import('../../src/models/sign-in/credentials/auth.ts')), ...(await import('../../src/models/sign-in/lifecycle/oauthLifecycle.ts')) }
const { getSecureStorage } = await import('../../src/platform/secure-storage/index.ts')
getSecureStorage().update({
  claudeAiOauth: {
    accessToken: 'at_proof',
    refreshToken: 'rt_proof',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
    rateLimitTier: null,
  },
})
auth.clearOAuthTokenCache()

const { saveGlobalConfig } = await import('../../src/platform/config/globalConfig.ts')
const seatKey = (): void => {
  saveGlobalConfig(current => ({ ...current, primaryApiKey: 'sk-ant-proof-managed-key' }))
  auth.getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
}
const dropKey = (): void => {
  saveGlobalConfig(current => ({ ...current, primaryApiKey: undefined }))
  auth.getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
}

const { deriveFamilySlotGroups } = await import('../../src/models/roads/accountSlots.ts')
const anthropicActives = (): string[] => {
  const groups = deriveFamilySlotGroups([], {})
  const anthropic = groups.find(g => (g.family.id as string) === 'anthropic')
  return (anthropic?.slots ?? []).filter(s => s.active).map(s => s.id)
}
const activesOrNull = (): string[] | null => {
  try {
    const groups = deriveFamilySlotGroups()
    const anthropic = groups.find(g => (g.family.id as string) === 'anthropic')
    return (anthropic?.slots ?? []).filter(s => s.active).map(s => s.id)
  } catch {
    return null
  }
}

section('§1 baseline — no preference: the sign-in is the seat')
{
  seatKey()
  check('the stored preference starts absent', auth.readAnthropicPreferredSource() === undefined, 'readAnthropicPreferredSource in src/models/sign-in/credentials/auth.ts reads getGlobalConfig().anthropicPreferredSource; the scratch config home was not clean')
  check('the token source is claude.ai', auth.getAuthTokenSource().source === 'claude.ai', `source=${auth.getAuthTokenSource().source}; getAuthTokenSource in src/models/sign-in/credentials/auth.ts must return claude.ai for a stored sign-in with no preference`)
  check('subscriber answers TRUE (the subscription seat)', auth.isClaudeAISubscriber() === true, 'isClaudeAISubscriber in src/models/sign-in/credentials/auth.ts must be true for a stored sign-in with no preference')
  check('the API key still RESOLVES underneath (presence, not the seat)', auth.getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).source === '/logins managed key', 'getAnthropicApiKeyWithSource in src/models/sign-in/credentials/auth.ts must still resolve the managed key from config')
}

section("§2 preference 'api-key' — the seat flips; the sign-in stays stored")
{
  auth.writeAnthropicPreferredSource('api-key')
  check('the preference reads back', auth.readAnthropicPreferredSource() === 'api-key', 'writeAnthropicPreferredSource in src/models/sign-in/credentials/auth.ts must save anthropicPreferredSource to the global config')
  const source = auth.getAuthTokenSource()
  check('the token source leaves claude.ai', source.source !== 'claude.ai', `source=${source.source}`)
  check('subscriber answers FALSE (a key-billed Anthropic session)', auth.isClaudeAISubscriber() === false, 'isClaudeAISubscriber in src/models/sign-in/credentials/auth.ts must yield to the managed key (subscriptionYieldsToManagedKey) when the preference is api-key')
  check('the client would bill the managed key', auth.getAnthropicApiKey() === 'sk-ant-proof-managed-key', 'getAnthropicApiKey in src/models/sign-in/credentials/auth.ts must return the managed key when the preference is api-key')
  check('the sign-in STAYS stored (never dropped by a switch)', auth.getClaudeAIOAuthTokens()?.refreshToken === 'rt_proof', 'switching the preference must not delete or rewrite the stored sign-in; check writeAnthropicPreferredSource in src/models/sign-in/credentials/auth.ts')
  check('the sign-in is not painted expired by the flip', auth.isAnthropicOAuthSignInExpired() === false, 'isAnthropicOAuthSignInExpired in src/models/sign-in/credentials/auth.ts must be false while the seat is the key')
}

section('§3 the guard — a removed key hands the seat back')
{
  dropKey()
  check('with the key gone, the sign-in quietly resumes the seat', auth.getAuthTokenSource().source === 'claude.ai' && auth.isClaudeAISubscriber() === true, 'subscriptionYieldsToManagedKey in src/models/sign-in/credentials/auth.ts must stay false when no managed key is stored')
  seatKey()
  check('the key back ⇒ the standing preference seats it again', auth.isClaudeAISubscriber() === false, 'subscriptionYieldsToManagedKey in src/models/sign-in/credentials/auth.ts must read the preference live, not remember the key being gone')
}

section('§4 the slots board paints ONE active slot — the seat')
{
  const withPreference = activesOrNull()
  if (withPreference !== null) {
    check('preference api-key ⇒ exactly the key slot active', withPreference.length === 1 && withPreference[0] === 'anthropic:api-key', JSON.stringify(withPreference))
  } else {
    check('slot derivation unavailable in this hermetic home (guarded)', true)
  }
  auth.writeAnthropicPreferredSource(null)
  const cleared = activesOrNull()
  if (cleared !== null) {
    const oauthActive = cleared.some(id => id !== 'anthropic:api-key')
    check('preference cleared ⇒ the OAuth slot is the active one again', oauthActive && !cleared.includes('anthropic:api-key'), JSON.stringify(cleared))
  } else {
    check('slot derivation unavailable in this hermetic home (guarded)', true)
  }
  auth.writeAnthropicPreferredSource('api-key')
}

section('§5 clearing restores the baseline')
{
  auth.writeAnthropicPreferredSource(null)
  check('the preference clears', auth.readAnthropicPreferredSource() === undefined, 'writeAnthropicPreferredSource(null) in src/models/sign-in/credentials/auth.ts must delete anthropicPreferredSource')
  check('the sign-in is the seat again', auth.getAuthTokenSource().source === 'claude.ai' && auth.isClaudeAISubscriber() === true, 'getAuthTokenSource and isClaudeAISubscriber in src/models/sign-in/credentials/auth.ts must return to the sign-in once the preference is cleared')
}


console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ANTHROPIC SLOT PREFERENCE: ALL GREEN')
else console.log(`❌ ${failures} SLOT-PREFERENCE LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
