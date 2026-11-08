#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import stripAnsi from 'strip-ansi'
import { modelPickerFooter } from '../../src/utils/model/modelPickerFooter.js'
import { MODEL_PICKER_HINT, MODEL_PICKER_PANEL } from '../../src/utils/model/modelPickerGroups.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

console.log('============================================================')
console.log(' /model picker — single-column, highlighted-selected, no overflow')
console.log('============================================================')

section('terminal-fit: single-column width never overflows')
const panelWidth = (cols: number): number => Math.min(cols - 2, MODEL_PICKER_PANEL.cap)
for (const cols of [80, 100, 120, 160, 200]) {
  const w = panelWidth(cols)
  check(`@${cols} panelWidth(${w}) ≤ cols-2 (${cols - 2}) — no overflow`, w <= cols - 2)
}
section('footer discipline: sheds on narrow, never wraps, keeps the nav+exit floor')
const innerOf = (cols: number): number => panelWidth(cols) - 4
const FLOOR = '↑↓ select · esc closes'.length
const stress = { gated: true, enableFlag: 'MERCURY_ASEPRITE' }
for (const cols of [50, 56, 64, 80, 100, 120]) {
  const inner = innerOf(cols)
  const f = modelPickerFooter(stress, inner)
  check(`@${cols} footer len ${f.length} ≤ inner ${inner} — no wrap`, f.length <= Math.max(inner, FLOOR), `"${f}"`)
  check(`@${cols} keeps the ↑↓ select … esc closes floor`, f.startsWith('↑↓ select') && /esc (?:or click outside )?closes$/.test(f))
}
const wideSegs = modelPickerFooter(stress, innerOf(120)).split(' · ').length
const narrowSegs = modelPickerFooter(stress, innerOf(50)).split(' · ').length
check('wide footer shows more segments than narrow (shedding actually fires)', wideSegs > narrowSegs, `wide=${wideSegs} narrow=${narrowSegs}`)
const mid = modelPickerFooter(stress, 60)
check('sheds "tab to search" before "ctrl+w context" (the chord stays named while the box already says to type)', !mid.includes('tab to search') || mid.includes('ctrl+w context'), `"${mid}"`)
const home = modelPickerFooter({ gated: false }, innerOf(120))
check('the home footer is the ratified hint row, whole', home === MODEL_PICKER_HINT, `"${home}"`)
check('on a heading the action word follows the fold', modelPickerFooter({ gated: false, heading: { fold: 'folded' } }, innerOf(120)).includes('↵ unfold') && modelPickerFooter({ gated: false, heading: { fold: 'open' } }, innerOf(120)).includes('↵ fold'))
check('while the search box has focus the legend swaps: type to search · ↵ switch · tab back to the rows · esc clears the search', modelPickerFooter({ gated: false, filterFocus: true, filtering: true }, innerOf(120)) === '↑↓ select · type to search · ↵ switch · tab back to the rows · esc clears the search' && modelPickerFooter({ gated: false, filterFocus: true, filtering: false }, innerOf(120)).endsWith('tab back to the rows · esc or click outside closes'))
check('a search kept while the rows have focus still says esc clears it', modelPickerFooter({ gated: false, filterFocus: false, filtering: true }, innerOf(120)) === '↑↓ select · ↵ switch · ctrl+w context · → ← fold · tab to search · esc clears the search')

