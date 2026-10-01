#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import React from 'react'
import { mock } from 'bun:test'
import { strict as assert } from 'node:assert'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import stringWidth from 'string-width'
import { mountOffscreen, settle } from '../lib/settingsPopupHarness.ts'
import { xaiUsageFixture, XAI_FIXTURE_NOW } from '../providers/lib/xai-usage-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const originalNow = Date.now
let now = XAI_FIXTURE_NOW
Date.now = () => now
const fixture = xaiUsageFixture()
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const owner = await import('../../src/services/providers/providerUsage.ts')
const fresh = await import('../../src/services/providers/usageFreshness.ts')
mock.module('../../src/services/providers/providerUsage.ts', () => ({ ...owner, providerFamilyPresences: () => [{ id: 'xai', available: true, credentialed: true, credentialLabel: 'xAI API key (fixture)' }, { id: 'deepseek', available: false, credentialed: false }, { id: 'openai-compat', available: false, credentialed: false }] }))
const keybindings = await import('../../src/keybindings/useKeybinding.ts')
mock.module('../../src/keybindings/useKeybinding.ts', () => ({ ...keybindings, useKeybinding: () => undefined }))
const { Usage } = await import('../../src/components/Settings/Usage.tsx')
const framesArg = process.argv.indexOf('--frames')
const frames = framesArg >= 0 ? process.argv[framesArg + 1] : undefined
let checks = 0
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); checks++; console.log(`[PASS] ${label}`) }
async function capture(name: string, width: number): Promise<string> {
  const board = await mountOffscreen(React.createElement(Usage, { width, rowBudget: 44 }), width, 48)
  try {
    const deadline = originalNow() + 5000
    while (!board.screen().includes('xAI usage') && originalNow() < deadline) await settle(10)
    const frame = board.lines().join('\n')
    check(`${name}: the usage board paints before the capture deadline`, frame.includes('xAI usage'))
    check(`${name}: source-rendered usage board fits ${width} columns without a render error`, !frame.includes('RENDER ERROR') && frame.split('\n').every(line => stringWidth(line) <= width))
    if (frames) writeFileSync(join(frames, `${name}-${width}.txt`), frame + '\n')
    return (width >= 120 ? frame.split('\n').map(line => line.slice(0, 46).trimEnd()).join('\n') : frame).replace(/\s+/g, ' ')
  } finally { board.unmount() }
}
try {
  await owner.refreshProviderUsage('xai', { now: () => now, force: true })
  for (const width of [116, 146]) {
    const frame = await capture('xai-usage', width)
    check(`xAI ${width}: credits and team-cycle usage actually paint`, frame.includes('credits: USD 12.34 prepaid') && frame.includes('USD 21.00 team usage (2026-09)'))
    check(`xAI ${width}: postpaid invoice and cap paint separately with freshness`, frame.includes('USD 18.00 postpaid invoice preview (with VAT)') && frame.includes('USD 100.00 postpaid spending limit') && frame.includes('endpoint-fed'))
  }
  now += fresh.usageStaleAfterMs() + 1000
  fixture.state.status = 403
  await owner.refreshProviderUsage('xai', { now: () => now, force: true })
  const refused = await capture('xai-usage-refused', 116)
  check('refused management key is visible beside aged last-observed credits', refused.includes('refused the management key (HTTP 403)') && refused.includes('USD 12.34 prepaid') && refused.includes('stale'))
  delete process.env.XAI_MANAGEMENT_API_KEY
  const missing = await capture('xai-usage-api-only', 116)
  check('API-only usage paints the exact management-key remedy without a failure or an old balance', missing.includes("add a management key from the console's settings page to read usage — /logins xai") && !missing.includes('refused') && !missing.includes('USD 12.34'))
  const oauth = await import('../../src/services/providers/xai/xaiOauth.ts')
  const { XAI_FIXTURE_SUBSCRIPTION_TOKEN } = await import('../providers/lib/xai-usage-fixture.ts')
  oauth.writeXaiTokens({ accessToken: XAI_FIXTURE_SUBSCRIPTION_TOKEN, refreshToken: 'fixture-subscription-refresh', expiresAtMs: now + 3600_000, email: 'fixture@example.invalid' })
  oauth.writePreferredXaiSource('grok-subscription')
  try {
    await owner.refreshProviderUsage('xai', { now: () => now, force: true })
    const subscription = (await capture('xai-usage-subscription', 116)).split('DeepSeek usage')[0] ?? ''
    check('a Grok subscription paints its included weekly pool as a meter beside its purchased credits, and the key slot stays inactive', subscription.includes('Grok subscription') && subscription.includes('Current week') && subscription.includes('100%') && subscription.includes('resets Oct 4, 2026') && subscription.includes('credits: USD 5.00 purchased credits') && subscription.includes('not the active billing source this session') && !subscription.includes('not reported'))
    fixture.state.poolStatus = 403
    await owner.refreshProviderUsage('xai', { now: () => now, force: true })
    const poolRefused = await capture('xai-usage-subscription-refused', 116)
    check('a refused pool read paints the reconnect remedy beside the last observed window', poolRefused.includes('refused the subscription pool read (HTTP 403)') && poolRefused.includes('Current week'))
  } finally { oauth.clearStoredXaiSubscription(); fixture.state.poolStatus = 200 }
  console.log(`XAI USAGE POPUP GREEN (${checks} checks; source-rendered fixtures)`)
} finally {
  Date.now = originalNow
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
