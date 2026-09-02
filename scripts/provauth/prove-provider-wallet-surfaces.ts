#!/usr/bin/env bun
// ============================================================================
//  scripts/provauth/prove-provider-wallet-surfaces.ts
//  PROOF: the wallet + /accounts +
//  usage-facade surfaces for the OpenRouter and Gemini families — hermetic
//  stores, injected reads, no network:
//    1. walletEntries enumerates each family's real credential identities
//       (OAuth-minted key · env key · Google OAuth · key ladder) with
//       stable ids and NO secret in any field;
//    2. activeWalletEntry follows each custodian's arbitration;
//    3. providerFamilyPresences carries both families (derived — the
//       /usage, /config and /accounts row sets follow with no UI edit);
//    4. deriveFamilySlotGroups renders every source as its own slot with
//       honest shadowing notes; executeSlotRemoval routes each slot to its
//       owning store (env pins refused with the shell-owned note);
//    5. the activeSourceUsage arms answer for both providers through
//       injected reads (shapes, labels, limited windows).
//  Run:  ~/.bun/bin/bun run scripts/provauth/prove-provider-wallet-surfaces.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' PROVAUTH — wallet · /accounts slots · usage facade (both families)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_OPENROUTER_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_GEMINI_OAUTH_AUTH_BASE',
  'MERCURY_GEMINI_OAUTH_TOKEN_BASE',
  'MERCURY_GEMINI_OAUTH_CLIENT_ID',
  'MERCURY_GEMINI_OAUTH_CLIENT_SECRET',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-wallet-surfaces-'))

// Arm config reads BEFORE any real-owner path (the injected-doubles-mask
// lesson): the presence leg builds the real router snapshot, whose anthropic
// adapter walks the credential owners.
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = 'https://fixture.invalid/o/oauth2/v2/auth'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://fixture.invalid/token'

const orAccounts = await import('../../src/services/providers/openrouter/openrouterAccounts.js')
const gmAccounts = await import('../../src/services/providers/gemini/geminiAccounts.js')
const secrets = await import('../../src/utils/router/providerSecrets.js')
const wallet = await import('../../src/services/wallet/wallet.js')
const slots = await import('../../src/services/providers/accountSlots.js')
const providerUsage = await import('../../src/services/providers/providerUsage.js')

const OR_KEY = 'sk-or-v1-MINTEDFIXTURE0000000'

// Seed: mint an OpenRouter key via the real connect machinery (paste path,
// injected exchange) + a Google OAuth grant the same way.
{
  const exchange: typeof fetch = (async () =>
    new Response(JSON.stringify({ key: OR_KEY }), { status: 200 })) as unknown as typeof fetch
  const handles = orAccounts.beginOpenrouterConnect({ skipBrowserOpen: true, fetchImpl: exchange })
  handles.completeWithRedirect('http://localhost:1456/auth/callback?code=SEED')
  await handles.result

  gmAccounts.writeGeminiOauthClientConfig({ clientId: 'seed-client.apps.googleusercontent.com' })
  const token: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ access_token: 'SEED-ACCESS', refresh_token: 'SEED-REFRESH', expires_in: 3600 }),
      { status: 200 },
    )) as unknown as typeof fetch
  const gm = gmAccounts.beginGeminiBrowserConnect({ skipBrowserOpen: true, fetchImpl: token })
  const state = new URL(gm.authorizeUrl).searchParams.get('state')!
  gm.completeWithRedirect(`http://127.0.0.1:1457/oauth2/callback?code=SEED&state=${state}`)
  await gm.result
  secrets.writeStoredGeminiApiKey('AIza-STORED-FIXTURE00000000')
}

