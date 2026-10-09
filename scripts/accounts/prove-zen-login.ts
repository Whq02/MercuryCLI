import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync, statSync, readFileSync } from 'node:fs'
import { startZenFixture } from '../providers/lib/zen-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.OPENCODE_API_KEY
const KEY = 'sk-proof-key-zen-fixture-login-not-a-real-key-000000000000000000000000000'
const fixture = startZenFixture({ key: KEY })
process.env.MERCURY_ZEN_API_BASE = fixture.base
process.env.MERCURY_ZEN_GO_API_BASE = fixture.goBase
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { storeZenApiKeyLogin } = await import('../../src/services/providers/zen/zenLogin.ts')
const { resolveZenApiKey, resolveZenAccount, zenApiBase, zenGoApiBase, ZEN_ENV_KEY } = await import('../../src/services/providers/zen/zenAccounts.ts')
const { readStoredZenApiKey, writeStoredZenApiKey, providerSecretsPathForDisplay, credentialEnvNames } = await import('../../src/utils/router/providerSecrets.ts')
const { readSignInLedger } = await import('../../src/utils/accounts/signInLedger.ts')
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS, PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
const { providerIdentityLine } = await import('../../src/services/providers/providerIdentityLine.ts')
const { zenObservedGoUsage, refreshZenGoUsage, __resetZenUsageForTest } = await import('../../src/services/providers/zen/zenUsageState.ts')
const { usageForProvider, refreshProviderUsage } = await import('../../src/services/providers/providerUsage.ts')
const env = process.env
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('the documented bases and the one env spelling belong to Zen', zenApiBase({} as NodeJS.ProcessEnv) === 'https://opencode.ai/zen/v1' && zenGoApiBase({} as NodeJS.ProcessEnv) === 'https://opencode.ai/zen/go/v1' && ZEN_ENV_KEY === 'OPENCODE_API_KEY' && ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes('OPENCODE_API_KEY') && credentialEnvNames().includes('OPENCODE_API_KEY') && PROVIDER_CREDENTIAL_ENV_VARS.zen.join() === 'OPENCODE_API_KEY')
  const empty = await storeZenApiKeyLogin(' ', { env })
  check('empty paste stores nothing', !empty.ok && !empty.stored)
  const rejected = await storeZenApiKeyLogin('sk-not-the-fixture-key-000000000000000000000000000000000000000000000000', { env })
  check('a key the gateway refuses (HTTP 401 on the usage read) is never stored and the receipt names the console', !rejected.ok && !rejected.stored && !readStoredZenApiKey() && rejected.receipt.includes('opencode.ai/auth') && rejected.receipt.includes('401'))
  const saved = await storeZenApiKeyLogin(KEY, { env })
  check('a valid pay-as-you-go key (403 EntitlementError on the Go read) is stored with an honest no-plan receipt, never its secret', saved.ok && saved.stored && saved.receipt.includes('no OpenCode Go plan') && saved.receipt.includes('mode 600') && !saved.receipt.includes(KEY) && readStoredZenApiKey() === KEY)
  check('at-rest storage is auth-scoped and mode 600 in its own slot', providerSecretsPathForDisplay().startsWith(proofHome) && (statSync(providerSecretsPathForDisplay()).mode & 0o777) === 0o600 && JSON.parse(readFileSync(providerSecretsPathForDisplay(), 'utf8')).zenApiKey === KEY)
  check('sign-in recency records the Zen key', readSignInLedger().zen?.kind === 'api-key')
  check('account labels carry presence, never the secret', resolveZenApiKey()?.source === 'stored' && resolveZenAccount()?.label === 'OpenCode Zen API key (stored, auth-scoped)' && !JSON.stringify(resolveZenAccount()).includes(KEY))
  const noPlan = zenObservedGoUsage()
  check('the key check left an observed no-plan fact, no invented windows', noPlan.plan === 'none' && noPlan.usage === null && noPlan.failure === null)
  const view = usageForProvider('zen')
  check('/usage shows API spend with the console-only balance line and no Go windows', view.sourceKind === 'api-key' && view.shape === 'api-spend' && view.windows.length === 0 && view.credits.state === 'unreported' && (view.absence ?? '').includes('no OpenCode Go plan') && (view.absence ?? '').includes('console'))
  const goSaved = await storeZenApiKeyLogin(fixture.goKey, { env })
  check('a key with an OpenCode Go plan stores with its three windows in the receipt', goSaved.ok && goSaved.stored && goSaved.receipt.includes('OpenCode Go plan') && goSaved.receipt.includes('Go 5 hour 13%') && goSaved.receipt.includes('Go weekly 40%') && goSaved.receipt.includes('Go monthly 100% (limit reached)') && readStoredZenApiKey() === fixture.goKey)
  __resetZenUsageForTest()
  await refreshProviderUsage('zen', { force: true, reason: 'operator' })
  const goView = usageForProvider('zen')
  check('/usage paints the Go windows from the gateway with their reset stamps', goView.windows.length === 3 && goView.windows.map(window => window.label).join(' ') === 'Go 5 hour Go weekly Go monthly' && goView.windows.every(window => window.state === 'live' && window.resetsAtMs !== undefined && window.source === 'endpoint') && goView.windows[2]?.usedPct === 100)
  const observed = zenObservedGoUsage()
  const again = await refreshZenGoUsage()
  check('the usage read is TTL-bounded (a second read inside the floor serves the observation)', observed.plan === 'go' && again.usage?.observedAtMs === observed.usage?.observedAtMs)
  process.env.OPENCODE_API_KEY = 'sk-env-pin-zen-fixture-000000000000000000000000000000000000000000000000000'
  check('the env spelling wins over the store and is labelled as such', resolveZenApiKey()?.source === 'env' && resolveZenAccount()?.label === 'OPENCODE_API_KEY (env)')
  const groups = deriveFamilySlotGroups()
  const slots = groups.find(group => group.family.id === 'zen')?.slots ?? []
  check('account slots show honest env-over-stored precedence', slots.length === 2 && slots.some(slot => slot.envPinned && slot.active) && slots.some(slot => !slot.envPinned && !slot.active))
  check('identity and slot views never expose complete key values', !JSON.stringify(groups).includes(KEY) && !JSON.stringify(groups).includes(fixture.goKey) && !JSON.stringify(groups).includes(process.env.OPENCODE_API_KEY) && !providerIdentityLine('zen').text.includes(fixture.goKey))
  delete process.env.OPENCODE_API_KEY
  const removed = await executeSlotRemoval(slots.find(slot => slot.removal.route === 'zen-stored-key')!)
  check('slot removal clears the owning store', removed.mutated && !readStoredZenApiKey() && resolveZenAccount() === undefined)
  check('a signed-out family reads as not connected', usageForProvider('zen').sourceKind === 'none' && usageForProvider('zen').whyNot?.includes('/logins zen'))
  const network = (async () => { throw new Error(`fixture offline ${KEY}`) }) as typeof fetch
  const unverified = await storeZenApiKeyLogin(KEY, { env, fetchImpl: network })
  check('an unreachable usage endpoint stores an explicitly unverified key with a scrubbed receipt', unverified.stored && unverified.receipt.includes('UNVERIFIED') && !unverified.receipt.includes(KEY))
  console.log(`ZEN LOGIN GREEN (${count} checks; fixture only)`)
} finally {
  writeStoredZenApiKey(null)
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
