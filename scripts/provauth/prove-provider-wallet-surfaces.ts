#!/usr/bin/env bun
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

const { enableConfigs } = await import('../../src/platform/settings/config.js')
enableConfigs()
process.env.MERCURY_OPENROUTER_AUTH_BASE = 'https://fixture.invalid/auth'
process.env.MERCURY_OPENROUTER_API_BASE = 'https://fixture.invalid/api/v1'
process.env.MERCURY_GEMINI_API_BASE = 'https://fixture.invalid/v1beta'
process.env.MERCURY_GEMINI_OAUTH_AUTH_BASE = 'https://fixture.invalid/o/oauth2/v2/auth'
process.env.MERCURY_GEMINI_OAUTH_TOKEN_BASE = 'https://fixture.invalid/token'

const orAccounts = await import('../../src/models/roads/openrouter/openrouterAccounts.js')
const gmAccounts = await import('../../src/models/roads/gemini/geminiAccounts.js')
const secrets = await import('../../src/models/sign-in/account-ledger/providerSecrets.js')
const wallet = await import('../../src/models/wallet/wallet.js')
const slots = await import('../../src/models/roads/accountSlots.js')
const providerUsage = await import('../../src/models/roads/providerUsage.js')

const OR_KEY = 'sk-or-v1-MINTEDFIXTURE0000000'

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

{
  const entries = wallet.walletEntries()
  const orOauth = entries.find(e => e.id === 'openrouter:oauth-key')
  check('openrouter OAuth-minted entry enumerates', orOauth?.provider === 'openrouter' && orOauth?.kind === 'api-key' && orOauth?.custodian === 'openrouter-accounts', 'fix walletEntries in src/models/wallet/wallet.ts so the OpenRouter minted key enumerates as provider openrouter, kind api-key, custodian openrouter-accounts')
  const gmOauth = entries.find(e => e.id === 'gemini:oauth')
  check('gemini Google OAuth entry enumerates (kind oauth)', gmOauth?.kind === 'oauth' && gmOauth?.custodian === 'gemini-accounts', 'fix walletEntries in src/models/wallet/wallet.ts so the Gemini OAuth login enumerates as id gemini:oauth, kind oauth, custodian gemini-accounts')
  const gmKey = entries.find(e => e.id === 'gemini:api-key:stored')
  check('gemini stored key entry enumerates beside the OAuth login', gmKey?.kind === 'api-key' && gmKey?.custodian === 'provider-secrets', 'fix walletEntries in src/models/wallet/wallet.ts so the stored Gemini key enumerates as id gemini:api-key:stored, kind api-key, custodian provider-secrets')
  check('no wallet field carries a secret value', JSON.stringify(entries).includes(OR_KEY) === false && JSON.stringify(entries).includes('SEED-REFRESH') === false, 'a wallet entry now carries a secret value; keep the key and refresh token out of the entries built by walletEntries in src/models/wallet/wallet.ts')

  check('openrouter active = the minted key (no env pin)', wallet.activeWalletEntry('openrouter')?.id === 'openrouter:oauth-key', 'fix activeWalletEntry in src/models/wallet/wallet.ts so the minted key is active when no env key is set')
  process.env.OPENROUTER_API_KEY = 'sk-or-v1-ENVFIXTURE0000000000'
  check('env pin flips the active entry to the env key', wallet.activeWalletEntry('openrouter')?.id === 'openrouter:api-key:env', 'fix activeWalletEntry in src/models/wallet/wallet.ts so OPENROUTER_API_KEY in the environment wins over the minted key')
  delete process.env.OPENROUTER_API_KEY

  check('gemini active = OAuth (default arbitration)', wallet.activeWalletEntry('gemini')?.kind === 'oauth', 'fix activeWalletEntry in src/models/wallet/wallet.ts so Gemini defaults to the OAuth login when no source preference is set')
  gmAccounts.writePreferredGeminiSource('api-key')
  check('gemini api-key preference flips the active entry', wallet.activeWalletEntry('gemini')?.kind === 'api-key', 'fix activeWalletEntry in src/models/wallet/wallet.ts so a preferred source of api-key (writePreferredGeminiSource) makes the key entry active')
  gmAccounts.writePreferredGeminiSource(null)
}

