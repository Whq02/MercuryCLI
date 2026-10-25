import React from 'react'
import { mock } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle } from '../lib/settingsPopupHarness.ts'

const home = pinScratchHome('gemini-usage-identity')
const email = 'gemini-recording@example.com'
const entry = { provider: 'gemini', kind: 'subscription-oauth', label: 'Google AI plan', identity: { email } }
async function stub(path: string, fixture: Record<string, unknown>): Promise<void> {
  const actual = await import(path)
  mock.module(path, () => ({ ...actual, ...fixture }))
}
await stub('../../src/services/wallet/wallet.js', { walletEntries: () => [entry], activeWalletEntry: () => entry })
await stub('../../src/services/providers/providerUsage.js', {
  providerFamilyPresences: () => [{ id: 'gemini', credentialed: true, credentialLabel: 'Google AI plan', identity: email }],
  usageForProvider: () => ({ provider: 'gemini', sourceKind: 'oauth', windows: [], figures: [], pools: [] }),
  refreshProviderUsage: async () => undefined,
})
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { Usage } = await import('../../src/components/Settings/Usage.js')
let failures = 0
try {
  for (const shown of [true, false]) {
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { accountIdentity: shown } }))
    resetSettingsCache()
    const m = await mountOffscreen(React.createElement(Usage, { width: 110, rowBudget: 45 }), 110, 45)
    await settle(250)
    const frame = m.screen()
    const ok = frame.includes('Google sign-in') && frame.includes(email) === shown
    if (!ok) failures++
    console.log(`${ok ? 'PASS' : 'FAIL'} Gemini usage obeys identity visibility=${shown}${ok ? '' : `\n${frame}`}`)
    m.unmount()
  }
} finally {
  await releaseScratchHome(home)
}
process.exit(failures === 0 ? 0 : 1)
