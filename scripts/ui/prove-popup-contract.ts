import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'
import { gridToPng } from './gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR || process.env.MERCURY_HOME) throw new Error('Use a scratch MERCURY_CONFIG_DIR with MERCURY_HOME unset')
pinSourceRef()
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
process.env.BROWSER = '/usr/bin/true'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const React = await import('react')
const { Box, Text } = await import('../../src/ink.ts')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { Select } = await import('../../src/components/CustomSelect/select.tsx')
const { SelectMulti } = await import('../../src/components/CustomSelect/SelectMulti.tsx')
const { useInteractiveList } = await import('../../src/components/mercury-ui/useInteractiveList.ts')
const { InteractiveRow } = await import('../../src/components/mercury-ui/InteractiveRow.tsx')
const { PopupForm } = await import('../../src/components/PopupForm.tsx')
const { Dialog } = await import('../../src/components/design-system/Dialog.tsx')
const { ColorPicker } = await import('../../src/components/agents/ColorPicker.tsx')
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const h = React.createElement
const framesAt = process.argv.indexOf('--frames')
const frames = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frames) mkdirSync(frames, { recursive: true })
const keys = { down: '\x1b[B', up: '\x1b[A', pgdn: '\x1b[6~', pgup: '\x1b[5~', enter: '\r', esc: '\x1b', end: '\x1b[F' }
const options = Array.from({ length: 24 }, (_, i) => ({ label: `choice ${String(i + 1).padStart(2, '0')}`, value: String(i) }))
let failures = 0
let checks = 0
const check = (label: string, good: boolean, detail = '') => {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
const save = async (scene: Mounted, label: string, cols: number, rows = 24) => {
  if (!frames) return
  writeFileSync(join(frames, `${label}-${cols}.txt`), scene.screen())
  const grid = scene.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => {
    const style = scene.styleAt(x, y)
    return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false, rev: style?.inverse ?? false }
  }))
  const path = join(frames, `${label}-${cols}.json`)
  writeFileSync(path, JSON.stringify({ grid, cols, rows }))
  await gridToPng(path, join(frames, `${label}-${cols}.png`))
}
const mount = (element: React.ReactNode, cols: number) => mountOffscreen(h(ThemeProvider, {}, h(AppStateProvider, {}, h(KeybindingSetup, {}, h(Box, { width: cols, height: 24, flexDirection: 'column' }, element)))), cols, 24)

for (const cols of [80, 120]) {
  for (const multi of [false, true]) {
    let focused = ''
    let committed = ''
    let cancelled = false
    const common = { options, visibleOptionCount: 4, onFocus: (value: string) => { focused = value }, onCancel: () => { cancelled = true } }
    const element = multi ? h(SelectMulti, { ...common, onSubmit: (values: string[]) => { committed = values.join(',') } }) : h(Select, { ...common, onChange: (value: string) => { committed = value } })
    const scene = await mount(h(Dialog, { title: multi ? 'Multiple choices' : 'Choices', onCancel: common.onCancel }, element), cols)
    const label = `${cols} ${multi ? 'multi' : 'single'}`
    try {
      await settledFrame(scene, frame => frame.includes('choice 01'))
      check(`${label}: a real scroll window hides the tail`, !scene.screen().includes('choice 24'))
      scene.push(keys.down)
      check(`${label}: Down moves focus`, await waitFor(() => focused === '1', 1200))
      scene.push(keys.up)
      check(`${label}: Up moves focus`, await waitFor(() => focused === '0', 1200))
      scene.push(keys.pgdn)
      check(`${label}: PageDown moves one visible page`, await waitFor(() => focused === '4', 1200), focused)
      await settledFrame(scene)
      check(`${label}: both edge markers survive a focused edge row`, scene.screen().includes('↑') && scene.screen().split('\n').some(line => line.includes('↓') && line.includes('choice')))
      check(`${label}: footer teaches movement and paging`, scene.screen().includes('↑↓') && scene.screen().includes('pgup/pgdn') && scene.screen().includes('↵') && scene.screen().includes('esc'))
      await save(scene, multi ? 'select-multi' : 'select-single', cols)
      scene.push(keys.pgup)
      check(`${label}: PageUp returns one page`, await waitFor(() => focused === '0', 1200))
      if (multi) scene.push(' ')
      scene.push(keys.enter)
      check(`${label}: Enter activates the focused choice`, await waitFor(() => committed === '0', 1200), committed)
      scene.push(keys.esc)
      check(`${label}: Escape closes`, await waitFor(() => cancelled, 1200))
    } finally { scene.unmount() }
  }
  let focused = ''
  const inputOptions = [{ label: 'Type an answer', value: 'input', type: 'input' as const, onChange() {} }, ...options]
  const scene = await mount(h(PopupForm, { width: cols - 4, rows: 8 }, h(Select, { options: inputOptions, visibleOptionCount: 3, onFocus: (value: string) => { focused = value }, onCancel() {} })), cols)
  try {
    await settledFrame(scene)
    scene.push(keys.pgdn)
    check(`${cols} input row: PageDown reaches another row instead of being ignored`, await waitFor(() => focused === '2', 1200), focused)
    await save(scene, 'input-select', cols)
  } finally { scene.unmount() }
  let listFocus = -1
  let picked = -1
  function InteractiveFixture(): React.ReactNode {
    const list = useInteractiveList({ rows: options, rowId: row => row.value, pageSize: 4, onClose() {}, actions: [{ key: 'return', hint: 'pick', run: row => { picked = Number(row?.value); return null } }] })
    listFocus = list.selectedIndex
    return h(Box, { flexDirection: 'column' }, ...options.slice(Math.max(0, list.selectedIndex - 2), Math.max(0, list.selectedIndex - 2) + 4).map(row => h(InteractiveRow, { key: row.value, ...list.rowProps(row, Number(row.value)), height: 1 }, h(Text, {}, row.label))), h(Text, {}, list.hints))
  }
  const interactive = await mount(h(InteractiveFixture), cols)
  try {
    await settledFrame(interactive)
    interactive.push(keys.pgdn)
    check(`${cols} interactive lists: PageDown uses the real visible span`, await waitFor(() => listFocus === 4, 1200), String(listFocus))
    interactive.push(keys.enter)
    check(`${cols} interactive lists: Enter acts on the paged row`, await waitFor(() => picked === 4, 1200), String(picked))
    check(`${cols} interactive lists: guide names paging`, interactive.screen().includes('pgup/pgdn'))
  } finally { interactive.unmount() }
}
console.log(`popup-contract: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
