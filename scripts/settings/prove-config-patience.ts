#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'
import type { DOMElement } from '../../src/ink.js'

pinSourceRef()
const home = pinScratchHome('config-patience')
process.chdir(home)
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
enableConfigs()
let failures = 0
function check(label: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
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
    check(`${columns}x${rows}: config opened`, await waitFor(() => mounted.screen().includes('Mercury · config'), 4000))
    mounted.push('patience')
    check(`${columns}x${rows}: the Patience search is committed`, await waitFor(() => mounted.screen().includes('/ patience') && mounted.screen().includes('Patience with a quiet model'), 4000))
    mounted.push(KEY.enter)
    for (const mode of ['normal', 'patient', 'custom'] as const) {
      check(`${columns}x${rows}: ${mode} renders on the selected row`, await waitFor(() => mounted.lines().some(line => line.includes('› Patience with a quiet model') && line.includes(` ${mode} `)), 4000))
      if (columns === 178) {
        check(`${mode}: the rendered help promises every provider`, await waitFor(() => mounted.screen().includes('applies to every provider'), 4000))
        check(`${mode}: the value names the quiet budget without a provider exclusion`, mounted.screen().includes('(quiet ') && !mounted.screen().includes('(OpenAI '))
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