// ── 1+2. wallet enumeration + arbitration ───────────────────────────────────
{
  const entries = wallet.walletEntries()
  const orOauth = entries.find(e => e.id === 'openrouter:oauth-key')
  check('openrouter OAuth-minted entry enumerates', orOauth?.provider === 'openrouter' && orOauth?.kind === 'api-key' && orOauth?.custodian === 'openrouter-accounts')
  const gmOauth = entries.find(e => e.id === 'gemini:oauth')
  check('gemini Google OAuth entry enumerates (kind oauth)', gmOauth?.kind === 'oauth' && gmOauth?.custodian === 'gemini-accounts')
  const gmKey = entries.find(e => e.id === 'gemini:api-key:stored')
  check('gemini stored key entry enumerates beside the OAuth login', gmKey?.kind === 'api-key' && gmKey?.custodian === 'provider-secrets')
  check('no wallet field carries a secret value', JSON.stringify(entries).includes(OR_KEY) === false && JSON.stringify(entries).includes('SEED-REFRESH') === false)

  check('openrouter active = the minted key (no env pin)', wallet.activeWalletEntry('openrouter')?.id === 'openrouter:oauth-key')
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-ENVFIXTURE0000000000'
  check('env pin flips the active entry to the env key', wallet.activeWalletEntry('openrouter')?.id === 'openrouter:api-key:env')
  delete process.env.OPENROUTER_API_KEY

  check('gemini active = OAuth (default arbitration)', wallet.activeWalletEntry('gemini')?.kind === 'oauth')
  gmAccounts.writePreferredGeminiSource('api-key')
  check('gemini api-key preference flips the active entry', wallet.activeWalletEntry('gemini')?.kind === 'api-key')
  gmAccounts.writePreferredGeminiSource(null)
}

// ── 3. presences carry both families (derived rows everywhere) ──────────────
{
  // Injected anthropic reads keep the leg hermetic (the main-loop credential
  // owners can refuse enumeration in a bare environment).
  const presences = providerUsage.providerFamilyPresences(undefined, {
    claudeSubscriber: () => false,
    subscriptionType: () => null,
    anthropicApiKeyPresent: () => false,
  })
  const ids = presences.map(p => p.id)
  check('presences enumerate openrouter + gemini after anthropic/openai/zai', ids.includes('openrouter') && ids.includes('gemini'))
  const or = presences.find(p => p.id === 'openrouter')
  check('openrouter presence: credentialed with the OAuth-minted label', or?.credentialed === true && or?.credentialLabel === 'OpenRouter (OAuth-minted key)')
  const gm = presences.find(p => p.id === 'gemini')
  check('gemini presence: credentialed with the Google OAuth label', gm?.credentialed === true && gm?.credentialLabel === 'Google account (OAuth)')
}

