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
import { nousFixture, NOUS_FIXTURE_NOW } from '../providers/lib/nous-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const originalNow = Date.now
let now = NOUS_FIXTURE_NOW
Date.now = () => now
const fixture = nousFixture()
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/platform/settings/config.ts'); enableConfigs()
const owner = await import('../../src/models/roads/providerUsage.ts')
const fresh = await import('../../src/models/roads/usageFreshness.ts')
const usageState = await import('../../src/models/roads/nous/nousUsageState.ts')
mock.module('../../src/models/roads/providerUsage.ts', () => ({ ...owner, providerFamilyPresences: () => [{ id: 'nous', available: true, credentialed: true, credentialLabel: 'NOUS_API_KEY (env)' }, { id: 'deepseek', available: false, credentialed: false }, { id: 'openai-compat', available: false, credentialed: false }] }))
const keybindings = await import('../../src/screen/keys/useKeybinding.ts')
mock.module('../../src/screen/keys/useKeybinding.ts', () => ({ ...keybindings, useKeybinding: () => undefined }))
const { Usage } = await import('../../src/screen/settings/Usage.tsx')
const framesArg = process.argv.indexOf('--frames')
const frames = framesArg >= 0 ? process.argv[framesArg + 1] : undefined
let checks = 0
const check = (label: string, ok: unknown, detail?: string): void => { assert.ok(ok, detail ? `${label} (${detail})` : label); checks++; console.log(`[PASS] ${label}`) }
async function capture(name: string, width: number): Promise<string> {
  const board = await mountOffscreen(React.createElement(Usage, { width, rowBudget: 44 }), width, 48)
  try {
    const deadline = originalNow() + 5000
    while (!board.screen().includes('Nous Portal usage') && originalNow() < deadline) await settle(10)
    const frame = board.lines().join('\n')
    check(`${name}: the usage board paints before the capture deadline`, frame.includes('Nous Portal usage'), 'the board never showed its Nous Portal usage title; check the title in src/screen/settings/usage/plan.ts and nousUsageView in src/models/roads/provider-usage/nous.ts')
    check(`${name}: source-rendered usage board fits ${width} columns without a render error`, !frame.includes('RENDER ERROR') && frame.split('\n').every(line => stringWidth(line) <= width), 'a frame line is wider than the width or the board threw while rendering; read the frame by running this proof with --frames <dir> and fix the row layout in src/screen/settings/Usage.tsx')
    if (frames) writeFileSync(join(frames, `${name}-${width}.txt`), frame + '\n')
    return (width >= 120 ? frame.split('\n').map(line => line.slice(0, 46).trimEnd()).join('\n') : frame).replace(/\s+/g, ' ')
  } finally { board.unmount() }
}
try {
  await owner.refreshProviderUsage('nous', { now: () => now, force: true })
  for (const width of [116, 146]) {
    const frame = await capture('nous-usage', width)
    check(`Nous Portal ${width}: the usable credits paint as the credits line with their feed`, frame.includes('credits: USD 42.50 usable credits') && frame.includes('endpoint-fed'), 'the balance display is built in nousUsageView in src/models/roads/provider-usage/nous.ts and the feed word in src/models/roads/usageFreshness.ts')
    check(`Nous Portal ${width}: the plan and the credit figures paint`, frame.includes('Plus (tier 2) subscription plan') && frame.includes('USD 12.50 of 20.00 monthly subscription credits remaining') && frame.includes('USD 30.00 purchased credits remaining') && frame.includes('USD 7.25 of 100.00 organisation spend cap'), 'the plan and credit figures are built in nousUsageView in src/models/roads/provider-usage/nous.ts')
  }
  now += fresh.usageStaleAfterMs() + 1000
  usageState.__resetNousUsageForTest()
  fixture.state.accountStatus = 401
  await owner.refreshProviderUsage('nous', { now: () => now, force: true })
  const unresolved = await capture('nous-usage-unresolved', 116)
  check('a key the Portal does not resolve paints the honest note and no figure', unresolved.includes('HTTP 401') && unresolved.includes('API key is not associated with a user account') && unresolved.includes('portal.nousresearch.com') && !unresolved.includes('USD 42.50'), 'the failure note is written by nousAccountFailureWords in src/models/roads/nous/nousUsageState.ts and the stale balance must not paint in nousUsageView in src/models/roads/provider-usage/nous.ts')
  fixture.state.accountStatus = 200
  console.log(`NOUS USAGE POPUP GREEN (${checks} checks; source-rendered fixtures)`)
} finally {
  Date.now = originalNow
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
