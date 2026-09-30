#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { xaiUsageFixture, XAI_FIXTURE_NOW, XAI_FIXTURE_API_KEY, XAI_FIXTURE_MANAGEMENT_KEY } from './lib/xai-usage-fixture.ts'

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
  delete process.env.XAI_API_KEY
  check('management key alone does not credential inference or fabricate a usage section', owner.usageForProvider('xai').sourceKind === 'none' && !resolveProviderUsability().xai.usable)
  console.log(`XAI USAGE GREEN (${checks} checks; loopback only)`)
} finally {
  fixture.stop()
  state.__resetXaiUsageForTest()
  rmSync(proofHome, { recursive: true, force: true })
}