// ── 4. slots: one row per source, honest shadowing, routed removal ──────────
{
  const reads = {
    openrouterEnvKey: () => 'sk-or-v1-ENVFIXTURE0000000000',
    openrouterMintedKey: () => ({ key: OR_KEY, mintedAtMs: 1_755_000_000_000 }),
    openrouterStoredKey: () => 'sk-or-v1-STOREDFIXTURE000000',
    geminiOauthConnected: () => true,
    geminiActiveAccount: () => ({
      provider: 'gemini' as const,
      kind: 'oauth' as const,
      label: 'Google account (OAuth)',
    }),
    geminiEnvGoogleKey: () => 'AIza-GOOGLE-FIXTURE00000000',
    geminiEnvGeminiKey: () => 'AIza-GEMINI-FIXTURE00000000',
    geminiStoredKey: () => 'AIza-STORED-FIXTURE00000000',
  }
  const groups = slots.deriveFamilySlotGroups(undefined, reads)
  const orGroup = groups.find(g => g.family.id === 'openrouter')
  check('openrouter renders three slots (env · oauth-minted · stored)', orGroup?.slots.length === 3)
  const mintedSlot = orGroup?.slots.find(s => s.id === 'openrouter:oauth-key')
  check('minted slot: kind oauth, shadowed by the env pin, masked tail only', mintedSlot?.kind === 'oauth' && mintedSlot?.active === false && (mintedSlot?.stateNote ?? '').includes('env pin wins') && !JSON.stringify(mintedSlot).includes(OR_KEY.slice(0, -4)))
  const storedSlot = orGroup?.slots.find(s => s.id === 'openrouter:stored-key')
  check('stored slot shadowed with the honest note', (storedSlot?.stateNote ?? '').includes('env pin wins'))

  const gmGroup = groups.find(g => g.family.id === 'gemini')
  check('gemini renders four slots (oauth · 2 env keys · stored)', gmGroup?.slots.length === 4)
  const geminiEnvSlot = gmGroup?.slots.find(s => s.id === 'gemini:env-gemini-key')
  check('GEMINI_API_KEY slot shadowed by GOOGLE_API_KEY (the documented precedence)', (geminiEnvSlot?.stateNote ?? '').includes('GOOGLE_API_KEY wins'))

  // Removal routing — injected owners observe the calls; env pins refuse.
  const calls: string[] = []
  const owners = {
    disconnectOpenrouterOauthKey: () => calls.push('or-oauth'),
    clearStoredOpenrouterKey: () => calls.push('or-stored'),
    disconnectGeminiOauth: () => calls.push('gm-oauth'),
    clearStoredGeminiKey: () => calls.push('gm-stored'),
  }
  const envSlot = orGroup!.slots.find(s => s.id === 'openrouter:env-key')!
  const envOutcome = slots.executeSlotRemoval(envSlot, owners)
  check('env slot removal REFUSES with the shell-owned note', envOutcome.mutated === false && envOutcome.note.includes('OPENROUTER_API_KEY'))
  const mintedOutcome = slots.executeSlotRemoval(mintedSlot!, owners)
  check('minted slot removal routes to the openrouter custodian + names server-side revocation', mintedOutcome.mutated === true && calls.includes('or-oauth') && mintedOutcome.note.includes('openrouter.ai'))
  slots.executeSlotRemoval(storedSlot!, owners)
  slots.executeSlotRemoval(gmGroup!.slots.find(s => s.id === 'gemini:oauth')!, owners)
  slots.executeSlotRemoval(gmGroup!.slots.find(s => s.id === 'gemini:stored-key')!, owners)
  check('every non-env slot routed to its OWN store', calls.join(',') === 'or-oauth,or-stored,gm-oauth,gm-stored')
}

// ── 5. the activeSourceUsage arms (injected reads; no network) ──────────────
{
  const spend = { inputTokens: 10, outputTokens: 5, costUSD: 0.01, models: 1 }
  const or = providerUsage.activeSourceUsage({
    model: 'x',
    reads: {
      route: () => 'openrouter',
      openrouterKeyPresent: () => true,
      openrouterObserved: () => ({ usage: null }),
      openrouterLimited: () => ({ state: 'limited', resetsAtMs: 9_999_999_999_999, observedAtMs: 1 }),
      spend: () => spend,
    },
  })
  check('openrouter arm: api-key/api-spend + the limited window rides', or.sourceKind === 'api-key' && or.shape === 'api-spend' && or.limited?.resetsAtMs === 9_999_999_999_999)

  const gmOauth = providerUsage.activeSourceUsage({
    model: 'x',
    reads: {
      route: () => 'gemini',
      geminiAccount: () => ({ provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }),
      geminiLimited: () => ({ state: 'clear' }),
      spend: () => spend,
    },
  })
  check('gemini oauth arm: sourceKind oauth, provider-named label, NO fabricated windows', gmOauth.sourceKind === 'oauth' && gmOauth.label === 'Gemini usage' && gmOauth.windows.length === 0)

  const gmNone = providerUsage.activeSourceUsage({
    model: 'x',
    reads: { route: () => 'gemini', geminiAccount: () => undefined, spend: () => spend },
  })
  check('gemini uncredentialed arm: honest none shape', gmNone.sourceKind === 'none' && gmNone.shape === 'none')
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} wallet-surface proof(s) failed`)
  process.exit(1)
}
console.log('✅ WALLET + SLOTS + USAGE FACADE PROVEN for OpenRouter and Gemini')
