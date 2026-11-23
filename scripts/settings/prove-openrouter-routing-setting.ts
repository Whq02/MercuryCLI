#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from 'node:fs'
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
const { SettingsSchema } = await import('../../src/platform/settings/settingsSchema.js')
const schema = SettingsSchema()
const routingShape = (schema.shape.routing as { unwrap?: () => { shape?: Record<string, unknown> } }).unwrap?.()?.shape ?? {}
check('routing setting is a declared schema property', 'openrouter' in routingShape, 'declare routing.openrouter as a z.object in SettingsSchema in src/platform/settings/settingsSchema.ts')
for (const value of [null, true, 'deny', { dataCollection: 'log' }, { requireParameters: 'true' }, { allowFallbacks: 0 }, { zeroDataRetention: 1 }]) {
  check(`invalid routing setting refused: ${JSON.stringify(value)}`, !schema.safeParse({ routing: { openrouter: value } }).success, 'tighten the routing.openrouter z.object in SettingsSchema (src/platform/settings/settingsSchema.ts) so this value is refused')
}
for (const dataCollection of ['allow', 'deny']) for (const requireParameters of [false, true]) for (const allowFallbacks of [false, true]) for (const zeroDataRetention of [false, true]) {
  check('all four valid knobs pass validation', schema.safeParse({ routing: { openrouter: { dataCollection, requireParameters, allowFallbacks, zeroDataRetention } } }).success, 'loosen the routing.openrouter z.object in SettingsSchema (src/platform/settings/settingsSchema.ts) so every valid combination parses: ' + JSON.stringify({ dataCollection, requireParameters, allowFallbacks, zeroDataRetention }))
}
check('absent and empty routing settings validate', schema.safeParse({}).success && schema.safeParse({ routing: { openrouter: {} } }).success, 'make routing and each routing.openrouter field optional in SettingsSchema (src/platform/settings/settingsSchema.ts)')
const React = await import('react')
const { Box } = await import('../../src/screen/themedRenderer.js')
const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
const { SettingsPopupSlot, settingsPopupGeometry } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
const store = await import('../../src/screen/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK, configRowApplicability } = await import('../../src/screen/settings/Config.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
const { getInitialSettings, updateSettingsForSource } = await import('../../src/platform/settings/settings.js')
enableConfigs()
check('OpenRouter row applies on its own road', configRowApplicability('openrouter' as never, 'openrouter').applies, 'configRowApplicability in src/screen/settings/config/configRowFacts.ts should apply the openrouter row on the openrouter road')
check('OpenRouter row refuses other roads', !configRowApplicability('openrouter' as never, 'deepseek').applies, 'configRowApplicability in src/screen/settings/config/configRowFacts.ts should refuse the openrouter row on other roads')
const stored = (): unknown => getInitialSettings().routing?.openrouter
for (const [columns, rows] of [[178, 51], [80, 21]] as const) {
  updateSettingsForSource('userSettings', { engine: { model: 'openrouter/fixture/model' }, routing: { openrouter: undefined } })
  const element = React.createElement(AppStateProvider as never, {}, React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: columns, height: rows }, React.createElement(SettingsPopupSlot, { overlay: true }))))
  const m = await mountOffscreen(element, columns, rows)
  const request = configPopupRequest({ messages: [], options: {} } as never)
  const hint = store.settingsPopupHintText(CONFIG_POPUP_HINT, settingsPopupGeometry(request, columns, rows).inner)
  store.openSettingsPopup(request)
  check(`${columns}x${rows}: popup opens with its hint row whole (${hint.slice(-10)})`, await waitFor(() => m.screen().includes(hint), 5000))
  m.push('OpenRouter routing policy')
  await waitFor(() => m.screen().includes('/ OpenRouter routing policy') && m.lines().some(line => line.includes('  OpenRouter routing policy ')), 5000)
  m.push(KEY.enter)
  const found = await waitFor(() => m.screen().includes(`${CONFIG_ROW_MARK} OpenRouter routing policy`), 5000)
  check(`${columns}x${rows}: routing row exists`, found, 'the routing.openrouter row (label OpenRouter routing policy) in src/screen/settings/config/configRowsEngine.tsx did not appear in the popup; screen: ' + m.screen())
  check(`${columns}x${rows}: absent setting displays deny and required parameters, never no policy`, m.screen().includes('deny · parameters required') && !m.screen().includes('no request policy'), 'the routing.openrouter row value in src/screen/settings/config/configRowsEngine.tsx must default to deny and parameters required; screen: ' + m.screen())
  if (columns >= 100) check('the absent setting displays fallbacks on and ZDR off', m.screen().includes('fallbacks on · ZDR off'), 'the routing.openrouter row value in src/screen/settings/config/configRowsEngine.tsx must default to fallbacks on and ZDR off')
  if (frames) writeFileSync(join(frames, `config-routing-${columns}x${rows}.txt`), m.lines().join('\n') + '\n')
  if (found) {
    for (let i = 0; i < 3; i++) {
      const before = JSON.stringify(stored())
      m.push(KEY.right)
      check(`${columns}x${rows}: cycle ${i + 1} persists a valid user setting`, await waitFor(() => JSON.stringify(stored()) !== before, 5000) && schema.safeParse({ routing: { openrouter: stored() } }).success, 'the change handler of the routing.openrouter row in src/screen/settings/config/configRowsEngine.tsx must write a schema-valid user setting on right; stored: ' + JSON.stringify(stored()))
      if (i === 0) check('right from the absent balanced default explicitly relaxes all four knobs', JSON.stringify(stored()) === '{"dataCollection":"allow","requireParameters":false,"allowFallbacks":true,"zeroDataRetention":false}', 'the change handler of the routing.openrouter row in src/screen/settings/config/configRowsEngine.tsx must step balanced to open and write all four knobs; stored: ' + JSON.stringify(stored()))
    }
    check(`${columns}x${rows}: all four fields persisted`, Object.keys((stored() ?? {}) as object).length === 4, 'the change handler of the routing.openrouter row in src/screen/settings/config/configRowsEngine.tsx must write all four knobs; stored: ' + JSON.stringify(stored()))
    m.push(KEY.esc)
    check(`${columns}x${rows}: escape restores absent setting`, await waitFor(() => stored() === undefined, 5000), 'escape from the settings popup should restore the absent routing.openrouter setting; stored: ' + JSON.stringify(stored()))
  }
  m.unmount()
  store.closeSettingsPopup()
}
await releaseScratchHome(home)
console.log(`prove-openrouter-routing-setting: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
