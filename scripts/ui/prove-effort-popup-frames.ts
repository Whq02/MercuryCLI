#!/usr/bin/env bun

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'effort-popup-frames-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
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
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { useCompactWorkControls } = await import('../../src/components/tasks/CompactWorkSummary.tsx')
const { GlobalKeybindingHandlers } = await import('../../src/hooks/useGlobalKeybindings.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const effortCommand = await import('../../src/commands/effort/effort.tsx')
const popup = await import('../../src/commands/effort/EffortPopup.tsx')
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const { MODEL_PICKER_CURRENT } = await import('../../src/utils/model/modelPickerGroups.ts')
const h = React.createElement

const TITLE = 'Mercury · effort'
const COMPOSER = 'Type a prompt'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const HOME_KEY = '\x1b[H'
const END_KEY = '\x1b[F'
const WHEEL_UP = '\x1b[<64;10;10M'
const WHEEL_DOWN = '\x1b[<65;10;10M'
const ENTER = '\r'
const ESC = '\x1b'
const CLICK_OUTSIDE = '\x1b[<0;3;3M\x1b[<0;3;3m'
const SIZES: Array<[number, number]> = [[178, 51], [80, 24], [100, 30], [64, 20]]

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
  columns = 178
  rows = 51
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
const hardLimit = setTimeout(() => { console.error('effort-popup-frames exceeded its deadline'); process.exit(1) }, 240_000)
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
const cursorRow = (window: Window): string | undefined => window.rows.map(inner).find(row => row.startsWith('❯ '))
const cursorWord = (window: Window): string | undefined => cursorRow(window)?.slice(2).trim().split(/\s+/)[0]
const tierRows = (window: Window): string[] => window.rows.map(inner).filter(row => /^(❯| ) (auto|low|medium|high|xhigh|max)\s/.test(row)).map(row => row.slice(2).trim().split(/\s+/)[0]!)
const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}

type Scene = { lines: () => string[]; push: (data: string) => void; resize: (cols: number, rows: number) => Promise<void>; done: () => unknown[][]; close: () => Promise<void> }

async function openScene(cols: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const done: unknown[][] = []
  const context = { messages: [], options: { engineModel: getEngineModel() }, getAppState: () => getDefaultAppState(), setAppState: () => {} }
  const element = await effortCommand.call((...args: unknown[]) => { done.push(args) }, context as never, '')
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
  const stdout = new Output()
  stdout.columns = cols
  stdout.rows = rows
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness)))
  const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
  const painted = await until(() => lines().join('\n').includes(TITLE) && lines().join('\n').includes(COMPOSER))
  check(`the session painted the popup at ${cols}x${rows}`, painted, lines().slice(0, 6).join(' | '))
  await sleep(400)
  return {
    lines,
    push: data => stdin.push(data),
    resize: async (nextCols, nextRows) => {
      stdout.columns = nextCols
      stdout.rows = nextRows
      stdout.emit('resize')
      await sleep(500)
    },
    done: () => done,
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}

const model = getEngineModel()
const expectedRows = popup.effortPopupRows(model).map(row => row.word)
const expectedCurrent = popup.effortPopupOpeningLevel(model, undefined)

function frameReadsRight(label: string, lines: string[], cols: number, rows: number, envLine: boolean, cursorAt: string | undefined = expectedCurrent): Window | null {
  const window = windowOf(lines)
  console.log(`${label}: ${describe(window)}`)
  check(`${label}: one closed bordered window titled ${TITLE}`, window !== null && wholeBottom(window), lines.slice(0, 8).join(' | '))
  if (window === null) return null
  check(`${label}: the window lies inside the terminal (${cols}x${rows})`, window.right < cols && window.bottom < rows && window.left >= 0 && window.top >= 0, describe(window))
  check(`${label}: the rows are the tiers the model serves, auto first, max last (${expectedRows.join(' ')})`, tierRows(window).join(' ') === expectedRows.join(' '), tierRows(window).join(' '))
  const current = window.rows.map(inner).find(row => row.endsWith(` ${MODEL_PICKER_CURRENT}`))
  check(`${label}: exactly one row carries the ${MODEL_PICKER_CURRENT} mark and it is the running tier (${expectedCurrent})`, window.rows.map(inner).filter(row => row.endsWith(` ${MODEL_PICKER_CURRENT}`)).length === 1 && current !== undefined && current.slice(2).trim().startsWith(expectedCurrent), current ?? '(no current row)')
  check(`${label}: the cursor row is ${cursorAt === expectedCurrent ? 'the running tier' : `where it was left (${cursorAt})`}`, cursorWord(window) === cursorAt, cursorWord(window) ?? '(no cursor row)')
  const footer = inner(window.rows[window.height - 2]!)
  check(`${label}: the hint footer is the window's last inner row`, footer.startsWith('↑↓ move · ↵ apply') && popup.EFFORT_POPUP_HINT.startsWith(footer.replace(/…$/, '')), footer)
  check(`${label}: the model line names the model and the ladder`, window.rows.some(row => inner(row).includes('effort ') && inner(row).includes('…') && inner(row).includes('running ')), window.rows.slice(1, 4).map(inner).join(' | '))
  check(`${label}: the env-override line ${envLine ? 'is painted' : 'is absent'}`, window.rows.some(row => inner(row).startsWith('MERCURY_EFFORT_LEVEL=')) === envLine, window.rows.slice(1, 4).map(inner).join(' | '))
  const composerRow = lines.findIndex(line => line.includes(COMPOSER))
  check(`${label}: the composer stays visible under the popup`, composerRow > window.bottom, `composer row ${composerRow}`)
  return window
}

