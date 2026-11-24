import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { strict as assert } from 'node:assert'
import { statSync, readFileSync } from 'node:fs'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of ['MODEL_API_KEY', 'META_API_KEY']) delete process.env[name]
const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
const { storeMetaApiKeyLogin } = await import('../../src/models/roads/meta/metaLogin.ts')
const { resolveMetaApiKey, resolveMetaAccount, metaApiBase } = await import('../../src/models/roads/meta/metaAccounts.ts')
const { readStoredMetaApiKey, writeStoredMetaApiKey, providerSecretsPathForDisplay, credentialEnvNames } = await import('../../src/models/sign-in/account-ledger/providerSecrets.ts')
const { readSignInLedger } = await import('../../src/models/sign-in/account-ledger/signInLedger.ts')
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS, PROVIDER_CREDENTIAL_VALUE_SHAPES } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/models/roads/accountSlots.ts')
const { providerIdentityLine } = await import('../../src/models/roads/providerIdentityLine.ts')
const key = 'LLM|123456789|fixture-not-a-real-key-abcdefgh'
const env = { MERCURY_META_API_BASE: 'http://127.0.0.1:1/v1' } as NodeJS.ProcessEnv
let count = 0
const check = (name: string, value: unknown, hint?: string): void => { assert.ok(value, hint ? `${name} (${hint})` : name); count++; console.log(`[PASS] ${name}`) }
const reply = (status: number): typeof fetch => (async (url, init) => {
  assert.equal(String(url), 'http://127.0.0.1:1/v1/models')
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`)
  assert.equal(init?.method, 'GET')
  return Response.json({ data: [{ id: 'muse-spark-1.3', created: 3, owned_by: 'meta' }] }, { status })
}) as typeof fetch
try {
  check('the documented base and both documented env spellings belong to Meta', metaApiBase({} as NodeJS.ProcessEnv) === 'https://api.meta.ai/v1' && ['MODEL_API_KEY', 'META_API_KEY'].every(name => ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) && credentialEnvNames().includes(name)), 'fix metaApiBase in src/models/roads/meta/metaAccounts.ts or the Meta env names in src/models/sign-in/credentials/credentialEnvSpellings.ts and credentialEnvNames in src/models/sign-in/account-ledger/providerSecrets.ts')
  check('Meta key values have their own redaction shape', PROVIDER_CREDENTIAL_VALUE_SHAPES.meta?.pattern.test(key), 'fix the meta entry of PROVIDER_CREDENTIAL_VALUE_SHAPES in src/models/sign-in/credentials/credentialEnvSpellings.ts so it matches the fixture key')
  const empty = await storeMetaApiKeyLogin(' ', { env })
  check('empty paste stores nothing', !empty.ok && !empty.stored, 'storeMetaApiKeyLogin in src/models/roads/meta/metaLogin.ts must refuse a blank paste without storing')
  for (const status of [401, 403]) {
    const rejected = await storeMetaApiKeyLogin(key, { env, fetchImpl: reply(status) })
    check(`${status} refuses storage and names the key dashboard`, !rejected.ok && !rejected.stored && !readStoredMetaApiKey() && rejected.receipt.includes('dev.meta.ai'), 'storeMetaApiKeyLogin in src/models/roads/meta/metaLogin.ts must not store on a 401 or 403 and its receipt must name dev.meta.ai')
  }
  const saved = await storeMetaApiKeyLogin(key, { env, fetchImpl: reply(200) })
  check('a listed key is stored with an explicit pay-as-you-go receipt, never its secret', saved.ok && saved.stored && saved.receipt.includes('1 Muse Spark model listed') && saved.receipt.includes('the active source') && saved.receipt.includes('pay-as-you-go') && !saved.receipt.includes(key) && readStoredMetaApiKey() === key, 'storeMetaApiKeyLogin in src/models/roads/meta/metaLogin.ts must store a listed key and word the receipt as the test expects without echoing the key')
  check('at-rest storage is auth-scoped and mode 600', providerSecretsPathForDisplay().startsWith(proofHome) && (process.platform === 'win32' || (statSync(providerSecretsPathForDisplay()).mode & 0o777) === 0o600), 'the secrets file path and mode come from src/models/sign-in/account-ledger/providerSecrets.ts')
  check('sign-in recency records the Meta key', readSignInLedger().meta?.kind === 'api-key', 'storeMetaApiKeyLogin must record the sign-in in src/models/sign-in/account-ledger/signInLedger.ts')
  check('account labels contain presence, never the secret', resolveMetaApiKey({})?.source === 'stored' && !JSON.stringify(resolveMetaAccount({} as NodeJS.ProcessEnv)).includes(key), 'fix resolveMetaApiKey and resolveMetaAccount in src/models/roads/meta/metaAccounts.ts')
  process.env.META_API_KEY = 'meta-fixture-code-env'
  check('Muse Code env spelling is an API-key alias, not a browser-session import', resolveMetaApiKey()?.key === process.env.META_API_KEY && resolveMetaAccount()?.label === 'META_API_KEY (env)', 'fix resolveMetaApiKey and resolveMetaAccount in src/models/roads/meta/metaAccounts.ts')
  process.env.MODEL_API_KEY = 'meta-fixture-api-env'
  check('Model API env spelling wins over the Muse Code spelling and the store', resolveMetaApiKey()?.key === process.env.MODEL_API_KEY && resolveMetaAccount()?.label === 'MODEL_API_KEY (env)', 'fix the env order in resolveMetaApiKey and resolveMetaAccount in src/models/roads/meta/metaAccounts.ts')
  const groups = deriveFamilySlotGroups()
  const slots = groups.find(group => group.family.id === 'meta')?.slots ?? []
  check('account slots show honest env-over-stored precedence', slots.length === 2 && slots.some(slot => slot.envPinned && slot.active) && slots.some(slot => !slot.envPinned && !slot.active), 'fix the meta slots in deriveFamilySlotGroups in src/models/roads/accountSlots.ts')
  check('identity and slot views never expose complete key values', !JSON.stringify(groups).includes(key) && !JSON.stringify(groups).includes(process.env.MODEL_API_KEY!) && !providerIdentityLine('meta').text.includes(key), 'a full key leaks from deriveFamilySlotGroups in src/models/roads/accountSlots.ts or providerIdentityLine in src/models/roads/providerIdentityLine.ts')
  delete process.env.MODEL_API_KEY
  delete process.env.META_API_KEY
  const removed = await executeSlotRemoval(slots.find(slot => slot.removal.route === 'meta-stored-key')!)
  check('slot removal clears the owning store', removed.mutated && !readStoredMetaApiKey(), 'executeSlotRemoval in src/models/roads/accountSlots.ts must clear the stored Meta key for the meta-stored-key route')
  const network = (async () => { throw new Error(`fixture offline ${key}`) }) as typeof fetch
  const unverified = await storeMetaApiKeyLogin(key, { env, fetchImpl: network })
  check('an unreachable endpoint stores an explicitly unverified key with a scrubbed receipt', unverified.stored && unverified.receipt.includes('UNVERIFIED') && !unverified.receipt.includes(key), 'storeMetaApiKeyLogin in src/models/roads/meta/metaLogin.ts must store the key as UNVERIFIED on a network error and scrub the key from the receipt')
  check('the key has its own at-rest slot', JSON.parse(readFileSync(providerSecretsPathForDisplay(), 'utf8')).metaApiKey === key, 'writeStoredMetaApiKey in src/models/sign-in/account-ledger/providerSecrets.ts must keep the key in the metaApiKey slot of the secrets file')
  console.log(`META LOGIN GREEN (${count} checks; fixture only)`)
} finally {
  writeStoredMetaApiKey(null)
  try {
    removeScratch(proofHome, { maxRetries: 4, retryDelayMs: 50 })
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
  }
}
