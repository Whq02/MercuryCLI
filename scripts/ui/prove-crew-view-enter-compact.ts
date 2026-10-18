#!/usr/bin/env bun
// gate-watch: src/components/tasks/BackgroundTasksDialog.tsx src/components/mercury-ui/components.tsx src/components/mercury-ui/useCursorFollow.ts src/components/PopupForm.tsx src/components/FullscreenLayout.tsx src/state/vitalsBus.ts src/ink/ink.tsx
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crew-view-enter-'))
const CWD = mkdtempSync(join(tmpdir(), 'crew-view-cwd-'))
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
const { openCrewView, isCrewViewOpen } = await import('../../src/utils/cockpit/crewView.ts')
const { useAppStateStore } = await import('../../src/state/AppState.tsx')
let storeRef: { getState: () => unknown } | null = null
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
const hardLimit = setTimeout(() => { console.error('crew-view-enter-compact exceeded its deadline'); process.exit(1) }, 240_000)
hardLimit.unref()

const rosterRows = [
  { id: 'mon-1', kind: 'monitor' as const, name: 'monitor 1 watching build-1.log', status: 'running', startTime: Date.now() - 60_000, command: 'tail -f build-1.log' },
  { id: 'agent-1', kind: 'agent' as const, name: 'scout one', status: 'running', startTime: Date.now() - 120_000, description: 'reads the ledger', agentType: 'scout' },
  { id: 'agent-2', kind: 'agent' as const, name: 'builder two', status: 'completed', startTime: Date.now() - 240_000, endTime: Date.now() - 100_000, description: 'built the thing', agentType: 'mercury-crew' },
]
let roster = { rows: rosterRows, mission: [] as Array<{ id: string; subject: string; activeForm?: string; status: string }>, samples: [], reported: true }
const rosterListeners = new Set<() => void>()
const stops: string[] = []
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
      if (prop === 'stopAgent') return (id: string) => { stops.push(id); return Promise.resolve({ outcome: 'applied' }) }
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
  const gone = { id: 'agent-9', name: 'courier nine', kind: 'agent', status: 'completed', state: 'done', running: false, model: 'claude-fable-5-1', tokens: null, costUSD: null, unpricedTurns: 0, toolUses: 3, activity: null, wait: null, toolUseId: null, startedAt: Date.now() - 900_000, endedAt: Date.now() - 600_000, agentType: 'mercury-crew', crew: null, effort: null, transcriptAgentId: null, description: 'carried the note', error: null, stopReason: null, phase: null, paused: null, pendingAsks: 0, unreadNotices: 0, sessionId: null }
  ;(state as { crewLedger: Record<string, unknown> }).crewLedger = { 'agent-9': { facts: gone, hosted: true, listed: false, cleared: false, stamp: JSON.stringify(gone) } }
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
    storeRef = useAppStateStore() as never
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




const viewing = (): string | undefined => (storeRef?.getState() as { viewingAgentTaskId?: string } | undefined)?.viewingAgentTaskId
const mainChat = (): string | undefined => (storeRef?.getState() as { mainChatTaskId?: string } | undefined)?.mainChatTaskId
const bandTop = (lines: string[]): string => lines.find(line => /✶ Mercury|◉ |★ /.test(line)) ?? ''
const cardShown = (lines: string[]): boolean => lines.some(line => line.includes('◉ builder two')) && lines.some(line => line.includes('esc back to Mercury Lead'))

for (const [cols, rows, zen] of [[64, 20, false], [80, 24, false], [100, 30, true], [177, 49, false]] as Array<[number, number, boolean]>) {
  const label = `${cols}x${rows}${zen ? ' zen' : ''}`
  const scene = await openScene(cols, rows, zen)
  section(`§1 ${label}: ↵ on a crewmate row in /crewmates opens its view, visibly; esc returns`)
  openCrewView()
  check(`${label}: /crewmates lists the crewmates`, await until(() => isCrewViewOpen() && scene.lines().some(line => line.includes('scout one')) && scene.lines().some(line => line.includes('builder two'))), scene.lines().filter(l => l.trim() !== '').slice(0, 12).join(' | '))
  for (let step = 0; step < 4 && !scene.lines().some(line => /▸ . builder two/.test(line)); step++) { scene.push(DOWN); await sleep(200) }
  check(`${label}: ↓ walks the cursor onto builder two`, scene.lines().some(line => /▸ . builder two/.test(line)), scene.lines().filter(line => line.includes('builder two')).join(' | '))
  scene.push(ENTER)
  check(`${label}: ↵ enters the crewmate's view (the second row, builder two)`, await until(() => viewing() === 'agent-2' && !isCrewViewOpen()), `viewing ${viewing()} · open ${isCrewViewOpen()}`)
  check(`${label}: the band shows the crewmate's card with its way back`, await until(() => cardShown(scene.lines())), scene.lines().filter(l => l.trim() !== '').slice(0, 4).join(' | '))
  scene.push(ESC)
  check(`${label}: esc leaves the view`, await until(() => viewing() === undefined), `viewing ${viewing()}`)
  check(`${label}: the band is the session's own again`, await until(() => bandTop(scene.lines()).includes('✶ Mercury') && !cardShown(scene.lines())), bandTop(scene.lines()))
  await scene.close()
}

