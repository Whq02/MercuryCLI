#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { xaiUsageFixture, XAI_FIXTURE_NOW, XAI_FIXTURE_API_KEY, XAI_FIXTURE_MANAGEMENT_KEY, XAI_FIXTURE_SUBSCRIPTION_TOKEN } from './lib/xai-usage-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const state = await import('../../src/services/providers/xai/xaiUsageState.ts')
const owner = await import('../../src/services/providers/providerUsage.ts')
const { usageStaleAfterMs } = await import('../../src/services/providers/usageFreshness.ts')
const { resolveProviderUsability } = await import('../../src/services/providers/providerUsability.ts')
const fixture = xaiUsageFixture()
Object.assign(process.env, fixture.env)
const io = { env: process.env, now: () => XAI_FIXTURE_NOW }
let checks = 0
const check = (label: string, value: unknown): void => { assert.ok(value, label); checks++; console.log(`[PASS] ${label}`) }
try {
  delete process.env.XAI_MANAGEMENT_API_KEY
  await owner.refreshProviderUsage('xai', io)
  const absent = owner.usageForProvider('xai')
  check('API key alone makes no request, no error, and names the optional management-key door', fixture.requests.length === 0 && absent.absence === state.XAI_MANAGEMENT_KEY_HINT && !absent.readerNote && absent.credits?.state === 'unreported')
  process.env.XAI_MANAGEMENT_API_KEY = XAI_FIXTURE_MANAGEMENT_KEY
  await Promise.all([owner.refreshProviderUsage('xai', io), owner.refreshProviderUsage('xai', io)])
  let view = owner.usageForProvider('xai')
  check('two concurrent refreshes make one five-request read with separate inference and management bearers', fixture.requests.length === 5)
  check('documented negative prepaid cents become positive available USD, not session spend', view.credits?.display === 'USD 12.34 prepaid' && view.balance?.observedAtMs === XAI_FIXTURE_NOW)
  check('billing-cycle series is summed in USD with its stated cycle', view.figures?.find(f => f.key === 'team-cycle')?.value === 'USD 21.00' && view.figures[0]?.label.includes('2026-09'))
  check('postpaid invoice and effective spending limit are separately labelled, never a fabricated percentage of team spend', view.figures?.find(f => f.key === 'postpaid-preview')?.value === 'USD 18.00' && view.figures?.find(f => f.key === 'postpaid-limit')?.value === 'USD 100.00' && view.windows.length === 0)
  check('every figure carries endpoint source and observation stamp', view.figures?.every(f => f.source === 'endpoint' && f.observedAtMs === XAI_FIXTURE_NOW) && !view.absence && !view.readerNote)
  await owner.refreshProviderUsage('xai', io)
  check('the freshness floor coalesces another showing', fixture.requests.length === 5)
  fixture.state.partial = true
  await owner.refreshProviderUsage('xai', { ...io, reason: 'operator' })
  view = owner.usageForProvider('xai')
  check('limitReached is cardinality truncation, visibly partial and never a billing rejection', view.figures?.[0]?.label.includes('partial') && view.readerNote?.includes('not a spending-limit signal') && !view.limited && resolveProviderUsability().xai.usable)
  fixture.state.partial = false
  fixture.state.status = 403
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  view = owner.usageForProvider('xai')
  check('refused management key names the credential, status and remedy while keeping the last observation', view.readerNote?.includes('refused the management key (HTTP 403)') && view.readerNote.includes('/logins xai') && view.credits?.display === 'USD 12.34 prepaid')
  const words = owner.usageCreditsLine(view.credits, XAI_FIXTURE_NOW + usageStaleAfterMs() + 1)
  check('a retained observation ages through the shared freshness vocabulary', words?.includes('stale'))
  const failedCount = fixture.requests.length
  await owner.refreshProviderUsage('xai', io)
  check('failed reads have the same bounded re-show floor', fixture.requests.length === failedCount)
  fixture.state.status = 200
  fixture.state.prepaidOnly = true
  const beforePrepaid = fixture.requests.length
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  check('prepaid-only teams read the provider cycle and series without asking postpaid spending limits', fixture.requests.length === beforePrepaid + 4 && !fixture.requests.slice(beforePrepaid).some(r => r.path.endsWith('/spending-limits')) && !owner.usageForProvider('xai').figures?.some(f => f.key === 'postpaid-limit'))
  fixture.state.malformed = true
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  check('malformed usage is labelled and does not replace the last good figures with zeros', owner.usageForProvider('xai').readerNote?.includes('unrecognised response') && owner.usageForProvider('xai').figures?.[0]?.value === 'USD 21.00')
  fixture.state.malformed = false
  process.env.XAI_MANAGEMENT_API_KEY = 'a-different-management-key'
  check('management-key replacement drops both the old usage and failure immediately', state.xaiObservedUsage().usage === null && state.xaiObservedUsage().failure === null)
  process.env.XAI_MANAGEMENT_API_KEY = XAI_FIXTURE_MANAGEMENT_KEY
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  process.env.XAI_API_KEY = 'a-different-inference-key'
  check('inference-key replacement also drops the team record immediately', state.xaiObservedUsage().usage === null)
  process.env.XAI_API_KEY = XAI_FIXTURE_API_KEY
  let reached = (): void => {}
  const atUsage = new Promise<void>(resolve => { reached = resolve })
  let release = (): void => {}
  fixture.state.hold = new Promise<void>(resolve => { release = resolve })
  fixture.state.hitUsage = reached
  const pending = owner.refreshProviderUsage('xai', { ...io, force: true })
  await atUsage
  delete process.env.XAI_MANAGEMENT_API_KEY
  check('removing the management key during a read clears the record', state.xaiObservedUsage().usage === null)
  release()
  await pending
  check('a late response cannot resurrect the departed credential’s usage', state.xaiObservedUsage().usage === null && owner.usageForProvider('xai').absence === state.XAI_MANAGEMENT_KEY_HINT)
  fixture.state.hold = undefined
  fixture.state.hitUsage = undefined
  process.env.XAI_MANAGEMENT_API_KEY = XAI_FIXTURE_MANAGEMENT_KEY
  const error = await state.fetchXaiUsage(XAI_FIXTURE_API_KEY, XAI_FIXTURE_MANAGEMENT_KEY, { ...io, fetchImpl: (async () => { throw new Error(`${XAI_FIXTURE_API_KEY} ${XAI_FIXTURE_MANAGEMENT_KEY}`) }) as typeof fetch })
  check('network errors carry no key bytes', error.state === 'failed' && !JSON.stringify(error).includes(XAI_FIXTURE_API_KEY) && !JSON.stringify(error).includes(XAI_FIXTURE_MANAGEMENT_KEY))
  check('zero, owed balance, decimal mistakes and unsafe integers have distinct honest decodes', state.decodeXaiPrepaidBalance({ total: { val: '0' } }) === 0 && state.decodeXaiPrepaidBalance({ total: { val: '125' } }) === -1.25 && state.decodeXaiPrepaidBalance({ total: { val: '1.25' } }) === undefined && state.decodeXaiPrepaidBalance({ total: { val: '9007199254740993' } }) === undefined)
  check('empty documented series means zero, malformed series is never zero', state.decodeXaiUsageSeries({ timeSeries: [], limitReached: false })?.usd === 0 && state.decodeXaiUsageSeries({}) === undefined)
  const oauth = await import('../../src/services/providers/xai/xaiOauth.ts')
  const { resolveXaiAccount } = await import('../../src/services/providers/xai/xaiAccounts.ts')
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  const keyView = JSON.stringify(owner.usageForProvider('xai'))
  check('the key road view before the subscription section is the observed team record', owner.usageForProvider('xai').figures?.[0]?.value === 'USD 21.00')
  oauth.writeXaiTokens({ accessToken: XAI_FIXTURE_SUBSCRIPTION_TOKEN, refreshToken: 'fixture-subscription-refresh', expiresAtMs: XAI_FIXTURE_NOW + 3600_000, email: 'fixture@example.invalid' })
  oauth.writePreferredXaiSource('grok-subscription')
  const beforePool = fixture.requests.length
  await Promise.all([owner.refreshProviderUsage('xai', io), owner.refreshProviderUsage('xai', io)])
  const poolRequests = fixture.requests.slice(beforePool)
  view = owner.usageForProvider('xai')
  check('a Grok subscription reads the proxy pool once with the subscription bearer and the CLI client headers, never the key or management roads', resolveXaiAccount()?.kind === 'grok-subscription' && poolRequests.length === 1 && poolRequests[0]?.path === '/proxy/v1/billing' && poolRequests[0].headers['x-grok-client-mode'] === 'cli' && view.sourceKind === 'subscription-oauth' && view.tier === 'Grok subscription')
  const pool = view.windows[0]
  check('the included weekly pool is one live window: the stated percent, the period end as its reset, endpoint-fed at the fixture clock', view.windows.length === 1 && pool?.label === 'wk' && pool.usedPct === 100 && pool.resetsAtMs === Date.parse('2026-10-04T20:25:36.625288+00:00') && pool.source === 'endpoint' && pool.observedAtMs === XAI_FIXTURE_NOW && view.pools.length === 0)
  check('purchased credits ride the credits line as USD from cents, never session spend, with the compact rail spelling', view.credits?.display === 'USD 5.00 purchased credits' && owner.usageCreditsLine(view.credits, XAI_FIXTURE_NOW)?.startsWith('credits: USD 5.00 purchased credits · endpoint-fed') && owner.usageCreditsLine(view.credits, XAI_FIXTURE_NOW, 'compact') === 'credits USD 5.00 purchased' && !view.absence && !view.readerNote)
  check('a full pool reads as reached in the shared vocabulary', owner.usageWindowReached(view, XAI_FIXTURE_NOW) === 'full')
  check('a full pool names what carries requests past it: the purchased credits the same read returned, with the balance, in prose and compact', view.carry?.state === 'carries' && view.carry.source === 'endpoint' && view.carry.observedAtMs === XAI_FIXTURE_NOW && owner.usageReachedWords(view, XAI_FIXTURE_NOW) === '100% · on purchased credits · USD 5.00 left' && owner.usageReachedWords(view, XAI_FIXTURE_NOW, 'compact') === '100% · on purchased credits USD 5.00')
  check('a drained purchased balance says nothing carries requests until the reset; an unread pool stays unstated', owner.xaiPurchasedCreditsCarry({ observedAtMs: XAI_FIXTURE_NOW, usedPercent: 100, prepaidBalanceUsd: 0 }, false).state === 'nothing' && owner.xaiPurchasedCreditsCarry({ observedAtMs: XAI_FIXTURE_NOW, usedPercent: 100, prepaidBalanceUsd: 0 }, false).display === 'purchased credits USD 0.00 — nothing carries requests until the reset' && owner.xaiPurchasedCreditsCarry({ observedAtMs: XAI_FIXTURE_NOW, usedPercent: 100 }, false).state === 'unstated' && owner.xaiPurchasedCreditsCarry(null, false).display === owner.XAI_POOL_NOT_READ_WORDS)
  await owner.refreshProviderUsage('xai', io)
  check('the pool read keeps the shared freshness floor', fixture.requests.length === beforePool + 1)
  fixture.state.poolStatus = 403
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  view = owner.usageForProvider('xai')
  check('a refused pool read names the status and the reconnect remedy while the last window stands', view.readerNote?.includes('refused the subscription pool read (HTTP 403)') && view.readerNote.includes('/logins xai') && view.windows[0]?.usedPct === 100 && view.credits?.display === 'USD 5.00 purchased credits')
  fixture.state.poolStatus = 200
  fixture.state.poolMalformed = true
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  check('a malformed pool answer is labelled and never replaces the last window with zeros', owner.usageForProvider('xai').readerNote?.includes('unrecognised response') && owner.usageForProvider('xai').windows[0]?.usedPct === 100)
  fixture.state.poolMalformed = false
  fixture.state.poolPercent = undefined
  fixture.state.poolPrepaidCents = '250'
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  view = owner.usageForProvider('xai')
  check('an omitted percent is an honest absence, never a fabricated 0% window; a string cents balance still decodes', view.windows.length === 0 && view.absence === owner.XAI_POOL_UNSTATED_WORDS && view.credits?.display === 'USD 2.50 purchased credits')
  fixture.state.poolPercent = 100
  fixture.state.poolPrepaidCents = 500
  check('a pool decode keeps the live field names: creditUsagePercent, currentPeriod.type/start/end, prepaidBalance.val, subscription_tier', JSON.stringify(state.decodeXaiSubscriptionCredits({ subscription_tier: 'SuperGrok', config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' }, creditUsagePercent: 12.5, prepaidBalance: { val: '1234' } } }, XAI_FIXTURE_NOW)) === JSON.stringify({ observedAtMs: XAI_FIXTURE_NOW, usedPercent: 12.5, period: { type: 'USAGE_PERIOD_TYPE_MONTHLY', startMs: Date.parse('2026-09-01T00:00:00Z'), endMs: Date.parse('2026-10-01T00:00:00Z') }, prepaidBalanceUsd: 12.34, tier: 'SuperGrok' }) && state.decodeXaiSubscriptionCredits({ nothing: true }, XAI_FIXTURE_NOW) === undefined && state.decodeXaiSubscriptionCredits({ config: { used: { val: '50' }, monthlyLimit: { val: '200' } } }, XAI_FIXTURE_NOW)?.usedPercent === 25)
  const poolError = await state.fetchXaiSubscriptionCredits(XAI_FIXTURE_SUBSCRIPTION_TOKEN, { ...io, fetchImpl: (async () => { throw new Error(XAI_FIXTURE_SUBSCRIPTION_TOKEN) }) as typeof fetch })
  check('pool network errors carry no token bytes', poolError.state === 'failed' && poolError.failure.endpoint === 'subscription' && !JSON.stringify(poolError).includes(XAI_FIXTURE_SUBSCRIPTION_TOKEN))
  let reachedPool = (): void => {}
  const atPool = new Promise<void>(resolve => { reachedPool = resolve })
  let releasePool = (): void => {}
  fixture.state.poolHold = new Promise<void>(resolve => { releasePool = resolve })
  fixture.state.hitPool = reachedPool
  const pendingPool = owner.refreshProviderUsage('xai', { ...io, force: true })
  await atPool
  oauth.clearStoredXaiSubscription()
  releasePool()
  await pendingPool
  fixture.state.poolHold = undefined
  fixture.state.hitPool = undefined
  check('signing out mid-read drops the pool record and a late answer cannot resurrect it', state.xaiObservedSubscriptionCredits().credits === null && resolveXaiAccount()?.kind === 'api-key')
  const afterPool = fixture.requests.length
  await owner.refreshProviderUsage('xai', { ...io, force: true })
  check('the API-key road is untouched by the subscription pool: the same view, the same management requests', JSON.stringify(owner.usageForProvider('xai')) === keyView && fixture.requests.slice(afterPool).every(r => !r.path.startsWith('/proxy/')) && fixture.requests.slice(afterPool).length === (fixture.state.prepaidOnly ? 4 : 5))
  delete process.env.XAI_API_KEY
  check('management key alone does not credential inference or fabricate a usage section', owner.usageForProvider('xai').sourceKind === 'none' && !resolveProviderUsability().xai.usable)
  console.log(`XAI USAGE GREEN (${checks} checks; loopback only)`)
} finally {
  fixture.stop()
  state.__resetXaiUsageForTest()
  rmSync(proofHome, { recursive: true, force: true })
}
