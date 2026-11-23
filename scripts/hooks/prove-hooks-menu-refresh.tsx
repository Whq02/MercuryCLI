import React from 'react'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('hooks-menu-refresh')
let failures = 0
const menuRefreshHint = 'the open menu did not pick up the settings change: make src/screen/event-hooks-menu/HooksConfigMenu.tsx recompute its counts and managed-only notice (listHooks, managedHooksOnly from src/integrations/event-hooks/hooksConfigSnapshot.ts) after settingsChangeDetector.notifyChange, and check that refreshHooksSnapshot re-reads settings.json'
const check = (label: string, ok: boolean): void => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
  if (!ok) {
    failures++
    console.log(`  ${menuRefreshHint}`)
  }
}
await import('../../src/tools/crewmate/CrewmateTool.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { KeybindingSetup } = await import('../../src/screen/keys/KeybindingProviderSetup.js')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { HooksConfigMenu } = await import('../../src/screen/event-hooks-menu/HooksConfigMenu.js')
const { refreshHooksSnapshot } = await import('../../src/integrations/event-hooks/hooksConfigSnapshot.js')
const { settingsChangeDetector } = await import('../../src/platform/settings/changeDetector.js')
enableConfigs()
const file = join(home, 'settings.json')
const hooks = { 'tool.before': [{ run: 'true', match: 'Read', name: 'fixture hook' }] }
writeFileSync(file, JSON.stringify({ events: { hooks } }))
refreshHooksSnapshot()
const view = await mountOffscreen(<AppStateProvider><ThemeProvider><KeybindingSetup><Box width={100} height={32} flexDirection="column"><HooksConfigMenu toolNames={['Read']} onExit={() => {}} /></Box></KeybindingSetup></ThemeProvider></AppStateProvider>, 100, 32)
try {
  check('the hook browser starts from the stored hooks', await waitFor(() => view.screen().includes('1 configured hook'), 3000))
  writeFileSync(file, JSON.stringify({ events: { hooks: { ...hooks, 'tool.after': [{ run: 'true', name: 'second fixture hook' }] } } }))
  settingsChangeDetector.notifyChange('userSettings')
  check('a settings change refreshes the open count without reopening the menu', await waitFor(() => view.screen().includes('2 configured hooks'), 1500))
  writeFileSync(file, JSON.stringify({ events: { hooks, disabled: true } }))
  settingsChangeDetector.notifyChange('userSettings')
  check('a user-layer disable refreshes the managed-only policy and count together', await waitFor(() => view.screen().includes('Only hooks from managed settings can run right now.') && view.screen().includes('0 configured hooks'), 1500))
} finally {
  view.unmount()
  await settle(50)
  await releaseScratchHome(home)
}
console.log(`${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
