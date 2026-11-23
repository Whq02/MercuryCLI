#!/usr/bin/env bun
import { join } from 'node:path'
import { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-config-popup-scroll')

let failures = 0
function check(label: string, ok: boolean, detail = '', fix = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && fix ? ` — ${fix}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const { configListWindow, configMoreRow, configWarningRows, CONFIG_ROW_MARK, CONFIG_POPUP_HINT } = await import('../../src/screen/settings/Config.js')

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
  check('at the top: row 0 selected, offset 0, 10 hidden below, the list overflows', start.sel === 0 && start.off === 0 && start.hiddenBelow === 10 && start.overflows, JSON.stringify(start), 'fix configListWindow in src/screen/settings/config/configLayout.ts so the first window hides total - windowSize rows below')
  check('the more row reads "↓ 10 more" at the top', configMoreRow(start.hiddenBelow) === '↓ 10 more', '', 'fix configMoreRow in src/screen/settings/config/configLayout.ts to read the arrow, the count and more')
  for (let step = 1; step <= TOTAL - 1; step++) {
    const win = configListWindow(sel + 1, off, TOTAL, WINDOW)
    sel = win.sel
    off = win.off
    if (!(sel >= off && sel < off + WINDOW)) inside = false
    if (win.hiddenBelow !== TOTAL - off - WINDOW) exact = false
    hidden.push(win.hiddenBelow)
  }
  check('43 arrow-downs land on row 43 as the selected row', sel === 43, `sel ${sel}`, 'fix configListWindow in src/screen/settings/config/configLayout.ts so each step down moves the selection by one row')
  check('the selection index stays inside [offset, offset + 34) after every step', inside, '', 'fix the offset scroll in configListWindow in src/screen/settings/config/configLayout.ts so the selected row is never outside the window')
  check('hiddenBelow equals 44 − offset − 34 at every position', exact, '', 'fix hiddenBelow in configListWindow in src/screen/settings/config/configLayout.ts to be total - offset - windowSize')
  check('hiddenBelow reaches 0 at the end (offset 10)', hidden[hidden.length - 1] === 0 && off === 10, `${hidden[hidden.length - 1]} at offset ${off}`, 'fix configListWindow in src/screen/settings/config/configLayout.ts so the last window ends at the last row')
  check('the more row paints blank at the end of the list', configMoreRow(0) === '', '', 'fix configMoreRow in src/screen/settings/config/configLayout.ts to return an empty string for 0 hidden rows')
  check('the highlight walks to the bottom edge first (33 steps at offset 0), then the list moves one row per step', hidden.slice(0, 34).every(h => h === 10) && hidden.slice(34).join(',') === '9,8,7,6,5,4,3,2,1,0', hidden.join(','), 'fix configListWindow in src/screen/settings/config/configLayout.ts so the selection reaches the bottom edge before the offset moves')
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
  check('43 arrow-ups return to row 0 at offset 0 the same way', sel === 0 && off === 0 && inside && exact, `sel ${sel} off ${off}`, 'fix configListWindow in src/screen/settings/config/configLayout.ts so stepping up mirrors stepping down')
  check('the hidden count climbs back to 10 only once the top edge moves', hidden.slice(0, 33).every(h => h === 0) && hidden[hidden.length - 1] === 10, hidden.join(','), 'fix configListWindow in src/screen/settings/config/configLayout.ts so the offset moves only once the top edge is passed')
  const past = configListWindow(99, 0, TOTAL, WINDOW)
  check('a selection past the end clamps to the last row with the window at the end', past.sel === 43 && past.off === 10 && past.hiddenBelow === 0, '', 'fix configListWindow in src/screen/settings/config/configLayout.ts to clamp the selection to the last row')
  const short = configListWindow(3, 0, 5, WINDOW)
  check('a list shorter than the window hides nothing and never overflows', short.off === 0 && short.hiddenBelow === 0 && !short.overflows, '', 'fix configListWindow in src/screen/settings/config/configLayout.ts for a total smaller than the window')
  const empty = configListWindow(0, 0, 0, WINDOW)
  check('an empty list is safe', empty.sel === 0 && empty.off === 0 && empty.hiddenBelow === 0, '', 'fix configListWindow in src/screen/settings/config/configLayout.ts for a total of 0')
  check('a warning row costs the window its wrapped lines', configWarningRows('a', 106) === 1 && configWarningRows('x'.repeat(200), 106) === 2, '', 'fix configWarningRows in src/screen/settings/config/configLayout.ts to count the wrapped lines')
}

section('§2 the rendered popup at 178×51, driven through the ink pipeline: every step of the walk')
{
  const React = await import('react')
  const { Box } = await import('../../src/screen/themedRenderer.js')
  const { AppStateProvider } = await import('../../src/screen/app-state/AppState.js')
  const { ThemeProvider } = await import('../../src/screen/theme/ThemeProvider.js')
  const { SettingsPopupSlot } = await import('../../src/screen/overlays/SettingsPopupSlot.js')
  const store = await import('../../src/screen/cockpit/settingsPopup.js')
  const { configPopupRequest } = await import('../../src/commands/config/config.js')
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
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
  check('the popup painted with the hint row', up, '', 'the config popup did not paint CONFIG_POPUP_HINT within 4 s: look at configPopupRequest in src/commands/config/config.tsx and SettingsPopupSlot')
  await settle(120)
  const innerOf = (line: string): string => Array.from(line).slice(LEFT + 2, LEFT + 108).join('')
  const labelOf = (row: string): string => row.slice(2, 36).trim()
  const readFrame = () => {
    const lines = m.lines()
    const listRows = Array.from({ length: LIST_ROWS }, (_, i) => innerOf(lines[LIST_FIRST + i] ?? ''))
    const more = innerOf(lines[MORE_ROW] ?? '').trim()
    return { listRows, more, hint: innerOf(lines[TOP + 42] ?? '').trim(), lines }
  }
  const total = Number(/(\d+) settings/.exec(m.screen())?.[1] ?? 0)
  check('the context line names the row count', total > LIST_ROWS, `${total} settings`, 'the popup context line should read N settings with N above 34: look at the context line in src/screen/settings/config/ConfigViews.tsx')
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
  check('the first frame: row 0 selected, the more row counts the rest', markedRows[0] === 0 && initial.more === `↓ ${total - LIST_ROWS} more`, `${markedRows[0]} · ${initial.more}`, 'the first frame should mark row 0 and show the more row: look at src/screen/settings/config/ConfigViews.tsx and useConfigList.ts')
  check(`${total - 1} arrow-downs land on the last row as the selected row`, markedRows[total - 1] >= 0 && labels[total - 1] !== '' && new Set(labels).size === total, `${new Set(labels).size} distinct labels over ${total} steps`, 'each arrow-down should select the next setting: look at the key handling in src/screen/settings/config/useConfigList.ts')
  check('exactly one marked row, inside the 34-row list window, after every step', markedRows.every(i => i >= 0 && i < LIST_ROWS), markedRows.join(','), 'a step left no marked row or more than one in the list window: look at the row mark in src/screen/settings/config/ConfigViews.tsx')
  check('the more row paints blank at the end of the list', frames[total - 1]!.more === '', JSON.stringify(frames[total - 1]!.more), 'the more row must be blank at the end: look at configMoreRow in src/screen/settings/config/configLayout.ts and its use in ConfigViews.tsx')
  check('the hint row stays the last body row through the walk', readFrame().hint === CONFIG_POPUP_HINT, '', 'the hint row must stay in place below the list: look at src/screen/settings/config/ConfigViews.tsx and configPopupRequest in src/commands/config/config.tsx')
  const known = new Set(labels)
  let contiguous = true
  let exact = true
  let sizeTrue = true
  let selectedInside = true
  const detail: string[] = []
  frames.forEach((frame, k) => {
    const shown = frame.listRows.map(row => (known.has(labelOf(row)) && row.slice(36).trim() !== '' ? labels.indexOf(labelOf(row)) : -1))
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
  check('the visible rows are a contiguous run of the catalogue at every step', contiguous, '', 'look at the window slicing in src/screen/settings/config/useConfigList.ts')
  check('the selected row is inside the visible run at every step', selectedInside, '', 'look at configListWindow in src/screen/settings/config/configLayout.ts and useConfigList.ts')
  check('the window is 34 rows less the selected row\'s warning rows at every step', sizeTrue, '', 'look at configWarningRows in src/screen/settings/config/configLayout.ts and the window size in useConfigList.ts')
  check('"↓ n more" is the true remainder (total − offset − window) at every step', exact, detail.join(' | '), 'the more row must equal configMoreRow of the true remainder: look at ConfigViews.tsx and configLayout.ts under src/screen/settings/config')
  const downFrames = frames.slice()
  for (let step = 1; step < total; step++) {
    m.push(KEY.up)
    await settle(25)
  }
  await settle(60)
  const back = readFrame()
  check(`${total - 1} arrow-ups walk back to row 0 with the first frame restored`, back.listRows.join('\n') === downFrames[0]!.listRows.join('\n') && back.more === downFrames[0]!.more, back.more, 'stepping up must retrace the down walk: look at the key handling in src/screen/settings/config/useConfigList.ts')
  m.push(KEY.up)
  await settle(40)
  const search = readFrame()
  check('one more ↑ from row 0 hands the keys to the search row (no row selected, the list unmoved)', !search.listRows.some(row => row.startsWith(`${CONFIG_ROW_MARK} `)) && search.listRows[0] === downFrames[0]!.listRows[0]!.replace(`${CONFIG_ROW_MARK} `, '  '), '', 'arrow-up from row 0 must move focus to the search row and leave the list offset alone: look at src/screen/settings/config/useConfigList.ts')
  m.unmount()
  store.closeSettingsPopup()
  await settle(50)
}

await releaseScratchHome(HOME)
console.log(`\nprove-config-popup-scroll: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
