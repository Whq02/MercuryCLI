#!/usr/bin/env bun

import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'activity-screen-keys-'))
const CWD = mkdtempSync(join(tmpdir(), 'activity-screen-cwd-'))
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
const { BackgroundTasksDialog } = await import('../../src/components/tasks/BackgroundTasksDialog.tsx')
const { useCompactWorkControls } = await import('../../src/components/tasks/CompactWorkSummary.tsx')
const { GlobalKeybindingHandlers } = await import('../../src/hooks/useGlobalKeybindings.tsx')
const { ScrollKeybindingHandler } = await import('../../src/components/ScrollKeybindingHandler.tsx')
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
const { setZenMode } = await import('../../src/utils/cockpit/zenMode.ts')
const { _publishVitalsForProofs } = await import('../../src/state/vitalsBus.ts')
const h = React.createElement

const STATS = 'Session statistics'
const COMPOSER = 'Type a prompt'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const LEFT = '\x1b[D'
const WHEEL_DOWN = '\x1b[<65;10;10M'
const ENTER = '\r'
const ESC = '\x1b'
const TOGGLE = '\u0014'
const MONITORS = 6
const SIZES: Array<[number, number, boolean]> = [[80, 24, false], [64, 20, false], [100, 30, true], [177, 49, true]]

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
const hardLimit = setTimeout(() => { console.error('activity-screen-keys exceeded its deadline'); process.exit(1) }, 240_000)
hardLimit.unref()

const rosterRows = Array.from({ length: MONITORS }, (_, index) => ({
  id: `mon-${index + 1}`, kind: 'monitor' as const, name: `monitor ${index + 1} watching build-${index + 1}.log`, status: 'running', startTime: Date.now() - (index + 1) * 60_000, command: `tail -f build-${index + 1}.log`,
}))
let roster = { rows: rosterRows, mission: [] as Array<{ id: string; subject: string; activeForm?: string; status: string }>, samples: [], reported: true }
const rosterListeners = new Set<() => void>()
function landMission(): void {
  roster = { ...roster, mission: [
    { id: 'm1', subject: 'walk the activity screen', activeForm: 'walking the activity screen', status: 'in_progress' },
    { id: 'm2', subject: 'read the counts', activeForm: 'reading the counts', status: 'in_progress' },
    { id: 'm3', subject: 'reach the last monitor', status: 'pending' },
    { id: 'm4', subject: 'close the screen', status: 'pending' },
  ] }
  for (const listener of rosterListeners) listener()
}
function seedRoster(): void {
  roster = { ...roster, mission: [] }
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

const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}
const monitorAt = (lines: string[]): number | undefined => {
  const row = lines.find(line => /^❯ .*monitor \d+ watching/.test(line))
  const match = row?.match(/monitor (\d+) watching/)
  return match === null || match === undefined ? undefined : Number(match[1])
}
const cursorPainted = (lines: string[]): boolean => lines.some(line => /^❯ .*monitor \d+ watching/.test(line))
const hintPainted = (lines: string[]): boolean => lines.some(line => line.includes('↑/↓ select') && line.includes('esc close'))
const statsPainted = (lines: string[]): boolean => lines.some(line => line.startsWith(STATS))
const shellFooterPainted = (lines: string[]): boolean => /esc close\s*$/.test(lines[lines.length - 1] ?? '')
const describe = (lines: string[]): string => `cursor on ${monitorAt(lines) ?? 'nothing'} · rows ${lines.length} · last ${JSON.stringify(lines[lines.length - 1] ?? '')}`

type Scene = { lines: () => string[]; push: (data: string) => void; resize: (cols: number, rows: number) => Promise<void>; focus: () => string; close: () => Promise<void> }

