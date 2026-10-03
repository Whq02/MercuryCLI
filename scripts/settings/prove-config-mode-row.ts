#!/usr/bin/env bun
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-mode-row')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
const settings = await import('../../src/utils/settings/settings.js')
const { PERMISSION_MODES, permissionModeTitle } = await import('../../src/utils/permissions/PermissionMode.js')
enableConfigs()

const COLS = 178
const ROWS = 51
const LEFT = 34
const TOP = 4
const ROW = 'Default permission mode'

async function openPopup(): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  await settle(120)
  return m
}
const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
const firstRow = (m: Mounted): string => innerOf(m.lines()[TOP + 6] ?? '').trim()
const savedMode = (): unknown => settings.getSettingsForSource('userSettings')?.guardrails?.mode
const seed = (mode: string | undefined): void => {
  const written = settings.updateSettingsForSource('userSettings', { guardrails: { mode } } as never)
  if (written.error !== null) throw new Error(`seed ${String(mode)}: ${String(written.error)}`)
}
async function selectRow(m: Mounted): Promise<void> {
  m.push('/')
  await settle(60)
  for (const ch of 'default permission mode') {
    m.push(ch)
    await settle(25)
  }
  await settle(100)
  m.push(KEY.down)
  await settle(120)
}
const shown = (m: Mounted): string => firstRow(m).replace(`${CONFIG_ROW_MARK} ${ROW}`, '').trim()

console.log('§1 the row shows the saved word for every mode the schema accepts')
for (const mode of PERMISSION_MODES) {
  seed(mode)
  const m = await openPopup()
  await selectRow(m)
  check(`a saved guardrails.mode of ${mode} shows ${permissionModeTitle(mode)}`, firstRow(m).startsWith(`${CONFIG_ROW_MARK} ${ROW}`) && shown(m) === permissionModeTitle(mode), firstRow(m))
  m.push(KEY.esc)
  await settle(120)
  m.unmount()
  await settle(40)
}

console.log('§2 → walks default → implement → apollo → flow → dontAsk → default; sovereign is never offered')
{
  seed(undefined)
  const m = await openPopup()
  await selectRow(m)
  check('an unset mode shows Default', shown(m) === permissionModeTitle('default'), firstRow(m))
  const walk: string[] = []
  for (let step = 0; step < 5; step++) {
    m.push(KEY.right)
    await settle(160)
    walk.push(String(savedMode()))
  }
  check('five steps save implement, apollo, flow, dontAsk and come back to default', JSON.stringify(walk) === JSON.stringify(['implement', 'apollo', 'flow', 'dontAsk', 'default']), JSON.stringify(walk))
  check('the row shows the word it just saved', shown(m) === permissionModeTitle('default'), firstRow(m))
  m.push(KEY.left)
  await settle(160)
  check('← from default lands on dontAsk, not sovereign', savedMode() === 'dontAsk' && shown(m) === permissionModeTitle('dontAsk'), `${String(savedMode())} · ${firstRow(m)}`)
  m.push(KEY.enter)
  await settle(160)
  check('↵ keeps the saved word', !store.isSettingsPopupOpen() && savedMode() === 'dontAsk', String(savedMode()))
  m.unmount()
  await settle(40)
}

console.log('§3 a saved sovereign (a hand edit) shows its own title and the next step leaves it')
{
  seed('sovereign')
  const m = await openPopup()
  await selectRow(m)
  check('the row shows Sovereign Mode, the word the file holds', shown(m) === permissionModeTitle('sovereign'), firstRow(m))
  m.push(KEY.right)
  await settle(160)
  check('→ from sovereign saves implement (the step after default in the offered order)', savedMode() === 'implement', String(savedMode()))
  m.push(KEY.enter)
  await settle(160)
  m.unmount()
  await settle(40)
}

await releaseScratchHome(HOME)
if (failures > 0) {
  console.error(`\nprove-config-mode-row: ${failures} FAILED`)
  process.exit(1)
}
console.log('\nprove-config-mode-row: all green')