section('§2 refusals: an empty roster, the stop chord, the monitor card')
{
  const scene = await openScene(80, 24, false)
  const held = roster
  roster = { ...roster, rows: [] }
  for (const listener of rosterListeners) listener()
  await sleep(200)
  openCrewView()
  await until(() => isCrewViewOpen() && scene.lines().some(line => line.includes('crew')))
  scene.push(ENTER); await sleep(400)
  check('↵ on an empty roster enters no view and keeps the list', viewing() === undefined && isCrewViewOpen(), `viewing ${viewing()} · open ${isCrewViewOpen()}`)
  scene.push(ESC); await until(() => !isCrewViewOpen())
  roster = held
  for (const listener of rosterListeners) listener()
  await sleep(200)
  openCrewView()
  await until(() => isCrewViewOpen() && scene.lines().some(line => line.includes('scout one')))
  scene.push('x'); await sleep(150); scene.push('x')
  check('x x on the running crewmate sends the stop to its runner, the view unchanged', await until(() => stops.includes('agent-1')) && viewing() === undefined, `stops ${stops.join(',')} · viewing ${viewing()}`)
  scene.push(ESC); await until(() => !isCrewViewOpen())
  scene.push(TOGGLE); await sleep(150); scene.push(ENTER)
  check('ctrl+t then ↵ opens the activity screen', await until(() => scene.focus() === 'detail' && scene.lines().some(line => line.includes('activity ·'))))
  scene.push(ENTER)
  check('↵ on the monitor row (the first row) opens its card as before', await until(() => scene.lines().some(line => line.includes('monitor › monitor 1') || line.includes('tail -f build-1.log'))), scene.lines().filter(l => l.trim() !== '').slice(-6).join(' | '))
  await scene.close()
}

section('§3 80x16: the list has no row to paint, says what it cannot paint, ↵ still enters the selected row\'s view and the one-line band shows the card')
{
  const scene = await openScene(80, 16, false)
  openCrewView()
  await until(() => isCrewViewOpen() && scene.lines().some(line => line.includes('Crewmates (2)')))
  check('80x16: the popup says what it cannot paint rather than nothing', scene.lines().some(line => line.includes('2 crewmates cannot paint at this height — ↵ opens scout one')), scene.lines().filter(l => l.trim() !== '').join(' | '))
  scene.push(ENTER)
  check('80x16: ↵ enters the first row\'s view', await until(() => viewing() === 'agent-1' && !isCrewViewOpen()), `viewing ${viewing()} · open ${isCrewViewOpen()}`)
  check('80x16: the one-line band names the crewmate and the way back', await until(() => scene.lines().some(line => line.includes('◉ scout one') && line.includes('esc'))), scene.lines().filter(l => l.trim() !== '').slice(0, 3).join(' | '))
  await scene.close()
}

