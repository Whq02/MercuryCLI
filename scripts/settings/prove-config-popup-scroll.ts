#!/usr/bin/env bun
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-popup-scroll')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { configListWindow, configMoreRow, configWarningRows, CONFIG_ROW_MARK, CONFIG_POPUP_HINT } = await import('../../src/components/Settings/Config.js')

section('§1 the pure window: 44 rows through a 34-row window')
{
  const TOTAL = 44
  const WINDOW = 34
  let sel = 0
  let off = 0
  let inside = true
  let exact = true
  let hidden: number[] = [TOTAL - WINDOW]
  const start = configListWindow(0, 0, TOTAL, WINDOW)
  check('at the top: row 0 selected, offset 0, 10 hidden below, the list overflows', start.sel === 0 && start.off === 0 && start.hiddenBelow === 10 && start.overflows, JSON.stringify(start))
  check('the more row reads "↓ 10 more" at the top', configMoreRow(start.hiddenBelow) === '↓ 10 more')
  for (let step = 1; step <= TOTAL - 1; step++) {
    const win = configListWindow(sel + 1, off, TOTAL, WINDOW)
    sel = win.sel
    off = win.off
    if (!(sel >= off && sel < off + WINDOW)) inside = false
    if (win.hiddenBelow !== TOTAL - off - WINDOW) exact = false
    hidden.push(win.hiddenBelow)
  }
  check('43 arrow-downs land on row 43 as the selected row', sel === 43, `sel ${sel}`)
  check('the selection index stays inside [offset, offset + 34) after every step', inside)
  check('hiddenBelow equals 44 − offset − 34 at every position', exact)
  check('hiddenBelow reaches 0 at the end (offset 10)', hidden[hidden.length - 1] === 0 && off === 10, `${hidden[hidden.length - 1]} at offset ${off}`)
  check('the more row paints blank at the end of the list', configMoreRow(0) === '')
  check('the highlight walks to the bottom edge first (33 steps at offset 0), then the list moves one row per step', hidden.slice(0, 34).every(h => h === 10) && hidden.slice(34).join(',') === '9,8,7,6,5,4,3,2,1,0', hidden.join(','))
  inside = true
  exact = true
  hidden = []
  for (let step = 1; step <= TOTAL - 1; step++) {
    const win = configListWindow(sel - 1, off, TOTAL, WINDOW)
    sel = win.sel
    off = win.off
    if (!(sel >= off && sel < off + WINDOW)) inside = false
    if (win.hiddenBelow !== TOTAL - off - WINDOW) exact = false
    hidden.push(win.hiddenBelow)
  }
  check('43 arrow-ups return to row 0 at offset 0 the same way', sel === 0 && off === 0 && inside && exact, `sel ${sel} off ${off}`)
  check('the hidden count climbs back to 10 only once the top edge moves', hidden.slice(0, 33).every(h => h === 0) && hidden[hidden.length - 1] === 10, hidden.join(','))
  const past = configListWindow(99, 0, TOTAL, WINDOW)
  check('a selection past the end clamps to the last row with the window at the end', past.sel === 43 && past.off === 10 && past.hiddenBelow === 0)
  const short = configListWindow(3, 0, 5, WINDOW)
  check('a list shorter than the window hides nothing and never overflows', short.off === 0 && short.hiddenBelow === 0 && !short.overflows)
  const empty = configListWindow(0, 0, 0, WINDOW)
  check('an empty list is safe', empty.sel === 0 && empty.off === 0 && empty.hiddenBelow === 0)
  check('a warning row costs the window its wrapped lines', configWarningRows('a', 106) === 1 && configWarningRows('x'.repeat(200), 106) === 2)
}

