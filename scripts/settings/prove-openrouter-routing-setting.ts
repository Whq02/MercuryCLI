#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, waitFor } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const home = pinScratchHome('openrouter-routing-setting')
process.env.HOME = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
const frameAt = process.argv.indexOf('--frames')
const frames = frameAt < 0 ? undefined : process.argv[frameAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const { SettingsSchema } = await import('../../src/utils/settings/types.js')
const schema = SettingsSchema()
check('routing setting is a declared schema property', 'openrouterRouting' in schema.shape)
for (const value of [null, true, 'deny', { dataCollection: 'log' }, { requireParameters: 'true' }, { allowFallbacks: 0 }, { zeroDataRetention: 1 }]) {
  check(`invalid routing setting refused: ${JSON.stringify(value)}`, !schema.safeParse({ openrouterRouting: value }).success)
}
for (const dataCollection of ['allow', 'deny']) for (const requireParameters of [false, true]) for (const allowFallbacks of [false, true]) for (const zeroDataRetention of [false, true]) {
  check('all four valid knobs pass validation', schema.safeParse({ openrouterRouting: { dataCollection, requireParameters, allowFallbacks, zeroDataRetention } }).success)
}
check('absent and empty routing settings validate', schema.safeParse({}).success && schema.safeParse({ openrouterRouting: {} }).success)
const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK, configRowApplicability } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
const { getInitialSettings, updateSettingsForSource } = await import('../../src/utils/settings/settings.js')
enableConfigs()
check('OpenRouter row applies on its own road', configRowApplicability('openrouter' as never, 'openrouter').applies)
check('OpenRouter row refuses other roads', !configRowApplicability('openrouter' as never, 'deepseek').applies)
const stored = (): unknown => getInitialSettings().openrouterRouting
for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
  updateSettingsForSource('userSettings', { model: 'openrouter/fixture/model', openrouterRouting: undefined } as never)
  const element = React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: rows }, React.createElement(SettingsPopupSlot, { overlay: true }))))
  const m = await mountOffscreen(element, columns, rows)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  check(`${columns}x${rows}: popup opens`, await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT.slice(-20)), 5000))
  m.push('OpenRouter routing policy')
  await waitFor(() => m.screen().includes('/ OpenRouter routing policy') && m.lines().some(line => line.includes('  OpenRouter routing policy ')), 5000)
  m.push(KEY.enter)
  const found = await waitFor(() => m.screen().includes(`${CONFIG_ROW_MARK} OpenRouter routing policy`), 5000)
  check(`${columns}x${rows}: routing row exists`, found, m.screen())
  check(`${columns}x${rows}: absent setting displays deny and required parameters, never no policy`, m.screen().includes('deny · parameters required') && !m.screen().includes('no request policy'), m.screen())
  if (columns >= 100) check('the absent setting displays fallbacks on and ZDR off', m.screen().includes('fallbacks on · ZDR off'))
  if (frames) writeFileSync(join(frames, `config-routing-${columns}x${rows}.txt`), m.lines().join('\n') + '\n')
  if (found) {
    for (let i = 0; i < 3; i++) {
      const before = JSON.stringify(stored())
      m.push(KEY.right)
      check(`${columns}x${rows}: cycle ${i + 1} persists a valid user setting`, await waitFor(() => JSON.stringify(stored()) !== before, 5000) && schema.safeParse({ openrouterRouting: stored() }).success, JSON.stringify(stored()))
      if (i === 0) check('right from the absent balanced default explicitly relaxes all four knobs', JSON.stringify(stored()) === '{"dataCollection":"allow","requireParameters":false,"allowFallbacks":true,"zeroDataRetention":false}', JSON.stringify(stored()))
    }
    check(`${columns}x${rows}: all four fields persisted`, Object.keys((stored() ?? {}) as object).length === 4)
    m.push(KEY.esc)
    check(`${columns}x${rows}: escape restores absent setting`, await waitFor(() => stored() === undefined, 5000), JSON.stringify(stored()))
  }
  m.unmount()
  store.closeSettingsPopup()
}
check('Config snapshots the user setting for escape', readFileSync(join(import.meta.dir, '../../src/components/Settings/Config.tsx'), 'utf8').includes('openrouterRouting: user.openrouterRouting'))
await releaseScratchHome(home)
console.log(`prove-openrouter-routing-setting: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
