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
import { mistralFixture, MISTRAL_FIXTURE_NOW } from '../providers/lib/mistral-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const originalNow = Date.now
let now = MISTRAL_FIXTURE_NOW
Date.now = () => now
const fixture = mistralFixture()
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const owner = await import('../../src/services/providers/providerUsage.ts')
const fresh = await import('../../src/services/providers/usageFreshness.ts')
const { __resetMistralUsageForTest } = await import('../../src/services/providers/mistral/mistralUsageState.ts')
mock.module('../../src/services/providers/providerUsage.ts', () => ({ ...owner, providerFamilyPresences: () => [{ id: 'mistral', available: true, credentialed: true, credentialLabel: 'Mistral API key (fixture)' }, { id: 'deepseek', available: false, credentialed: false }, { id: 'openai-compat', available: false, credentialed: false }] }))
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
    while (!board.screen().includes('Mistral usage') && originalNow() < deadline) await settle(10)
    const frame = board.lines().join('\n')
    check(`${name}: the usage board paints before the capture deadline`, frame.includes('Mistral usage'))
    check(`${name}: source-rendered usage board fits ${width} columns without a render error`, !frame.includes('RENDER ERROR') && frame.split('\n').every(line => stringWidth(line) <= width))
    if (frames) writeFileSync(join(frames, `${name}-${width}.txt`), frame + '\n')
    return (width >= 120 ? frame.split('\n').map(line => line.slice(0, 46).trimEnd()).join('\n') : frame).replace(/\s+/g, ' ')
  } finally { board.unmount() }
}
try {
  await owner.refreshProviderUsage('mistral', { now: () => now, force: true })
  for (const width of [116, 146]) {
    const frame = await capture('mistral-usage', width)
    check(`Mistral ${width}: the account, the month-to-date usage and the monthly limit paint`, frame.includes('fixture@example.invalid') && frame.includes('EUR 45.00 organisation usage this month') && frame.includes('EUR 500.00 monthly spend limit'))
    check(`Mistral ${width}: the remainder paints as credits with freshness, the rate limit beside it`, frame.includes('credits: EUR 455.00 left of the monthly limit') && frame.includes('6 requests/s rate limit') && frame.includes('endpoint-fed'))
  }
  now += fresh.usageStaleAfterMs() + 1000
  fixture.state.adminStatus = 403
  await owner.refreshProviderUsage('mistral', { now: () => now, force: true })
  const refused = await capture('mistral-usage-refused', 116)
  check('a refused admin key is visible beside the aged last-observed meter', refused.includes('refused the Admin API key (HTTP 403)') && refused.includes('EUR 455.00') && refused.includes('stale'))
  fixture.state.adminStatus = 200
  delete process.env.MISTRAL_ADMIN_API_KEY
  __resetMistralUsageForTest()
  await owner.refreshProviderUsage('mistral', { now: () => now, force: true })
  const missing = await capture('mistral-usage-api-only', 116)
  check('a standard key paints the exact Admin API key remedy and the account, without a failure or an old meter', missing.includes('usage is read with an Admin API key (Enterprise plans, backoffice.mistral.ai)') && missing.includes('fixture@example.invalid') && !missing.includes('refused') && !missing.includes('EUR 455.00'))
  console.log(`MISTRAL USAGE POPUP GREEN (${checks} checks; source-rendered fixtures)`)
} finally {
  Date.now = originalNow
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
