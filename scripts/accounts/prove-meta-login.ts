import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync, statSync, readFileSync } from 'node:fs'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
for (const name of ['MODEL_API_KEY', 'META_API_KEY']) delete process.env[name]
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { storeMetaApiKeyLogin } = await import('../../src/services/providers/meta/metaLogin.ts')
const { resolveMetaApiKey, resolveMetaAccount, metaApiBase } = await import('../../src/services/providers/meta/metaAccounts.ts')
const { readStoredMetaApiKey, writeStoredMetaApiKey, providerSecretsPathForDisplay, credentialEnvNames } = await import('../../src/utils/router/providerSecrets.ts')
const { readSignInLedger } = await import('../../src/utils/accounts/signInLedger.ts')
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS, PROVIDER_CREDENTIAL_VALUE_SHAPES } = await import('../../src/services/providers/credentialEnvSpellings.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
const { providerIdentityLine } = await import('../../src/services/providers/providerIdentityLine.ts')
const { metaObservedBalance } = await import('../../src/services/providers/meta/metaUsageState.ts')
const key = 'LLM|123456789|fixture-not-a-real-key-abcdefgh'
const env = { MERCURY_META_API_BASE: 'http://127.0.0.1:1/v1' } as NodeJS.ProcessEnv
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
const reply = (status: number): typeof fetch => (async (url, init) => {
  assert.equal(String(url), 'http://127.0.0.1:1/v1/models')
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`)
  assert.equal(init?.method, 'GET')
  return Response.json({ data: [{ id: 'muse-spark-1.3', created: 3, owned_by: 'meta' }] }, { status })
}) as typeof fetch
try {
  check('the documented base and both documented env spellings belong to Meta', metaApiBase({} as NodeJS.ProcessEnv) === 'https://api.meta.ai/v1' && ['MODEL_API_KEY', 'META_API_KEY'].every(name => ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes(name) && credentialEnvNames().includes(name)))
  check('Meta key values have their own redaction shape', PROVIDER_CREDENTIAL_VALUE_SHAPES.meta?.pattern.test(key))
  const empty = await storeMetaApiKeyLogin(' ', { env })
  check('empty paste stores nothing', !empty.ok && !empty.stored)
  for (const status of [401, 403]) {
    const rejected = await storeMetaApiKeyLogin(key, { env, fetchImpl: reply(status) })
    check(`${status} refuses storage and names the key dashboard`, !rejected.ok && !rejected.stored && !readStoredMetaApiKey() && rejected.receipt.includes('dev.meta.ai'))
  }
  const saved = await storeMetaApiKeyLogin(key, { env, fetchImpl: reply(200) })
  check('a listed key is stored with an explicit pay-as-you-go receipt, never its secret', saved.ok && saved.stored && saved.receipt.includes('1 Muse Spark model listed') && saved.receipt.includes('Muse Code only') && !saved.receipt.includes(key) && readStoredMetaApiKey() === key)
  check('at-rest storage is auth-scoped and mode 600', providerSecretsPathForDisplay().startsWith(proofHome) && (statSync(providerSecretsPathForDisplay()).mode & 0o777) === 0o600)
  check('sign-in recency records the Meta key', readSignInLedger().meta?.kind === 'api-key')
  check('account labels contain presence, never the secret', resolveMetaApiKey({})?.source === 'stored' && !JSON.stringify(resolveMetaAccount({} as NodeJS.ProcessEnv)).includes(key))
  process.env.META_API_KEY = 'meta-fixture-code-env'
  check('Muse Code env spelling is an API-key alias, not a browser-session import', resolveMetaApiKey()?.key === process.env.META_API_KEY && resolveMetaAccount()?.label === 'META_API_KEY (env)')
  process.env.MODEL_API_KEY = 'meta-fixture-api-env'
  check('Model API env spelling wins over the Muse Code spelling and the store', resolveMetaApiKey()?.key === process.env.MODEL_API_KEY && resolveMetaAccount()?.label === 'MODEL_API_KEY (env)')
  const groups = deriveFamilySlotGroups()
  const slots = groups.find(group => group.family.id === 'meta')?.slots ?? []
  check('account slots show honest env-over-stored precedence', slots.length === 2 && slots.some(slot => slot.envPinned && slot.active) && slots.some(slot => !slot.envPinned && !slot.active))
  check('identity and slot views never expose complete key values', !JSON.stringify(groups).includes(key) && !JSON.stringify(groups).includes(process.env.MODEL_API_KEY!) && !providerIdentityLine('meta').text.includes(key))
  delete process.env.MODEL_API_KEY
  delete process.env.META_API_KEY
  const removed = await executeSlotRemoval(slots.find(slot => slot.removal.route === 'meta-stored-key')!)
  check('slot removal clears the owning store', removed.mutated && !readStoredMetaApiKey())
  const network = (async () => { throw new Error(`fixture offline ${key}`) }) as typeof fetch
  const unverified = await storeMetaApiKeyLogin(key, { env, fetchImpl: network })
  check('an unreachable endpoint stores an explicitly unverified key with a scrubbed receipt', unverified.stored && unverified.receipt.includes('UNVERIFIED') && !unverified.receipt.includes(key))
  check('no account balance or subscription allowance is invented', metaObservedBalance() === null)
  check('the key has its own at-rest slot', JSON.parse(readFileSync(providerSecretsPathForDisplay(), 'utf8')).metaApiKey === key)
  console.log(`META LOGIN GREEN (${count} checks; fixture only)`)
} finally {
  writeStoredMetaApiKey(null)
  rmSync(proofHome, { recursive: true, force: true })
}
