#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'
import type { DOMElement } from '../../src/screen/themedRenderer.js'

pinSourceRef()
const home = pinScratchHome('config-patience')
process.chdir(home)
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const store = await import('../../src/screen/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
const { updateSettingsForSource } = await import('../../src/platform/settings/settings.js')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.js')
enableConfigs()
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
  updateSettingsForSource('userSettings', { patience: undefined })
  resetSettingsCache()
  const hostRef = React.createRef<DOMElement>()
  const element = React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { width: columns, height: rows, flexDirection: 'column' },
    React.createElement(Box, { ref: hostRef, height: rows - 4, flexShrink: 0 }),
    React.createElement(SettingsPopupSlot, { overlay: true, hostRef, framed: false }),
  )))
  const mounted = await mountOffscreen(element, columns, rows)
  try {
    store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
    check(`${columns}x${rows}: config opened`, await waitFor(() => mounted.screen().includes('Mercury · config'), 4000), 'the config popup did not open: check configPopupRequest in src/commands/config/config.ts and SettingsPopupSlot in src/screen/overlays/SettingsPopupSlot.tsx')
    mounted.push('patience')
    check(`${columns}x${rows}: the Patience search is committed`, await waitFor(() => mounted.screen().includes('/ patience') && mounted.screen().includes('Patience with a quiet model'), 4000), 'the Patience row did not show after searching patience: check the Patience row in src/screen/settings/config/configRowsEngine.tsx')
    mounted.push(KEY.enter)
    for (const mode of ['normal', 'patient', 'custom'] as const) {
      check(`${columns}x${rows}: ${mode} renders on the selected row`, await waitFor(() => mounted.lines().some(line => line.includes('› Patience with a quiet model') && line.includes(` ${mode} `)), 4000), 'the selected Patience row did not show this mode: check the Patience row value and its change handler in src/screen/settings/config/configRowsEngine.tsx')
      if (columns === 178) {
        check(`${mode}: the rendered help promises every provider`, await waitFor(() => mounted.screen().includes('applies to every provider'), 4000), 'the help text of the Patience row in src/screen/settings/config/configRowsEngine.tsx must say it applies to every provider')
        check(`${mode}: the value names the quiet budget without a provider exclusion`, mounted.screen().includes('(quiet ') && !mounted.screen().includes('(OpenAI '), 'the Patience value must show (quiet ...) from patienceWords in src/models/roads/patience.ts and must not name a provider')
      }
      if (frames) writeFileSync(join(frames, `patience-${mode}-${columns}x${rows}.txt`), mounted.lines().join('\n') + '\n')
      if (mode !== 'custom') mounted.push(KEY.right)
    }
  } finally {
    store.closeSettingsPopup()
    mounted.unmount()
  }
}
await releaseScratchHome(home)
console.log(`prove-config-patience: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
