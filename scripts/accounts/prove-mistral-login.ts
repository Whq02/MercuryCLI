import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { strict as assert } from 'node:assert'
import { statSync, readFileSync } from 'node:fs'
import { mistralFixture, MISTRAL_FIXTURE_API_KEY, MISTRAL_FIXTURE_ADMIN_KEY } from '../providers/lib/mistral-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of ['MISTRAL_API_KEY', 'MISTRAL_ADMIN_API_KEY']) delete process.env[name]
const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
const { storeMistralApiKeyLogin, storeMistralAdminKeyLogin } = await import('../../src/models/roads/mistral/mistralLogin.ts')
const { resolveMistralApiKey, resolveMistralAccount, resolveMistralAdminApiKey, mistralApiBase } = await import('../../src/models/roads/mistral/mistralAccounts.ts')
const { readStoredMistralApiKey, writeStoredMistralApiKey, readStoredMistralAdminApiKey, writeStoredMistralAdminApiKey, providerSecretsPathForDisplay, credentialEnvNames } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const { readSignInLedger } = await import('../../src/models/sign-in/account-ledger/signInLedger.ts')
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS, PROVIDER_CREDENTIAL_VALUE_SHAPES } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/models/roads/accountSlots.ts')
const { providerIdentityLine } = await import('../../src/models/roads/providerIdentityLine.ts')
const fixture = mistralFixture()
const key = MISTRAL_FIXTURE_API_KEY
const env = { MERCURY_MISTRAL_API_BASE: fixture.base } as NodeJS.ProcessEnv
let count = 0
const check = (name: string, value: unknown, hint?: string): void => { assert.ok(value, hint ? `${name} (${hint})` : name); count++; console.log(`[PASS] ${name}`) }
try {
  check('the documented base and both env spellings belong to Mistral', mistralApiBase({} as NodeJS.ProcessEnv) === 'https://api.mistral.ai/v1' && ['MISTRAL_API_KEY', 'MISTRAL_ADMIN_API_KEY'].every(name => ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) && credentialEnvNames().includes(name)), 'fix mistralApiBase in src/models/roads/mistral/mistralAccounts.ts or the Mistral env names in src/models/sign-in/credentials/credentialEnvSpellings.ts and credentialEnvNames in src/models/sign-in/account-ledger/providerSecrets.ts')
  check('Mistral keys carry no distinctive prefix, so the assignment pass is their only redactor', PROVIDER_CREDENTIAL_VALUE_SHAPES.mistral === null, 'the mistral entry of PROVIDER_CREDENTIAL_VALUE_SHAPES in src/models/sign-in/credentials/credentialEnvSpellings.ts must stay null')
  const empty = await storeMistralApiKeyLogin(' ', { env })
  check('an empty paste stores nothing', !empty.ok && !empty.stored, 'storeMistralApiKeyLogin in src/models/roads/mistral/mistralLogin.ts must refuse a blank paste without storing')
  const rejected = await storeMistralApiKeyLogin('proof-key-mistral-wrong', { env })
  check('a refused key stores nothing and names the key page', !rejected.ok && !rejected.stored && !readStoredMistralApiKey() && rejected.receipt.includes('console.mistral.ai/api-keys') && rejected.receipt.includes('HTTP 401'), 'storeMistralApiKeyLogin in src/models/roads/mistral/mistralLogin.ts must not store a refused key and its receipt must name console.mistral.ai/api-keys and HTTP 401')
  const saved = await storeMistralApiKeyLogin(key, { env })
  check('a listed key is stored with the model count, the account and the plan words, never its secret', saved.ok && saved.stored && saved.receipt.includes('6 chat models listed') && saved.receipt.includes('fixture@example.invalid (Fixture org / Fixture workspace)') && saved.receipt.includes('included monthly usage') && !saved.receipt.includes(key) && readStoredMistralApiKey() === key, 'storeMistralApiKeyLogin in src/models/roads/mistral/mistralLogin.ts must store a listed key and word the receipt as the test expects without echoing the key')
  check('the key leg read the model list and the identity, nothing of the admin road', fixture.requests.some(request => request.path === '/v1/models') && fixture.requests.some(request => request.path === '/v1/users/me' && request.headers['x-api-key'] === key) && !fixture.requests.some(request => request.path.startsWith('/v1/admin/')), 'storeMistralApiKeyLogin in src/models/roads/mistral/mistralLogin.ts must read /v1/models and /v1/users/me with the x-api-key header and never call /v1/admin/')
  check('at-rest storage is auth-scoped and mode 600', providerSecretsPathForDisplay().startsWith(proofHome) && (process.platform === 'win32' || (statSync(providerSecretsPathForDisplay()).mode & 0o777) === 0o600), 'the secrets file path and mode come from src/models/sign-in/account-ledger/providerSecrets.ts')
  check('sign-in recency records the Mistral key', readSignInLedger().mistral?.kind === 'api-key', 'storeMistralApiKeyLogin must record the sign-in in src/models/sign-in/account-ledger/signInLedger.ts')
  check('account labels contain presence, never the secret', resolveMistralApiKey({})?.source === 'stored' && !JSON.stringify(resolveMistralAccount({} as NodeJS.ProcessEnv)).includes(key), 'fix resolveMistralApiKey and resolveMistralAccount in src/models/roads/mistral/mistralAccounts.ts')
  process.env.MISTRAL_API_KEY = 'proof-key-mistral-env'
  check('the env spelling wins over the store', resolveMistralApiKey()?.key === process.env.MISTRAL_API_KEY && resolveMistralAccount()?.label === 'MISTRAL_API_KEY (env)', 'fix the env order in resolveMistralApiKey and resolveMistralAccount in src/models/roads/mistral/mistralAccounts.ts')
  const groups = deriveFamilySlotGroups()
  const slots = groups.find(group => group.family.id === 'mistral')?.slots ?? []
  check('account slots show honest env-over-stored precedence', slots.length === 2 && slots.some(slot => slot.envPinned && slot.active) && slots.some(slot => !slot.envPinned && !slot.active), 'fix the mistral slots in deriveFamilySlotGroups in src/models/roads/accountSlots.ts')
  check('identity and slot views never expose complete key values', !JSON.stringify(groups).includes(key) && !JSON.stringify(groups).includes(process.env.MISTRAL_API_KEY!) && !providerIdentityLine('mistral').text.includes(key), 'a full key leaks from deriveFamilySlotGroups in src/models/roads/accountSlots.ts or providerIdentityLine in src/models/roads/providerIdentityLine.ts')
  delete process.env.MISTRAL_API_KEY
  const removed = await executeSlotRemoval(slots.find(slot => slot.removal.route === 'mistral-stored-key')!)
  check('slot removal clears the owning store', removed.mutated && !readStoredMistralApiKey(), 'executeSlotRemoval in src/models/roads/accountSlots.ts must clear the stored Mistral key for the mistral-stored-key route')
  const network = (async () => { throw new Error(`fixture offline ${key}`) }) as typeof fetch
  const unverified = await storeMistralApiKeyLogin(key, { env, fetchImpl: network })
  check('an unreachable endpoint stores an explicitly unverified key with a scrubbed receipt', unverified.stored && unverified.receipt.includes('UNVERIFIED') && !unverified.receipt.includes(key), 'storeMistralApiKeyLogin in src/models/roads/mistral/mistralLogin.ts must store the key as UNVERIFIED on a network error and scrub the key from the receipt')
  check('the key has its own at-rest slot', JSON.parse(readFileSync(providerSecretsPathForDisplay(), 'utf8')).mistralApiKey === key, 'writeStoredMistralApiKey in src/models/sign-in/account-ledger/providerSecrets.ts must keep the key in the mistralApiKey slot of the secrets file')
  const adminEmpty = await storeMistralAdminKeyLogin('', { env })
  check('an empty admin paste stores nothing', !adminEmpty.ok && !adminEmpty.stored, 'storeMistralAdminKeyLogin in src/models/roads/mistral/mistralLogin.ts must refuse a blank paste without storing')
  const adminAsInference = await storeMistralAdminKeyLogin(key, { env })
  check('an inference key pasted as the admin key is refused by the admin road and not stored', !adminAsInference.stored && adminAsInference.receipt.includes('refused the Admin API key (HTTP 401)') && !readStoredMistralAdminApiKey(), 'storeMistralAdminKeyLogin in src/models/roads/mistral/mistralLogin.ts must not store a key the admin road refuses and its receipt must say refused the Admin API key (HTTP 401)')
  const admin = await storeMistralAdminKeyLogin(MISTRAL_FIXTURE_ADMIN_KEY, { env })
  check('a working admin key is stored with the month-to-date meter in its receipt', admin.ok && admin.stored && admin.receipt.includes('EUR 45.00 of 500.00 used this month') && readStoredMistralAdminApiKey() === MISTRAL_FIXTURE_ADMIN_KEY && resolveMistralAdminApiKey()?.source === 'stored', 'storeMistralAdminKeyLogin in src/models/roads/mistral/mistralLogin.ts must store a working admin key and put the month-to-date meter in the receipt; resolveMistralAdminApiKey is in mistralAccounts.ts')
  fixture.state.monthlyLimitReached = true
  const reached = await storeMistralAdminKeyLogin(MISTRAL_FIXTURE_ADMIN_KEY, { env })
  check('a reached monthly limit is said in the receipt, never hidden', reached.receipt.includes('LIMIT REACHED'), 'storeMistralAdminKeyLogin in src/models/roads/mistral/mistralLogin.ts must say LIMIT REACHED in the receipt when the monthly limit is reached')
  fixture.state.monthlyLimitReached = false
  const adminSlots = deriveFamilySlotGroups().find(group => group.family.id === 'mistral')?.slots ?? []
  const adminRemoved = await executeSlotRemoval(adminSlots.find(slot => slot.removal.route === 'mistral-admin-key')!)
  check('removing the admin slot clears only the admin key', adminRemoved.mutated && !readStoredMistralAdminApiKey() && readStoredMistralApiKey() === key, 'executeSlotRemoval in src/models/roads/accountSlots.ts must clear only the admin key for the mistral-admin-key route')
  console.log(`MISTRAL LOGIN GREEN (${count} checks; fixture only)`)
} finally {
  writeStoredMistralApiKey(null)
  writeStoredMistralAdminApiKey(null)
  fixture.stop()
  try {
    removeScratch(proofHome, { maxRetries: 4, retryDelayMs: 50 })
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
  }
}
