#!/usr/bin/env bun
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-session-mode-row')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
const settings = await import('../../src/utils/settings/settings.js')
const state = await import('../../src/bootstrap/state.js')
enableConfigs()

const COLS = 178
const ROWS = 51
const LEFT = 34
const TOP = 4
const ROW = 'Default permission mode'
const SESSION_WORDS = 'this session:'
const NEXT_BOOT_WORDS = 'the saved switch governs the next boot, never this one'

type Birth = { mode: 'default' | 'implement' | 'apollo' | 'flow' | 'dontAsk' | 'sovereign'; source: 'launch-flag' | 'mode-argument' | 'saved-settings' | 'session-birth' | 'session-choice' | 'default' }

async function openPopup(sessionMode: Birth['mode'], birth: Birth): Promise<Mounted> {
  state.setSessionPermissionModeResolution(birth)
  const initial = getDefaultAppState()
  const seeded = { ...initial, toolPermissionContext: { ...initial.toolPermissionContext, mode: sessionMode } }
  const element = React.createElement(
    AppStateProvider as never,
    { initialState: seeded },
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  await settle(120)
  return m
}
const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
const rowLine = (m: Mounted): string => innerOf(m.lines()[TOP + 6] ?? '').trim()
const belowRow = (m: Mounted): string =>
  [TOP + 7, TOP + 8, TOP + 9]
    .map(index => innerOf(m.lines()[index] ?? '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
const shown = (m: Mounted): string => rowLine(m).replace(`${CONFIG_ROW_MARK} ${ROW}`, '').trim()
async function selectRow(m: Mounted): Promise<void> {
  m.push('/')
  await settle(60)
  for (const ch of 'default permission mode') {
    m.push(ch)
    await settle(25)
  }
  await settle(100)
  m.push(KEY.down)
  await settle(160)
}
async function close(m: Mounted): Promise<void> {
  m.push(KEY.esc)
  await settle(120)
  m.unmount()
  await settle(40)
}

const seeded = settings.updateSettingsForSource('userSettings', { guardrails: { mode: 'flow' } } as never)
if (seeded.error !== null) throw new Error(`seed flow: ${String(seeded.error)}`)

console.log('§1 a saved default of flow, a session born sovereign by its launch flag: the row names both, the selected row explains')
{
  const m = await openPopup('sovereign', { mode: 'sovereign', source: 'launch-flag' })
  await selectRow(m)
  check('the row reads the saved word and the session word: Flow · this session: Sovereign Mode', rowLine(m).startsWith(`${CONFIG_ROW_MARK} ${ROW}`) && shown(m) === 'Flow · this session: Sovereign Mode', rowLine(m))
  check(
    'the selected row carries the explanation: this session: Sovereign Mode · from the launch flag; the saved switch governs the next boot, never this one',
    belowRow(m).startsWith('this session: Sovereign Mode · from the launch flag; the saved switch governs the next boot, never this one'),
    belowRow(m),
  )
  await close(m)
}

console.log('§2 a saved default of flow, a session born implement by its mode argument: the same shape, its own source')
{
  const m = await openPopup('implement', { mode: 'implement', source: 'mode-argument' })
  await selectRow(m)
  check('the row reads Flow · this session: Implement Mode', shown(m) === 'Flow · this session: Implement Mode', rowLine(m))
  check(
    'the selected row names the mode argument as the source',
    belowRow(m).startsWith('this session: Implement Mode · from the mode argument; the saved switch governs the next boot, never this one'),
    belowRow(m),
  )
  await close(m)
}

console.log("§3 silent: the user's own switch inside the session (born flow from the saved settings, now implement) shows the saved word alone")
{
  const m = await openPopup('implement', { mode: 'flow', source: 'saved-settings' })
  await selectRow(m)
  check('the row reads Flow and nothing more', shown(m) === 'Flow', rowLine(m))
  check('no session words on the row', !rowLine(m).includes(SESSION_WORDS), rowLine(m))
  check('no explanation under the selected row', !belowRow(m).includes(SESSION_WORDS) && !belowRow(m).includes(NEXT_BOOT_WORDS), belowRow(m))
  await close(m)
}

console.log('§4 silent: the session and the saved default agree (both flow) — the saved word alone')
{
  const m = await openPopup('flow', { mode: 'flow', source: 'saved-settings' })
  await selectRow(m)
  check('the row reads Flow and nothing more', shown(m) === 'Flow', rowLine(m))
  check('no session words on the row', !rowLine(m).includes(SESSION_WORDS), rowLine(m))
  check('no explanation under the selected row', !belowRow(m).includes(SESSION_WORDS) && !belowRow(m).includes(NEXT_BOOT_WORDS), belowRow(m))
  await close(m)
}

console.log('§5 the row is not selected: the explanation stays off the screen while the session words stay on the row')
{
  const m = await openPopup('sovereign', { mode: 'sovereign', source: 'launch-flag' })
  const screen = m.screen()
  check('the row carries the session words before any selection', screen.includes('Flow · this session: Sovereign Mode'), screen.split('\n').find(line => line.includes(ROW)) ?? '')
  check('the explanation is not painted until the row is selected', !screen.includes(NEXT_BOOT_WORDS))
  await close(m)
}

await releaseScratchHome(HOME)
if (failures > 0) {
  console.error(`\nprove-config-session-mode-row: ${failures} FAILED`)
  process.exit(1)
}
console.log('\nprove-config-session-mode-row: all green')
