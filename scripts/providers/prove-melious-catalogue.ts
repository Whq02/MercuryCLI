import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import fixture from './fixtures/melious-documented-2026-10-24.json'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of [...ALL_PROVIDER_CREDENTIAL_ENV_VARS, 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_MELIOUS_API_BASE = 'http://127.0.0.1:1/v1'
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const catalogue = await import('../../src/services/providers/melious/meliousCatalogue.ts')
const { resolveMeliousApiKey } = await import('../../src/services/providers/melious/meliousAccounts.ts')
const { storeMeliousApiKeyLogin } = await import('../../src/services/providers/melious/meliousLogin.ts')
const { readStoredMeliousApiKey, writeStoredMeliousApiKey } = await import('../../src/services/providers/providerSecrets.ts')
const { loginFamilyRows, KEY_PAGES } = await import('../../src/components/loginFamilyRows.ts')
const { resolveModelPricing, getModelPricingString } = await import('../../src/utils/modelCost.ts')
const { modelSupportsThinking, effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { getContextWindowForModel } = await import('../../src/utils/context.ts')
const { keyLanePins, keyLaneListState, parseKeyConnectValue } = await import('../../src/utils/model/modelOptions.ts')
const { buildProviderSnapshot } = await import('../../src/services/providers/modelRegistry.ts')
const { meliousRecordHeaders, meliousRecordChunk, meliousObservedUsage } = await import('../../src/services/providers/melious/meliousUsageState.ts')
const { usageForProvider } = await import('../../src/services/providers/providerUsage.ts')
let count = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); count++; console.log(`[PASS] ${name}`) }
let fetches = 0
let status = 200
let body: unknown = fixture.models
const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
  fetches++
  assert.equal(String(url), `${process.env.MERCURY_MELIOUS_API_BASE}/models?include_meta=true`)
  assert.ok(new Headers(init?.headers).get('authorization')?.startsWith('Bearer proof-key-'))
  return Response.json(status === 200 ? body : fixture.modelError, { status })
}) as typeof fetch
try {
  check('login row uses the API-key family grammar', loginFamilyRows({ engineLegs: true }).some(row => row.value === 'melious' && row.label === 'Melious AI — API key'))
  check('the key page and connect action name the same family', KEY_PAGES.melious === 'melious.ai/account/api/keys' && parseKeyConnectValue('__mercury_connect__:melious') === 'melious')
  await catalogue.refreshMeliousCatalogue({ fetchImpl })
  check('no key means no catalogue traffic or invented fallback models', fetches === 0 && catalogue.meliousCatalogueRows().rows.length === 0)
  const login = await storeMeliousApiKeyLogin('proof-key-melious-stored', { fetchImpl })
  check('key paste stores through the shared secret store', login.stored && readStoredMeliousApiKey() === 'proof-key-melious-stored')
  check('stored key remains mode 600', (statSync(join(proofHome, '.provider-secrets.json')).mode & 0o777) === 0o600)
  check('key value never appears in its receipt', !login.receipt.includes('proof-key-'))
  check('stored account resolves its source', resolveMeliousApiKey()?.source === 'stored')
  check('live catalogue offers balanced plus three routing variants', catalogue.meliousCatalogueRows().rows.map(row => row.id).join(',') === ['melious/glm-5.3', 'melious/glm-5.3:speed', 'melious/glm-5.3:price', 'melious/glm-5.3:eco'].join(','))
  check('catalogue joins provider registry and model picker', buildProviderSnapshot().listAvailable().some(row => row.ref.provider === 'melious') && keyLanePins('melious').length === 4 && keyLaneListState('melious').kind === 'live')
  check('variant context comes from this catalogue, not the native GLM pin', getContextWindowForModel('melious/glm-5.3:eco') === 1000000)
  check('reasoning and max effort come from the documented control', modelSupportsThinking('melious/glm-5.3') && effortVocabularyFor('melious/glm-5.3').kind === 'provider' && catalogue.meliousEffortVocabulary('melious/glm-5.3').includes('max'))
  check('catalogue keeps EUR rates and never prices them as dollars', catalogue.meliousListedModel('melious/glm-5.3')?.pricing?.cacheReadPerMtokEUR === 0.2 && resolveModelPricing('melious/glm-5.3').basis === 'unpriced' && getModelPricingString('melious/glm-5.3:eco') === '€1/€3 per Mtok')
  const beforeTtl = fetches
  await catalogue.refreshMeliousCatalogue({ fetchImpl })
  check('the five-minute catalogue cache avoids another read', fetches === beforeTtl)
  process.env.MELIOUS_API_KEY = 'proof-key-melious-env'
  check('environment key wins and cannot borrow the stored key catalogue', resolveMeliousApiKey()?.source === 'env' && catalogue.getCachedMeliousCatalogue() === null)
  body = { data: [...fixture.models.data, { id: 'embedding-fixture', _meta: { type: 'embeddings' } }, { id: 'no-meta-fixture' }] }
  await Promise.all([catalogue.refreshMeliousCatalogue({ force: true, fetchImpl }), catalogue.refreshMeliousCatalogue({ force: true, fetchImpl })])
  check('single-flight fetch filters non-chat and untyped rows', fetches === beforeTtl + 1 && catalogue.getCachedMeliousCatalogue()?.models.length === 1 && catalogue.getCachedMeliousCatalogue()?.otherLines === 2)
  const base = process.env.MERCURY_MELIOUS_API_BASE!
  meliousRecordHeaders(new Headers(fixture.rateHeaders), process.env.MELIOUS_API_KEY!, base)
  meliousRecordChunk(fixture.usageChunk, process.env.MELIOUS_API_KEY!, base)
  check('documented rate headers populate the usage meter', meliousObservedUsage()?.limit === 120 && meliousObservedUsage()?.remaining === 119 && usageForProvider('melious').windows.length === 1)
  check('EUR billing strings retain precision and payment source', meliousObservedUsage()?.billing?.credits === '0.000262' && usageForProvider('melious').figures?.some(row => row.value.includes('EUR 0.000262')))
  check('environment impact is read but never shown in usage', meliousObservedUsage()?.environmentImpact?.location === 'FI' && !JSON.stringify(usageForProvider('melious')).includes('carbon'))
  meliousRecordHeaders(new Headers(), process.env.MELIOUS_API_KEY!, base)
  check('a new response without usage cannot inherit the preceding charge', meliousObservedUsage()?.billing === undefined && meliousObservedUsage()?.environmentImpact === undefined && meliousObservedUsage()?.remaining === 119)
  meliousRecordChunk(fixture.usageChunk, process.env.MELIOUS_API_KEY!, base)
  const { environment_impact: _impact, billing_cost: _billing, ...withoutBilling } = fixture.usageChunk
  meliousRecordChunk(withoutBilling, process.env.MELIOUS_API_KEY!, base)
  check('missing billing is absent rather than zero or a previous request charge', meliousObservedUsage()?.billing === undefined && meliousObservedUsage()?.environmentImpact === undefined)
  process.env.MERCURY_MELIOUS_API_BASE = 'http://127.0.0.1:2/v1'
  check('endpoint changes isolate catalogue and usage observations', catalogue.getCachedMeliousCatalogue() === null && meliousObservedUsage() === null)
  process.env.MERCURY_MELIOUS_API_BASE = base
  status = 401
  const refused = await storeMeliousApiKeyLogin('proof-key-melious-refused', { fetchImpl })
  check('refused key paste does not overwrite the stored key', !refused.stored && readStoredMeliousApiKey() === 'proof-key-melious-stored')
  status = 403
  const scoped = await storeMeliousApiKeyLogin('proof-key-melious-scope', { fetchImpl })
  check('missing catalogue scope points to both required scopes', !scoped.stored && scoped.receipt.includes('inference.models and inference.chat'))
  status = 200; body = { data: [] }
  await catalogue.refreshMeliousCatalogue({ force: true, fetchImpl })
  check('a successful empty list stays empty, without invented fallback pins', catalogue.meliousCatalogueRows().rows.length === 0 && catalogue.meliousCatalogueRows().source.kind === 'live')
  body = fixture.models
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const beforeOff = fetches
  await catalogue.refreshMeliousCatalogue({ force: true, fetchImpl })
  check('nonessential-traffic switch prevents catalogue fetches', fetches === beforeOff)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  delete process.env.MELIOUS_API_KEY
  writeStoredMeliousApiKey(null)
  check('stored key removal leaves no credential', resolveMeliousApiKey() === undefined)
  console.log(`MELIOUS CATALOGUE GREEN (${count} checks; documented fixtures only)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