{
  const presences = providerUsage.providerFamilyPresences(undefined, {
    claudeSubscriber: () => false,
    subscriptionType: () => null,
    anthropicApiKeyPresent: () => false,
  })
  const ids = presences.map(p => p.id)
  check('presences enumerate openrouter + gemini after anthropic/openai/zai', ids.includes('openrouter') && ids.includes('gemini'), 'fix providerFamilyPresences in src/models/roads/providerUsage.ts so it lists openrouter and gemini; ids were ' + ids.join(','))
  const or = presences.find(p => p.id === 'openrouter')
  check('openrouter presence: credentialed with the OAuth-minted label', or?.credentialed === true && or?.credentialLabel === 'OpenRouter (OAuth-minted key)', 'fix providerFamilyPresences in src/models/roads/providerUsage.ts; got ' + JSON.stringify(or))
  const gm = presences.find(p => p.id === 'gemini')
  check('gemini presence: credentialed with the Google OAuth label', gm?.credentialed === true && gm?.credentialLabel === 'Google account (OAuth)', 'fix providerFamilyPresences in src/models/roads/providerUsage.ts; got ' + JSON.stringify(gm))
}

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
  check('openrouter renders three slots (env · oauth-minted · stored)', orGroup?.slots.length === 3, 'fix deriveFamilySlotGroups in src/models/roads/accountSlots.ts; slot ids were ' + (orGroup?.slots.map(s => s.id).join(',') ?? 'no group'))
  const mintedSlot = orGroup?.slots.find(s => s.id === 'openrouter:oauth-key')
  check('minted slot: kind oauth, shadowed by the env pin, masked tail only', mintedSlot?.kind === 'oauth' && mintedSlot?.active === false && mintedSlot?.stateNote === 'shadowed — the environment variable wins' && !JSON.stringify(mintedSlot).includes(OR_KEY.slice(0, -4)), 'fix deriveFamilySlotGroups in src/models/roads/accountSlots.ts so the minted slot is oauth, inactive, noted as shadowed by the environment variable, and shows only a masked tail; got ' + JSON.stringify(mintedSlot?.stateNote))
  const storedSlot = orGroup?.slots.find(s => s.id === 'openrouter:stored-key')
  check('stored slot shadowed with the honest note', storedSlot?.stateNote === 'shadowed — the environment variable wins', 'fix deriveFamilySlotGroups in src/models/roads/accountSlots.ts so the stored slot is noted as shadowed by the env key; got ' + JSON.stringify(storedSlot?.stateNote))

  const gmGroup = groups.find(g => g.family.id === 'gemini')
  check('gemini renders four slots (oauth · 2 env keys · stored)', gmGroup?.slots.length === 4, 'fix deriveFamilySlotGroups in src/models/roads/accountSlots.ts; slot ids were ' + (gmGroup?.slots.map(s => s.id).join(',') ?? 'no group'))
  const geminiEnvSlot = gmGroup?.slots.find(s => s.id === 'gemini:env-gemini-key')
  check('GEMINI_API_KEY slot shadowed by GOOGLE_API_KEY (the documented precedence)', (geminiEnvSlot?.stateNote ?? '').includes('GOOGLE_API_KEY wins'), 'fix deriveFamilySlotGroups in src/models/roads/accountSlots.ts so the GEMINI_API_KEY slot says GOOGLE_API_KEY wins; got ' + JSON.stringify(geminiEnvSlot?.stateNote))

  const calls: string[] = []
  const owners = {
    disconnectOpenrouterOauthKey: () => calls.push('or-oauth'),
    clearStoredOpenrouterKey: () => calls.push('or-stored'),
    disconnectGeminiOauth: () => calls.push('gm-oauth'),
    clearStoredGeminiKey: () => calls.push('gm-stored'),
  }
  const envSlot = orGroup!.slots.find(s => s.id === 'openrouter:env-key')!
  const envOutcome = slots.executeSlotRemoval(envSlot, owners)
  check('env slot removal REFUSES with the shell-owned note', envOutcome.mutated === false && envOutcome.note.includes('OPENROUTER_API_KEY'), 'fix executeSlotRemoval in src/models/roads/account-slots/removal.ts so an env slot is refused with a note naming OPENROUTER_API_KEY; got ' + JSON.stringify(envOutcome))
  const mintedOutcome = slots.executeSlotRemoval(mintedSlot!, owners)
  check('minted slot removal routes to the openrouter custodian + names server-side revocation', mintedOutcome.mutated === true && calls.includes('or-oauth') && mintedOutcome.note.includes('openrouter.ai'), 'fix executeSlotRemoval in src/models/roads/account-slots/removal.ts so the minted slot calls disconnectOpenrouterOauthKey and the note names openrouter.ai; got ' + JSON.stringify(mintedOutcome))
  slots.executeSlotRemoval(storedSlot!, owners)
  slots.executeSlotRemoval(gmGroup!.slots.find(s => s.id === 'gemini:oauth')!, owners)
  slots.executeSlotRemoval(gmGroup!.slots.find(s => s.id === 'gemini:stored-key')!, owners)
  check('every non-env slot routed to its OWN store', calls.join(',') === 'or-oauth,or-stored,gm-oauth,gm-stored', 'fix executeSlotRemoval in src/models/roads/account-slots/removal.ts so each slot calls its own custodian; calls were ' + calls.join(','))
}

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
  check('openrouter arm: api-key/api-spend + the limited window rides', or.sourceKind === 'api-key' && or.shape === 'api-spend' && or.limited?.resetsAtMs === 9_999_999_999_999, 'fix activeSourceUsage in src/models/roads/providerUsage.ts; got ' + JSON.stringify({ sourceKind: or.sourceKind, shape: or.shape, limited: or.limited }))

  const gmOauth = providerUsage.activeSourceUsage({
    model: 'x',
    reads: {
      route: () => 'gemini',
      geminiAccount: () => ({ provider: 'gemini', kind: 'oauth', label: 'Google account (OAuth)' }),
      geminiLimited: () => ({ state: 'clear' }),
      spend: () => spend,
    },
  })
  check('gemini oauth arm: sourceKind oauth, provider-named label, NO fabricated windows', gmOauth.sourceKind === 'oauth' && gmOauth.label === 'Gemini usage' && gmOauth.windows.length === 0, 'fix activeSourceUsage in src/models/roads/providerUsage.ts; got ' + JSON.stringify({ sourceKind: gmOauth.sourceKind, label: gmOauth.label, windows: gmOauth.windows.length }))

  const gmNone = providerUsage.activeSourceUsage({
    model: 'x',
    reads: { route: () => 'gemini', geminiAccount: () => undefined, spend: () => spend },
  })
  check('gemini uncredentialed arm: honest none shape', gmNone.sourceKind === 'none' && gmNone.shape === 'none', 'fix activeSourceUsage in src/models/roads/providerUsage.ts; got ' + JSON.stringify({ sourceKind: gmNone.sourceKind, shape: gmNone.shape }))
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
