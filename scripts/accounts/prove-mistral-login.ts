import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync, statSync, readFileSync } from 'node:fs'
import { mistralFixture, MISTRAL_FIXTURE_API_KEY, MISTRAL_FIXTURE_ADMIN_KEY } from '../providers/lib/mistral-fixture.ts'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of ['MISTRAL_API_KEY', 'MISTRAL_ADMIN_API_KEY']) delete process.env[name]
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { storeMistralApiKeyLogin, storeMistralAdminKeyLogin } = await import('../../src/services/providers/mistral/mistralLogin.ts')
const { resolveMistralApiKey, resolveMistralAccount, resolveMistralAdminApiKey, mistralApiBase } = await import('../../src/services/providers/mistral/mistralAccounts.ts')
const { readStoredMistralApiKey, writeStoredMistralApiKey, readStoredMistralAdminApiKey, writeStoredMistralAdminApiKey, providerSecretsPathForDisplay, credentialEnvNames } = await import('../../src/utils/router/providerSecrets.ts')
const { readSignInLedger } = await import('../../src/utils/accounts/signInLedger.ts')
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS, PROVIDER_CREDENTIAL_VALUE_SHAPES } = await import('../../src/services/providers/credentialEnvSpellings.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
const { providerIdentityLine } = await import('../../src/services/providers/providerIdentityLine.ts')
const fixture = mistralFixture()
const key = MISTRAL_FIXTURE_API_KEY
const env = { MERCURY_MISTRAL_API_BASE: fixture.base } as NodeJS.ProcessEnv
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
try {
  check('the documented base and both env spellings belong to Mistral', mistralApiBase({} as NodeJS.ProcessEnv) === 'https://api.mistral.ai/v1' && ['MISTRAL_API_KEY', 'MISTRAL_ADMIN_API_KEY'].every(name => ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) && credentialEnvNames().includes(name)))
  check('Mistral keys carry no distinctive prefix, so the assignment pass is their only redactor', PROVIDER_CREDENTIAL_VALUE_SHAPES.mistral === null)
  const empty = await storeMistralApiKeyLogin(' ', { env })
  check('an empty paste stores nothing', !empty.ok && !empty.stored)
  const rejected = await storeMistralApiKeyLogin('proof-key-mistral-wrong', { env })
  check('a refused key stores nothing and names the key page', !rejected.ok && !rejected.stored && !readStoredMistralApiKey() && rejected.receipt.includes('console.mistral.ai/api-keys') && rejected.receipt.includes('HTTP 401'))
  const saved = await storeMistralApiKeyLogin(key, { env })
  check('a listed key is stored with the model count, the account and the plan words, never its secret', saved.ok && saved.stored && saved.receipt.includes('5 chat models listed') && saved.receipt.includes('fixture@example.invalid (Fixture org / Fixture workspace)') && saved.receipt.includes('included monthly usage') && !saved.receipt.includes(key) && readStoredMistralApiKey() === key)
  check('the key leg read the model list and the identity, nothing of the admin road', fixture.requests.some(request => request.path === '/v1/models') && fixture.requests.some(request => request.path === '/v1/users/me' && request.headers['x-api-key'] === key) && !fixture.requests.some(request => request.path.startsWith('/v1/admin/')))
  check('at-rest storage is auth-scoped and mode 600', providerSecretsPathForDisplay().startsWith(proofHome) && (statSync(providerSecretsPathForDisplay()).mode & 0o777) === 0o600)
  check('sign-in recency records the Mistral key', readSignInLedger().mistral?.kind === 'api-key')
  check('account labels contain presence, never the secret', resolveMistralApiKey({})?.source === 'stored' && !JSON.stringify(resolveMistralAccount({} as NodeJS.ProcessEnv)).includes(key))
  process.env.MISTRAL_API_KEY = 'proof-key-mistral-env'
  check('the env spelling wins over the store', resolveMistralApiKey()?.key === process.env.MISTRAL_API_KEY && resolveMistralAccount()?.label === 'MISTRAL_API_KEY (env)')
  const groups = deriveFamilySlotGroups()
  const slots = groups.find(group => group.family.id === 'mistral')?.slots ?? []
  check('account slots show honest env-over-stored precedence', slots.length === 2 && slots.some(slot => slot.envPinned && slot.active) && slots.some(slot => !slot.envPinned && !slot.active))
  check('identity and slot views never expose complete key values', !JSON.stringify(groups).includes(key) && !JSON.stringify(groups).includes(process.env.MISTRAL_API_KEY!) && !providerIdentityLine('mistral').text.includes(key))
  delete process.env.MISTRAL_API_KEY
  const removed = await executeSlotRemoval(slots.find(slot => slot.removal.route === 'mistral-stored-key')!)
  check('slot removal clears the owning store', removed.mutated && !readStoredMistralApiKey())
  const network = (async () => { throw new Error(`fixture offline ${key}`) }) as typeof fetch
  const unverified = await storeMistralApiKeyLogin(key, { env, fetchImpl: network })
  check('an unreachable endpoint stores an explicitly unverified key with a scrubbed receipt', unverified.stored && unverified.receipt.includes('UNVERIFIED') && !unverified.receipt.includes(key))
  check('the key has its own at-rest slot', JSON.parse(readFileSync(providerSecretsPathForDisplay(), 'utf8')).mistralApiKey === key)
  const adminEmpty = await storeMistralAdminKeyLogin('', { env })
  check('an empty admin paste stores nothing', !adminEmpty.ok && !adminEmpty.stored)
  const adminAsInference = await storeMistralAdminKeyLogin(key, { env })
  check('an inference key pasted as the admin key is refused by the admin road and not stored', !adminAsInference.stored && adminAsInference.receipt.includes('refused the Admin API key (HTTP 401)') && !readStoredMistralAdminApiKey())
  const admin = await storeMistralAdminKeyLogin(MISTRAL_FIXTURE_ADMIN_KEY, { env })
  check('a working admin key is stored with the month-to-date meter in its receipt', admin.ok && admin.stored && admin.receipt.includes('EUR 45.00 of 500.00 used this month') && readStoredMistralAdminApiKey() === MISTRAL_FIXTURE_ADMIN_KEY && resolveMistralAdminApiKey()?.source === 'stored')
  fixture.state.monthlyLimitReached = true
  const reached = await storeMistralAdminKeyLogin(MISTRAL_FIXTURE_ADMIN_KEY, { env })
  check('a reached monthly limit is said in the receipt, never hidden', reached.receipt.includes('LIMIT REACHED'))
  fixture.state.monthlyLimitReached = false
  const adminSlots = deriveFamilySlotGroups().find(group => group.family.id === 'mistral')?.slots ?? []
  const adminRemoved = await executeSlotRemoval(adminSlots.find(slot => slot.removal.route === 'mistral-admin-key')!)
  check('removing the admin slot clears only the admin key', adminRemoved.mutated && !readStoredMistralAdminApiKey() && readStoredMistralApiKey() === key)
  console.log(`MISTRAL LOGIN GREEN (${count} checks; fixture only)`)
} finally {
  writeStoredMistralApiKey(null)
  writeStoredMistralAdminApiKey(null)
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