section('§4 the activity screen (the strip\'s ↵) opens a crewmate in the view on ↵, never its facts card; esc from the view returns')
for (const [cols, rows, zen] of [[80, 24, false], [100, 30, true]] as Array<[number, number, boolean]>) {
  const label = `${cols}x${rows}${zen ? ' zen' : ''}`
  const scene = await openScene(cols, rows, zen)
  const activityUp = (): boolean => scene.focus() === 'detail' && scene.lines().some(line => line.includes('Mercury — activity'))
  const cardUp = (name: string): boolean => scene.lines().some(line => line.includes(`agent › ${name}`))
  const openActivity = async (): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      scene.push(TOGGLE); await sleep(150); scene.push(ENTER)
      if (await until(activityUp, 2500)) return true
    }
    return activityUp()
  }
  const walkTo = async (name: string, key = DOWN): Promise<boolean> => {
    for (let step = 0; step < 6 && !scene.lines().some(line => new RegExp(`❯ .*${name}`).test(line)); step++) { scene.push(key); await sleep(150) }
    return scene.lines().some(line => new RegExp(`❯ .*${name}`).test(line))
  }
  check(`${label}: ctrl+t then ↵ opens the activity screen`, await openActivity(), `focus ${scene.focus()} · ${scene.lines().filter(l => l.trim() !== '').slice(0, 4).join(' | ')}`)
  check(`${label}: ↓ walks the cursor onto the running crewmate (scout one)`, await walkTo('scout one'), scene.lines().filter(line => line.includes('scout one')).join(' | '))
  scene.push(ENTER)
  check(`${label}: ↵ on the running crewmate enters its view and closes the activity screen (no facts card)`, await until(() => viewing() === 'agent-1' && scene.focus() === 'composer' && !scene.lines().some(line => line.includes('Mercury — activity')), 5000) && !cardUp('scout one'), `viewing ${viewing()} · focus ${scene.focus()} · card ${cardUp('scout one')} · ${scene.lines().filter(l => l.trim() !== '').slice(0, 3).join(' | ')}`)
  check(`${label}: the band shows the crewmate's card with its keys`, await until(() => scene.lines().some(line => line.includes('◉ scout one')) && scene.lines().some(line => line.includes('esc interrupts')), 5000), scene.lines().filter(l => l.trim() !== '').slice(0, 3).join(' | '))
  const stopsBefore = stops.length
  check(`${label}: the activity screen opens again over the view`, await openActivity(), `focus ${scene.focus()}`)
  check(`${label}: ↓ walks the cursor onto the lead's row, which heads the crewmates and names the way back`, await walkTo('Mercury Lead') && scene.lines().some(line => /❯ ✶ Mercury Lead · the lead's own chat · ↵ goes back/.test(line)) && (scene.lines().findIndex(line => line.includes('scout one')) < 0 || scene.lines().findIndex(line => line.includes('Mercury Lead')) < scene.lines().findIndex(line => line.includes('scout one'))), scene.lines().filter(l => l.includes('Crewmates') || l.includes('Mercury Lead') || l.includes('scout one')).join(' | '))
  scene.push(ENTER)
  check(`${label}: ↵ on the lead's row goes back to the lead's chat without stopping the crewmate`, await until(() => viewing() === undefined && scene.focus() === 'composer' && bandTop(scene.lines()).includes('✶ Mercury'), 5000) && stops.length === stopsBefore, `viewing ${viewing()} · focus ${scene.focus()} · stops ${stops.length - stopsBefore} · ${bandTop(scene.lines())}`)
  check(`${label}: the lead's row is gone from the list once the lead is the view again`, await openActivity() && !scene.lines().some(line => line.includes('✶ Mercury Lead')), scene.lines().filter(l => l.includes('Mercury Lead')).join(' | '))
  check(`${label}: ↓ walks the cursor onto the finished crewmate (builder two)`, await walkTo('builder two'), scene.lines().filter(line => line.includes('builder two')).join(' | '))
  scene.push(ENTER)
  check(`${label}: ↵ on the finished crewmate enters its view`, await until(() => viewing() === 'agent-2' && scene.focus() === 'composer', 5000) && !cardUp('builder two'), `viewing ${viewing()} · focus ${scene.focus()} · card ${cardUp('builder two')}`)
  check(`${label}: the band names builder two with the way back`, await until(() => cardShown(scene.lines()), 5000), scene.lines().filter(l => l.trim() !== '').slice(0, 3).join(' | '))
  openCrewView()
  await until(() => isCrewViewOpen() && scene.lines().some(line => line.includes('builder two')))
  for (let step = 0; step < 4 && !scene.lines().some(line => /▸ . builder two/.test(line)); step++) { scene.push(DOWN); await sleep(200) }
  scene.push('m')
  check(`${label}: m in /crewmates pins builder two as the main chat`, await until(() => mainChat() === 'agent-2' && !isCrewViewOpen(), 5000), `main chat ${mainChat()} · open ${isCrewViewOpen()}`)
  await sleep(300)
  check(`${label}: the activity screen opens over the pinned view`, await openActivity(), `focus ${scene.focus()}`)
  check(`${label}: ↓ walks the cursor onto the lead's row`, await walkTo('Mercury Lead'), scene.lines().filter(line => line.includes('Mercury Lead')).join(' | '))
  scene.push('m')
  check(`${label}: m on the lead's row hands the main chat back and keeps the view`, await until(() => mainChat() === undefined && scene.focus() === 'composer', 5000) && viewing() === 'agent-2', `main chat ${mainChat()} · viewing ${viewing()} · focus ${scene.focus()}`)
  scene.push(ESC)
  check(`${label}: esc leaves the view and the band is the session's own again`, await until(() => viewing() === undefined && bandTop(scene.lines()).includes('✶ Mercury') && !cardShown(scene.lines()), 5000), `viewing ${viewing()} · ${bandTop(scene.lines())}`)
  check(`${label}: the monitor row's ↵ still opens its card`, await openActivity() && await walkTo('monitor 1', UP) && (scene.push(ENTER), await until(() => scene.lines().some(line => line.includes('monitor › monitor 1') || line.includes('tail -f build-1.log')), 5000)), scene.lines().filter(l => l.trim() !== '').slice(-6).join(' | '))
  await scene.close()
}

clearTimeout(hardLimit)
check('no render fault', faults.length === 0, faults.join(' | ').slice(0, 300))
rmSync(HOME, { recursive: true, force: true })
rmSync(CWD, { recursive: true, force: true })
console.log(`\n${failures === 0 ? '✅' : '❌'} crew-view-enter-compact — ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