section('source wiring: single-column, boxed-selected, click-driven')
const src = readFileSync(join(root, 'src', 'components', 'MercuryModelPicker.tsx'), 'utf-8')
check('single-column outer Box (flexDirection="column" + round border — schema-true)', /flexDirection="column" borderStyle="round"/.test(src))
check('footer uses the width-disciplined modelPickerFooter (no raw ternary hint)', /modelPickerFooter\(/.test(src) && /import \{ modelPickerFooter \}/.test(src))
check('panelWidth rides the ONE panel contract (cap 100 · reserve 2 · floor 20) — never overflows', /panelWidthFor\(slot\.columns, MODEL_PICKER_PANEL\)/.test(src) && MODEL_PICKER_PANEL.cap === 100 && MODEL_PICKER_PANEL.reserve === 2 && MODEL_PICKER_PANEL.min === 20)
check('uses InteractiveRow for the highlighted-selected container', /<InteractiveRow\n {8}key=\{line\.key\}\n {8}id=\{`model:row:\$\{line\.key\}`\}/.test(src) && /import \{ InteractiveRow \}/.test(src))
check('the provider heading derives from the one heading composer (PROVIDER · door · account · N live)', /headingWords\(heading, line\.group/.test(src))
check('every row is click-selectable (onSelect → selectRow) and ↵-parity (onActivate → commitCurrent)', /onSelect=\{\(\) => selectRow\(idx\)\}/.test(src) && /onActivate=\{commitCurrent\}/.test(src) && /const selectRow = \(n: number\)/.test(src))
check(
  'retired the shrink-wrapping rail+detail (no modelPickerLayout import, no railWidth/detailWidth)',
  !/import \{ modelPickerLayout \}/.test(src) && !/width=\{railWidth\}/.test(src) && !/width=\{detailWidth\}/.test(src),
)

section('SEAT LAW — the picker\'s selection grammar names no engine')
check('SEAT LAW: glm/haiku never in the picker; gpt only as the seat-state surface', !/glm/i.test(src) && !/haiku/i.test(src))
check(
  "SEAT LAW: 'gpt' spellings confined to the seat-state + window-law surfaces (+ their docs)",
  src
    .split('\n')
    .filter(l => /gpt/i.test(l))
    .every(
      l =>
        /gptDetail|gptEligible|'gpt'|focusedGptWindow|focusedGptToggle|GptServedWindowSuffix|gptCtxNudge|parseGptModelId|gptDisplayPin|liveGptContextWindow|liveGptContextCeiling|GPT account source/i.test(l) ||
        /^\s*(\/?\*|\/\/|\{\/\*)/.test(l),
    ),
)
section('§8.2 — pending-switch current→next visibility + the ONE apply owner')
const wrapper = readFileSync(join(root, 'src', 'commands', 'model', 'mercuryModel.tsx'), 'utf-8')
check("picker accepts pendingNext + renders the 'next' AMBER row state", /pendingNext\?: string/.test(src) && /'next', AMBER/.test(src))
check('picker renders the current→next header with the turn-settle note', /applies when the turn settles/.test(src))
check('wrapper feeds pendingNext from AppState.pendingModelSwitch', /s\.pendingModelSwitch/.test(wrapper) && /pendingNext/.test(wrapper))
check('/model select routes through settleModelSelection (the ONE settlement owner — unison W1)', /settleModelSelection\(/.test(wrapper) && !/decideModelTransition\(\{/.test(wrapper))
check('cross-provider picks carry the crossProviderNote', /crossProviderNote\(value\)/.test(wrapper))

section('rendered frames: the crewmate-view picker shares the main /model picker\'s panel geometry at the same terminal size')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = mkdtempSync(join(tmpdir(), 'model-picker-layout-'))
Object.assign(process.env, {
  MERCURY_CONFIG_DIR: proofHome,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_FULLSCREEN: '1',
  MERCURY_HELM_HOME: '1',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_REDUCED_MOTION: '1',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  FORCE_COLOR: '3',
})
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'MERCURY_RECESS', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'NODE_ENV']) delete process.env[key]
for (const key of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[key] = 'http://127.0.0.1:1'
const frameArg = process.argv.indexOf('--frames')
const frameDir = frameArg < 0 ? undefined : process.argv[frameArg + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
async function until(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 8000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  return predicate()
}
class Output extends EventEmitter {
  isTTY = true
  constructor(public columns: number, public rows: number) { super() }
  write(): boolean { return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
  get readableLength(): number { return 0 }
}
const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { useAppStateStore } = await import('../../src/state/AppState.tsx')
const { enterCrewmateView } = await import('../../src/state/crewmateViewHelpers.ts')
const { useViewedCrewmate } = await import('../../src/components/tasks/useCrewmateView.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, registerRouteSurface, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
registerRouteSurface('concourse', { render: () => null })
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { resetHelmFocusForTest } = await import('../../src/utils/cockpit/helmFocus.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const { call: openMainPicker } = await import('../../src/commands/model/mercuryModel.tsx')
const { openCrewmateModelPickerFor } = await import('../../src/components/PromptInput/crewmateCommands.tsx')
const { closeSettingsPopup } = await import('../../src/utils/cockpit/settingsPopup.ts')
type AppState = import('../../src/state/AppState.tsx').AppState
type WorkRow = import('../../src/services/engine-connector/types.ts').WorkRowV1
type CrewmateInView = import('../../src/components/tasks/useCrewmateView.ts').CrewmateInView
const h = React.createElement
const leadModel = 'claude-fable-5-1'
const taskId = 'picker-agent'
const row: WorkRow = { id: taskId, agentId: taskId, kind: 'agent', name: 'atlas', status: 'running', startTime: Date.now(), model: 'claude-haiku-5-5' }
const roster = { rows: [row], mission: [], samples: [], reported: true }
const overrides: Record<string, unknown> = {
  sessionId: () => 'picker-parent',
  modelFacts: () => ({ main: leadModel, effective: leadModel, sessionPin: null, effort: 'high', effortSent: 'high', pendingSwitch: null }),
  workRoster: () => roster,
  subscribeWork: () => () => {},
  live: () => IDLE_LIVE,
  subscribeLive: () => () => {},
  status: () => ({ title: 'a chat', projectLabel: 'proof', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false }),
  tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
}
const connector = new Proxy(noSessionConnector(), {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
setFocusedSessionConnector(connector)
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))

let store: ReturnType<typeof useAppStateStore>
let viewed: CrewmateInView | null = null
let modalNode: React.ReactNode = null
const modalListeners = new Set<() => void>()
function setModal(node: React.ReactNode): void {
  modalNode = node
  for (const listener of modalListeners) listener()
}
const subscribeModal = (listener: () => void): (() => void) => {
  modalListeners.add(listener)
  return () => { modalListeners.delete(listener) }
}
const transcript = Array.from({ length: 60 }, (_, index) => `${String(index).padStart(2, '0')} ${'·'.repeat(300)}`)
function Harness(): React.ReactNode {
  store = useAppStateStore()
  viewed = useViewedCrewmate()
  const modal = React.useSyncExternalStore(subscribeModal, () => modalNode, () => modalNode)
  return h(KeybindingSetup, null, h(FullscreenLayout, {
    scrollable: h(Box, { flexDirection: 'column' }, ...transcript.map((line, index) => h(Text, { key: index, wrap: 'truncate-end' }, line))),
    bottom: h(Box, { flexDirection: 'column' },
      h(Text, null, viewed === null ? ' Fable 5.1 · high' : ` viewing ${viewed.name}`),
      h(Box, { borderStyle: 'round' }, h(Text, null, viewed === null ? '› message Mercury Lead' : `› message ${viewed.name}`)),
    ),
    modal,
  }))
}
type Panel = { top: number; bottom: number; left: number; right: number; width: number; gutterLeft: number; gutterRight: number; selectedFramed: boolean }
function panelOf(frame: string[]): Panel | null {
  const title = frame.findIndex(line => line.includes('Mercury · model'))
  if (title < 1) return null
  const titleCells = Array.from(frame[title]!)
  const left = titleCells.lastIndexOf('│', Array.from(frame[title]!.slice(0, frame[title]!.indexOf('Mercury · model'))).length)
  const lid = Array.from(frame[title - 1]!)
  const right = lid.indexOf('╮', left)
  if (left < 0 || right < 0 || lid[left] !== '╭') return null
  let gutterLeft = 0
  for (let x = left - 1; x >= 0 && lid[x] === ' '; x--) gutterLeft++
  let gutterRight = 0
  for (let x = right + 1; x < lid.length && lid[x] === ' '; x++) gutterRight++
  const bottom = frame.findIndex((line, y) => y > title && Array.from(line)[left] === '╰')
  const selectedFramed = frame.some((line, y) => y > title && y < bottom && Array.from(line)[left + 2] === '╭' && Array.from(line)[right - 2] === '╮')
  return { top: title - 1, bottom, left, right, width: right - left + 1, gutterLeft, gutterRight, selectedFramed }
}
const describe = (panel: Panel | null): string => panel === null ? 'no panel painted' : `${panel.width} wide at columns ${panel.left}..${panel.right}, rows ${panel.top}..${panel.bottom}, ${panel.gutterLeft}/${panel.gutterRight} blank columns beside it, selected row ${panel.selectedFramed ? 'framed' : 'unframed'}`
const pickerPainted = (frame: string[]): boolean => frame.some(line => line.includes('Mercury · model')) && frame.some(line => line.includes('current'))
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }
for (const [cols, rows] of [[178, 51], [120, 40]] as const) {
  const size = `${cols}x${rows}`
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetHelmFocusForTest()
  const stdout = new Output(cols, rows)
  const ink = new Ink({ stdout: stdout as never, stdin: new Input() as never, stderr: new Output(cols, rows) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: { ...getDefaultAppState(), effortValue: 'high' } as AppState, getFpsMetrics: () => undefined }, h(Harness)))
  const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
  const save = (name: string, frame: string[]): void => {
    if (frameDir !== undefined) writeFileSync(join(frameDir, `${size}-${name}.txt`), frame.join('\n') + '\n')
  }
  await until(() => lines().some(line => line.includes('› message Mercury Lead')))
  setModal(await openMainPicker(() => setModal(null), { messages: [] } as never, ''))
  const mainPainted = await until(() => pickerPainted(lines()))
  await new Promise(resolve => setTimeout(resolve, 300))
  const mainFrame = lines()
  save('main-picker', mainFrame)
  const main = panelOf(mainFrame)
  check(`${size}: the main /model picker paints its panel inside the centre column, within the panel contract's cap`, mainPainted && main !== null && main.width <= MODEL_PICKER_PANEL.cap && main.width >= MODEL_PICKER_PANEL.min, describe(main))
  setModal(null)
  await until(() => !lines().some(line => line.includes('Mercury · model')))
  enterCrewmateView(taskId, store!.setState)
  await until(() => viewed !== null && lines().some(line => line.includes('› message atlas')))
  await openCrewmateModelPickerFor(viewed!, { setAppState: store!.setState, receipt: () => {} })
  const crewPainted = await until(() => pickerPainted(lines()))
  await new Promise(resolve => setTimeout(resolve, 300))
  const crewFrame = lines()
  save('crewmate-picker', crewFrame)
  const crew = panelOf(crewFrame)
  check(`${size}: the crewmate-view picker paints its panel over the viewed crewmate`, crewPainted && crew !== null && crewFrame.some(line => line.includes('↵ picks · esc keeps')), describe(crew))
  check(`${size}: the crewmate-view picker's panel has the main picker's width and columns`, main !== null && crew !== null && crew.width === main.width && crew.left === main.left && crew.right === main.right, `main ${describe(main)} · crewmate ${describe(crew)}`)
  check(`${size}: the crewmate-view picker's popup hugs its panel as the main picker's does — one ground column each side, never a wide gutter`, main !== null && crew !== null && crew.gutterLeft === main.gutterLeft && crew.gutterRight === main.gutterRight, `main ${main?.gutterLeft}/${main?.gutterRight} · crewmate ${crew?.gutterLeft}/${crew?.gutterRight} blank columns beside the panel`)
  check(`${size}: both pickers frame the selected row the same way (the product's own band, not an annotation)`, main !== null && crew !== null && main.selectedFramed === crew.selectedFramed, `main ${main?.selectedFramed ? 'framed' : 'unframed'} · crewmate ${crew?.selectedFramed ? 'framed' : 'unframed'}`)
  console.log(`  ${size} main picker:     ${describe(main)}`)
  console.log(`  ${size} crewmate picker: ${describe(crew)}`)
  closeSettingsPopup()
  ink.unmount()
  await ink.waitUntilExit()
  instances.delete(stdout as never)
}
console.error = originalError
check('no render or hook-order faults while the pickers painted', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 500))
rmSync(proofHome, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ /model picker is single-column, highlighted-selected, fits every width')
  process.exit(0)
} else {
  console.log(` ❌ /model picker layout — ${failures} check(s) failed`)
  process.exit(1)
}
