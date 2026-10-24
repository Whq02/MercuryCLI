import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'
import { gridToPng } from './gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('Use a scratch MERCURY_CONFIG_DIR (it outranks MERCURY_HOME, so a pinned suite home is fine)')
const sourceRef = pinSourceRef()
if (sourceRef) {
  const root = join(import.meta.dir, '../..')
  const path = join(root, 'assets/splash/splash-core.mjs')
  const contents = execFileSync('git', ['-C', root, 'show', sourceRef + ':assets/splash/splash-core.mjs'], { encoding: 'utf8' })
  Bun.plugin({ name: 'versioned-popup-legend', setup(build) { build.onLoad({ filter: /splash-core\.mjs$/ }, args => args.path === path ? { contents, loader: 'js' } : undefined) } })
}
const previousCwd = process.cwd()
mkdirSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true })
const fixtureRoot = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR!, 'popup-contract-'))
process.chdir(fixtureRoot)
process.env.HOME = process.env.MERCURY_CONFIG_DIR
process.env.USERPROFILE = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CLIPBOARD_FILE = join(process.env.MERCURY_CONFIG_DIR!, 'popup-clipboard.txt')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
for (const name of Object.keys(process.env)) if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|HF_TOKEN|GH_TOKEN)$/.test(name)) delete process.env[name]
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_RECESS = '0'
process.env.FORCE_COLOR = '3'
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
const mount = (element: React.ReactNode, cols: number, terminalRows = 24) => mountOffscreen(h(ThemeProvider, {}, h(AppStateProvider, {}, h(KeybindingSetup, {}, h(Box, { width: cols, height: terminalRows, flexDirection: 'column' }, element)))), cols, terminalRows)

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
      if (name === 'mcp') {
        scene.push(keys.down)
        await settledFrame(scene)
        scene.push(keys.enter)
        await settledFrame(scene, frame => frame.includes('tool-00'))
        const toolsFirst = focus()
        scene.push(keys.pgdn)
        check(cols + ' mcp tools: page keys move the tool highlight', await waitFor(() => focus() !== toolsFirst, 1800), scene.screen())
        check(cols + ' mcp tools: markers and guide remain visible', scene.screen().includes('pgup/pgdn') && scene.lines().some(line => line.includes('↓') && !line.includes('↑↓')), scene.screen())
        await save(scene, 'mcp-tools-paged', cols)
        scene.push(keys.enter)
        await settledFrame(scene, frame => frame.includes('esc back to tools'))
        const detail = scene.screen()
        scene.push(keys.pgdn)
        check(cols + ' mcp detail: PageDown scrolls the description', await waitFor(() => scene.screen() !== detail, 1800), scene.screen())
        await save(scene, 'mcp-detail-paged', cols)
        scene.push(keys.esc)
        await settledFrame(scene, frame => frame.includes('tool-'))
        scene.push(keys.esc)
        await settledFrame(scene, frame => frame.includes('server-'))
      }
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


