#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync, statSync, readFileSync } from 'node:fs'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.XAI_API_KEY
delete process.env.XAI_MANAGEMENT_API_KEY
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { storeXaiApiKeyLogin, storeXaiManagementKeyLogin } = await import('../../src/services/providers/xai/xaiLogin.ts')
const { resolveXaiApiKey, resolveXaiAccount, xaiApiBase } = await import('../../src/services/providers/xai/xaiAccounts.ts')
const { readStoredXaiApiKey, writeStoredXaiApiKey, readStoredXaiManagementApiKey, writeStoredXaiManagementApiKey, providerSecretsPathForDisplay, credentialEnvNames } = await import('../../src/utils/router/providerSecrets.ts')
const { readSignInLedger } = await import('../../src/utils/accounts/signInLedger.ts')
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS, PROVIDER_CREDENTIAL_VALUE_SHAPES } = await import('../../src/services/providers/credentialEnvSpellings.ts')
const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
const { providerIdentityLine } = await import('../../src/services/providers/providerIdentityLine.ts')
const usage = await import('../../src/services/providers/xai/xaiUsageState.ts')
const key = 'xai-fixture-key-not-real-12345678'
const env = { MERCURY_XAI_API_BASE: 'http://127.0.0.1:1/v1' } as NodeJS.ProcessEnv
let checks = 0
const check = (name: string, value: unknown): void => { assert.ok(value, name); checks++; console.log(`[PASS] ${name}`) }
const reply = (status: number, data: unknown = { data: [{ id: 'grok-4.7' }] }): typeof fetch => (async (url, init) => {
  assert.equal(String(url), 'http://127.0.0.1:1/v1/models')
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`)
  assert.equal(init?.method, 'GET')
  return Response.json(data, { status })
}) as typeof fetch
try {
  check('documented base and key spelling', xaiApiBase({} as NodeJS.ProcessEnv) === 'https://api.x.ai/v1' && ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes('XAI_API_KEY') && credentialEnvNames().includes('XAI_API_KEY'))
  check('xAI key value has its own redaction shape', PROVIDER_CREDENTIAL_VALUE_SHAPES.xai?.pattern.test(key))
  const empty = await storeXaiApiKeyLogin(' ', { env })
  check('empty paste is refused without storing', !empty.ok && !empty.stored)
  const rejected = await storeXaiApiKeyLogin(key, { env, fetchImpl: reply(401) })
  check('401 refuses storage and names the real key door', !rejected.ok && !rejected.stored && readStoredXaiApiKey() === undefined && rejected.receipt.includes('console.x.ai'))
  const forbidden = await storeXaiApiKeyLogin(key, { env, fetchImpl: reply(403) })
  check('403 refuses storage without inventing a balance', !forbidden.stored && forbidden.receipt.includes('permissions'))
  const saved = await storeXaiApiKeyLogin(key, { env, fetchImpl: reply(200) })
  check('a listed key lands auth-scoped with no secret in its receipt', saved.ok && saved.stored && !saved.receipt.includes(key) && readStoredXaiApiKey() === key && saved.receipt.includes('1 chat model listed'))
  check('the stored key file is mode 600 and inside the proof home', providerSecretsPathForDisplay().startsWith(proofHome) && (statSync(providerSecretsPathForDisplay()).mode & 0o777) === 0o600)
  check('sign-in recency records the xAI key', readSignInLedger().xai?.kind === 'api-key')
  check('the account view has presence, never the secret', resolveXaiApiKey({})?.source === 'stored' && !JSON.stringify(resolveXaiAccount({} as NodeJS.ProcessEnv)).includes(key))
  process.env.XAI_API_KEY = 'xai-fixture-env-not-real-abcdefgh'
  check('environment key wins over the stored key', resolveXaiApiKey()?.source === 'env' && resolveXaiApiKey()?.key === process.env.XAI_API_KEY)
  const groups = deriveFamilySlotGroups()
  const slots = groups.find(group => group.family.id === 'xai')?.slots ?? []
  check('account slots show stored and env keys with honest precedence', slots.length === 2 && slots.some(slot => slot.envPinned && slot.active) && slots.some(slot => !slot.envPinned && !slot.active))
  check('identity line uses the masked key tail, never the key', providerIdentityLine('xai').text.includes('efgh') && !JSON.stringify(groups).includes(key) && !JSON.stringify(groups).includes(process.env.XAI_API_KEY!))
  delete process.env.XAI_API_KEY
  const removal = slots.find(slot => slot.removal.route === 'xai-stored-key')!
  const removed = await executeSlotRemoval(removal)
  check('slot removal uses the xAI store', removed.mutated && readStoredXaiApiKey() === undefined)
  const network = (async () => { throw new Error(`fixture unreachable ${key}`) }) as typeof fetch
  const unverified = await storeXaiApiKeyLogin(key, { env, fetchImpl: network })
  check('unreachable endpoint stores unverified with a scrubbed receipt', unverified.stored && unverified.receipt.includes('UNVERIFIED') && !unverified.receipt.includes(key))
  let requests = 0
  const forbiddenFetch = (async () => { requests++; throw new Error('no management key') }) as typeof fetch
  await usage.refreshXaiUsage({ fetchImpl: forbiddenFetch })
  check('API key alone asks no management endpoint and has no reader error', requests === 0 && usage.xaiObservedUsage().usage === null && usage.xaiObservedUsage().failure === null)
  const { xaiUsageFixture, XAI_FIXTURE_NOW, XAI_FIXTURE_API_KEY, XAI_FIXTURE_MANAGEMENT_KEY } = await import('../providers/lib/xai-usage-fixture.ts')
  const fixture = xaiUsageFixture()
  try {
    const io = { env: fixture.env, now: () => XAI_FIXTURE_NOW }
    const savedLedger = JSON.stringify(readSignInLedger())
    fixture.state.status = 403
    const refused = await storeXaiManagementKeyLogin(XAI_FIXTURE_MANAGEMENT_KEY, io)
    check('a refused management key is named and not stored; inference key stays', !refused.stored && refused.receipt.includes('refused the management key') && !readStoredXaiManagementApiKey() && readStoredXaiApiKey() === key)
    fixture.state.status = 200
    const managed = await storeXaiManagementKeyLogin(XAI_FIXTURE_MANAGEMENT_KEY, io)
    check('management key lands beside the API key without leaking or moving the model sign-in order', managed.stored && !managed.receipt.includes(XAI_FIXTURE_MANAGEMENT_KEY) && !managed.receipt.includes(XAI_FIXTURE_API_KEY) && readStoredXaiManagementApiKey() === XAI_FIXTURE_MANAGEMENT_KEY && JSON.stringify(readSignInLedger()) === savedLedger)
    check('management key is registered in both credential scrub lists', ALL_PROVIDER_CREDENTIAL_ENV_VARS.includes('XAI_MANAGEMENT_API_KEY') && credentialEnvNames().includes('XAI_MANAGEMENT_API_KEY'))
    const { resolveXaiManagementApiKey } = await import('../../src/services/providers/xai/xaiAccounts.ts')
    check('management environment pin wins independently', resolveXaiManagementApiKey({ XAI_MANAGEMENT_API_KEY: 'env-management-fixture' })?.key === 'env-management-fixture' && resolveXaiApiKey({})?.key === key)
    const ownSlots = deriveFamilySlotGroups().find(group => group.family.id === 'xai')!.slots
    const managementSlot = ownSlots.find(slot => slot.removal.route === 'xai-management-key')!
    check('management has an independent usage-only removal slot, never an active inference slot', managementSlot && !managementSlot.active && managementSlot.stateNote?.includes('usage only') && !JSON.stringify(ownSlots).includes(XAI_FIXTURE_MANAGEMENT_KEY))
    executeSlotRemoval(managementSlot)
    check('management-key removal keeps inference signed in', !readStoredXaiManagementApiKey() && readStoredXaiApiKey() === key)
    const unreachable = await storeXaiManagementKeyLogin(XAI_FIXTURE_MANAGEMENT_KEY, { ...io, fetchImpl: network })
    check('unreachable management check stores unverified without leaking either key', unreachable.stored && unreachable.receipt.includes('UNVERIFIED') && !unreachable.receipt.includes(key) && !unreachable.receipt.includes(XAI_FIXTURE_MANAGEMENT_KEY))
    const face = await import('../../src/components/BootLoginsScreen.tsx')
    const pane = face.keyPromptPaneLines('xai-management', null, 0, false).join(' ')
    check('the optional face key step names the console settings and leaves an explicit skip road', pane.includes('settings page') && pane.includes('usage meter') && pane.includes('API key stays'))
    check('face and modal call the same management-key driver', readFileSync(new URL('../../src/components/BootLoginsScreen.tsx', import.meta.url), 'utf8').includes('storeXaiManagementKeyLogin(value)') && readFileSync(new URL('../../src/components/XaiConnect.tsx', import.meta.url), 'utf8').includes('storeXaiManagementKeyLogin(key)'))
  } finally { fixture.stop(); writeStoredXaiManagementApiKey(null) }
  check('at-rest store contains the key only under its own slot', JSON.parse(readFileSync(providerSecretsPathForDisplay(), 'utf8')).xaiApiKey === key)
  console.log(`XAI LOGIN GREEN (${checks} checks; fixture only)`)
} finally { writeStoredXaiApiKey(null); rmSync(proofHome, { recursive: true, force: true }) }
