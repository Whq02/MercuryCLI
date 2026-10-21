import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'
import { gridToPng } from './gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR || process.env.MERCURY_HOME) throw new Error('Use a scratch MERCURY_CONFIG_DIR with MERCURY_HOME unset')
pinSourceRef()
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
for (const name of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN)$/.test(name)) delete process.env[name]
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

const { EffortPopup, EffortApplyContext } = await import('../../src/commands/effort/EffortPopup.tsx')
const { McpPopup } = await import('../../src/commands/mcp/McpPopup.tsx')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.tsx')
const { PopupFrameContext } = await import('../../src/components/PopupGutter.tsx')
const { ModalContext } = await import('../../src/context/modalContext.tsx')
const { getFocusedSessionConnector, setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const originalConnector = getFocusedSessionConnector()
const clients = Array.from({ length: 25 }, (_, index) => ({ name: 'server-' + String(index).padStart(2, '0'), type: 'connected', toolCount: 25 }))
setFocusedSessionConnector(new Proxy(originalConnector, { get(target, property) {
  if (property === 'mcpRoster') return () => ({ clients })
  if (property === 'mcpTools') return async () => ({ state: 'connected', tools: Array.from({ length: 25 }, (_, index) => ({ name: 'tool-' + String(index).padStart(2, '0'), description: 'Tool description '.repeat(50), registeredAs: 'fixture-tool', loading: 'listed', inputSchema: { type: 'object', properties: {} } })), omitted: 0 })
  const value = Reflect.get(target, property)
  return typeof value === 'function' ? value.bind(target) : value
} }))
const models = Array.from({ length: 25 }, (_, index) => ({ id: 'fixture-model-' + String(index).padStart(2, '0'), name: 'fixture-model-' + String(index).padStart(2, '0'), tag: '', ctx: '64k', group: 'fixture' }))
for (const cols of [80, 120]) {
  for (const name of ['effort', 'mcp', 'model', 'color']) {
    let done = false
    let picked = ''
    const body = name === 'effort' ? h(EffortApplyContext.Provider, { value: value => { picked = String(value); return 'Applied' } }, h(EffortPopup, { onDone: () => { done = true } }))
      : name === 'mcp' ? h(McpPopup, { onDone: () => { done = true } })
      : name === 'model' ? h(MercuryModelPicker, { models, current: models[0]!.id, initialFilter: 'fixture', onSelect: value => { picked = value }, onClose: () => { done = true } })
      : h(Dialog, { title: 'Color', onCancel: () => { done = true } }, h(ColorPicker, { agentName: 'fixture', onConfirm: value => { picked = value ?? 'automatic' } }))
    const fixtureRows = name === 'effort' ? 8 : name === 'color' ? 9 : 15
    const scene = await mount(h(ModalContext.Provider, { value: { rows: fixtureRows, columns: cols, scrollRef: null } }, h(PopupFrameContext.Provider, { value: { width: Math.min(cols - 2, name === 'effort' ? 100 : 78), rows: fixtureRows } }, body)), cols)
    const focus = () => scene.lines().find(line => /[❯›] /.test(line) && !line.includes('↑↓'))?.trim() ?? ''
    try {
      await settledFrame(scene, frame => frame.includes(name === 'mcp' ? 'server-00' : name === 'model' ? 'fixture-model-00' : name === 'color' ? 'automatic' : 'Mercury · effort'))
      scene.push('\x1b[H')
      await settledFrame(scene)
      const first = focus()
      scene.push(keys.down)
      await settledFrame(scene)
      check(cols + ' ' + name + ': Down moves the highlight', focus() !== first && focus() !== '', focus())
      scene.push(keys.up)
      await settledFrame(scene)
      check(cols + ' ' + name + ': Up restores the highlight', focus() === first, focus())
      scene.push(keys.pgdn)
      await settledFrame(scene)
      const page = focus()
      check(cols + ' ' + name + ': PageDown moves the highlighted row', page !== first && page !== '', page)
      check(cols + ' ' + name + ': page keys and close are visible', scene.screen().includes('pgup/pgdn') && scene.screen().includes('esc'), scene.screen())
      check(cols + ' ' + name + ': scrolling has an edge marker', scene.lines().some(line => /[↑↓]/.test(line) && !/↑↓|pgup/.test(line)), scene.screen())
      await save(scene, name + '-paged', cols)
      scene.push(keys.pgup)
      await settledFrame(scene)
      check(cols + ' ' + name + ': PageUp moves toward the first page', focus() !== page, focus())
      scene.push(keys.enter)
      await settledFrame(scene)
      check(cols + ' ' + name + ': Enter acts on that surface', name === 'mcp' ? scene.screen().includes('tools') : picked !== '', picked || scene.screen())
      if (name !== 'effort') {
        scene.push(keys.esc)
        check(cols + ' ' + name + ': Escape closes or clears one filter level', await waitFor(() => done || (name === 'model' && !scene.screen().includes('/ fixture')), 1600))
      }
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}
setFocusedSessionConnector(originalConnector)


const { SettingsPopupSlot } = await import('../../src/components/SettingsPopupSlot.tsx')
const { openSettingsPopup, closeSettingsPopup, isSettingsPopupOpen } = await import('../../src/utils/cockpit/settingsPopup.ts')
const { Config, CONFIG_POPUP_HINT } = await import('../../src/components/Settings/Config.tsx')
const { Jev, JEV_POPUP_HINT } = await import('../../src/components/Settings/Jev.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { ElicitationDialog } = await import('../../src/components/mcp/ElicitationDialog.tsx')
for (const cols of [80, 120]) {
  for (const view of ['config', 'jev'] as const) {
    const request = { view, width: cols - 4, rows: 12, line: 'fixture', hint: view === 'config' ? CONFIG_POPUP_HINT : JEV_POPUP_HINT, body: (geometry: { inner: number; rowBudget: number; compact: boolean }) => view === 'config'
      ? h(Config, { onClose: closeSettingsPopup, context: { messages: [], options: { commands: [], tools: [], agents: [] }, getAppState: getDefaultAppState, setAppState() {} } as never, width: geometry.inner, contentHeight: geometry.rowBudget, compact: geometry.compact })
      : h(Jev, { width: geometry.inner, rowBudget: geometry.rowBudget }) }
    openSettingsPopup(request)
    const scene = await mount(h(SettingsPopupSlot, { overlay: false }), cols)
    try {
      await settledFrame(scene, frame => frame.includes('Mercury · ' + view))
      const row = () => scene.lines().find(line => /[❯›] /.test(line))?.trim() ?? ''
      const first = row()
      scene.push(keys.down)
      await settledFrame(scene)
      check(cols + ' ' + view + ': Down moves a visible control', row() !== first && row() !== '', scene.screen())
      scene.push(keys.up)
      await settledFrame(scene)
      check(cols + ' ' + view + ': Up restores the control', row() === first, row())
      scene.push(keys.pgdn)
      await settledFrame(scene)
      const page = row()
      check(cols + ' ' + view + ': PageDown follows the selected control', page !== first && page !== '', scene.screen())
      check(cols + ' ' + view + ': guide survives the small popup', scene.screen().includes('pgup/pgdn') && scene.screen().includes('esc'), scene.screen())
      await save(scene, view + '-paged', cols)
      scene.push(keys.pgup)
      await settledFrame(scene)
      check(cols + ' ' + view + ': PageUp returns toward the top', row() !== page, scene.screen())
      const before = scene.screen()
      scene.push(keys.enter)
      check(cols + ' ' + view + ': Enter operates the selected control', await waitFor(() => scene.screen() !== before, 2500), scene.screen())
      if (isSettingsPopupOpen()) {
        scene.push(keys.esc)
        await settledFrame(scene, frame => !isSettingsPopupOpen() || frame.trim() !== '')
      }
      if (isSettingsPopupOpen()) scene.push(keys.esc)
      check(cols + ' ' + view + ': Escape leaves the popup', await waitFor(() => !isSettingsPopupOpen(), 2500))
    } catch (error) { check(cols + ' ' + view + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount(); closeSettingsPopup() }
  }
  let answer = ''
  const event = { serverName: 'fixture', signal: new AbortController().signal, params: { mode: 'form', message: 'Choose a value', requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: options.map(row => row.label) } } } } }
  const scene = await mount(h(ElicitationDialog, { event: event as never, onResponse: action => { answer = action }, onWaitingDismiss() {} }), cols)
  try {
    await settledFrame(scene, frame => frame.includes('Choose a value'))
    scene.push('\x1b[C')
    await settledFrame(scene, frame => frame.includes('choice 01'))
    check(cols + ' elicitation: enum is windowed', !scene.screen().includes('choice 24'), scene.screen())
    scene.push(keys.pgdn)
    await settledFrame(scene)
    check(cols + ' elicitation: PageDown reveals later choices', !scene.screen().includes('choice 01') && /choice \d\d/.test(scene.screen()), scene.screen())
    check(cols + ' elicitation: page guide and edge markers are present', scene.screen().includes('pgup/pgdn') && scene.lines().some(line => line.includes('↓') && !line.includes('↑↓')), scene.screen())
    await save(scene, 'elicitation-enum', cols)
    scene.push(keys.enter)
    await settledFrame(scene, frame => frame.includes('Accept') && !frame.includes('→ expand'))
    scene.push(keys.esc)
    check(cols + ' elicitation: Escape cancels after a picked value', await waitFor(() => answer === 'cancel', 1800), answer)
  } catch (error) { check(cols + ' elicitation: drive completes', false, String(error) + '\n' + scene.screen()) }
  finally { scene.unmount() }
}

console.log(`popup-contract: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