section('§2 the rendered popup at 178×51, driven through the ink pipeline: every step of the walk')
{
  const React = await import('react')
  const { Box } = await import('../../src/ink.js')
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
  const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.js')
  const store = await import('../../src/utils/cockpit/settingsPopup.js')
  const { configPopupRequest } = await import('../../src/commands/config/config.js')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const COLS = 178
  const ROWS = 51
  const LEFT = 34
  const TOP = 4
  const LIST_FIRST = TOP + 6
  const LIST_ROWS = 34
  const MORE_ROW = TOP + 40
  const element = React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(ThemeProvider as never, {}, React.createElement(Box, { flexDirection: 'column', width: COLS, height: ROWS }, React.createElement(SettingsPopupSlot, { overlay: true }))),
  )
  const m: Mounted = await mountOffscreen(element, COLS, ROWS)
  store.openSettingsPopup(configPopupRequest({ messages: [], options: {} } as never))
  const up = await waitFor(() => m.screen().includes(CONFIG_POPUP_HINT), 4000)
  check('the popup painted with the hint row', up)
  await settle(120)
  const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
  const labelOf = (row: string): string => row.slice(2, 44).trim()
  const readFrame = () => {
    const lines = m.lines()
    const listRows = Array.from({ length: LIST_ROWS }, (_, i) => innerOf(lines[LIST_FIRST + i] ?? ''))
    const more = innerOf(lines[MORE_ROW] ?? '').trim()
    return { listRows, more, hint: innerOf(lines[TOP + 42] ?? '').trim(), lines }
  }
  const total = Number(/(\d+) settings/.exec(m.screen())?.[1] ?? 0)
  check('the context line names the row count', total > LIST_ROWS, `${total} settings`)
  const frames: Array<{ listRows: string[]; more: string }> = []
  const labels: string[] = []
  const markedRows: number[] = []
  const recordStep = (): void => {
    const frame = readFrame()
    frames.push({ listRows: frame.listRows, more: frame.more })
    const marked = frame.listRows.map((row, i) => (row.startsWith(`${CONFIG_ROW_MARK} `) ? i : -1)).filter(i => i >= 0)
    markedRows.push(marked.length === 1 ? marked[0]! : -1)
    labels.push(marked.length === 1 ? labelOf(frame.listRows[marked[0]!]!) : '')
  }
  recordStep()
  for (let step = 1; step < total; step++) {
    m.push(KEY.down)
    await settle(25)
    recordStep()
  }
  const initial = frames[0]!
  check('the first frame: row 0 selected, the more row counts the rest', markedRows[0] === 0 && initial.more === `↓ ${total - LIST_ROWS} more`, `${markedRows[0]} · ${initial.more}`)
  check(`${total - 1} arrow-downs land on the last row as the selected row`, markedRows[total - 1] >= 0 && labels[total - 1] !== '' && new Set(labels).size === total, `${new Set(labels).size} distinct labels over ${total} steps`)
  check('exactly one marked row, inside the 34-row list window, after every step', markedRows.every(i => i >= 0 && i < LIST_ROWS), markedRows.join(','))
  check('the more row paints blank at the end of the list', frames[total - 1]!.more === '', JSON.stringify(frames[total - 1]!.more))
  check('the hint row stays the last body row through the walk', readFrame().hint === CONFIG_POPUP_HINT)
  const known = new Set(labels)
  let contiguous = true
  let exact = true
  let sizeTrue = true
  let selectedInside = true
  const detail: string[] = []
  frames.forEach((frame, k) => {
    const shown = frame.listRows.map(row => (known.has(labelOf(row)) && row.slice(44).trim() !== '' ? labels.indexOf(labelOf(row)) : -1))
    const indices = shown.filter(i => i >= 0)
    const warnings = frame.listRows.filter((row, i) => row.trim() !== '' && shown[i] === -1).length
    const off = indices[0] ?? -1
    const size = indices.length
    for (let i = 1; i < indices.length; i++) if (indices[i] !== indices[i - 1]! + 1) contiguous = false
    if (!(k >= off && k < off + size)) selectedInside = false
    if (size !== Math.min(LIST_ROWS - warnings, total - off)) sizeTrue = false
    const expectMore = configMoreRow(total - off - size)
    if (frame.more !== expectMore) {
      exact = false
      if (detail.length < 4) detail.push(`step ${k}: off ${off} size ${size} warnings ${warnings} more "${frame.more}" expected "${expectMore}"`)
    }
  })
  check('the visible rows are a contiguous run of the catalogue at every step', contiguous)
  check('the selected row is inside the visible run at every step', selectedInside)
  check('the window is 34 rows less the selected row\'s warning rows at every step', sizeTrue)
  check('"↓ n more" is the true remainder (total − offset − window) at every step', exact, detail.join(' | '))
  const downFrames = frames.slice()
  for (let step = 1; step < total; step++) {
    m.push(KEY.up)
    await settle(25)
  }
  await settle(60)
  const back = readFrame()
  check(`${total - 1} arrow-ups walk back to row 0 with the first frame restored`, back.listRows.join('\n') === downFrames[0]!.listRows.join('\n') && back.more === downFrames[0]!.more, back.more)
  m.push(KEY.up)
  await settle(40)
  const search = readFrame()
  check('one more ↑ from row 0 hands the keys to the search row (no row selected, the list unmoved)', !search.listRows.some(row => row.startsWith(`${CONFIG_ROW_MARK} `)) && search.listRows[0] === downFrames[0]!.listRows[0]!.replace(`${CONFIG_ROW_MARK} `, '  '))
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-config-popup-scroll: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
