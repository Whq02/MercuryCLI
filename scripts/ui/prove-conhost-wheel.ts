import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mountOffscreen, pinScratchHome, releaseScratchHome, settle, waitFor, pinSourceRef, type Mounted } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const HOME = pinScratchHome('conhost-wheel')
for (const key of ['TYPESAFE_API_KEY', 'MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_SKIP_PROMPT_HISTORY', 'NODE_ENV']) delete process.env[key]
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_JEV_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_OPERATOR = 'operator'
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.BROWSER = '/usr/bin/true'
const PROJECT = join(HOME, 'project')
mkdirSync(PROJECT, { recursive: true })
process.chdir(PROJECT)
mock.module('node:child_process', () => ({
  ...childProcess,
  execFile: (...args: unknown[]) => {
    const callback = args.find(arg => typeof arg === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
    return { kill() {}, on() {}, unref() {} }
  },
}))

const React = await import('react')
const h = React.createElement
const { App } = await import('../../src/components/App.js')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.js')
const { SurfaceRouter } = await import('../../src/components/SurfaceRouter.js')
const { Chat } = await import('../../src/screens/Chat.js')
const route = await import('../../src/context/surfaceRoute.js')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.js')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.js')
const { InkInstanceContext } = await import('../../src/ink/components/InkInstanceContext.js')
const { resolveAlternateScrollIntent } = await import('../../src/ink/termio/alternateScrollPolicy.js')
const { parseMultipleKeypresses, INITIAL_STATE } = await import('../../src/ink/input/input-decoder.js')
const pending = await import('../../src/input-core/pending-input.js')
const slot = await import('../../src/services/engine-connector/focusedConnector.js')
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.js')
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
const { getCommands } = await import('../../src/commands.js')
const { markDaemonHaltStanddown } = await import('../../src/utils/daemonStanddown.js')
const history = await import('../../src/history.js')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true, hasTrustDialogAccepted: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false, hasCompletedOnboarding: true, theme: 'dark' }))
markDaemonHaltStanddown()
const commands = await getCommands(PROJECT)
const LINES = ['! echo WHEEL_A', '! echo WHEEL_B', '! echo WHEEL_C']
for (const line of LINES) history.addToHistory(line)
await waitFor(() => { const health = history.getHistoryFlushHealth(); return health.pending === 0 && !health.inFlight }, 4000)

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const SGR_UP = '\x1b[<64;60;15M'
const SGR_DOWN = '\x1b[<65;60;15M'
const DRAFT = 'U20_DRAFT'
const COLS = 120
const ROWS = 30
let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 2000)}` : ''}`)
}
let mounted: Mounted | undefined
let ink: React.ContextType<typeof InkInstanceContext>
function Tap(): null { ink = React.useContext(InkInstanceContext); return null }
function chatTree(): React.ReactElement {
  return h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined, children: h(React.Fragment, null, h(Tap), h(SurfaceRouter, null, h(Chat, { commands, initialTools: [] }))) })
}
async function openChat(long: boolean): Promise<Mounted> {
  mounted?.unmount()
  slot.releaseFocusedSessionConnector()
  const connector = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'fixture', title: 'wheel fixture', projectLabel: 'fixture', workspaceId: 'fixture', home: HOME })
  connector.workspace = () => ({ cwd: PROJECT, projectRoot: PROJECT }) as ReturnType<typeof connector.workspace>
  if (long) for (const block of ['A', 'B', 'C']) {
    connector.addDisplayRow(createUserMessage({ content: `output ${block}` }))
    connector.addDisplayRow(createAssistantMessage({ content: Array.from({ length: 35 }, (_, i) => `WHEEL_${block}_${String(i + 1).padStart(2, '0')}`).join('\n') }))
  }
  slot.setFocusedSessionConnector(connector)
  route.initializeSurfaceRoute(route.ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  pending.setPastedContents({})
  mounted = await mountOffscreen(chatTree(), COLS, ROWS, { mouseTracking: true })
  check(`${long ? 'long' : 'short'} transcript mounts the real composer`, await waitFor(() => mounted!.screen().includes('Type a prompt'), 8000), mounted.screen())
  await settle(250)
  return mounted
}
async function push(data: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' })
  try {
    mounted!.push(data)
    await settle(180)
  } finally { Object.defineProperty(process, 'platform', descriptor) }
}
const rows = (): string[] => mounted!.lines().flatMap(line => line.match(/WHEEL_[ABC]_\d\d/g) ?? [])
const rowNumber = (): number => {
  const first = rows()[0]
  return first ? (first.charCodeAt(6) - 65) * 35 + Number(first.slice(-2)) : -1
}
const frameAt = process.argv.indexOf('--frames')
const frames = frameAt < 0 ? undefined : process.argv[frameAt + 1]
async function capture(name: string): Promise<void> {
  if (!frames) return
  mkdirSync(frames, { recursive: true })
  const grid = mounted!.lines().map((line, y) => Array.from(line.padEnd(COLS)).map((c, x) => {
    const style = mounted!.styleAt(x, y)
    return { c, bg: style?.bg ?? 'default', fg: style?.fg ?? 'default', bold: style?.bold ?? false }
  }))
  const file = join(frames, name + '.grid.json')
  writeFileSync(file, JSON.stringify({ cols: COLS, rows: ROWS, grid }))
  writeFileSync(join(frames, name + '.txt'), mounted!.screen())
  const { gridToPng } = await import('./gridToPng.js')
  await gridToPng(file, join(frames, name + '.png'))
}
async function notches(label: string, up = UP, down = DOWN): Promise<void> {
  for (const [direction, bytes] of [[-1, up], [-1, up], [1, down]] as const) {
    const before = rowNumber()
    await push(bytes)
    check(`${label}: ${direction < 0 ? 'up' : 'down'} notch moves three transcript rows`, before > 0 && rowNumber() === before + 3 * direction, `${before} -> ${rowNumber()}`)
    check(`${label}: draft and mode survive the notch`, pending.text() === DRAFT && pending.mode() === 'prompt', pending.text())
  }
}
try {
  const arrows = parseMultipleKeypresses(INITIAL_STATE, UP + DOWN)[0]
  const state = { altScreenActive: true, mouseTrackingEnabled: true, elevatedSurfaceActive: false, platform: 'win32', wheelReportingConfirmed: false, scrollableTranscript: true }
  const names = (overrides: Partial<typeof state> = {}): string => resolveAlternateScrollIntent(arrows, { ...state, ...overrides }).map(a => a.kind === 'key' ? a.name : a.kind).join(',')
  check('requested-but-unconfirmed win32 tracking routes plain arrows to transcript wheel', names() === 'wheelup,wheeldown', names())
  for (const [label, patch] of [
    ['non-scrollable transcript', { scrollableTranscript: false }],
    ['SGR wheel confirmed', { wheelReportingConfirmed: true }],
    ['elevated surface', { elevatedSurfaceActive: true }],
    ['main screen', { altScreenActive: false }],
    ['non-Windows terminal', { platform: 'linux' }],
  ] as const) check(`${label} keeps keyboard history arrows`, names(patch) === 'up,down', names(patch))
  const modified = parseMultipleKeypresses(INITIAL_STATE, '\x1b[1;5A\x1b[1;2B\x10\x0e')[0]
  check('modified arrows and Ctrl-P/Ctrl-N are never wheel', resolveAlternateScrollIntent(modified, state).every((a, i) => a === modified[i]))
  check('native selection keeps its existing alternate-scroll road', names({ mouseTrackingEnabled: false, platform: 'linux' }) === 'wheelup,wheeldown')

  await openChat(true)
  check('tracking requested before any wheel report', ink?.isMouseTrackingEnabled() === true)
  const emptyBefore = rowNumber()
  await push(UP)
  check('an empty composer scrolls instead of recalling history', pending.text() === '' && rowNumber() === emptyBefore - 3, `${emptyBefore} -> ${rowNumber()}; ${pending.text()}`)
  await push('\x15')
  pending.setMode('prompt')
  await settle(80)
  await push(DRAFT)
  await capture('conhost-before')
  await notches('conhost 120x30')
  await capture('conhost-after')
  for (const columns of [121, 120]) {
    mounted!.resize(chatTree(), columns, ROWS)
    await settle(300)
    check(`resize to ${columns} columns keeps the draft`, pending.text() === DRAFT, pending.text())
  }
  await notches('conhost 120→121→120')
  await capture('conhost-resized')
  await notches('conhost application cursor arrows', '\x1bOA', '\x1bOB')
  await push('\x1b[<35;60;15M')
  await notches('motion alone does not confirm SGR wheel support')
  await push('\x10')
  check('Ctrl-P still recalls on a scrollable transcript', pending.mode() === 'bash' && pending.text().includes('echo WHEEL_C'), pending.text())
  await push('\x1b')
  check('one Esc clears a recalled shell line and returns to prompt mode', pending.text() === '' && pending.mode() === 'prompt', pending.text())
  await push(DRAFT)
  check('typing after Esc starts a fresh draft', pending.text() === DRAFT, pending.text())

  await openChat(false)
  await push(UP)
  check('a physical Up on a non-scrollable transcript still recalls history', pending.mode() === 'bash' && pending.text().includes('echo WHEEL_C'), pending.text())
  await push('\x1b')
  check('Esc clears recalled history on a non-scrollable transcript', pending.text() === '' && pending.mode() === 'prompt', pending.text())
  await push('fresh')
  check('no recalled suffix survives clearing', pending.text() === 'fresh', pending.text())

  await openChat(true)
  await push(DRAFT)
  await notches('Windows Terminal SGR wheel', SGR_UP, SGR_DOWN)
  await push(UP)
  check('a delivered SGR wheel report restores real keyboard history on win32', pending.mode() === 'bash' && pending.text().includes('echo WHEEL_C'), pending.text())
  await push('\x1b')
  await push(DRAFT)
  for (const columns of [121, 120]) { mounted!.resize(chatTree(), columns, ROWS); await settle(300) }
  await notches('Windows Terminal after resize', SGR_UP, SGR_DOWN)
  await capture('windows-terminal-resized')
  await push(UP)
  check('resize retains confirmed SGR wheel support', pending.mode() === 'bash' && pending.text().includes('echo WHEEL_C'), pending.text())
  await push('\x1b')
  await push(DRAFT)
  ink!.setMouseTrackingEnabled(false)
  ink!.setMouseTrackingEnabled(true)
  await notches('a fresh tracking request needs a fresh wheel report')
  await push('\x15')
  await push('/workbench')
  await push('\r')
  check('the workbench opens above the scrollable transcript', await waitFor(() => /PROMPTS \(3\)/.test(mounted!.screen()), 4000), mounted!.screen())
  await push(UP)
  check('unconfirmed win32 arrows still navigate the workbench list', /output B/.test(mounted!.lines().find(line => /^│ ▸ /.test(line)) ?? ''), mounted!.screen())
  await push('\x1b')
  await push(DRAFT)
  await notches('closing the workbench restores the conhost scroll target')
} finally {
  mounted?.unmount()
  slot.releaseFocusedSessionConnector()
  await releaseScratchHome(HOME)
}
console.log(`conhost-wheel: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
