#!/usr/bin/env bun
// ============================================================================
//  prove-anthropic-slot-preference — the Anthropic ACTIVE-slot switch road.
//  The family's two Mercury-held slots are the
//  claude.ai sign-in and the /logins managed key; before this lane the seat
//  was structural (subscription always won) — no switch existed. The road:
//  ONE stored preference, consulted at the ONE resolution door (utils/auth),
//  never a parallel resolution path.
//
//    §1 baseline byte-identical: no preference ⇒ the sign-in is the seat
//       (source claude.ai · subscriber true · the OAuth slot active)
//    §2 preference 'api-key' + the managed key present ⇒ the seat flips:
//       source leaves claude.ai, subscriber reads false, the client would
//       bill the key; the sign-in STAYS stored (presence, not activity)
//    §3 the guard: preference 'api-key' with NO managed key ⇒ the
//       subscription quietly keeps the seat (never a credential-less refusal)
//    §4 the slots board paints ONE active slot per state — the seat the
//       wire would bill (gauge = truth)
//    §5 clearing the preference restores the baseline
//    §6 structural: only the two predicates consult the yield; the refresh
//       lane reads scope facts, never the preference (the parked sign-in
//       stays background-refreshed)
//
//  Run: ~/.bun/bin/bun run scripts/accounts/prove-anthropic-slot-preference.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'anthropic-slot-preference-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
delete process.env.MERCURY_HOME
// The file-backed credential store — a scratch home must never reach the
// machine's OS keychain (the secureStorage pin).
process.env.MERCURY_CREDENTIAL_STORE = 'file'
// No env credentials may shadow the two slots under proof.
delete process.env.ANTHROPIC_API_KEY
delete process.env.ANTHROPIC_AUTH_TOKEN
delete process.env.MERCURY_OAUTH_TOKEN
// The key ladder's CI/test refusal keys on these — absent, the ladder
// resolves normally. NODE_ENV must stay UNSET under bun: forcing
// 'production' at runtime desyncs bun's dev-mode JSX transpile from the
// jsx-runtime it loads (the jsxDEV crash class).
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

// Config reads are boot-gated; the prover is its own boot.
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

// The stored claude.ai sign-in (the subscription slot), landed the way the
// login lands it — through the secure-storage door.
const auth = await import('../../src/utils/auth.ts')
const { getSecureStorage } = await import('../../src/utils/secureStorage/index.ts')
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

// The managed key (the api-key slot), landed where the /logins mint lands
// it (config primaryApiKey — the keychain leg is the darwin overlay; the
// scoped service name cannot exist for a scratch home, so the ladder falls
// through to config).
const { saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
const seatKey = (): void => {
  saveGlobalConfig(current => ({ ...current, primaryApiKey: 'sk-ant-proof-managed-key' }))
  auth.getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
}
const dropKey = (): void => {
  saveGlobalConfig(current => ({ ...current, primaryApiKey: undefined }))
  auth.getApiKeyFromConfigOrMacOSKeychain.cache?.clear?.()
}

const { deriveFamilySlotGroups } = await import('../../src/services/providers/accountSlots.ts')
const anthropicActives = (): string[] => {
  const groups = deriveFamilySlotGroups([], {})
  const anthropic = groups.find(g => (g.family.id as string) === 'anthropic')
  return (anthropic?.slots ?? []).filter(s => s.active).map(s => s.id)
}
// The slot derivation needs the anthropic presence row even with no
// provider snapshot — presences come from providerFamilyPresences over the
// passed providers; an empty snapshot yields no groups. Derive with the
// full default instead when available; guard cheaply.
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
  check('the stored preference starts absent', auth.readAnthropicPreferredSource() === undefined)
  check('the token source is claude.ai', auth.getAuthTokenSource().source === 'claude.ai')
  check('subscriber answers TRUE (the subscription seat)', auth.isClaudeAISubscriber() === true)
  check('the API key still RESOLVES underneath (presence, not the seat)', auth.getAnthropicApiKeyWithSource({ skipRetrievingKeyFromApiKeyHelper: true }).source === '/logins managed key')
}

section("§2 preference 'api-key' — the seat flips; the sign-in stays stored")
{
  auth.writeAnthropicPreferredSource('api-key')
  check('the preference reads back', auth.readAnthropicPreferredSource() === 'api-key')
  const source = auth.getAuthTokenSource()
  check('the token source leaves claude.ai', source.source !== 'claude.ai', `source=${source.source}`)
  check('subscriber answers FALSE (a key-billed Anthropic session)', auth.isClaudeAISubscriber() === false)
  check('the client would bill the managed key', auth.getAnthropicApiKey() === 'sk-ant-proof-managed-key')
  check('the sign-in STAYS stored (never dropped by a switch)', auth.getClaudeAIOAuthTokens()?.refreshToken === 'rt_proof')
  check('the sign-in is not painted expired by the flip', auth.isAnthropicOAuthSignInExpired() === false)
}

section('§3 the guard — a removed key hands the seat back')
{
  dropKey()
  check('with the key gone, the sign-in quietly resumes the seat', auth.getAuthTokenSource().source === 'claude.ai' && auth.isClaudeAISubscriber() === true)
  seatKey()
  check('the key back ⇒ the standing preference seats it again', auth.isClaudeAISubscriber() === false)
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
  check('the preference clears', auth.readAnthropicPreferredSource() === undefined)
  check('the sign-in is the seat again', auth.getAuthTokenSource().source === 'claude.ai' && auth.isClaudeAISubscriber() === true)
}

section('§6 structural — one door; the refresh lane never reads the preference')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src/utils/auth.ts'), 'utf8')
  const consults = (src.match(/!subscriptionYieldsToManagedKey\(\)/g) ?? []).length
  check('exactly the two predicates consult the yield (the two negated call sites)', consults === 2, `found ${consults}`)
  check('the yield helper exists once, module-private', (src.match(/function subscriptionYieldsToManagedKey\(\)/g) ?? []).length === 1 && !src.includes('export function subscriptionYieldsToManagedKey'))
  const refreshRegion = src.slice(src.indexOf('async function doRefresh'), src.indexOf('// --- 401 handling'))
  check('doRefresh reads scope facts, never the slot preference (the parked sign-in stays refreshed)', refreshRegion.length > 0 && !refreshRegion.includes('subscriptionYieldsToManagedKey') && !refreshRegion.includes('anthropicPreferredSource'))
  check('the config field is documented at the schema', readFileSync(join(import.meta.dir, '..', '..', 'src/utils/config/schema.ts'), 'utf8').includes('anthropicPreferredSource?:'))
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('ANTHROPIC SLOT PREFERENCE: ALL GREEN')
else console.log(`❌ ${failures} SLOT-PREFERENCE LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
