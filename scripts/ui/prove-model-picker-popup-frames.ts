#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'picker-popup-frames-'))
process.env.MERCURY_CONFIG_DIR = HOME
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
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { BootSplashScreen } = await import('../../src/components/BootSplashScreen.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { useCompactWorkControls } = await import('../../src/components/tasks/CompactWorkSummary.tsx')
const { GlobalKeybindingHandlers } = await import('../../src/hooks/useGlobalKeybindings.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const modelCommand = await import('../../src/commands/model/mercuryModel.tsx')
const h = React.createElement

const COLS = 178
const ROWS = 51
const TITLE = 'Mercury · model'
const COMPOSER = 'Type a prompt'
const KEYS = '↑↓ select'
const DOWN = '\x1b[B'
const ESC = '\x1b'

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
async function until(predicate: () => boolean, ms = 15000): Promise<boolean> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, ms)
  while (!predicate() && !expired) await sleep(10)
  clearTimeout(timer)
  return predicate()
}
class Output extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
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
const hardLimit = setTimeout(() => { console.error('picker-popup-frames exceeded its deadline'); process.exit(1) }, 180_000)
hardLimit.unref()

type Window = { top: number; bottom: number; left: number; right: number; width: number; height: number; rows: string[] }

function windowOf(lines: string[]): Window | null {
  const titleRow = lines.findIndex(line => line.includes(TITLE))
  if (titleRow < 0) return null
  const titleAt = lines[titleRow]!.indexOf(TITLE)
  const left = lines[titleRow]!.lastIndexOf('│', titleAt)
  if (left < 0) return null
  let top = -1
  for (let y = titleRow; y >= 0; y--) {
    if (Array.from(lines[y]!)[left] === '╭') { top = y; break }
  }
  if (top < 0) return null
  const right = Array.from(lines[top]!).indexOf('╮', left + 1)
  if (right < 0) return null
  let bottom = -1
  for (let y = top + 1; y < lines.length; y++) {
    if (Array.from(lines[y]!)[left] === '╰') { bottom = y; break }
  }
  if (bottom < 0) return null
  const rows = lines.slice(top, bottom + 1).map(line => Array.from(line).slice(left, right + 1).join(''))
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1, rows }
}
const inner = (row: string): string => Array.from(row).slice(2, -2).join('').replace(/\s+$/, '')
const describe = (window: Window | null): string => (window === null ? 'no closed window' : `left ${window.left} · top ${window.top} · width ${window.width} · height ${window.height} (rows ${window.top}..${window.bottom})`)
const wholeBottom = (window: Window): boolean => Array.from(window.rows[window.height - 1]!).at(-1) === '╯'
const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${COLS}x${ROWS}.txt`), `${lines.join('\n')}\n`)
}
const cellsOf = (line: string): string[] => Array.from(line)

type Scene = { lines: () => string[]; push: (data: string) => void; close: () => Promise<void> }

async function mount(tree: React.ReactNode, ready: () => boolean): Promise<Scene> {
  const stdout = new Output()
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, tree))
  const painted = await until(() => ready() && ink.lastFrameText() !== '')
  check('the scene painted', painted, stripAnsi(ink.lastFrameText()).slice(0, 300))
  await sleep(300)
  return {
    lines: () => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n'),
    push: data => stdin.push(data),
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}

async function bootScene(): Promise<{ scene: Scene; frame: string[] }> {
  const scene = await mount(h(KeybindingSetup, null, h(BootSplashScreen)), () => true)
  const face = await until(() => scene.lines().join('\n').includes('↑↓ choose'))
  check('the Boot face painted its hint row', face, scene.lines().slice(0, 6).join(' | '))
  await sleep(200)
  scene.push('m')
  const opened = await until(() => scene.lines().some(line => line.includes(TITLE)), 8000)
  check('m opens the picker over the Boot face', opened)
  await sleep(400)
  return { scene, frame: scene.lines() }
}

async function sessionScene(): Promise<{ scene: Scene; frame: string[]; done: () => number }> {
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  let done = 0
  const element = await modelCommand.call(() => { done++ }, { messages: [], options: {} } as never, '')
  check('the /model command hands the session a surface to mount', element !== null && element !== undefined)
  const insertRef = { current: null } as React.MutableRefObject<unknown>
  const modalScrollRef = React.createRef<null>()
  function Transcript(): React.ReactNode {
    return h(Text, null, Array.from({ length: 3 }, (_, index) => `13:00:0${index + 1} [op] ❯ task ${index + 1}`).join('\n'))
  }
  function Harness(): React.ReactNode {
    const { controls, focus } = useCompactWorkControls()
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
      h(FullscreenLayout, {
        scrollable: h(Transcript),
        statusBand: h(Text, null, 'activity specimen'),
        statusBandActive: false,
        modal: h(Box, { width: '100%', flexDirection: 'column' }, element),
        modalScrollRef,
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 0, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async () => {},
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: true, insertTextRef: insertRef,
        } as never),
      } as never),
    )
  }
  const scene = await mount(h(Harness), () => true)
  const painted = await until(() => scene.lines().join('\n').includes(TITLE) && scene.lines().join('\n').includes('lanes'))
  check('the session painted the cockpit with the picker open', painted, scene.lines().slice(0, 6).join(' | '))
  await sleep(400)
  return { scene, frame: scene.lines(), done: () => done }
}

section(`§1 the Boot face at ${COLS}x${ROWS}: the picker as the pop-up it already is`)
const boot = await bootScene()
save('boot-face-picker', boot.frame)
const bootWindow = windowOf(boot.frame)
console.log(`Boot face window: ${describe(bootWindow)}`)
check('the Boot face draws the picker as one closed bordered window', bootWindow !== null, boot.frame.slice(0, 8).join(' | '))
await boot.scene.close()

section(`§2 the session at ${COLS}x${ROWS}: the same picker must be the same window`)
const session = await sessionScene()
save('session-picker', session.frame)
const sessionWindow = windowOf(session.frame)
console.log(`session window: ${describe(sessionWindow)}`)
const composerRow = session.frame.findIndex(line => line.includes(COMPOSER))
const lanesRow = session.frame.findIndex(line => line.includes('lanes'))
console.log(`composer row ${composerRow} · lanes header row ${lanesRow}`)
const sheetRule = session.frame.findIndex(line => /^▔+$/.test(line.trim()) && line.trim().length >= COLS - 2)
check('no full-width sheet rule is drawn across the terminal', sheetRule < 0, `rule at row ${sheetRule}`)
check('the composer stays visible around the picker', composerRow >= 0, 'the composer placeholder is not on screen')
check('the session draws the picker as one closed bordered window', sessionWindow !== null, session.frame.slice(-10).join(' | '))
if (bootWindow !== null && sessionWindow !== null) {
  check(`the window's left edge equals the Boot face's (${bootWindow.left})`, sessionWindow.left === bootWindow.left, `session ${sessionWindow.left}`)
  check(`the window's top row equals the Boot face's (${bootWindow.top})`, sessionWindow.top === bootWindow.top, `session ${sessionWindow.top}`)
  check(`the window's width equals the Boot face's (${bootWindow.width})`, sessionWindow.width === bootWindow.width, `session ${sessionWindow.width}`)
  const footer = inner(sessionWindow.rows[sessionWindow.height - 2]!)
  check('the keys row is the window\'s last inner row', footer.startsWith(KEYS), footer)
  const cells = cellsOf(session.frame[sessionWindow.top + 2] ?? '')
  check('the lanes rail stays visible left of the window', cells.slice(0, sessionWindow.left).join('').trim() !== '', 'nothing painted left of the window')
  const viewLeft = cellsOf(session.frame[0] ?? '').indexOf('╭')
  const viewBottom = session.frame.findIndex((line, row) => row > 0 && cellsOf(line)[viewLeft] === '╰')
  const viewRows = viewBottom - sessionWindow.top - 1
  const viewBudget = Math.min(bootWindow.height, viewRows)
  console.log(`the view's bottom border row ${viewBottom} · the window's bottom border row ${sessionWindow.bottom} · the composer's input row ${composerRow} · the Boot face's ${bootWindow.height} rows against the view's ${viewRows} inner rows from row ${sessionWindow.top}`)
  check(`the window's height is the view's budget (${viewBudget}: the lesser of the Boot face's ${bootWindow.height} and the view's ${viewRows} inner rows from row ${sessionWindow.top})`, sessionWindow.height === viewBudget, `session ${sessionWindow.height}`)
  check(`the window ends above the view's bottom border (row ${viewBottom}) and its bottom border paints whole`, viewBottom > 0 && sessionWindow.bottom < viewBottom && wholeBottom(sessionWindow), `window bottom ${sessionWindow.bottom} · last cell ${JSON.stringify(Array.from(sessionWindow.rows[sessionWindow.height - 1]!).at(-1))}`)
}
if (sessionWindow !== null) {
  const before = session.scene.lines()
  const beforeWindow = windowOf(before)!
  const firstRow = inner(beforeWindow.rows[3]!)
  for (let step = 0; step < 60; step++) {
    session.scene.push(DOWN)
    await sleep(25)
  }
  await sleep(400)
  const after = session.scene.lines()
  save('session-picker-scrolled', after)
  const afterWindow = windowOf(after)
  console.log(`session window after ↓×60: ${describe(afterWindow)}`)
  check('after ↓ past the last visible row the window keeps its place and its height', afterWindow !== null && afterWindow.top === beforeWindow.top && afterWindow.left === beforeWindow.left && afterWindow.width === beforeWindow.width && afterWindow.height === beforeWindow.height, describe(afterWindow))
  check('the rows scrolled inside the window (the first row changed and a ↑ more line leads)', afterWindow !== null && inner(afterWindow.rows[3]!) !== firstRow && afterWindow.rows.some(row => /↑ \d+ more/.test(row)), afterWindow === null ? '' : afterWindow.rows.slice(1, 5).map(inner).join(' | '))
  const footer = afterWindow === null ? '' : inner(afterWindow.rows[afterWindow.height - 2]!)
  check('the footer stays the window\'s last inner row while the rows scroll', footer.startsWith(KEYS), footer)
  session.scene.push(ESC)
  const closed = await until(() => !session.scene.lines().some(line => line.includes(TITLE)) || session.done() > 0, 5000)
  check('esc closes the picker', closed)
}
await session.scene.close()

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\npicker-popup-frames: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
