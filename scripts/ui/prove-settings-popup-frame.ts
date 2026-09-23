#!/usr/bin/env bun
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-settings-popup-frame')

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
const { SettingsPopupSlot, settingsPopupGeometry, SETTINGS_POPUP_CHROME_ROWS } = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_POPUP_ROWS, CONFIG_POPUP_WIDTH, CONFIG_SEARCH_PLACEHOLDER, CONFIG_LIST_CHROME_ROWS, CONFIG_ROW_MARK } = await import('../../src/components/Settings/Config.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const context = { messages: [], options: {} } as never

async function mountPopup(columns: number, rows: number): Promise<Mounted> {
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(
      ThemeProvider as never,
      {},
      React.createElement(Box, { flexDirection: 'column', width: columns, height: rows }, React.createElement(SettingsPopupSlot, { overlay: true })),
    ),
  )
  const m = await mountOffscreen(element, columns, rows)
  store.openSettingsPopup(configPopupRequest(context))
  await waitFor(() => m.screen().includes('Mercury · config'), 4000)
  await settle(150)
  return m
}

type Frame = { top: number; left: number; width: number; height: number; rows: string[] }

function popupFrame(lines: string[], geometry: { left: number; width: number }): Frame | null {
  const top = lines.findIndex(line => Array.from(line)[geometry.left] === '╭')
  if (top === -1) return null
  let bottom = top
  for (let y = top + 1; y < lines.length; y++) {
    if (Array.from(lines[y]!)[geometry.left] === '╰') {
      bottom = y
      break
    }
  }
  if (bottom === top) return null
  const rows = lines.slice(top, bottom + 1).map(line => Array.from(line).slice(geometry.left, geometry.left + geometry.width).join(''))
  return { top, left: geometry.left, width: geometry.width, height: bottom - top + 1, rows }
}

function inner(row: string): string {
  return row.slice(2, -2).replace(/\s+$/, '')
}

async function frameAt(columns: number, rows: number): Promise<{ m: Mounted; frame: Frame | null; geometry: ReturnType<typeof settingsPopupGeometry> }> {
  const m = await mountPopup(columns, rows)
  const geometry = settingsPopupGeometry({ width: CONFIG_POPUP_WIDTH, rows: CONFIG_POPUP_ROWS }, columns, rows)
  const frame = popupFrame(m.lines(), geometry)
  return { m, frame, geometry }
}