const { BootLoginsScreen } = await import('../../src/components/BootLoginsScreen.tsx')
const { KitMenuScreen, KIT_LEGEND_PRESET } = await import('../../src/components/KitMenuScreen.tsx')
const { BootSaturnScreen, saturnLegendOf } = await import('../../src/components/BootSaturnScreen.tsx')
const { mixedFacts } = await import('./face-logins-stills.ts')
const { FIXTURE_FACTS, FIXED_NOW } = await import('./saturn-screen-stills.ts')
const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
const kitCatalogue = { rows: Array.from({ length: 35 }, (_, index) => ({ kind: 'mcp', section: 'mcp', name: 'fixture-server-' + String(index).padStart(2, '0'), scope: 'project', extension: null })) }
const saturnFacts = { ...FIXTURE_FACTS, heldTotal: 0, rows: Array.from({ length: 35 }, (_, index) => {
  const row = FIXTURE_FACTS.rows[0]!
  const id = 'schedule-' + String(index).padStart(2, '0')
  return { ...row, sessionId: 'fixture-session', sessionTitle: 'fixture session', workspaceId: fixtureRoot, held: [], box: false, facts: { ...row.facts, id }, schedule: { ...row.schedule, id } }
}) }
for (const cols of [80, 120]) {
  for (const name of ['boot-logins', 'kit', 'saturn']) {
    const terminalRows = cols === 80 ? 24 : name === 'boot-logins' ? 26 : 40
    let closed = false
    let written = ''
    const states = new Map<string, string>()
    const store = { read: () => states, write: (_cwd: string, row: { name: string }, value: string) => { written = row.name; states.set('mcp:' + row.name, value); return { ok: true, receipt: 'Fixture saved' } } }
    const props = { onClose: () => { closed = true }, fullScene: { columns: cols, rows: terminalRows } }
    const element = name === 'boot-logins' ? h(BootLoginsScreen, { ...props, facts: mixedFacts() })
      : name === 'kit' ? h(KitMenuScreen, { ...props, catalogue: kitCatalogue as never, store: store as never, workspaceDir: fixtureRoot })
      : h(BootSaturnScreen, { ...props, facts: saturnFacts, nowMs: FIXED_NOW, receiptsOf: () => [], modelOptionsOf: () => ['fixture-model'], presetsOf: () => [], projectsOf: () => ['/fixture/project'] })
    const scene = await mount(element, cols, terminalRows)
    const focus = () => scene.lines().find(line => /❯ /.test(line))?.trim() ?? ''
    try {
      await settledFrame(scene, frame => frame.includes('pgup/pgdn'))
      scene.push('\x1b[H')
      await settledFrame(scene)
      const first = focus()
      scene.push(keys.down)
      await settledFrame(scene)
      check(cols + ' ' + name + ': Down moves one row', focus() !== first && focus() !== '', scene.screen())
      scene.push(keys.up)
      await settledFrame(scene)
      check(cols + ' ' + name + ': Up restores the row', focus() === first)
      scene.push(keys.pgdn)
      await settledFrame(scene)
      const page = focus()
      check(cols + ' ' + name + ': PageDown reaches the next visible window', page !== first && page !== '', scene.screen())
      check(cols + ' ' + name + ': scrolling and paging remain visible', /more (above|below)|↑ \d|↓ \d/.test(scene.screen()) && scene.screen().includes('pgup/pgdn') && scene.screen().includes('esc back'), scene.screen())
      if (name === 'kit') check(cols + ' kit: footer keeps every existing action word', scene.screen().replace(/\s+/g, ' ').includes(KIT_LEGEND_PRESET.replace(/\s+/g, ' ')), scene.screen())
      if (name === 'saturn') check(cols + ' saturn: footer keeps every existing action word', scene.screen().replace(/\s+/g, ' ').includes(saturnLegendOf({ busy: false }).replace(/\s+/g, ' ')), scene.screen())
      await save(scene, name + '-paged', cols, terminalRows)
      scene.push(keys.pgup)
      await settledFrame(scene)
      check(cols + ' ' + name + ': PageUp moves back', focus() !== page)
      if (name === 'kit') {
        scene.push(keys.enter)
        check(cols + ' kit: Enter uses the fixture store', await waitFor(() => written !== '', 2000))
      } else if (name === 'boot-logins') {
        scene.push('\x1b[H')
        await settledFrame(scene)
        scene.push(keys.enter)
        check(cols + ' boot logins: Enter opens credential choices without signing in', await waitFor(() => /subscription|usage-based billing/.test(scene.screen()), 2000))
        scene.push(keys.esc)
        await settledFrame(scene)
      } else {
        scene.push('a')
        check(cols + ' saturn: its advertised birth-form door opens', await waitFor(() => /schedule it|schedule birth/i.test(scene.screen()) && !scene.screen().includes('x delete'), 2000))
        scene.push('\x1b[H')
        scene.push(keys.down)
        scene.push(keys.down)
        await settledFrame(scene, frame => frame.includes('❯ Workspace'))
        scene.push(keys.enter)
        await settledFrame(scene, frame => frame.includes('/fixture/project'))
        scene.push(keys.enter)
        await settledFrame(scene, frame => frame.includes('Workspace') && frame.includes('/fixture/project'))
        await save(scene, 'saturn-form', cols, terminalRows)
        scene.push(keys.esc)
        await settledFrame(scene)
      }
      scene.push(keys.esc)
      check(cols + ' ' + name + ': Escape returns to the opener', await waitFor(() => closed, 2000))
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}
const core = createSplashCore({ nocolor: true, truecolor: false, accent: 'crimson' })
const model = { entries: [{ label: 'fixture', group: 'group', valueLabel: 'on', valueIsDefault: true, summary: 'fixture', pinnedVal: null }], selIdx: 0, title: 'fixture', summaryRows: [], environment: { model: 'fixture', critter: 'Clam', critterHue: '#ffffff', dirBase: 'fixture', dirTail: '' }, statusRight: 'fixture', legend: '↑↓ move · ↵ select · esc back' }
const fitting = core.composeBootMenu(120, 40, model).lines.map((line: string) => line.trim())
check('A boot legend that fits stays on exactly one row', fitting.filter((line: string) => line === model.legend).length === 1)


const { ThemePicker } = await import('../../src/components/ThemePicker.tsx')
const { ModelPicker } = await import('../../src/components/ModelPicker.tsx')
const { ExportDialog } = await import('../../src/components/ExportDialog.tsx')
const { CrashResumeDialog } = await import('../../src/components/CrashResumeDialog.tsx')
const { CostThresholdDialog } = await import('../../src/components/CostThresholdDialog.tsx')
const { SovereignModeDialog } = await import('../../src/components/SovereignModeDialog.tsx')
const { MCPServerApprovalDialog } = await import('../../src/components/MCPServerApprovalDialog.tsx')
const { MCPServerMultiselectDialog } = await import('../../src/components/MCPServerMultiselectDialog.tsx')
const { Commands } = await import('../../src/components/HelpV2/Commands.tsx')
const noAction = () => {}
for (const cols of [80, 120]) {
  const cases: Array<[string, React.ReactNode, string, boolean]> = [
    ['theme', h(ThemePicker, { onThemeSelect: noAction, onCancel: noAction, skipExitHandling: true }), 'The Mercury appearance', false],
    ['quick-model', h(ModelPicker, { initial: 'fixture-model', onSelect: noAction, onCancel: noAction, skipSettingsWrite: true }), 'Select model', true],
    ['export', h(ExportDialog, { content: 'fixture', defaultFilename: 'fixture.md', onDone: noAction }), 'Copy to clipboard', false],
    ['crash-resume', h(CrashResumeDialog, { origin: 'fixture', component: 'fixture', message: 'Fixture recovery', sessionId: 'fixture', cwd: fixtureRoot, moreCount: 0, onDone: noAction }), 'Resume that session', false],
    ['cost-threshold', h(CostThresholdDialog, { onDone: noAction }), 'Got it', false],
    ['sovereign', h(SovereignModeDialog, { onAccept: noAction }), 'No, exit', false],
    ['mcp-approval', h(MCPServerApprovalDialog, { serverName: 'fixture', onDone: noAction }), 'fixture', false],
    ['mcp-multiselect', h(MCPServerMultiselectDialog, { serverNames: options.map(row => row.label), onDone: noAction }), 'choice 01', true],
    ['help-commands', h(Commands, { commands: options.map(row => ({ name: row.label.replace(' ', '-'), description: 'Fixture command', type: 'local', isEnabled: () => true, userFacingName: () => row.label.replace(' ', '-') })) as never, maxHeight: 24, columns: cols, title: 'Fixture commands', onCancel: noAction, onPick: noAction }), 'Fixture commands', true],
  ]
  for (const [name, element, ready, pages] of cases) {
    const scene = await mount(element, cols, 36)
    try {
      await settledFrame(scene, frame => frame.includes(ready))
      check(cols + ' ' + name + ': guide names the actual confirm and exit keys', scene.screen().includes('↵') && scene.screen().includes('esc'), scene.screen())
      if (pages) check(cols + ' ' + name + ': guide names paging', scene.screen().includes('pgup/pgdn'), scene.screen())
      await save(scene, name + '-guide', cols, 36)
    } catch (error) { check(cols + ' ' + name + ': guide paints', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}


const { mock } = await import('bun:test')
const daemonModule = await import('../../src/daemon/status.ts')
const daemonStatus = { daemon: { pid: 1, version: 'fixture', uptimeSec: 10, dir: '/fixture/daemon' }, controlReachable: true, breakerOpen: false, leaseCount: 0, fireOutcomes: null, handshake: null, versionLine: null, workers: Array.from({ length: 30 }, (_, index) => ({ short: 'worker-' + String(index).padStart(2, '0'), state: 'idle', model: 'fixture-model', effort: 'max' })) }
mock.module('../../src/daemon/status.ts', () => ({ ...daemonModule, getMercuryDaemonStatus: async () => daemonStatus }))
const sessionModel = await import('../../src/components/mercury-ui/screens/sessionPickerModel.ts')
const sessions = options.map((row, index) => ({ sessionId: '00000000-0000-4000-8000-' + String(index).padStart(12, '0'), projectPath: fixtureRoot, cwd: fixtureRoot, modified: new Date().toISOString(), created: new Date().toISOString(), firstPrompt: row.label, customTitle: row.label, messageCount: 2, fullPath: join(fixtureRoot, row.value + '.jsonl') }))
const sessionFlat = sessions.map((log, index) => ({ project: 'fixture', head: index === 0, row: { project: 'fixture', label: log.customTitle, seen: 'now', log } }))
mock.module('../../src/components/mercury-ui/screens/sessionPickerModel.ts', () => ({ ...sessionModel, useSessionPickerModel: () => ({ logs: sessions, pendingMore: 0, projectKey: 'fixture', flat: sessionFlat, elsewhereCount: 0, dropSessions() {} }) }))
let sampleOpened = ''
mock.module('../../src/services/samples/open.ts', () => ({ openSampleUrl: async (url: string) => { sampleOpened = url; return { ok: true } } }))
const workRows = Array.from({ length: 30 }, (_, index) => ({ id: 'shell-' + index, kind: 'shell', name: 'shell-' + String(index).padStart(2, '0'), command: 'printf fixture', status: 'completed', startTime: Date.now() - 1000, endTime: Date.now(), exitCode: 0 }))
const samples = options.map(row => ({ id: row.value, title: row.label, version: 1, state: 'ready', glyph: '○', url: 'http://127.0.0.1:1/sample/' + row.value, updatedAt: new Date().toISOString() }))
const roster = { rows: workRows, mission: [], samples, reported: true }
const skills = options.map(row => ({ name: row.label.replace(' ', '-'), state: 'on', source: 'fixture', description: 'Fixture skill' }))
let skillChanged = ''
setFocusedSessionConnector(new Proxy(originalConnector, { get(target, property) {
  if (property === 'workRoster') return () => roster
  if (property === 'skillsRoster') return () => ({ skills })
  if (property === 'sessionId') return () => 'fixture-session'
  if (property === 'setKit') return async (change: { skills?: Array<{ name: string }> }) => { skillChanged = change.skills?.[0]?.name ?? ''; return { outcome: 'applied' } }
  const value = Reflect.get(target, property)
  return typeof value === 'function' ? value.bind(target) : value
} }))
const { DaemonView } = await import('../../src/components/mercury-ui/parity/DaemonView.tsx')
const { SessionManagerView } = await import('../../src/components/mercury-ui/screens/SessionManagerView.tsx')
const { SessionSkillsDial } = await import('../../src/components/skills/SessionSkillsDial.tsx')
const { SamplesListView } = await import('../../src/components/samples/SamplesListView.tsx')
const { BackgroundTasksDialog } = await import('../../src/components/tasks/BackgroundTasksDialog.tsx')
const { NavigablePanes } = await import('../../src/components/mercury-ui/NavigablePanes.tsx')
for (const cols of [80, 120]) {
  for (const name of ['daemon', 'sessions', 'skills', 'samples', 'tasks', 'panes']) {
    let closed = false
    let picked = ''
    const close = () => { closed = true }
    const context = { messages: [], options: { tools: [], commands: [], agents: [] }, getAppState: getDefaultAppState, setAppState() {} }
    const element = name === 'daemon' ? h(DaemonView, { onClose: close })
      : name === 'sessions' ? h(SessionManagerView, { onClose: close, onNewSession() {}, onResume: async id => { picked = id } })
      : name === 'skills' ? h(SessionSkillsDial, { onExit: close })
      : name === 'samples' ? h(SamplesListView, { onClose: close })
      : name === 'tasks' ? h(BackgroundTasksDialog, { toolUseContext: context as never, onDone: close })
      : h(NavigablePanes, { view: 'fixture panes', sections: [{ id: 'one', label: 'Choices', rows: options }], columns: [{ key: 'choice', header: 'Choice', cell: (row: typeof options[number]) => h(Text, {}, row.label) }], rowKey: row => (row as typeof options[number]).value, renderDetail: row => h(Text, {}, 'Detail ' + (row as typeof options[number]).label), onClose: close })
    const scene = await mount(h(ModalContext.Provider, { value: { rows: 24, columns: cols, scrollRef: null } }, element), cols)
    const focus = () => {
      const lines = scene.lines()
      if (name === 'sessions') {
        const y = lines.findIndex(line => line.includes('▸'))
        if (y < 0) return ''
        const x = lines[y]!.indexOf('▸')
        const start = lines[y]!.lastIndexOf('│', x)
        return lines[y + 1]?.slice(Math.max(0, start), Math.max(0, start) + 26).trim() ?? ''
      }
      if (name === 'skills') {
        const ground = scene.styleAt(0, 0)?.bg
        const y = lines.findIndex((line, at) => /choice-\d\d/.test(line) && scene.styleAt(Math.max(0, line.indexOf('choice-')), at)?.bg !== ground)
        return y < 0 ? '' : lines[y]!.trim()
      }
      const line = lines.find(line => /[❯›▸] /.test(line) && !/↑↓|fixture panes/.test(line)) ?? ''
      return line.match(/choice \d\d|worker-\d+|shell-\d+/)?.[0] ?? line.trim()
    }
    try {
      await settledFrame(scene, frame => frame.includes(name === 'daemon' ? 'worker-00' : name === 'skills' ? 'choice-01' : name === 'tasks' ? 'shell-00' : 'choice 01'))
      const first = focus()
      scene.push(keys.down)
      await settledFrame(scene)
      check(cols + ' ' + name + ': Down changes the visible highlight', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
      scene.push(keys.up)
      await settledFrame(scene)
      check(cols + ' ' + name + ': Up restores it', await waitFor(() => focus() === first, 1800), scene.screen())
      scene.push(keys.pgdn)
      await settledFrame(scene)
      await waitFor(() => focus() !== first && focus() !== '', 1800)
      const page = focus()
      check(cols + ' ' + name + ': PageDown moves selection within its viewport', page !== first && page !== '', scene.screen())
      check(cols + ' ' + name + ': paging and close guide remains visible', scene.screen().includes('pgup/pgdn') && scene.screen().includes('esc'), scene.screen())
      check(cols + ' ' + name + ': hidden rows have visible scroll markers', scene.lines().some(line => (/[↑↓]/.test(line) && !/↑↓|pgup/.test(line)) || /\+\d+ (more|above|below)/.test(line)), scene.screen())
      await save(scene, name + '-paged', cols)
      scene.push(keys.pgup)
      await settledFrame(scene)
      check(cols + ' ' + name + ': PageUp moves toward the top', await waitFor(() => focus() !== page, 1800), scene.screen())
      const before = scene.screen()
      sampleOpened = ''; skillChanged = ''
      scene.push(keys.enter)
      check(cols + ' ' + name + ': Enter selects or opens detail', await waitFor(() => name === 'samples' ? sampleOpened !== '' : name === 'skills' ? skillChanged !== '' : scene.screen() !== before, 2500), scene.screen())
      scene.push(keys.esc)
      await settledFrame(scene, frame => closed || frame.trim() !== '')
      if (!closed) scene.push(keys.esc)
      check(cols + ' ' + name + ': Escape closes or backs out then closes', await waitFor(() => closed, 2500))
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}
setFocusedSessionConnector(originalConnector)


const { CommandCenter } = await import('../../src/components/mercury-ui/components.tsx')
for (const cols of [80, 120]) {
  let closed = false
  const body = h(CommandCenter, { view: 'reader fixture', onClose: () => { closed = true } }, h(Text, {}, Array.from({ length: 80 }, (_, index) => 'reader line ' + String(index).padStart(2, '0')).join('\n')))
  const scene = await mount(h(ModalContext.Provider, { value: { rows: 24, columns: cols, scrollRef: null } }, body), cols)
  try {
    await settledFrame(scene, frame => frame.includes('reader line 00'))
    scene.push(keys.down)
    check(cols + ' popup reader: Down scrolls a row', await waitFor(() => !scene.screen().includes('reader line 00'), 1800), scene.screen())
    scene.push(keys.pgdn)
    check(cols + ' popup reader: PageDown scrolls a page', await waitFor(() => !scene.screen().includes('reader line 01'), 1800), scene.screen())
    check(cols + ' popup reader: guide and edge markers stay visible', scene.screen().includes('↑↓ scroll') && scene.screen().includes('pgup/pgdn') && scene.lines().some(line => /[↑↓]/.test(line) && !line.includes('↑↓')), scene.screen())
    await save(scene, 'command-reader-paged', cols)
    scene.push(keys.pgup)
    scene.push(keys.up)
    check(cols + ' popup reader: PageUp and Up return to the first row', await waitFor(() => scene.screen().includes('reader line 00'), 1800))
    scene.push(keys.esc)
    check(cols + ' popup reader: Escape closes', await waitFor(() => closed, 1800))
  } finally { scene.unmount() }
}


const bootFactsModule = await import('../../src/utils/bootCardFacts.ts')
mock.module('../../src/utils/bootCardFacts.ts', () => ({ ...bootFactsModule, workedInProjects: () => options.map(row => ({ dir: '/fixture/' + row.value, base: 'ground-' + row.label, ageMs: 0 })) }))
const subModelsModule = await import('../../src/utils/model/subModelSlots.ts')
const registryEntries = options.map(row => ({ kind: 'model', source: 'openai', modelId: 'fixture-' + row.value, displayName: row.label, state: 'selectable', availability: 'ready', description: 'Fixture model' }))
let subPicked = ''
mock.module('../../src/utils/model/subModelSlots.ts', () => ({ ...subModelsModule, composeSubModelRegistry: () => ({ families: [{ source: 'openai', label: 'OpenAI', credentialed: true, credentialLabel: 'fixture' }], entries: registryEntries }), resolveSubModel: () => ({ origin: 'unset', model: '' }), setSubModel: (_container: string, value: string | null) => { subPicked = value ?? 'unset'; return { ok: true, receipt: 'Fixture selection saved' } } }))
const coordinatorModule = await import('../../src/services/concourse/coordinatorModels.ts')
mock.module('../../src/services/concourse/coordinatorModels.ts', () => ({ ...coordinatorModule, composeCoordinatorModelRegistry: async () => ({ entries: registryEntries, selectable: true }), canonicalCoordinatorModelId: async (id: string) => id }))
const coordinatorLane = await import('../../src/services/concourse/coordinatorLane.ts')
mock.module('../../src/services/concourse/coordinatorLane.ts', () => ({ ...coordinatorLane, resolveEffectiveCoordinator: async () => ({ resolution: { requested: 'off', effective: 'off' } }) }))
const { GroundPicker } = await import('../../src/components/concourse/GroundPicker.tsx')
const { CoordinatorModelPicker } = await import('../../src/components/concourse/CoordinatorModelPicker.tsx')
const { SubModelPicker } = await import('../../src/components/SubModelPicker.tsx')
const { LocalSetupDialog, LOCAL_SETUP_POPUP_HINT } = await import('../../src/components/LocalSetupDialog.tsx')
const { MercuryHealthCertificate } = await import('../../src/commands/health/HealthCertificate.tsx')
for (const cols of [80, 120]) {
  for (const name of ['ground', 'coordinator', 'submodels', 'localsetup', 'health']) {
    let closed = false
    let picked = ''
    subPicked = ''
    const close = () => { closed = true }
    const callback = async (value: string) => { picked = value; return { ok: true, receipt: 'Fixture selection saved', outcome: 'applied' } }
    const setupRoad = async function* (ask: (question: unknown) => Promise<unknown>) {
      picked = JSON.stringify(await ask({ step: '4', found: 'Fixture models', willRun: 'Select a fixture', rows: options.map(row => ({ tag: row.label, words: 'Fixture model' })) }))
      yield { kind: 'done', summary: { stopped: false, done: [], notDone: [] } }
    }
    const report = async () => ({ verdict: 'certified', ranAt: new Date().toISOString(), head: { sha: 'fixture', branch: 'fixture', dirty: false }, version: 'fixture', durationMs: 1, depth: 'fast', sections: [{ id: 'fixture', title: 'FIXTURE', checks: options.map(row => ({ id: row.value, label: row.label, status: 'ok', evidence: 'Fixture evidence ' + row.label })) }] })
    const body = name === 'ground' ? h(GroundPicker, { currentGround: '/fixture/boot', bootGround: '/fixture/boot', onPick: value => { picked = value ?? 'boot' }, onClose: close })
      : name === 'coordinator' ? h(CoordinatorModelPicker, { callbacks: { switchCoordinatorModel: callback, switchCoordinatorMode: callback, switchCoordinatorEffort: callback } as never, onClose: close, allottedRows: 18, allottedWidth: cols - 8 })
      : name === 'submodels' ? h(SubModelPicker, { onClose: close, onRoute: noAction })
      : name === 'localsetup' ? h(Box, { flexDirection: 'column' }, h(LocalSetupDialog, { road: setupRoad as never, width: cols - 8, rowBudget: 10, onClose: close }), h(Text, {}, LOCAL_SETUP_POPUP_HINT))
      : h(MercuryHealthCertificate, { report: report as never, onClose: close })
    const scene = await mount(h(ModalContext.Provider, { value: { rows: 22, columns: cols, scrollRef: null } }, h(PopupFrameContext.Provider, { value: { rows: 20, width: cols - 4 } }, body)), cols, 26)
    const focus = () => {
      const lines = scene.lines()
      if (name === 'ground' || name === 'submodels' || name === 'coordinator') {
        const position = scene.cursor()
        const line = lines[position.y] ?? ''
        return /choice \d\d|fixture-\d+|Unset|ground-|boot|Mode/.test(line) ? line.trim() : ''
      }
      return lines.find(line => /[❯›▸] /.test(line) && !/↑↓|pgup/.test(line))?.trim() ?? ''
    }
    try {
      await settledFrame(scene, frame => frame.includes(name === 'localsetup' ? 'Fixture model' : name === 'health' ? 'FIXTURE' : name === 'ground' ? 'ground-' : name === 'coordinator' ? 'choice 01' : 'CONSOLE'))
      if (name === 'localsetup' && focus() === '') {
        scene.push(keys.down)
        await waitFor(() => focus() !== '', 1800)
      }
      const first = focus()
      scene.push(keys.down)
      check(cols + ' ' + name + ': Down reaches a row', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
      scene.push(keys.up)
      check(cols + ' ' + name + ': Up restores the selected row', await waitFor(() => focus() === first, 1800), scene.screen())
      scene.push(keys.pgdn)
      const previous = focus()
      check(cols + ' ' + name + ': PageDown changes the selected row', await waitFor(() => focus() !== previous && focus() !== '', 1800), scene.screen())
      check(cols + ' ' + name + ': paging guide stays visible', /pgup\/pgdn|⇞⇟ page/.test(scene.screen()), scene.screen())
      await save(scene, name + '-paged', cols, 26)
      const paged = focus()
      scene.push(keys.pgup)
      check(cols + ' ' + name + ': PageUp moves back a window', await waitFor(() => focus() !== paged, 1800), scene.screen())
      scene.push(keys.enter)
      check(cols + ' ' + name + ': Enter selects or unfolds', await waitFor(() => picked !== '' || subPicked !== '' || name === 'health' && scene.screen().includes('Fixture evidence'), 2500), scene.screen())
      scene.push(keys.esc)
      check(cols + ' ' + name + ': Escape closes', await waitFor(() => closed, 2000))
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}


const { LogSelector } = await import('../../src/components/LogSelector.tsx')
const { MercuryCommandPalette } = await import('../../src/components/MercuryCommandPalette.tsx')
const { SelectEventMode } = await import('../../src/components/hooks/SelectEventMode.tsx')
const { SelectMatcherMode } = await import('../../src/components/hooks/SelectMatcherMode.tsx')
const { SelectHookMode } = await import('../../src/components/hooks/SelectHookMode.tsx')
const ruleModule = await import('../../src/utils/permissions/decision/rules.ts')
const rules = options.map(row => ({ ruleBehavior: 'allow', source: 'userSettings', ruleValue: { toolName: 'Read', ruleContent: 'choice-' + row.value } }))
mock.module('../../src/utils/permissions/decision/rules.ts', () => ({ ...ruleModule, getAllowRules: () => rules, getAskRules: () => [], getDenyRules: () => [] }))
const { PermissionRuleList } = await import('../../src/components/permissions/rules/PermissionRuleList.tsx')
const logs = sessions.map((log, index) => ({ ...log, value: index, date: new Date().toISOString(), created: new Date(), modified: new Date(), messages: [], isSidechain: false }))
const hooks = options.map(row => ({ entry: { run: 'printf fixture', name: row.label }, source: { kind: 'extension', name: 'fixture' }, match: row.label, event: 'beforeTool' }))
for (const cols of [80, 120]) {
  for (const name of ['log-selector', 'palette', 'hook-events', 'hook-matchers', 'hook-list', 'permissions']) {
    let closed = false
    let picked = ''
    const close = () => { closed = true }
    const pick = (value: unknown) => { picked = String(value) }
    const body = name === 'log-selector' ? h(LogSelector, { logs: logs as never, maxHeight: 18, forceWidth: cols - 4, onCancel: close, onSelect: pick })
      : name === 'palette' ? h(MercuryCommandPalette, { commands: options.map(row => ({ name: row.label.replace(' ', '-'), description: 'Fixture command', type: 'local', isEnabled: () => true, userFacingName: () => row.label.replace(' ', '-') })) as never, onRun: pick, onClose: close })
      : name === 'hook-events' ? h(SelectEventMode, { events: options.map(row => row.label) as never, moments: {}, countsByEvent: {}, totalCount: 24, onSelect: pick, onExit: close })
      : name === 'hook-matchers' ? h(SelectMatcherMode, { event: 'beforeTool' as never, card: { moment: 'Fixture moment', match: 'tool' } as never, matches: options.map(row => row.label), hooksByMatch: {}, onSelect: pick, onBack: close })
      : name === 'hook-list' ? h(SelectHookMode, { event: 'beforeTool' as never, match: '', hasMatch: false, hooks: hooks as never, onSelect: pick, onBack: close })
      : h(PermissionRuleList, { onExit: close })
    const scene = await mount(body, cols, 30)
    const focus = () => {
      const lines = scene.lines()
      if (name === 'palette') return lines.find(line => line.includes('❯ ') && /choice/.test(line))?.trim() ?? ''
      const position = scene.cursor()
      return lines[position.y]?.trim() ?? ''
    }
    try {
      await settledFrame(scene, frame => /choice/.test(frame))
      if (name === 'permissions') {
        scene.push(keys.down)
        await waitFor(() => /Add a new rule|Read\(/.test(focus()), 1800)
      }
      const first = focus()
      scene.push(keys.down)
      check(cols + ' ' + name + ': Down moves the selection', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
      scene.push(keys.up)
      check(cols + ' ' + name + ': Up restores it', await waitFor(() => focus() === first, 1800), scene.screen())
      scene.push(keys.pgdn)
      check(cols + ' ' + name + ': PageDown changes the visible selection', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
      check(cols + ' ' + name + ': page and close guides are present', scene.screen().includes('pgup/pgdn') && scene.screen().includes('esc'), scene.screen())
      check(cols + ' ' + name + ': overflow is marked inside the list', scene.lines().some(line => /[↑↓]/.test(line) && !/↑↓|pgup/.test(line)), scene.screen())
      await save(scene, name + '-paged', cols, 30)
      const paged = focus()
      scene.push(keys.pgup)
      check(cols + ' ' + name + ': PageUp returns toward the first window', await waitFor(() => focus() !== paged, 1800), scene.screen())
      if (name === 'permissions') {
        scene.push('choice-1')
        check(cols + ' permissions: typing starts the filter', await waitFor(() => scene.screen().includes('/ choice-1'), 1800))
        scene.push(keys.enter)
        check(cols + ' permissions: Enter hands the filtered list back its keys', await waitFor(() => /Read\(choice-1/.test(focus()) && scene.screen().includes('pgup/pgdn'), 1800), scene.screen())
      }
      const before = scene.screen()
      scene.push(keys.enter)
      check(cols + ' ' + name + ': Enter activates the selected item', await waitFor(() => picked !== '' || name === 'permissions' && scene.screen() !== before, 2000), scene.screen())
      if (!closed) scene.push(keys.esc)
      if (name === 'permissions') { await settledFrame(scene); if (!closed) scene.push(keys.esc) }
      check(cols + ' ' + name + ': Escape closes or backs out once', await waitFor(() => closed, 2000))
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}


const { Usage } = await import('../../src/components/Settings/Usage.tsx')
for (const cols of [80, 120]) {
  for (const compact of [false, true]) {
    const request = { view: 'usage' as const, width: cols - 4, rows: 18, line: 'Fixture usage', hint: 'esc closes', body: (geometry: { inner: number; rowBudget: number }) => h(Usage, { width: geometry.inner, rowBudget: geometry.rowBudget, compact }) }
    openSettingsPopup(request)
    const scene = await mount(h(SettingsPopupSlot, { overlay: false }), cols)
    const label = cols + ' usage ' + (compact ? 'compact' : 'cards')
    try {
      await settledFrame(scene, frame => frame.includes('Mercury · usage') && frame.includes('pgup/pgdn'))
      const first = scene.screen()
      scene.push(keys.down)
      check(label + ': Down scrolls the body', await waitFor(() => scene.screen() !== first, 1800), scene.screen())
      scene.push(keys.up)
      check(label + ': Up returns to the first position', await waitFor(() => scene.screen() === first, 1800), scene.screen())
      scene.push(keys.pgdn)
      check(label + ': PageDown advances a page', await waitFor(() => scene.screen() !== first, 1800), scene.screen())
      const page = scene.screen()
      await save(scene, 'usage-' + (compact ? 'compact' : 'cards') + '-paged', cols)
      scene.push(keys.pgup)
      check(label + ': PageUp returns toward the top', await waitFor(() => scene.screen() !== page, 1800), scene.screen())
      scene.push(keys.esc)
      check(label + ': Escape closes', await waitFor(() => !isSettingsPopupOpen(), 1800))
    } catch (error) { check(label + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount(); closeSettingsPopup() }
  }
}
const diffModule = await import('../../src/hooks/useDiffData.ts')
const diffFiles = options.map(row => ({ path: 'choice-' + row.value + '.ts', linesAdded: 1, linesRemoved: 1, isBinary: false, isLargeFile: false, isTruncated: false }))
const diffData = { files: diffFiles, loading: false, stats: { filesChanged: diffFiles.length, insertions: 24, deletions: 24 }, hunks: new Map(diffFiles.map(file => [file.path, [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }]])) }
mock.module('../../src/hooks/useDiffData.ts', () => ({ ...diffModule, useDiffData: () => diffData }))
const diffSourcesModule = await import('../../src/components/diff/diffSources.ts')
mock.module('../../src/components/diff/diffSources.ts', () => ({ ...diffSourcesModule, enumerateExtraSources: async () => [] }))
const { DiffDialog } = await import('../../src/components/diff/DiffDialog.tsx')
const copyCommand = await import('../../src/commands/copy/copy.tsx')
const cachingCommand = await import('../../src/commands/caching/caching.tsx')
const response = options.map(row => '\x60\x60\x60ts\n' + row.label + '\n\x60\x60\x60').join('\n\n')
for (const cols of [80, 120]) {
  for (const name of ['diff', 'copy', 'caching']) {
    let closed = false
    const close = () => { closed = true }
    const context = { messages: [{ type: 'assistant', uuid: 'fixture', message: { role: 'assistant', content: [{ type: 'text', text: response }] } }], options: { tools: [], commands: [], agents: [] }, getAppState: getDefaultAppState, setAppState() {} }
    const body = name === 'diff' ? h(DiffDialog, { messages: [], onDone: close }) : name === 'copy' ? await copyCommand.call(close, context as never, '') : await cachingCommand.call(close, context as never, '')
    const scene = await mount(h(ModalContext.Provider, { value: { rows: 24, columns: cols, scrollRef: null } }, body), cols)
    const selected = () => {
      const at = scene.cursor()
      const line = scene.lines()[at.y] ?? ''
      return name === 'diff' ? line.match(/choice-\d+\.ts/)?.[0] ?? '' : line.trim()
    }
    try {
      await settledFrame(scene, frame => frame.includes(name === 'diff' ? 'choice-' : name === 'copy' ? 'Whole response' : 'caching'))
      const first = selected()
      scene.push(keys.down)
      check(cols + ' ' + name + ': Down moves selection', await waitFor(() => selected() !== first && selected() !== '', 1800), scene.screen())
      scene.push(keys.up)
      check(cols + ' ' + name + ': Up restores it', await waitFor(() => selected() === first, 1800), scene.screen())
      scene.push(keys.pgdn)
      check(cols + ' ' + name + ': PageDown moves the selection', await waitFor(() => selected() !== first && selected() !== '', 1800), scene.screen())
      check(cols + ' ' + name + ': guide names paging', scene.screen().includes('pgup/pgdn'), scene.screen())
      await save(scene, name + '-paged', cols)
      scene.push(keys.pgup)
      await waitFor(() => selected() === first, 1800)
      const before = scene.screen()
      scene.push(keys.enter)
      check(cols + ' ' + name + ': Enter takes its existing action', await waitFor(() => closed || scene.screen() !== before, 2000), scene.screen())
      if (!closed) { scene.push(keys.esc); await settledFrame(scene, frame => closed || frame.trim() !== ''); if (!closed) scene.push(keys.esc) }
      check(cols + ' ' + name + ': Escape returns to the opener', await waitFor(() => closed, 2000))
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}


const readinessModule = await import('../../src/utils/readiness.ts')
const readinessRows = options.map(row => ({ id: row.value, kind: 'tool', label: 'capability-' + row.value, state: 'ready', detail: 'Fixture capability ' + row.value, source: 'fixture', remedy: '', lastCheckedAt: Date.now() }))
mock.module('../../src/utils/readiness.ts', () => ({ ...readinessModule, collectReadiness: () => ({ records: readinessRows }) }))
const realmsModule = await import('../../src/utils/realmRegistry.ts')
const realms = options.map(row => ({ id: row.value, name: 'realm-' + row.value, dir: '/fixture/realm-' + row.value, issuedCount: 0 }))
let realmPicked = ''
mock.module('../../src/utils/realmRegistry.ts', () => ({ ...realmsModule, readRealmRegistry: () => ({ state: 'ready', realms, ledger: [] }), realmGitBranch: () => null, realmRegistryPath: () => '/fixture/realms.json', recordRealmLaunchIssued: (id: string) => { realmPicked = id; return { ok: true, message: 'mercury /fixture/realm-' + id } } }))
const osModule = await import('node:os')
mock.module('node:os', () => ({ ...osModule, homedir: () => process.env.MERCURY_CONFIG_DIR! }))
const accountsModule = await import('../../src/services/providers/accountSlots.ts')
const accountGroups = [{ family: { id: 'openai', available: true, credentialed: false }, slots: options.map(row => ({ family: 'openai', id: row.value, name: 'account-' + row.value, kind: 'api-key', kindLabel: 'API key', identity: 'fixture-' + row.value, active: false, signedIn: false, envPinned: false, removal: { route: 'owner', note: 'fixture' } })) }]
mock.module('../../src/services/providers/accountSlots.ts', () => ({ ...accountsModule, deriveFamilySlotGroups: () => accountGroups }))
const discoveryModule = await import('../../src/services/providers/providerDiscovery.ts')
mock.module('../../src/services/providers/providerDiscovery.ts', () => ({ ...discoveryModule, refreshProviderDiscovery: async () => undefined }))
const { CapabilityManagerView } = await import('../../src/components/mercury-ui/parity/CapabilityManagerView.tsx')
const { RealmsView } = await import('../../src/components/mercury-ui/parity/RealmsView.tsx')
const { AccountView } = await import('../../src/components/mercury-ui/parity/AccountView.tsx')
for (const cols of [80, 120]) {
  for (const name of ['capabilities', 'realms', 'accounts']) {
    let closed = false
    const close = () => { closed = true }
    realmPicked = ''
    const body = name === 'capabilities' ? h(CapabilityManagerView, { onClose: close }) : name === 'realms' ? h(RealmsView, { onClose: close }) : h(AccountView, { onClose: close })
    const scene = await mount(h(ModalContext.Provider, { value: { rows: 28, columns: cols, scrollRef: null } }, body), cols, 28)
    const selected = () => scene.lines().find(line => /[▸❯›] /.test(line) && /capability-|realm-|account-/.test(line))?.match(/capability-\d+|realm-\d+|account-\d+/)?.[0] ?? ''
    try {
      await settledFrame(scene, frame => frame.includes(name === 'capabilities' ? 'capability-0' : name === 'realms' ? 'realm-0' : 'account-0'))
      const first = selected()
      scene.push(keys.down)
      check(cols + ' ' + name + ': Down moves selection', await waitFor(() => selected() !== first && selected() !== '', 1800), scene.screen())
      scene.push(keys.up)
      check(cols + ' ' + name + ': Up restores selection', await waitFor(() => selected() === first, 1800), scene.screen())
      scene.push(keys.pgdn)
      check(cols + ' ' + name + ': PageDown moves the visible window', await waitFor(() => selected() !== first && selected() !== '', 1800), scene.screen())
      check(cols + ' ' + name + ': paging is taught in the footer', scene.screen().includes('pgup/pgdn'), scene.screen())
      await save(scene, name + '-paged', cols, 28)
      const page = selected()
      scene.push(keys.pgup)
      check(cols + ' ' + name + ': PageUp returns toward the top', await waitFor(() => selected() !== page, 1800), scene.screen())
      const before = scene.screen()
      scene.push(keys.enter)
      check(cols + ' ' + name + ': Enter opens its existing detail or route', await waitFor(() => closed || realmPicked !== '' || scene.screen() !== before, 2500), scene.screen())
      if (!closed) scene.push(keys.esc)
      check(cols + ' ' + name + ': Escape closes', await waitFor(() => closed, 1800))
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}


const crewRoster = { rows: options.map((row, index) => ({ id: 'crew-' + String(index).padStart(2, '0'), name: 'crew-' + String(index).padStart(2, '0'), kind: 'agent', status: 'completed', model: 'fixture-model', effort: 'max', startTime: 1000, endTime: 2000, description: 'Fixture crewmate' })), mission: [], samples: [], reported: true }
const emptyAsks: never[] = []
setFocusedSessionConnector(new Proxy(originalConnector, { get(target, property) {
  if (property === 'workRoster') return () => crewRoster
  if (property === 'asks') return () => emptyAsks
  if (property === 'sessionId') return () => 'fixture-session'
  const value = Reflect.get(target, property)
  return typeof value === 'function' ? value.bind(target) : value
} }))
const { CrewView } = await import('../../src/components/mercury-ui/screens/CrewView.tsx')
const agentStore = await import('../../src/services/agents/store.ts')
const trash = options.map(row => ({ id: row.value, agentType: 'trash-' + String(Number(row.value)).padStart(2, '0'), deletedAt: new Date().toISOString(), originalPath: '/fixture/agents/' + row.value + '.md', source: 'project' }))
let restored = ''
mock.module('../../src/services/agents/store.ts', () => ({ ...agentStore, listAgentTrash: () => trash, restoreAgentFromTrash: async (id: string) => { restored = id; return { path: '/fixture/restored.md' } } }))
const { AgentStudio } = await import('../../src/components/agents/studio/AgentStudio.tsx')
const runModule = await import('../../src/services/run/runCoordinator.ts')
const runSnapshot = { objective: 'Fixture run', runId: 'fixture', lifecycle: 'completed', phase: 'done', phaseReason: 'fixture', substantive: true, startedAt: 1000, updatedAt: 2000, continuationCount: 0, deliverables: [{ id: 'one', title: 'Fixture item', state: 'done' }], nextAction: 'Fixture next action', blocker: null, recentEffects: [], changedPaths: [], pendingTools: [], totalChangedPaths: 0, unresolvedBadEffects: 0, verification: { state: 'verified', detail: 'Fixture evidence' }, contextEpoch: 1, lastContextTransition: null, ideFeedback: { state: 'clean', detail: 'Fixture diagnostics' }, totalEvents: 0, recentEvents: [] }
mock.module('../../src/services/run/runCoordinator.ts', () => ({ ...runModule, getRunSnapshot: () => runSnapshot, subscribeRuns: () => () => {} }))
const runCommand = await import('../../src/commands/run/run.tsx')
for (const cols of [80, 120]) {
  for (const name of ['crew', 'agent-trash', 'run-inspector']) {
    let closed = false
    const close = () => { closed = true }
    restored = ''
    const body = name === 'crew' ? h(CrewView, { onClose: close }) : name === 'agent-trash' ? h(AgentStudio, { tools: [] as never, onExit: close }) : await runCommand.call(close, {} as never, '')
    const scene = await mount(h(ModalContext.Provider, { value: { rows: name === 'run-inspector' ? 14 : 24, columns: cols, scrollRef: null } }, body), cols)
    const focus = () => {
      const lines = scene.lines()
      const line = name === 'run-inspector' ? lines[scene.cursor().y] ?? '' : lines.find(line => /[▸❯›]/.test(line) && /crew-\d|trash-\d/.test(line)) ?? ''
      return line.match(/crew-\d+|trash-\d+|RUN|DELIVERABLES|NEXT|EFFECTS|EVIDENCE|CONTEXT|IDE|TIMELINE/)?.[0] ?? ''
    }
    try {
      if (name === 'agent-trash') {
        await settledFrame(scene, frame => frame.includes('U trash'))
        scene.push('U')
      }
      await settledFrame(scene, frame => frame.includes(name === 'crew' ? 'crew-00' : name === 'agent-trash' ? 'trash-00' : 'Fixture run'))
      const first = focus()
      scene.push(keys.down)
      check(cols + ' ' + name + ': Down moves the visible selection', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
      scene.push(keys.up)
      check(cols + ' ' + name + ': Up restores selection', await waitFor(() => focus() === first, 1800), scene.screen())
      scene.push(keys.pgdn)
      check(cols + ' ' + name + ': PageDown follows the selection', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
      check(cols + ' ' + name + ': page guide is visible', scene.screen().includes('pgup/pgdn'), scene.screen())
      await save(scene, name + '-paged', cols)
      const page = focus()
      scene.push(keys.pgup)
      check(cols + ' ' + name + ': PageUp returns toward the top', await waitFor(() => focus() !== page, 1800), scene.screen())
      const before = scene.screen()
      scene.push(keys.enter)
      check(cols + ' ' + name + ': Enter uses its existing detail or restore door', await waitFor(() => restored !== '' || closed || scene.screen() !== before, 2000), scene.screen())
      if (!closed) {
        scene.push(keys.esc)
        await settledFrame(scene, frame => closed || frame.trim() !== '')
        if (!closed) scene.push(keys.esc)
      }
      check(cols + ' ' + name + ': Escape closes or backs out once', await waitFor(() => closed, 1800))
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}
setFocusedSessionConnector(originalConnector)


const { createUserMessage } = await import('../../src/utils/messages.ts')
const workbenchRecords = options.map(row => createUserMessage({ content: 'prompt-' + row.value }))
const workflowRoster = { rows: options.map(row => ({ id: 'workflow-' + row.value, runId: 'workflow-' + row.value, name: 'workflow-' + row.value, kind: 'workflow', status: 'completed', startTime: 1000, endTime: 2000 })), mission: [], samples: [], reported: true }
setFocusedSessionConnector(new Proxy(originalConnector, { get(target, property) {
  if (property === 'workRoster') return () => workflowRoster
  if (property === 'records') return () => workbenchRecords
  if (property === 'sessionId') return () => 'fixture-session'
  const value = Reflect.get(target, property)
  return typeof value === 'function' ? value.bind(target) : value
} }))
const { PromptsPanel } = await import('../../src/components/prompts-panel/PromptsPanel.tsx')
const { WorkflowsBoard } = await import('../../src/components/tasks/WorkflowsBoard.tsx')
for (const cols of [80, 120]) {
  for (const name of ['workbench', 'workflows']) {
    let closed = false
    const body = name === 'workbench' ? h(PromptsPanel, { onClose: () => { closed = true } }) : h(WorkflowsBoard, { onClose: () => { closed = true } })
    const scene = await mount(h(ModalContext.Provider, { value: { rows: 24, columns: cols, scrollRef: null } }, body), cols)
    const focus = () => {
      const line = scene.lines()[scene.cursor().y] ?? ''
      return line.match(/prompt-\d+|workflow-\d+/)?.[0] ?? ''
    }
    try {
      await settledFrame(scene, frame => frame.includes(name === 'workbench' ? 'prompts' : name))
      if (name === 'workflows') scene.push('2')
      scene.push('\x1b[H')
      await settledFrame(scene, frame => /prompt-0|workflow-0/.test(frame))
      const first = focus()
      scene.push(keys.down)
      check(cols + ' ' + name + ': Down selects a visible row', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
      scene.push(keys.up)
      check(cols + ' ' + name + ': Up returns to it', await waitFor(() => focus() === first, 1800), scene.screen())
      scene.push(keys.pgdn)
      check(cols + ' ' + name + ': PageDown moves a page', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
      check(cols + ' ' + name + ': page guide and markers paint', scene.screen().includes('pgup/pgdn') && scene.lines().some(line => /[↑↓]/.test(line) && !line.includes('↑↓')), scene.screen())
      await save(scene, name + '-paged', cols)
      const page = focus()
      scene.push(keys.pgup)
      check(cols + ' ' + name + ': PageUp moves back', await waitFor(() => focus() !== page, 1800), scene.screen())
      const before = scene.screen()
      scene.push(keys.enter)
      check(cols + ' ' + name + ': Enter opens the selected row', await waitFor(() => scene.screen() !== before, 2500), scene.screen())
      scene.push(keys.esc)
      await settledFrame(scene, frame => closed || frame.trim() !== '')
      if (!closed) scene.push(keys.esc)
      check(cols + ' ' + name + ': Escape returns then closes', await waitFor(() => closed, 1800))
    } catch (error) { check(cols + ' ' + name + ': drive completes', false, String(error) + '\n' + scene.screen()) }
    finally { scene.unmount() }
  }
}
setFocusedSessionConnector(originalConnector)


const { ConsoleOAuthFlow } = await import('../../src/components/ConsoleOAuthFlow.tsx')
const { FilePermissionDialog } = await import('../../src/components/permissions/FilePermissionDialog/FilePermissionDialog.tsx')
for (const cols of [80, 120]) {
  const request = { view: 'logins' as const, width: cols - 4, rows: 18, line: 'Fixture logins', hint: 'esc closes', bodyOwnsEscape: true, body: (geometry: { inner: number; rowBudget: number }) => h(PopupForm, { width: geometry.inner, rows: geometry.rowBudget }, h(ConsoleOAuthFlow, { onDone: closeSettingsPopup, onCancel: closeSettingsPopup, onOpenaiDone: noAction })) }
  openSettingsPopup(request)
  const scene = await mount(h(SettingsPopupSlot, { overlay: false }), cols)
  const focus = () => scene.lines()[scene.cursor().y]?.trim() ?? ''
  try {
    await settledFrame(scene, frame => frame.includes('pgup/pgdn') && frame.includes('Anthropic'))
    const first = focus()
    scene.push(keys.down)
    check(cols + ' login roster: Down moves selection', await waitFor(() => focus() !== first && focus() !== '', 1800), scene.screen())
    scene.push(keys.up)
    check(cols + ' login roster: Up restores it', await waitFor(() => focus() === first, 1800), scene.screen())
    scene.push(keys.pgdn)
    check(cols + ' login roster: PageDown follows the roster, not its wrapper', await waitFor(() => focus() !== first, 1800), scene.screen())
    await save(scene, 'login-roster-paged', cols)
    scene.push('\x1b[H')
    await settledFrame(scene)
    scene.push(keys.enter)
    check(cols + ' login roster: Enter opens the account card, not a network sign-in', await waitFor(() => scene.screen().includes('Sign in / re-login'), 2500), scene.screen())
    const accountFirst = focus()
    scene.push(keys.pgdn)
    check(cols + ' login account card: PageDown follows a bounded choice window', await waitFor(() => focus() !== accountFirst && /Remove key/.test(focus()), 1800), scene.screen())
    await save(scene, 'login-account-paged', cols)
    scene.push('\x1b[H')
    await waitFor(() => focus().includes('Sign in / re-login'), 1800)
    scene.push(keys.enter)
    check(cols + ' login account card: Enter opens credential choices without authentication', await waitFor(() => scene.screen().includes('ChatGPT subscription — browser sign-in') && scene.screen().includes('OpenAI API key — usage-based billing'), 1800), scene.screen())
    scene.push(keys.esc)
    await settledFrame(scene)
    scene.push(keys.esc)
    check(cols + ' login roster: Escape returns then closes', await waitFor(() => !isSettingsPopupOpen(), 1800))
  } catch (error) { check(cols + ' login roster: drive completes', false, String(error) + '\n' + scene.screen()) }
  finally { scene.unmount(); closeSettingsPopup() }
  let allowed = false
  const confirm = { toolUseID: 'fixture', input: {}, permissionResult: { behavior: 'ask' }, onAllow() { allowed = true }, onReject() {}, onUserInteraction() {}, onAbort() {}, tool: { name: 'Read' }, toolUseContext: {}, assistantMessage: {} }
  const permission = await mount(h(FilePermissionDialog, { toolUseConfirm: confirm as never, onDone() {}, onReject() {}, title: 'Fixture file permission', path: null, parseInput: input => input as Record<string, unknown>, operationType: 'read', content: h(Text, {}, 'Fixture content') }), cols)
  try {
    await settledFrame(permission, frame => frame.includes('Fixture file permission'))
    check(cols + ' file permission: guide names movement paging confirmation and cancellation', permission.screen().includes('↑↓') && permission.screen().includes('pgup/pgdn') && permission.screen().includes('↵ confirm') && permission.screen().includes('esc cancel'), permission.screen())
    await save(permission, 'file-permission-guide', cols)
    permission.push(keys.enter)
    check(cols + ' file permission: Enter calls only its supplied allow callback', await waitFor(() => allowed, 1800))
  } finally { permission.unmount() }
}
const fsModule = await import('../../src/utils/fsOperations.ts')
const fixtureFs = fsModule.getFsImplementation()
mock.module('../../src/utils/fsOperations.ts', () => ({ ...fsModule, getFsImplementation: () => new Proxy(fixtureFs, { get(target, key) { if (key === 'cwd') return () => '/fixture/project'; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value } }) }))
const configModule = await import('../../src/utils/config.ts')
mock.module('../../src/utils/config.ts', () => ({ ...configModule, getProjectPathForConfig: () => '/fixture/project', checkHasTrustDialogAccepted: () => false }))
const { TrustDialog } = await import('../../src/components/TrustDialog/TrustDialog.tsx')
for (const cols of [80, 120]) {
  const scene = await mount(h(TrustDialog, { onDone() {} }), cols, 30)
  try {
    await settledFrame(scene, frame => frame.includes('Trust this folder?'))
    check(cols + ' trust: guide preserves the exit meaning', scene.screen().includes('↑↓ move') && scene.screen().includes('↵ confirm') && scene.screen().includes('esc exits'), scene.screen())
    await save(scene, 'trust-guide', cols, 30)
  } finally { scene.unmount() }
}


const { useInput: useFixtureInput } = await import('../../src/ink.ts')
for (const cols of [80, 120]) {
  let focused = ''
  function LateSelector(): React.ReactNode {
    const [open, setOpen] = React.useState(false)
    useFixtureInput(input => { if (input === 'r') setOpen(true) })
    return h(PopupForm, { width: cols - 4, rows: 8 }, open
      ? h(Select, { options, visibleOptionCount: 3, onFocus: value => { focused = String(value) } })
      : h(Text, {}, 'r opens the list'))
  }
  const scene = await mount(h(LateSelector), cols)
  try {
    await settledFrame(scene, frame => frame.includes('r opens the list'))
    scene.push('r')
    await settledFrame(scene, frame => frame.includes('choice 01'))
    scene.push(keys.pgdn)
    check(cols + ' late selector: a mounted form yields PageDown even without a cancel callback', await waitFor(() => focused === '3', 1800), focused)
    scene.push(keys.pgup)
    check(cols + ' late selector: PageUp returns to the first choice', await waitFor(() => focused === '0', 1800), focused)
    await save(scene, 'late-selector', cols)
  } finally { scene.unmount() }
}


const instructionsModule = await import('../../src/services/instructions/engine.ts')
const instructionFiles = Promise.resolve(options.map(row => ({ path: '/fixture/instruction-' + row.value + '.md', content: '', family: 'native', type: 'Project' })))
mock.module('../../src/services/instructions/engine.ts', () => ({ ...instructionsModule, getInstructionFiles: () => instructionFiles }))
const libraryModule = await import('../../src/mneme/mnemeLibrary.ts')
const topicDocs = options.map((row, index) => ({ id: 'topic-fixture-' + String.fromCharCode(97 + index), slug: 'fixture-' + String.fromCharCode(97 + index), summary: 'topic ' + row.value, tokenCount: 100, created: new Date().toISOString(), updated: new Date().toISOString(), updateLog: [], history: [], sections: [{ heading: 'Facts', entries: Array.from({ length: 20 }, (_, i) => ({ text: 'Fixture fact ' + row.value + '-' + i + ' with enough words to wrap inside the reader.', seq: index * 20 + i + 1, time: new Date().toISOString(), source: 'operator:fixture' })) }] }))
mock.module('../../src/mneme/mnemeLibrary.ts', () => ({ ...libraryModule, listTopicDocs: () => topicDocs, listArchiveDocs: () => [] }))
const maintenanceModule = await import('../../src/mneme/mnemeMaintenance.ts')
mock.module('../../src/mneme/mnemeMaintenance.ts', () => ({ ...maintenanceModule, mnemeStatus: () => ({ enabled: true, entryCount: 480, buffered: 0, pendingConsuming: 0, historyCount: 0, topicCount: 24, due: false, dueReason: '', running: false, degraded: false, lastConsolidatedAt: null }) }))
const { MemoryCentreView } = await import('../../src/components/memory/MemoryCentreView.tsx')
const { MemoryFileSelector } = await import('../../src/components/memory/MemoryFileSelector.tsx')
const { memoryFooter } = await import('../../src/components/memory/memoryCentreLayout.ts')
const { useSettingsPopupFrame } = await import('../../src/components/Settings/Settings.tsx')
function MemoryFixture({ width, rows }: { width: number; rows: number }): React.ReactNode {
  const frame = useSettingsPopupFrame()
  return h(MemoryCentreView, { width, rowBudget: rows, initialRow: 'topics', onClose: closeSettingsPopup, onHint: frame.setHint })
}
for (const cols of [80, 120]) {
  const request = { view: 'memory' as const, width: cols - 4, rows: 20, line: 'Fixture memory', hint: 'esc closes', bodyOwnsEscape: true, body: (geometry: { inner: number; rowBudget: number }) => h(MemoryFixture, { width: geometry.inner, rows: geometry.rowBudget }) }
  openSettingsPopup(request)
  const scene = await mount(h(SettingsPopupSlot, { overlay: false }), cols)
  try {
    await settledFrame(scene, frame => frame.includes('list the topics'))
    scene.push(keys.enter)
    await settledFrame(scene, frame => frame.includes('fixture-'))
    const first = scene.screen()
    scene.push(keys.pgdn)
    check(cols + ' memory topics: PageDown moves the window', await waitFor(() => scene.screen() !== first, 1800), scene.screen())
    check(cols + ' memory topics: guide includes paging', scene.screen().includes('pgup/pgdn'), scene.screen())
    await save(scene, 'memory-topics-paged', cols)
    scene.push(keys.enter)
    await settledFrame(scene, frame => frame.includes('Fixture fact'))
    const page = scene.screen()
    scene.push(keys.pgdn)
    check(cols + ' memory reader: PageDown scrolls the actual topic', await waitFor(() => scene.screen() !== page, 1800), scene.screen())
    await save(scene, 'memory-reader-paged', cols)
    scene.push(keys.esc)
    await settledFrame(scene, frame => !frame.includes('Fixture fact'))
    scene.push(keys.esc)
    await settledFrame(scene, frame => frame.includes('topics'))
    scene.push(keys.esc)
    check(cols + ' memory: Escape leaves one level at a time', await waitFor(() => !isSettingsPopupOpen(), 1800))
  } catch (error) { check(cols + ' memory: drive completes', false, String(error) + '\n' + scene.screen()) }
  finally { scene.unmount(); closeSettingsPopup() }
  let picked = ''
  let closed = false
  const fileScene = await mount(h(Dialog, { title: 'Memory files', onCancel: () => { closed = true }, inputGuide: () => h(Text, {}, memoryFooter({ kind: 'files', direct: true })) }, h(React.Suspense, { fallback: null }, h(MemoryFileSelector, { onSelect: value => { picked = value }, onCancel: () => { closed = true } }))), cols)
  try {
    await settledFrame(fileScene, frame => frame.includes('/fixture/instruction-'))
    const first = fileScene.lines()[fileScene.cursor().y] ?? ''
    fileScene.push(keys.pgdn)
    check(cols + ' memory files: PageDown follows an overflowing Select', await waitFor(() => (fileScene.lines()[fileScene.cursor().y] ?? '') !== first, 1800), fileScene.screen())
    await save(fileScene, 'memory-files-paged', cols)
    fileScene.push(keys.enter)
    check(cols + ' memory files: Enter chooses a file without opening an editor', await waitFor(() => picked !== '', 1800))
    fileScene.push(keys.esc)
    check(cols + ' memory files: Escape closes', await waitFor(() => closed, 1800))
  } catch (error) { check(cols + ' memory files: drive completes', false, String(error) + '\n' + fileScene.screen()) }
  finally { fileScene.unmount() }
}

console.log(`popup-contract: ${checks} checks, ${failures} failed`)
process.chdir(previousCwd)
rmSync(fixtureRoot, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
