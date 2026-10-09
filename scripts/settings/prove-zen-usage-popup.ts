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
import { startZenFixture } from '../providers/lib/zen-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const originalNow = Date.now
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
const KEY = 'sk-proof-key-zen-fixture-popup-not-a-real-key-000000000000000000000000000'
const fixture = startZenFixture({ key: KEY })
process.env.MERCURY_ZEN_API_BASE = fixture.base
process.env.MERCURY_ZEN_GO_API_BASE = fixture.goBase
process.env.OPENCODE_API_KEY = fixture.goKey
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const owner = await import('../../src/services/providers/providerUsage.ts')
mock.module('../../src/services/providers/providerUsage.ts', () => ({ ...owner, providerFamilyPresences: () => [{ id: 'zen', available: true, credentialed: true, credentialLabel: 'OPENCODE_API_KEY (env)' }, { id: 'deepseek', available: false, credentialed: false }, { id: 'openai-compat', available: false, credentialed: false }] }))
const keybindings = await import('../../src/keybindings/useKeybinding.ts')
mock.module('../../src/keybindings/useKeybinding.ts', () => ({ ...keybindings, useKeybinding: () => undefined }))
const { Usage } = await import('../../src/components/Settings/Usage.tsx')
const { __resetZenUsageForTest } = await import('../../src/services/providers/zen/zenUsageState.ts')
const framesArg = process.argv.indexOf('--frames')
const frames = framesArg >= 0 ? process.argv[framesArg + 1] : undefined
let checks = 0
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); checks++; console.log(`[PASS] ${label}`) }
async function capture(name: string, width: number): Promise<string> {
  const board = await mountOffscreen(React.createElement(Usage, { width, rowBudget: 44 }), width, 48)
  try {
    const deadline = originalNow() + 5000
    while (!board.screen().includes('OpenCode Zen usage') && originalNow() < deadline) await settle(10)
    const frame = board.lines().join('\n')
    check(`${name}: the usage board paints before the capture deadline`, frame.includes('OpenCode Zen usage'))
    check(`${name}: source-rendered usage board fits ${width} columns without a render error`, !frame.includes('RENDER ERROR') && frame.split('\n').every(line => stringWidth(line) <= width))
    if (frames) writeFileSync(join(frames, `${name}-${width}.txt`), frame + '\n')
    return (width >= 120 ? frame.split('\n').map(line => line.slice(0, 46).trimEnd()).join('\n') : frame).replace(/\s+/g, ' ')
  } finally { board.unmount() }
}
try {
  await owner.refreshProviderUsage('zen', { force: true, reason: 'operator' })
  for (const width of [116, 146]) {
    const frame = await capture('zen-usage-go', width)
    check(`Zen ${width}: the Go plan's three windows paint as meters with their percentages`, frame.includes('Go 5 hour') && frame.includes('Go weekly') && frame.includes('Go monthly') && frame.includes('100%') && frame.includes('12%'))
    check(`Zen ${width}: the console-only balance line paints and no balance figure is invented`, frame.includes('console') && !frame.includes('USD'))
  }
  __resetZenUsageForTest()
  process.env.OPENCODE_API_KEY = KEY
  await owner.refreshProviderUsage('zen', { force: true, reason: 'operator' })
  const noPlan = await capture('zen-usage-key', 116)
  check('a pay-as-you-go key paints the no-plan line and the console pointer, never a window', noPlan.includes('no OpenCode Go plan') && noPlan.includes('console') && !noPlan.includes('Go 5 hour'))
  __resetZenUsageForTest()
  process.env.OPENCODE_API_KEY = 'sk-refused-zen-fixture-key-00000000000000000000000000000000000000000000000'
  await owner.refreshProviderUsage('zen', { force: true, reason: 'operator' })
  const refused = await capture('zen-usage-refused', 116)
  check('a refused key paints the usage reader\'s own words with the /logins zen remedy', refused.includes('refused the key on the usage read (HTTP 401)') && refused.includes('/logins zen'))
  console.log(`ZEN USAGE POPUP GREEN (${checks} checks; source-rendered fixtures)`)
} finally {
  Date.now = originalNow
  fixture.stop()
  rmSync(proofHome, { recursive: true, force: true })
}
