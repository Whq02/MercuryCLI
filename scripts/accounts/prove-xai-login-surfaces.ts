#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import React from 'react'
import { strict as assert } from 'node:assert'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, settle, KEY } from '../lib/settingsPopupHarness.ts'
import { xaiUsageFixture, XAI_FIXTURE_NOW, XAI_FIXTURE_API_KEY, XAI_FIXTURE_MANAGEMENT_KEY } from '../providers/lib/xai-usage-fixture.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_RECESS = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
const originalNow = Date.now
Date.now = () => XAI_FIXTURE_NOW
const fixture = xaiUsageFixture()
Object.assign(process.env, fixture.env)
delete process.env.XAI_API_KEY
delete process.env.XAI_MANAGEMENT_API_KEY
const { enableConfigs } = await import('../../src/utils/config.ts'); enableConfigs()
const { XaiConnect } = await import('../../src/components/XaiConnect.tsx')
const { BootLoginsScreen } = await import('../../src/components/BootLoginsScreen.tsx')
const { RouterKeyEntry } = await import('../../src/components/RouterKeyEntry.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const mount = (element: React.ReactNode, columns: number, rows: number) => mountOffscreen(React.createElement(AppStateProvider, { children: element }), columns, rows)
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const { signedOutFacts, STILLS, renderStill } = await import('../ui/face-logins-stills.ts')
const framesArg = process.argv.indexOf('--frames')
const frames = framesArg >= 0 ? process.argv[framesArg + 1] : undefined
let checks = 0
let observedScreen = (): string => 'not mounted'
const check = (label: string, ok: unknown): void => { assert.ok(ok, label); checks++; console.log(`[PASS] ${label}`) }
async function until(pred: () => boolean): Promise<void> {
  const deadline = performance.now() + 10000
  while (!pred() && performance.now() < deadline) await settle(10)
  assert.ok(pred(), `the expected source-rendered frame arrives; observed:\n${observedScreen()}`)
}
try {
  let result: { ok: boolean; receipt: string } | undefined
  const card = await mount(React.createElement(XaiConnect, { onResult: value => { result = value }, onBack: () => { throw new Error('unexpected back') } }), 120, 32)
  try {
    observedScreen = card.screen
    await until(() => card.screen().includes('Connect xAI'))
    card.push(XAI_FIXTURE_API_KEY); await settle(20); card.push(KEY.enter)
    await until(() => card.screen().includes('management key (optional)'))
    check('modal saves inference first and stays open for the optional management step', secrets.readStoredXaiApiKey() === XAI_FIXTURE_API_KEY && result === undefined)
    check('modal names settings, permission and skip without echoing the key', card.screen().includes('settings page') && card.screen().includes('Management Keys Read + Write') && !card.screen().includes(XAI_FIXTURE_API_KEY))
    if (frames) writeFileSync(join(frames, 'xai-management-modal.txt'), card.lines().join('\n') + '\n')
    card.push(KEY.enter)
    await until(() => result !== undefined)
    check('empty optional step completes without removing the API key', result?.ok && !secrets.readStoredXaiManagementApiKey() && secrets.readStoredXaiApiKey() === XAI_FIXTURE_API_KEY)
  } finally { card.unmount() }
  const face = await mount(React.createElement(BootLoginsScreen, { family: 'xai', fullScene: { columns: 120, rows: 40 }, facts: signedOutFacts() }), 120, 40)
  try {
    observedScreen = face.screen
    await until(() => face.screen().includes('xAI'))
    face.push(KEY.enter)
    await until(() => face.screen().includes('management key follows for /usage.'))
    face.push(KEY.enter)
    await until(() => face.screen().includes('management key (optional)'))
    check('face can keep the existing API key and proceed directly to management', face.screen().includes('settings page') && face.screen().includes('API key stays'))
    if (frames) writeFileSync(join(frames, 'xai-management-face.txt'), face.lines().join('\n') + '\n')
    face.push(XAI_FIXTURE_MANAGEMENT_KEY); await settle(20); face.push(KEY.enter)
    await until(() => secrets.readStoredXaiManagementApiKey() === XAI_FIXTURE_MANAGEMENT_KEY)
    check('face submits the management key through the same verified store', !face.screen().includes(XAI_FIXTURE_MANAGEMENT_KEY))
  } finally { face.unmount() }
  const compact = await mount(React.createElement(BootLoginsScreen, { family: 'xai', fullScene: { columns: 80, rows: 24 }, facts: signedOutFacts() }), 80, 24)
  try {
    observedScreen = compact.screen
    await until(() => compact.screen().includes('xAI'))
    compact.push(KEY.enter)
    await until(() => compact.screen().includes('key:'))
    compact.push(KEY.enter)
    await until(() => compact.screen().includes('xAI management key (optional)'))
    if (frames) writeFileSync(join(frames, 'xai-management-compact.txt'), compact.lines().join('\n') + '\n')
    const compactWords = compact.screen().replace(/\s+/g, ' ')
    check('compact face paints the management prompt in the existing confirmation band', compactWords.includes('settings page') && compactWords.includes('key:') && compactWords.includes('API key stays'))
    compact.push(KEY.esc); await settle(30)
    check('escape from the optional compact step keeps both credentials', secrets.readStoredXaiApiKey() === XAI_FIXTURE_API_KEY && secrets.readStoredXaiManagementApiKey() === XAI_FIXTURE_MANAGEMENT_KEY)
  } finally { compact.unmount() }
  let receipt = ''
  const router = await mount(React.createElement(RouterKeyEntry, { provider: 'xai-management', onDone: value => { receipt = value } }), 120, 24)
  try {
    observedScreen = router.screen
    await until(() => router.screen().includes('settings page'))
    router.push(XAI_FIXTURE_MANAGEMENT_KEY); await settle(20); router.push(KEY.enter)
    await until(() => receipt !== '')
    check('router management entry saves to the independent slot with the console guidance', secrets.readStoredXaiManagementApiKey() === XAI_FIXTURE_MANAGEMENT_KEY && !receipt.includes(XAI_FIXTURE_MANAGEMENT_KEY))
  } finally { router.unmount() }
  for (const still of STILLS.filter(s => s.id.includes('key-xai'))) {
    const text = renderStill(still.compose())
    check(`${still.id}: new still paints the key prompt and its exit`, text.includes(still.id.endsWith('management') ? 'xAI management key (optional)' : 'xAI API key') && text.includes('key:') && text.includes('esc') && !text.includes('RENDER ERROR'))
    if (frames) writeFileSync(join(frames, `${still.id}.txt`), text)
  }
  console.log(`XAI LOGIN SURFACES GREEN (${checks} checks; source-rendered fixtures)`)
} finally {
  fixture.stop()
  Date.now = originalNow
  rmSync(proofHome, { recursive: true, force: true })
}