async function openScene(cols: number, rows: number, zen: boolean): Promise<Scene> {
  setZenMode(zen)
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  seedRoster()
  const state = getDefaultAppState()
  const scrollRef = React.createRef<null>()
  const modalScrollRef = React.createRef<null>()
  const insertRef = { current: null } as React.MutableRefObject<unknown>
  let control: { read: () => string } | null = null
  function Transcript(): React.ReactNode {
    return h(Text, null, Array.from({ length: 30 }, (_, index) => `13:00:${String(index).padStart(2, '0')} [op] task ${index + 1}`).join('\n'))
  }
  function Harness(): React.ReactNode {
    const { controls, focus } = useCompactWorkControls()
    control = controls
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    const detail = focus === 'detail'
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
      h(ScrollKeybindingHandler, { scrollRef, isActive: true, modalScrollRef, modalUp: detail } as never),
      h(FullscreenLayout, {
        scrollRef, modalScrollRef, modalActive: detail,
        scrollable: h(Transcript),
        statusBand: h(Text, null, 'activity specimen'),
        statusBandActive: false,
        modal: detail ? h(BackgroundTasksDialog, { entry: 'compact-summary', compactControls: controls, onDone: () => controls.set('composer'), toolUseContext: {} as never }) : undefined,
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
  check(`the chat painted its composer at ${cols}x${rows}${zen ? ' (zen)' : ''}`, composed, lines().slice(0, 6).join(' | '))
  stdin.push(TOGGLE)
  await sleep(150)
  stdin.push(ENTER)
  const opened = await until(() => control?.read() === 'detail' && lines().some(line => line.includes('activity ·')))
  check(`ctrl+t then ↵ opens the activity screen at ${cols}x${rows}`, opened, lines().slice(0, 8).join(' | '))
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
    focus: () => control?.read() ?? 'none',
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
      releaseFocusedSessionConnector()
      setZenMode(false)
    },
  }
}

async function pressTimes(scene: Scene, data: string, times: number): Promise<void> {
  for (let index = 0; index < times; index++) {
    scene.push(data)
    await sleep(120)
  }
  await sleep(250)
}

section('§1 the arrows move the selection and the panel follows, at every size')
for (const [cols, rows, zen] of SIZES) {
  const label = `${cols}x${rows}${zen ? ' zen' : ''}`
  const scene = await openScene(cols, rows, zen)
  const opening = scene.lines()
  save(`activity-${cols}x${rows}-open`, opening)
  check(`${label}: the selected row is painted on open (the cursor on monitor 1)`, monitorAt(opening) === 1, describe(opening))
  check(`${label}: the shell footer is the last row`, shellFooterPainted(opening), describe(opening))
  await pressTimes(scene, DOWN, 3)
  const moved = scene.lines()
  save(`activity-${cols}x${rows}-down-3`, moved)
  check(`${label}: ↓ ×3 moves the cursor to monitor 4 and it is painted`, monitorAt(moved) === 4, describe(moved))
  check(`${label}: the shell footer stays the last row`, shellFooterPainted(moved), describe(moved))
  await pressTimes(scene, DOWN, MONITORS - 4)
  const last = scene.lines()
  check(`${label}: ↓ reaches the last monitor and it is painted`, monitorAt(last) === MONITORS, describe(last))
  await pressTimes(scene, DOWN, 3)
  const edge = scene.lines()
  save(`activity-${cols}x${rows}-end`, edge)
  check(`${label}: ↓ at the last row keeps the cursor there (never wraps)`, monitorAt(edge) === MONITORS, describe(edge))
  check(`${label}: the list's own hint row is reachable below the last row`, hintPainted(edge), describe(edge))
  await pressTimes(scene, UP, MONITORS + 2)
  const first = scene.lines()
  check(`${label}: ↑ walks back to monitor 1 and it is painted`, monitorAt(first) === 1, describe(first))
  await pressTimes(scene, UP, 16)
  const top = scene.lines()
  save(`activity-${cols}x${rows}-top`, top)
  check(`${label}: ↑ at the first row scrolls the panel up to the session statistics`, statsPainted(top), describe(top))
  check(`${label}: the cursor stays on monitor 1 while the panel scrolls`, monitorAt(top) === 1 || !cursorPainted(top), describe(top))
  await pressTimes(scene, DOWN, 1)
  const back = scene.lines()
  check(`${label}: ↓ after the scroll moves to monitor 2 and brings it into view`, monitorAt(back) === 2, describe(back))
  scene.push(WHEEL_DOWN)
  await sleep(300)
  const wheeled = scene.lines()
  check(`${label}: the wheel scrolls the panel without moving the selection`, monitorAt(wheeled) === 2 || !cursorPainted(wheeled), describe(wheeled))
  scene.push(ENTER)
  const detailed = await until(() => scene.lines().some(line => line.includes('tail -f build-2.log')) && !scene.lines().some(line => line.includes('Monitors (')), 5000)
  check(`${label}: ↵ opens the selected monitor's card`, detailed, scene.lines().slice(0, 10).join(' | '))
  scene.push(LEFT)
  const listed = await until(() => scene.lines().some(line => line.includes('Monitors (')), 5000)
  check(`${label}: ← returns to the list with the cursor where it was`, listed && monitorAt(scene.lines()) === 2, describe(scene.lines()))
  scene.push(ESC)
  const closed = await until(() => scene.focus() === 'composer' && scene.lines().join('\n').includes(COMPOSER), 5000)
  check(`${label}: esc closes the activity screen`, closed, describe(scene.lines()))
  await scene.close()
}

section('§2 a live resize while the screen is open keeps the selected row in view')
{
  const scene = await openScene(177, 49, true)
  await pressTimes(scene, DOWN, 3)
  for (const [cols, rows] of [[80, 24], [64, 20], [100, 30], [177, 49]] as Array<[number, number]>) {
    await scene.resize(cols, rows)
    const frame = scene.lines()
    save(`activity-resize-${cols}x${rows}`, frame)
    check(`resize → ${cols}x${rows}: the frame has the terminal's rows`, frame.length === rows, `${frame.length} rows`)
    check(`resize → ${cols}x${rows}: the cursor row (monitor 4) is painted`, monitorAt(frame) === 4, describe(frame))
    check(`resize → ${cols}x${rows}: the shell footer is the last row`, shellFooterPainted(frame), describe(frame))
    await pressTimes(scene, DOWN, 1)
    check(`resize → ${cols}x${rows}: ↓ still moves the cursor and it is painted`, monitorAt(scene.lines()) === 5, describe(scene.lines()))
    await pressTimes(scene, UP, 1)
  }
  await scene.close()
}

section('§3 content above the list lands after the first frame: the selected row stays in view')
const repositoryRow = (lines: string[]): boolean => lines.some(line => /^repository\s/.test(line))
const missionRow = (lines: string[]): boolean => lines.some(line => line.startsWith('Mission ('))
for (const [cols, rows] of [[80, 24], [64, 20]] as Array<[number, number]>) {
  const scene = await openScene(cols, rows, false)
  const opening = scene.lines()
  check(`${cols}x${rows}: the scene's folder is no repository, so the screen opens without the repository row and the cursor on monitor 1 in view`, !repositoryRow(opening) && monitorAt(opening) === 1, describe(opening))
  _publishVitalsForProofs({ git: { commitHash: '0123456789abcdef', branchName: 'lane/late-git', remoteUrl: null, isHeadOnRemote: false, isClean: true, worktreeCount: 1, unpushedCount: 0 } as never })
  const landed = await until(() => repositoryRow(scene.lines()), 5000)
  await sleep(300)
  const after = scene.lines()
  save(`activity-${cols}x${rows}-late-git`, after)
  check(`${cols}x${rows}: the repository row lands above the list`, landed && repositoryRow(after), describe(after))
  check(`${cols}x${rows}: the selected row is still painted after the late row (no key pressed)`, monitorAt(after) === 1, describe(after))
  landMission()
  const missionLanded = await until(() => missionRow(scene.lines()), 5000)
  await sleep(300)
  const withMission = scene.lines()
  save(`activity-${cols}x${rows}-late-mission`, withMission)
  check(`${cols}x${rows}: the mission rows land above the list`, missionLanded && missionRow(withMission), describe(withMission))
  check(`${cols}x${rows}: the selected row is still painted after the mission rows (no key pressed)`, monitorAt(withMission) === 1, describe(withMission))
  await pressTimes(scene, DOWN, 1)
  check(`${cols}x${rows}: ↓ then moves to monitor 2 in view`, monitorAt(scene.lines()) === 2, describe(scene.lines()))
  await scene.close()
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
rmSync(CWD, { recursive: true, force: true })
console.log(`\nactivity-screen-keys: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
