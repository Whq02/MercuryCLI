#!/usr/bin/env bun
// gate-watch: src/components/mercury-ui/screens/CrewView.tsx src/components/ScrollKeybindingHandler.tsx src/components/mercury-ui/InteractiveRow.tsx src/components/mercury-ui/navSemantics.ts src/components/CrewViewSlot.tsx src/utils/cockpit/crewView.ts src/components/CustomSelect/popup-list.tsx
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crew-view-mouse-'))
const CWD = mkdtempSync(join(tmpdir(), 'crew-view-mouse-cwd-'))
process.chdir(CWD)
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.FORCE_COLOR = '3'
delete process.env.MERCURY_RECESS
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { useCompactWorkControls } = await import('../../src/components/tasks/CompactWorkSummary.tsx')
const { GlobalKeybindingHandlers } = await import('../../src/hooks/useGlobalKeybindings.tsx')
const { ScrollKeybindingHandler, wheelYieldsToTopOverlay } = await import('../../src/components/ScrollKeybindingHandler.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { openCrewView, closeCrewView, isCrewViewOpen } = await import('../../src/utils/cockpit/crewView.ts')
const { CREW_OPEN_IN_VIEW_KEY } = await import('../../src/utils/cockpit/crewmateWords.ts')
const { useAppStateStore } = await import('../../src/state/AppState.tsx')
const h = React.createElement

const COMPOSER = 'Type a prompt'
const MODEL = 'claude-fable-5-1'
const SEATS = 40
const DOWN = '\x1b[B'
const PGUP = '\x1b[5~'
const PGDN = '\x1b[6~'
const ESC = '\x1b'
const press = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M`
const release = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}m`
const wheel = (dir: 'up' | 'down', x: number, y: number): string => `\x1b[<${dir === 'up' ? 64 : 65};${x + 1};${y + 1}M`
const seatName = (n: number): string => `seat${String(n).padStart(2, '0')}`
const seatId = (n: number): string => `a-${seatName(n)}`
const SIZES: Array<[number, number]> = [[178, 51], [100, 30]]

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(predicate: () => boolean, ms = 8000): Promise<boolean> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, ms)
  while (!predicate() && !expired) await sleep(10)
  clearTimeout(timer)
  return predicate()
}
class Output extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
  write(): boolean { return true }
}
class Input extends EventEmitter {
  isTTY = true
  isRaw = false
  chunks: string[] = []
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): string | null { return this.chunks.shift() ?? null }
  get readableLength(): number { return this.chunks.reduce((sum, chunk) => sum + chunk.length, 0) }
  push(data: string): void { this.chunks.push(data); this.emit('readable') }
}
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }
const hardLimit = setTimeout(() => { console.error('crew-view-mouse exceeded its deadline'); process.exit(1) }, 240_000)
hardLimit.unref()

