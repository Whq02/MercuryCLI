#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync, statSync, readFileSync } from 'node:fs'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.XAI_API_KEY
delete process.env.XAI_MANAGEMENT_API_KEY
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { storeXaiApiKeyLogin, storeXaiManagementKeyLogin, runXaiDeviceLogin } = await import('../../src/services/providers/xai/xaiLogin.ts')
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
  const auth = await import('../../src/services/providers/xai/xaiOauth.ts')
  const { xaiAuthFixture } = await import('../providers/lib/xai-auth-fixture.ts')
  const { setAuthScope, clearAuthScope } = await import('../../src/utils/envUtils.ts')
  const { resolveXaiCredential } = await import('../../src/services/providers/xai/xaiAccounts.ts')
  const oauth = xaiAuthFixture()
  let clock = Date.now()
  const waits: number[] = []
  const io = { env: oauth.env, now: () => clock }
  const sleep = async (ms: number): Promise<void> => { waits.push(ms); clock += ms }
  try {
    setAuthScope(`${proofHome}/scoped-grok`)
    const events: string[] = []
    const signed = await runXaiDeviceLogin({ io, sleep, onEvent: event => events.push(event.phase) })
    check('device code polls pending and slow_down before storing the approved grant', signed.ok && oauth.state.polls === 3 && waits.join(',') === '1000,1000,6000' && events.includes('waiting') && events.includes('finishing'))
    check('Grok token file is auth-scoped mode 600; receipt contains no token or device secret', auth.xaiAuthPathForDisplay() === `${proofHome}/scoped-grok/.xai-auth.json` && (statSync(auth.xaiAuthPathForDisplay()).mode & 0o777) === 0o600 && !signed.receipt.includes(oauth.token) && !signed.receipt.includes('fixture-device'))
    check('OAuth ledger and account identity name Grok, never an invented plan', readSignInLedger().xai?.kind === 'oauth' && resolveXaiAccount()?.kind === 'grok-subscription' && resolveXaiAccount()?.email === 'fixture@example.invalid')
    process.env.XAI_API_KEY = key
    check('subscription wins even over the env key like OpenAI', resolveXaiAccount()?.kind === 'grok-subscription')
    auth.writePreferredXaiSource('api-key')
    check('explicit source preference selects the key', resolveXaiAccount()?.kind === 'api-key')
    auth.writePreferredXaiSource('grok-subscription')
    clock += 3600_000
    const catalogue = await import('../../src/services/providers/xai/xaiCatalogue.ts')
    const listing = catalogue.refreshXaiCatalogue({ ...io, force: true })
    const refreshed = await Promise.all([resolveXaiCredential(io), resolveXaiCredential(io)])
    await listing
    check('expired subscription refreshes once with rotating tokens and no key fallback', oauth.state.refreshes === 1 && refreshed.every(row => row?.key === oauth.rotated) && auth.xaiStoredTokens()?.refreshToken === 'fixture-rotated-refresh')
    check('catalogue fetched through refresh is immediately visible under the rotated credential', catalogue.getCachedXaiCatalogue(io.env)?.models[0]?.id === 'grok-4.7')
    const oauthSlot = deriveFamilySlotGroups().find(group => group.family.id === 'xai')?.slots.find(slot => slot.kind === 'oauth')
    check('account board shows an active OAuth slot with its own removal door', oauthSlot?.active && oauthSlot.removal.route === 'xai-oauth')
    executeSlotRemoval(oauthSlot!)
    check('sign-out forgets only the subscription and keeps the env key', !auth.xaiStoredTokens() && resolveXaiAccount()?.kind === 'api-key')
    oauth.state.slow = false
    oauth.state.deny = true
    const denied = await runXaiDeviceLogin({ io, sleep })
    check('denied authorization never stores a grant', !denied.ok && !auth.xaiStoredTokens())
    oauth.state.deny = false
    let cancelled = false
    oauth.state.onToken = () => { cancelled = true }
    const late = await runXaiDeviceLogin({ io, sleep, cancelled: () => cancelled })
    check('approval racing cancel is stored and disclosed, never silently orphaned', late.ok && late.settledAfterCancel && auth.xaiStoredTokens())
    oauth.state.onToken = undefined
    oauth.state.failRefresh = true
    await assert.rejects(() => auth.refreshXaiTokens(io, true))
    check('invalid_grant leaves an expired sign-in without silently switching to API billing', auth.xaiStoredTokens()?.refreshToken === '' && resolveXaiAccount()?.kind === 'grok-subscription' && await resolveXaiCredential(io) === undefined)
    auth.clearStoredXaiSubscription()
    clearAuthScope()
    check('the outer auth scope never received subscription tokens', !auth.xaiStoredTokens())
  } finally { oauth.stop(); auth.clearStoredXaiSubscription(); clearAuthScope(); delete process.env.XAI_API_KEY }
  console.log(`XAI LOGIN GREEN (${checks} checks; fixture only)`)
} finally { writeStoredXaiApiKey(null); rmSync(proofHome, { recursive: true, force: true }) }
