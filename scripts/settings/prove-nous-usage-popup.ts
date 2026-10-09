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
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
Object.assign(process.env, fixture.env)
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const owner = await import('../../src/services/providers/providerUsage.ts')
const fresh = await import('../../src/services/providers/usageFreshness.ts')
const usageState = await import('../../src/services/providers/nous/nousUsageState.ts')
mock.module('../../src/services/providers/providerUsage.ts', () => ({ ...owner, providerFamilyPresences: () => [{ id: 'nous', available: true, credentialed: true, credentialLabel: 'NOUS_API_KEY (env)' }, { id: 'deepseek', available: false, credentialed: false }, { id: 'openai-compat', available: false, credentialed: false }] }))
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
    while (!board.screen().includes('Nous Portal usage') && originalNow() < deadline) await settle(10)
    const frame = board.lines().join('\n')
    check(`${name}: the usage board paints before the capture deadline`, frame.includes('Nous Portal usage'))
    check(`${name}: source-rendered usage board fits ${width} columns without a render error`, !frame.includes('RENDER ERROR') && frame.split('\n').every(line => stringWidth(line) <= width))
    if (frames) writeFileSync(join(frames, `${name}-${width}.txt`), frame + '\n')
    return (width >= 120 ? frame.split('\n').map(line => line.slice(0, 46).trimEnd()).join('\n') : frame).replace(/\s+/g, ' ')
  } finally { board.unmount() }
}
try {
  await owner.refreshProviderUsage('nous', { now: () => now, force: true })
  for (const width of [116, 146]) {
    const frame = await capture('nous-usage', width)
    check(`Nous Portal ${width}: the usable credits paint as the credits line with their feed`, frame.includes('credits: USD 42.50 usable credits') && frame.includes('endpoint-fed'))
    check(`Nous Portal ${width}: the plan and the credit figures paint`, frame.includes('Plus (tier 2) subscription plan') && frame.includes('USD 12.50 of 20.00 monthly subscription credits remaining') && frame.includes('USD 30.00 purchased credits remaining') && frame.includes('USD 7.25 of 100.00 organisation spend cap'))
  }
  now += fresh.usageStaleAfterMs() + 1000
  usageState.__resetNousUsageForTest()
  fixture.state.accountStatus = 401
  await owner.refreshProviderUsage('nous', { now: () => now, force: true })
  const unresolved = await capture('nous-usage-unresolved', 116)
  check('a key the Portal does not resolve paints the honest note and no figure', unresolved.includes('HTTP 401') && unresolved.includes('API key is not associated with a user account') && unresolved.includes('portal.nousresearch.com') && !unresolved.includes('USD 42.50'))
  fixture.state.accountStatus = 200
  console.log(`NOUS USAGE POPUP GREEN (${checks} checks; source-rendered fixtures)`)
} finally {
  Date.now = originalNow
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