const NOW = Date.now()
const rosterRows = Array.from({ length: SEATS }, (_, index) => {
  const n = index + 1
  const running = n <= 3
  return {
    id: seatId(n),
    kind: 'agent' as const,
    name: seatName(n),
    status: running ? 'running' : 'completed',
    startTime: NOW - 600_000 - n * 1000,
    ...(running ? {} : { endTime: NOW - 60_000 }),
    description: `${seatName(n)} — a lane of the wave`,
    model: MODEL,
    agentType: 'mercury-crew',
    inputTokens: 1000 * n,
    outputTokens: 500,
    totalTokens: 1000 * n + 500,
    contextTokens: 1000 * n,
  }
})
const roster = { rows: rosterRows, mission: [], samples: [], reported: true }
const rosterListeners = new Set<() => void>()
function seedRoster(): void {
  rosterListeners.clear()
  const resting = noSessionConnector()
  const seeded = new Proxy(resting, {
    get(target, prop, receiver) {
      if (prop === 'workRoster') return () => roster
      if (prop === 'subscribeWork') return (listener: () => void) => { rosterListeners.add(listener); return () => { rosterListeners.delete(listener) } }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  setFocusedSessionConnector(seeded as never)
}

type ScrollHandle = { getScrollTop: () => number; getScrollHeight: () => number; getViewportHeight: () => number }
type Scene = { lines: () => string[]; push: (data: string) => void; scrollTop: () => number; scrollMax: () => number; viewing: () => string | undefined; close: () => Promise<void> }

async function openScene(cols: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  seedRoster()
  const state = getDefaultAppState()
  const scrollRef = React.createRef<ScrollHandle>()
  const modalScrollRef = React.createRef<null>()
  const insertRef = { current: null } as React.MutableRefObject<unknown>
  let store: { getState: () => unknown } | null = null
  function Transcript(): React.ReactNode {
    return h(Text, null, Array.from({ length: 120 }, (_, index) => `13:00:${String(index % 60).padStart(2, '0')} [op] row ${index + 1} of the lead's transcript`).join('\n'))
  }
  function Harness(): React.ReactNode {
    const { controls, focus } = useCompactWorkControls()
    store = useAppStateStore() as never
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
      h(ScrollKeybindingHandler, { scrollRef, isActive: true, modalScrollRef, modalUp: false } as never),
      h(FullscreenLayout, {
        scrollRef, modalScrollRef, modalActive: false,
        scrollable: h(Transcript),
        statusBand: h(Text, null, 'crew specimen'),
        statusBandActive: false,
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: state.toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 0, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async () => {},
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        } as never),
      } as never),
    )
  }
  const stdout = new Output()
  stdout.columns = cols
  stdout.rows = rows
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: state, getFpsMetrics: () => undefined } as never, h(Harness)))
  const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
  const composed = await until(() => lines().join('\n').includes(COMPOSER))
  check(`the chat painted its composer at ${cols}x${rows}`, composed, lines().slice(0, 6).join(' | '))
  await sleep(400)
  stdin.push('\x1b[I')
  await sleep(200)
  return {
    lines,
    push: data => stdin.push(data),
    scrollTop: () => scrollRef.current?.getScrollTop() ?? -1,
    scrollMax: () => scrollRef.current === null ? -1 : Math.max(0, scrollRef.current.getScrollHeight() - scrollRef.current.getViewportHeight()),
    viewing: () => (store?.getState() as { viewingAgentTaskId?: string } | undefined)?.viewingAgentTaskId,
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
      releaseFocusedSessionConnector()
    },
  }
}

const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}
const SEAT_ROW = /\bseat\d\d\b/
const HEADER = `Crewmates (${SEATS})`
const popupLeft = (lines: string[]): number => {
  const header = lines.find(line => line.includes(HEADER))
  if (header === undefined) return -1
  const cells = Array.from(header)
  const at = cells.join('').indexOf(HEADER)
  for (let x = at; x >= 0; x--) if (cells[x] === '│') return x
  return -1
}
const popupText = (lines: string[], y: number): string => {
  const left = popupLeft(lines)
  return left < 0 ? '' : Array.from(lines[y] ?? '').slice(left).join('')
}
const agentLine = (lines: string[], y: number): boolean => {
  const text = popupText(lines, y)
  return SEAT_ROW.test(text) && text.includes(MODEL)
}
const popupRows = (lines: string[]): number[] => lines.map((_, y) => y).filter(y => agentLine(lines, y))
const cursorName = (lines: string[]): string => {
  const y = popupRows(lines).find(row => /▸ . seat\d\d/.test(popupText(lines, row)))
  return y === undefined ? '(none)' : popupText(lines, y).match(/▸ . (seat\d\d)/)?.[1] ?? '(none)'
}
const seatIndex = (name: string): number => Number(name.slice(4)) - 1
const cellAt = (lines: string[], name: string): { x: number; y: number } | null => {
  const y = popupRows(lines).find(row => popupText(lines, row).includes(name))
  if (y === undefined) return null
  return { x: popupLeft(lines) + Array.from(popupText(lines, y).split(name)[0]!).length, y }
}
const headerCell = (lines: string[]): { x: number; y: number } | null => {
  const y = lines.findIndex(line => line.includes(HEADER))
  if (y < 0) return null
  return { x: popupLeft(lines) + Array.from(popupText(lines, y).split('Crewmates')[0]!).length + 3, y }
}
const earlierMarker = (lines: string[]): boolean => lines.some((_, y) => /↑ \d+ earlier/.test(popupText(lines, y)))
const keyLine = (lines: string[]): string => {
  const from = lines.findIndex((_, y) => popupText(lines, y).includes('↑↓ move'))
  const to = lines.findIndex((_, y) => popupText(lines, y).includes('esc close'))
  if (from < 0 || to < from) return ''
  return lines.slice(from, to + 1).map((_, i) => popupText(lines, from + i).replace(/[│]/g, '').trim()).join(' ')
}
const visibleSeats = (lines: string[]): string[] => popupRows(lines).map(y => popupText(lines, y).match(SEAT_ROW)![0])
const describe = (scene: Scene): string => `cursor ${cursorName(scene.lines())} · transcript at ${scene.scrollTop()} · viewing ${String(scene.viewing())} · open ${isCrewViewOpen()}`
async function openList(scene: Scene): Promise<boolean> {
  openCrewView()
  return until(() => isCrewViewOpen() && scene.lines().some(line => line.includes(`Crewmates (${SEATS})`)) && cellAt(scene.lines(), seatName(1)) !== null)
}
async function settle(scene: Scene, predicate: () => boolean): Promise<boolean> {
  const landed = await until(predicate, 3000)
  await sleep(150)
  return landed && predicate()
}
const click = (scene: Scene, at: { x: number; y: number }): void => scene.push(press(at.x, at.y) + release(at.x, at.y))