section('§1 the frame at 178×51: the page\'s rows, row for row')
{
  const { m, frame, geometry } = await frameAt(178, 51)
  check('the popup painted', frame !== null, m.screen().slice(0, 400))
  if (frame !== null) {
    check('110 columns wide, 44 rows tall (rows 5–48 of 51)', frame.width === 110 && frame.height === 44 && frame.top === 4, `${frame.width}×${frame.height} at row ${frame.top + 1}`)
    check('centred on the terminal: left column 34', frame.left === 34 && geometry.left === 34)
    check('the top border is a round corner run', frame.rows[0] === `╭${'─'.repeat(108)}╮`, frame.rows[0])
    check('the bottom border is a round corner run', frame.rows[43] === `╰${'─'.repeat(108)}╯`, frame.rows[43])
    check('every body row keeps both border cells', frame.rows.slice(1, 43).every(row => row.startsWith('│') && row.endsWith('│')))
    check('row 1: the lockup "Mercury · config" after the sprite mark', /^│ \S+ Mercury · config\s+│$/.test(frame.rows[1]!), frame.rows[1])
    check('row 2: the context line "<folder> · N settings · k set by you"', /^[^ ·]+ · \d+ settings · \d+ set by you$/.test(inner(frame.rows[2]!)), inner(frame.rows[2]!))
    check('row 3: blank', inner(frame.rows[3]!) === '')
    check(`row 4: the search row "/ ${CONFIG_SEARCH_PLACEHOLDER}"`, inner(frame.rows[4]!) === `/ ${CONFIG_SEARCH_PLACEHOLDER}`, inner(frame.rows[4]!))
    check('row 5: blank', inner(frame.rows[5]!) === '')
    check(`row 6: the first setting selected with the page's mark "${CONFIG_ROW_MARK}"`, inner(frame.rows[6]!).startsWith(`${CONFIG_ROW_MARK} Auto-compact`), inner(frame.rows[6]!))
    check('rows 7–39: settings rows, none selected', frame.rows.slice(7, 40).every(row => inner(row).startsWith('  ') && !inner(row).startsWith(CONFIG_ROW_MARK)))
    const settings = Number(/(\d+) settings/.exec(inner(frame.rows[2]!))?.[1] ?? 0)
    const windowRows = CONFIG_POPUP_ROWS - SETTINGS_POPUP_CHROME_ROWS - CONFIG_LIST_CHROME_ROWS
    check('34 list rows show at a time', windowRows === 34)
    check(`row 40: "↓ ${settings - 34} more" (the rows not shown, from the line's own count ${settings})`, inner(frame.rows[40]!) === `↓ ${settings - 34} more`, inner(frame.rows[40]!))
    check('row 41: blank', inner(frame.rows[41]!) === '')
    check('row 42, the last body row: the hint row verbatim', inner(frame.rows[42]!) === CONFIG_POPUP_HINT, inner(frame.rows[42]!))
    check('the label column is 36 cells (the mark and a 34-cell label): the value starts at cell 36 of the row, as the page draws it', frame.rows[6]!.slice(2 + 36).startsWith('on') && frame.rows[6]!.slice(2 + 35, 2 + 36) === ' ', JSON.stringify(frame.rows[6]!.slice(2, 2 + 50)))
    const longest = frame.rows.slice(6, 40).map(row => inner(row)).find(row => row.startsWith('  Respect .gitignore in file picker'))
    check('the longest label still fits before the value column with one cell to spare', longest !== undefined && longest.slice(36).startsWith('on') && longest.slice(35, 36) === ' ', longest)
    const band = Array.from({ length: 108 }, (_, i) => m.styleAt(frame.left + 1 + i, frame.top + 6)?.bg ?? 'none')
    const outside = [m.styleAt(frame.left, frame.top + 6)?.bg ?? 'none', m.styleAt(frame.left + 109, frame.top + 6)?.bg ?? 'none']
    const unselected = m.styleAt(frame.left + 1, frame.top + 7)?.bg ?? 'none'
    check('the selection band spans the 108 cells between the borders, one paint', new Set(band).size === 1 && band[0] !== unselected, `${band[0]} vs row below ${unselected}; distinct paints ${new Set(band).size}`)
    check('the band stops at the border cells', outside.every(bg => bg !== band[0]), outside.join(','))
  }
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§2 the frame at 120×40: the box clamps to the terminal rows and stays centred')
{
  const { m, frame, geometry } = await frameAt(120, 40)
  check('the popup painted', frame !== null)
  if (frame !== null) {
    check('110 columns wide, 40 rows tall (the terminal\'s height), from row 1', frame.width === 110 && frame.height === 40 && frame.top === 0, `${frame.width}×${frame.height} at row ${frame.top + 1}`)
    check('centred: left column 5', frame.left === 5 && geometry.left === 5)
    check('row 1 the lockup, row 3 blank, row 4 the search row', /Mercury · config/.test(frame.rows[1]!) && inner(frame.rows[3]!) === '' && inner(frame.rows[4]!).startsWith('/ '))
    check('the last body row is the hint, the row before it blank', inner(frame.rows[38]!) === CONFIG_POPUP_HINT && inner(frame.rows[37]!) === '')
    const settings = Number(/(\d+) settings/.exec(inner(frame.rows[2]!))?.[1] ?? 0)
    check(`the more row counts the rows past a 30-row window: "↓ ${settings - 30} more"`, inner(frame.rows[36]!) === `↓ ${settings - 30} more`, inner(frame.rows[36]!))
    check('no row paints outside the frame', m.lines().every(line => Array.from(line).length <= 120))
  }
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§3 the frame at 100×30: the width clamps too; the chrome rows hold; nothing overflows the border')
{
  const { m, frame } = await frameAt(100, 30)
  check('the popup painted', frame !== null)
  if (frame !== null) {
    check('100 columns wide, 30 rows tall, at column 0 row 1', frame.width === 100 && frame.height === 30 && frame.left === 0 && frame.top === 0, `${frame.width}×${frame.height} at ${frame.left},${frame.top}`)
    check('the border corners close', frame.rows[0]!.startsWith('╭') && frame.rows[0]!.endsWith('╮') && frame.rows[29]!.startsWith('╰') && frame.rows[29]!.endsWith('╯'))
    check('every body row keeps both border cells', frame.rows.slice(1, 29).every(row => row.startsWith('│') && row.endsWith('│')))
    check('the hint row is cut to the inner width, never wrapped', inner(frame.rows[28]!).length <= 96 && inner(frame.rows[27]!) === '')
    const settings = Number(/(\d+) settings/.exec(inner(frame.rows[2]!))?.[1] ?? 0)
    check(`the more row counts the rows past a 20-row window: "↓ ${settings - 20} more"`, inner(frame.rows[26]!) === `↓ ${settings - 20} more`, inner(frame.rows[26]!))
  }
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

section('§4 the geometry, pure')
{
  const g178 = settingsPopupGeometry({ width: 110, rows: 44 }, 178, 51)
  check('178×51: width 110, left 34, rows 44, top 4 (ceil centring), budget 37, inner 106', g178.width === 110 && g178.left === 34 && g178.rows === 44 && g178.top === 4 && g178.rowBudget === 37 && g178.inner === 106, JSON.stringify(g178))
  const g120 = settingsPopupGeometry({ width: 110, rows: 44 }, 120, 40)
  check('120×40: rows clamp to 40, top 0, budget 33', g120.rows === 40 && g120.top === 0 && g120.rowBudget === 33 && g120.left === 5, JSON.stringify(g120))
  const g100 = settingsPopupGeometry({ width: 110, rows: 44 }, 100, 30)
  check('100×30: width clamps to 100, inner 96, rows 30, budget 23', g100.width === 100 && g100.inner === 96 && g100.rows === 30 && g100.rowBudget === 23, JSON.stringify(g100))
  const tiny = settingsPopupGeometry({ width: 110, rows: 44 }, 20, 6)
  check('a tiny terminal: the budget never drops below 1 and the chrome stays 7 rows', tiny.rowBudget >= 1 && SETTINGS_POPUP_CHROME_ROWS === 7, JSON.stringify(tiny))
  const content = settingsPopupGeometry({ width: 110, rows: null }, 178, 51)
  check('a content-sized popup: rows null, budget = terminal rows − chrome, top settled by the measured height', content.rows === null && content.rowBudget === 44 && content.top === null, JSON.stringify(content))
  const usage = settingsPopupGeometry({ width: 150, rows: 29 }, 178, 51)
  check('usage at 178×51: 150 wide at column 14, 29 rows from row 12 (ceil)', usage.width === 150 && usage.left === 14 && usage.rows === 29 && usage.top === 11, JSON.stringify(usage))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-settings-popup-frame: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
