import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mountOffscreen, pinSourceRef, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import { settledFrame } from './popupFrameSettle.ts'
import { gridToPng } from './gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR || process.env.MERCURY_HOME) throw new Error('Use a scratch MERCURY_CONFIG_DIR with MERCURY_HOME unset')
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
      : h(BootSaturnScreen, { ...props, facts: saturnFacts, nowMs: FIXED_NOW, receiptsOf: () => [], modelOptionsOf: () => ['fixture-model'], presetsOf: () => [], projectsOf: () => [] })
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
const daemonStatus = { daemon: { pid: 1, version: 'fixture', uptimeSec: 10, dir: fixtureRoot }, controlReachable: true, breakerOpen: false, leaseCount: 0, fireOutcomes: null, handshake: null, versionLine: null, workers: Array.from({ length: 30 }, (_, index) => ({ short: 'worker-' + String(index).padStart(2, '0'), state: 'idle', model: 'fixture-model', effort: 'max' })) }
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
      return lines.find(line => /[❯›▸] /.test(line) && !/↑↓|fixture panes/.test(line))?.trim() ?? ''
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

console.log(`popup-contract: ${checks} checks, ${failures} failed`)
process.chdir(previousCwd)
rmSync(fixtureRoot, { recursive: true, force: true })
process.exit(failures ? 1 : 0)