for (const [cols, rows] of SIZES) {
  const tag = `${cols}x${rows}`
  const scene = await openScene(cols, rows)
  section(`§1 ${tag}: the wheel over the list moves the selection the way the arrow keys do, and the transcript behind the popup stays where it was`)
  check(`${tag}: /crewmates lists the ${SEATS} crewmates`, await openList(scene), scene.lines().filter(l => l.trim() !== '').slice(0, 8).join(' | ').slice(0, 300))
  save(`crew-mouse-${tag}-rest`, scene.lines())
  const transcriptTop = scene.scrollTop()
  check(`${tag}: the transcript behind the popup can scroll (the scroller has rows to take)`, scene.scrollMax() > 0, `max ${scene.scrollMax()} · top ${transcriptTop}`)
  check(`${tag}: the cursor rests on the first row`, cursorName(scene.lines()) === seatName(1), describe(scene))
  const first = cellAt(scene.lines(), seatName(1))!
  scene.push(wheel('down', first.x, first.y))
  check(`${tag}: one wheel notch down moves the cursor to the second row`, await settle(scene, () => cursorName(scene.lines()) === seatName(2)), describe(scene))
  check(`${tag}: the transcript did not scroll under the popup`, scene.scrollTop() === transcriptTop, `top ${scene.scrollTop()} was ${transcriptTop}`)
  scene.push(wheel('down', first.x, first.y))
  check(`${tag}: a second notch moves it to the third row`, await settle(scene, () => cursorName(scene.lines()) === seatName(3)), describe(scene))
  scene.push(wheel('up', first.x, first.y))
  check(`${tag}: a notch up moves it back to the second row`, await settle(scene, () => cursorName(scene.lines()) === seatName(2)), describe(scene))
  scene.push(DOWN)
  check(`${tag}: ↓ still moves the cursor (the third row)`, await settle(scene, () => cursorName(scene.lines()) === seatName(3)), describe(scene))
  save(`crew-mouse-${tag}-wheel`, scene.lines())

  section(`§2 ${tag}: pgdn/pgup page the list, and the window follows the selection; the transcript stays`)
  const pageFrom = seatIndex(cursorName(scene.lines()))
  scene.push(PGDN)
  check(`${tag}: pgdn moves the cursor a page down and the window scrolls to it`, await settle(scene, () => seatIndex(cursorName(scene.lines())) > pageFrom + 1 && earlierMarker(scene.lines())), describe(scene))
  check(`${tag}: the transcript still did not scroll`, scene.scrollTop() === transcriptTop, `top ${scene.scrollTop()} was ${transcriptTop}`)
  scene.push(PGUP)
  check(`${tag}: pgup brings the cursor back to the third row`, await settle(scene, () => cursorName(scene.lines()) === seatName(3)), describe(scene))
  const firstShown = visibleSeats(scene.lines())[0]!
  let notches = 0
  while (notches < SEATS && !earlierMarker(scene.lines())) {
    const at = cellAt(scene.lines(), cursorName(scene.lines())) ?? first
    scene.push(wheel('down', at.x, at.y))
    notches++
    await sleep(60)
  }
  check(`${tag}: wheeling on scrolls the window with the cursor, as ↓ does (${notches} notches; ${firstShown} left the window)`, await settle(scene, () => earlierMarker(scene.lines()) && cursorName(scene.lines()) !== '(none)' && !visibleSeats(scene.lines()).includes(firstShown)), describe(scene))
  check(`${tag}: the transcript still did not scroll`, scene.scrollTop() === transcriptTop, `top ${scene.scrollTop()} was ${transcriptTop}`)
  save(`crew-mouse-${tag}-scrolled`, scene.lines())

  section(`§3 ${tag}: a click on a row selects it; a second click on the selected row opens it in the view, as ↵ does`)
  const shown = visibleSeats(scene.lines())
  const target = shown.find(name => seatIndex(name) >= 3 && name !== cursorName(scene.lines()))!
  click(scene, cellAt(scene.lines(), target)!)
  check(`${tag}: the click puts the cursor on ${target}`, await settle(scene, () => cursorName(scene.lines()) === target), describe(scene))
  check(`${tag}: a single click opens nothing — the list stays`, scene.viewing() === undefined && isCrewViewOpen(), describe(scene))
  await sleep(600)
  click(scene, cellAt(scene.lines(), target)!)
  check(`${tag}: the second click opens ${target} in the view and closes the list`, await settle(scene, () => scene.viewing() === seatId(seatIndex(target) + 1) && !isCrewViewOpen()), describe(scene))
  scene.push(ESC)
  check(`${tag}: esc leaves the view`, await settle(scene, () => scene.viewing() === undefined), describe(scene))

  section(`§4 ${tag}: a double click on a row opens it`)
  check(`${tag}: the list opens again`, await openList(scene), describe(scene))
  const fifth = seatName(5)
  const at = cellAt(scene.lines(), fifth)!
  scene.push(press(at.x, at.y) + release(at.x, at.y))
  await sleep(60)
  scene.push(press(at.x, at.y) + release(at.x, at.y))
  check(`${tag}: the double click opens ${fifth} in the view`, await settle(scene, () => scene.viewing() === seatId(5) && !isCrewViewOpen()), describe(scene))
  scene.push(ESC)
  check(`${tag}: esc leaves the view`, await settle(scene, () => scene.viewing() === undefined), describe(scene))

  section(`§5 ${tag}: clicks that land off the rows do nothing, and the key line reads as before`)
  check(`${tag}: the list opens again`, await openList(scene), describe(scene))
  const header = headerCell(scene.lines())!
  click(scene, header)
  await sleep(500)
  check(`${tag}: a click on the Crewmates heading moves nothing and opens nothing`, cursorName(scene.lines()) === seatName(1) && scene.viewing() === undefined && isCrewViewOpen(), describe(scene))
  click(scene, { x: header.x, y: header.y - 1 })
  await sleep(500)
  check(`${tag}: a click on the blank line above the heading moves nothing and opens nothing`, cursorName(scene.lines()) === seatName(1) && scene.viewing() === undefined && isCrewViewOpen(), describe(scene))
  const keys = keyLine(scene.lines())
  check(`${tag}: the key line still names the keys it named before`, keys.includes('↑↓ move') && keys.includes('pgup/pgdn page') && keys.includes(CREW_OPEN_IN_VIEW_KEY) && keys.includes('esc close'), keys)
  check(`${tag}: the key line gained no word for the mouse`, !/click|wheel|mouse|scroll/i.test(keys), keys)
  check(`${tag}: the transcript scroller yields the wheel while the list is open`, wheelYieldsToTopOverlay())
  scene.push(ESC)
  check(`${tag}: esc closes the list`, await settle(scene, () => !isCrewViewOpen()), describe(scene))
  check(`${tag}: the transcript scroller takes the wheel again once the list is closed`, !wheelYieldsToTopOverlay())
  await scene.close()
}

section('§6 the yield rule reads the crew view store alone')
{
  check('closed ⇒ the transcript keeps the wheel', !isCrewViewOpen() && !wheelYieldsToTopOverlay())
  openCrewView()
  check('open ⇒ the transcript yields the wheel', wheelYieldsToTopOverlay())
  closeCrewView()
  check('closed again ⇒ the transcript takes the wheel back', !wheelYieldsToTopOverlay())
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
rmSync(CWD, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} crew-view-mouse — ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
