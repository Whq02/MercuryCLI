#!/usr/bin/env bun
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-popup-esc')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const React = await import('react')
const { Box } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_SEARCH_PLACEHOLDER, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const { settingsPopupReceipt } = await import('../../src/components/Settings/Settings.js')
const { enableConfigs, getGlobalConfig } = await import('../../src/utils/config/globalConfig.js')
const { escapeFromOutsidePress } = await import('../../src/ink/recessLayer.js')
const OUTSIDE_PRESS = '\x1b[<0;2;2M'
const OUTSIDE_RELEASE = '\x1b[<0;2;2m'
enableConfigs()

const COLS = 178
const ROWS = 51
const LEFT = 34
const TOP = 4
type Notice = { key?: string; text: string; priority?: string }
let notices: Notice[] = []

async function openPopup(): Promise<Mounted> {
  notices = []
  const element = React.createElement(
    AppStateProvider as never,
    {
      onChangeAppState: ({ newState: state }: { newState: { notifications?: { current?: Notice | null; queue?: Notice[] } } }) => {
        const current = state.notifications?.current
        if (current && !notices.some(n => n.text === current.text)) notices.push(current)
        for (const queued of state.notifications?.queue ?? []) if (!notices.some(n => n.text === queued.text)) notices.push(queued)
      },
    },
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
const searchRow = (m: Mounted): string => innerOf(m.lines()[TOP + 4] ?? '').trim()
const popupUp = (m: Mounted): boolean => store.isSettingsPopupOpen() && m.screen().includes(CONFIG_POPUP_HINT)
const savedAutoCompact = (): string => {
  const value = getGlobalConfig().autoCompactEnabled
  return value === undefined ? 'unset' : String(value)
}

section('§1 a clean config: esc closes')
{
  const m = await openPopup()
  check('the popup opens in list mode with row 0 selected', firstRow(m).startsWith(`${CONFIG_ROW_MARK} Auto-compact`) && firstRow(m).endsWith('on'), firstRow(m))
  m.push(KEY.esc)
  await settle(120)
  check('one esc closes the popup', !store.isSettingsPopupOpen() && !m.screen().includes(CONFIG_POPUP_HINT))
  check('a dismissal posts no receipt', notices.length === 0, JSON.stringify(notices))
  m.unmount()
  await settle(40)
}

section('§2 a dirty config: esc reverts and stays, a second esc closes')
{
  const before = savedAutoCompact()
  const m = await openPopup()
  m.push(KEY.right)
  await settle(120)
  check('→ on Auto-compact toggles the row to off (the write lands at once)', firstRow(m).endsWith('off') && savedAutoCompact() === 'false', `${firstRow(m)} · saved ${savedAutoCompact()}`)
  m.push(KEY.esc)
  await settle(160)
  check('the first esc REVERTS the change and the popup STAYS', popupUp(m) && firstRow(m).endsWith('on'), `${firstRow(m)} · open ${store.isSettingsPopupOpen()}`)
  check('the saved key is back to its mount-time value', savedAutoCompact() === before, `${savedAutoCompact()} vs ${before}`)
  check('row 0 is still the selected row after the revert', firstRow(m).startsWith(`${CONFIG_ROW_MARK} `))
  m.push(KEY.esc)
  await settle(120)
  check('the second esc closes', !store.isSettingsPopupOpen())
  check('no receipt on the dismissal', notices.length === 0, JSON.stringify(notices))
  m.unmount()
  await settle(40)
}

section('§3 enter saves and closes with the summary receipt')
{
  const before = savedAutoCompact()
  const m = await openPopup()
  m.push(KEY.right)
  await settle(120)
  m.push(KEY.enter)
  await settle(160)
  check('↵ closes the popup', !store.isSettingsPopupOpen())
  check('the change stays saved', savedAutoCompact() === 'false', savedAutoCompact())
  check('the one-line summary rides the notification channel under the command key', notices.some(n => n.key === 'command-config' && n.text === 'set auto-compact to off' && n.priority === 'immediate'), JSON.stringify(notices))
  m.unmount()
  await settle(40)
  const undo = await openPopup()
  undo.push(KEY.right)
  await settle(120)
  undo.push(KEY.enter)
  await settle(160)
  check('the mirror change restores the key for the next leg', savedAutoCompact() === before || (before === 'unset' && savedAutoCompact() === 'true'), savedAutoCompact())
  undo.unmount()
  await settle(40)
}

section('§4 a click outside with an unsaved change reverts AND closes (a dismissal never saves)')
{
  const before = savedAutoCompact()
  const m = await openPopup()
  m.push(KEY.right)
  await settle(120)
  check('the toggle landed', firstRow(m).endsWith('off'))
  check('the flag reads false outside a press', escapeFromOutsidePress() === false)
  m.push(OUTSIDE_PRESS)
  await settle(160)
  check('a mouse press outside the frame closes the popup in one go (the real road: the press sends the escape)', !store.isSettingsPopupOpen())
  m.push(OUTSIDE_RELEASE)
  await settle(40)
  check('…and the change is reverted on disk', savedAutoCompact() === before, `${savedAutoCompact()} vs ${before}`)
  check('the flag is cleared after the press', escapeFromOutsidePress() === false)
  check('no receipt', notices.length === 0, JSON.stringify(notices))
  m.unmount()
  await settle(40)
}

section('§5 search mode: esc clears the query first; the outside press still dismisses')
{
  const m = await openPopup()
  m.push('/')
  await settle(60)
  m.push('t')
  await settle(40)
  m.push('h')
  await settle(80)
  check('/ then typing filters the list', searchRow(m).startsWith('/ th') && !firstRow(m).startsWith(`${CONFIG_ROW_MARK} `), `${searchRow(m)} · ${firstRow(m)}`)
  m.push(KEY.esc)
  await settle(100)
  check('esc clears the query and the popup stays', popupUp(m) && searchRow(m) === `/ ${CONFIG_SEARCH_PLACEHOLDER}`, searchRow(m))
  m.push(KEY.esc)
  await settle(120)
  check('esc on the empty clean search closes', !store.isSettingsPopupOpen())
  m.unmount()
  await settle(40)
  const n = await openPopup()
  n.push('/')
  await settle(60)
  n.push('a')
  await settle(60)
  n.push(OUTSIDE_PRESS)
  await settle(120)
  check('an outside press in search mode closes at once', !store.isSettingsPopupOpen())
  n.push(OUTSIDE_RELEASE)
  await settle(40)
  n.unmount()
  await settle(40)
}

section('§6 the receipt seam and the outside-press seam')
{
  const posted: Notice[] = []
  const rows: string[] = []
  check('no summary posts nothing', settingsPopupReceipt('config', '', n => posted.push(n), {}) === 'none' && posted.length === 0)
  check('one line posts a notification under the command key, priority immediate', settingsPopupReceipt('config', 'set tips to off', n => posted.push(n), {}) === 'notification' && posted[0]?.key === 'command-config' && posted[0]?.priority === 'immediate')
  const painted = settingsPopupReceipt('config', 'set tips to off\nset motion to full', n => posted.push(n), { addDisplayRow: row => rows.push(JSON.stringify(row)) })
  check('several lines paint the two display rows on a chat that paints rows', painted === 'rows' && rows.length === 2 && rows[1]!.includes('set tips to off') && rows[1]!.includes('set motion to full'))
  check('several lines on the blank chat fall back to one notification', settingsPopupReceipt('config', 'a\nb', n => posted.push(n), {}) === 'notification' && posted.length === 2)
  const app = readFileSync(join(REPO, 'src/ink/components/App.tsx'), 'utf8')
  check('the outside press rides dismissByOutsidePress around the same escape it sent before', app.includes('dismissByOutsidePress(() => app.pressEscape())') && !/^\s*app\.pressEscape\(\)\s*$/m.test(app))
  const config = readFileSync(join(REPO, 'src/components/Settings/Config.tsx'), 'utf8')
  check('the config body reads the seam, never a second click road', config.includes('escapeFromOutsidePress()') && !config.includes('onClickOutside'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-config-popup-esc: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