section('§1 the popup at every size the product supports, each opened fresh')
for (const [cols, rows] of SIZES) {
  const scene = await openScene(cols, rows)
  const frame = scene.lines()
  save(`effort-${cols}x${rows}`, frame)
  const window = frameReadsRight(`${cols}x${rows}`, frame, cols, rows, false)
  if (window !== null && cols >= 100) {
    const lanesRow = frame.findIndex(line => line.includes('lanes'))
    check(`${cols}x${rows}: the lanes rail stays visible left of the window`, lanesRow >= 0 && Array.from(frame[window.top + 2] ?? '').slice(0, window.left).join('').trim() !== '', 'nothing painted left of the window')
  }
  await scene.close()
}

section('§2 the keys at 80x24: ↑↓, the wheel, Home/End, then esc')
{
  const scene = await openScene(80, 24)
  const at = (): string => cursorWord(windowOf(scene.lines())!) ?? '(none)'
  const index = (word: string): number => expectedRows.indexOf(word)
  const start = index(at())
  scene.push(DOWN)
  await sleep(250)
  check('↓ moves the cursor one row down', index(at()) === Math.min(expectedRows.length - 1, start + 1), at())
  scene.push(WHEEL_DOWN)
  await sleep(250)
  check('the mouse wheel down moves the cursor one row down', index(at()) === Math.min(expectedRows.length - 1, start + 2), at())
  scene.push(WHEEL_UP)
  await sleep(250)
  check('the mouse wheel up moves the cursor one row up', index(at()) === Math.min(expectedRows.length - 1, start + 1), at())
  scene.push(UP)
  await sleep(250)
  check('↑ moves the cursor one row up', index(at()) === start, at())
  scene.push(END_KEY)
  await sleep(250)
  check('End reaches the last row, the model\'s max', at() === expectedRows[expectedRows.length - 1], at())
  scene.push(DOWN)
  await sleep(250)
  check('↓ at the last row clamps (never wraps)', at() === expectedRows[expectedRows.length - 1], at())
  scene.push(HOME_KEY)
  await sleep(250)
  check('Home reaches the first row, auto', at() === expectedRows[0], at())
  scene.push(UP)
  await sleep(250)
  check('↑ at the first row clamps (never wraps)', at() === expectedRows[0], at())
  const moved = windowOf(scene.lines())!
  check('the current mark never follows the cursor', moved.rows.map(inner).find(row => row.endsWith(` ${MODEL_PICKER_CURRENT}`))?.slice(2).trim().startsWith(expectedCurrent) === true)
  save('effort-80x24-cursor-auto', scene.lines())
  scene.push(ESC)
  const closed = await until(() => scene.done().length > 0, 5000)
  check('esc closes the popup with nothing changed', closed && String(scene.done()[0]?.[0]).startsWith('Effort unchanged ('), JSON.stringify(scene.done()))
  await scene.close()
}

section('§3 ↵ applies the row under the cursor through the apply road')
{
  const scene = await openScene(80, 24)
  scene.push(END_KEY)
  await sleep(250)
  scene.push(ENTER)
  const applied = await until(() => scene.done().length > 0, 8000)
  const receipt = scene.done()[0]
  const words = receipt === undefined ? '' : receipt[0] === undefined ? JSON.stringify(receipt[1]) : String(receipt[0])
  check('↵ settles the pick: the command finishes with the apply road\'s receipt (or the status-row skip)', applied && (words.includes('max') || words.includes('skip')), JSON.stringify(scene.done()))
  await scene.close()
}

section('§4 a click outside the popup closes it with nothing changed')
{
  const scene = await openScene(178, 51)
  scene.push(DOWN)
  await sleep(250)
  scene.push(CLICK_OUTSIDE)
  const closed = await until(() => scene.done().length > 0, 5000)
  check('a click on the chat beside the popup closes it like esc', closed && String(scene.done()[0]?.[0]).startsWith('Effort unchanged ('), JSON.stringify(scene.done()))
  await scene.close()
}

section('§5 a live resize while the popup is open, with the env pin painted')
{
  process.env.MERCURY_EFFORT_LEVEL = 'high'
  const scene = await openScene(178, 51)
  scene.push(DOWN)
  await sleep(250)
  const cursorBefore = cursorWord(windowOf(scene.lines())!)
  const stops: Array<[number, number]> = [[80, 24], [64, 20], [100, 30], [178, 51]]
  for (const [cols, rows] of stops) {
    await scene.resize(cols, rows)
    const frame = scene.lines()
    save(`effort-resize-${cols}x${rows}`, frame)
    frameReadsRight(`resize → ${cols}x${rows}`, frame, cols, rows, true, cursorBefore)
    check(`resize → ${cols}x${rows}: nothing of the popup paints outside the frame (no second title)`, frame.filter(line => line.includes(TITLE)).length === 1)
  }
  delete process.env.MERCURY_EFFORT_LEVEL
  await scene.close()
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\neffort-popup-frames: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
