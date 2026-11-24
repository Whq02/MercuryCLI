#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReactNode } from 'react'
import stripAnsi from 'strip-ansi'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(arg('--root') ?? join(import.meta.dir, '..', '..'))
const framesArg = arg('--frames')
const FRAMES = framesArg === undefined ? undefined : resolve(framesArg)
const COLS = 178
const ROWS = 51
const LANES_W = 30
const SHELL_ID = 'sh-fixture-1'
const SHELL_NAME = 'sleep 300'
const LEDGER = [
  { id: '1', subject: 'Chart the reef current', status: 'in_progress' as const, activeForm: 'Charting the reef current', blocks: [], blockedBy: [] },
  { id: '2', subject: 'Refit the tide gauges', status: 'pending' as const, blocks: [], blockedBy: [] },
  { id: '3', subject: 'Sound the harbor depth', status: 'pending' as const, blocks: [], blockedBy: [] },
  { id: '4', subject: 'Stow the survey gear', status: 'completed' as const, blocks: [], blockedBy: [] },
]

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'helm-tasks-card-'))
const PROJECT = join(SCRATCH, 'fixture-project')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(join(SCRATCH, 'home'), { recursive: true })
process.chdir(PROJECT)
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_TASKS = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.BROWSER = '/usr/bin/true'

const mod = async <T>(rel: string): Promise<T> => (await import(join(ROOT, rel))) as T
const reactModule = await mod<{ default?: typeof import('react') } & typeof import('react')>('node_modules/react/index.js')
const React = reactModule.default ?? reactModule
const { default: ScreenInstance } = await mod<typeof import('../../src/screen/renderer/screenInstance.tsx')>('src/screen/renderer/screenInstance.tsx')
const { Text } = await mod<typeof import('../../src/screen/themedRenderer.ts')>('src/screen/themedRenderer.ts')
const { App } = await mod<typeof import('../../src/boot/App.tsx')>('src/boot/App.tsx')
const { getDefaultAppState } = await mod<typeof import('../../src/screen/app-state/AppStateStore.ts')>('src/screen/app-state/AppStateStore.ts')
const { KeybindingSetup } = await mod<typeof import('../../src/screen/keys/KeybindingProviderSetup.tsx')>('src/screen/keys/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await mod<typeof import('../../src/screen/fullscreen-layout/FullscreenLayout.tsx')>('src/screen/fullscreen-layout/FullscreenLayout.tsx')
const { default: Composer } = await mod<typeof import('../../src/screen/composer/Composer.tsx')>('src/screen/composer/Composer.tsx')
const { SpinnerWithVerb } = await mod<typeof import('../../src/screen/spinner/Spinner.tsx')>('src/screen/spinner/Spinner.tsx')
const { GlobalKeybindingHandlers } = await mod<typeof import('../../src/screen/chat/useGlobalKeybindings.tsx')>('src/screen/chat/useGlobalKeybindings.tsx')
const { resetChromeModeLatchForTests } = await mod<typeof import('../../src/screen/fullscreen-layout/useLayoutTier.ts')>('src/screen/fullscreen-layout/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await mod<typeof import('../../src/screen/routes/surfaceRoute.ts')>('src/screen/routes/surfaceRoute.ts')
const { enableConfigs, saveCurrentProjectConfig } = await mod<typeof import('../../src/platform/settings/config.ts')>('src/platform/settings/config.ts')
const pending = await mod<typeof import('../../src/screen/composer/input-core/pending-input.ts')>('src/screen/composer/input-core/pending-input.ts')
const { default: instances } = await mod<typeof import('../../src/screen/renderer/instances.ts')>('src/screen/renderer/instances.ts')
const focusedSlot = await mod<typeof import('../../src/engine/connector/focusedConnector.ts')>('src/engine/connector/focusedConnector.ts')
const { noSessionConnector } = await mod<typeof import('../../src/engine/connector/noSessionConnector.ts')>('src/engine/connector/noSessionConnector.ts')
const vitals = await mod<typeof import('../../src/screen/app-state/vitalsBus.ts')>('src/screen/app-state/vitalsBus.ts')
const helm = await mod<typeof import('../../src/screen/cockpit/helmFocus.ts')>('src/screen/cockpit/helmFocus.ts')
type WorkRoster = import('../../src/engine/connector/types.ts').WorkRosterV1
type Connector = import('../../src/engine/connector/types.ts').EngineConnectorV1
type Row = import('../../src/screen/cockpit/helmFocus.ts').HelmRow
type InsertRef = import('../../src/screen/composer/Composer.tsx').ComposerProps['insertTextRef']
type ScrollHandle = import('../../src/screen/renderer/elements/ScrollBox.tsx').ScrollBoxHandle

enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
const h = React.createElement
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = '', hint = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!good && hint ? ` — to fix: ${hint}` : ''}`)
}
async function until(label: string, predicate: () => boolean, budgetMs = 5000): Promise<boolean> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, budgetMs)
  while (!predicate() && !expired) await new Promise<void>(resolve => setImmediate(resolve))
  clearTimeout(timer)
  const good = predicate()
  check(label, good)
  return good
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
  get readableLength(): number { return this.chunks.reduce((n, value) => n + value.length, 0) }
  push(value: string): void { this.chunks.push(value); this.emit('readable') }
}
const hardLimit = setTimeout(() => { console.error('helm tasks-card proof exceeded its deadline (150 s): a mount never reached its until() condition (composer, vitals ledger or frames); read the last FAIL line above and the mount() helper in scripts/ui/prove-helm-tasks-card.ts'); process.exit(1) }, 150_000)
hardLimit.unref()
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }

let roster: WorkRoster = { rows: [], mission: [] }
const workListeners = new Set<() => void>()
const restingConnector = noSessionConnector()
const overrides: Record<string, unknown> = {
  carrier: 'in-process',
  sessionId: () => 'helm-fixture-session',
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { workListeners.add(listener); return () => { workListeners.delete(listener) } },
}
const connector = new Proxy(restingConnector, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
}) as unknown as Connector
focusedSlot.setFocusedSessionConnector(connector)

const shellRow = () => ({ id: SHELL_ID, kind: 'shell' as const, name: SHELL_NAME, status: 'running', startTime: Date.now() - 12 * 60_000, command: SHELL_NAME })
const railColumns = (frame: string): string[] => frame.split('\n').map(line => line.slice(0, LANES_W))
const railText = (frame: string): string => railColumns(frame).join('\n')
const railHits = (frame: string, needle: RegExp): string => railColumns(frame).filter(line => needle.test(line)).map(line => line.trimEnd()).join(' | ')
const lanesRows = (): Row[] => helm.getHelmRows('lanes')
const missionLabels = (): string[] => lanesRows().map(row => row.label).filter(label => label.startsWith('mission:'))

type Mount = { ink: InstanceType<typeof ScreenInstance>; stdin: Input; frame: () => string; frames: () => number; close: () => Promise<void> }
async function mount(name: string, work: WorkRoster): Promise<Mount> {
  roster = work
  for (const listener of workListeners) listener()
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  helm.resetHelmFocusForTest()
  pending.edit('')
  pending.setMode('prompt')
  const stdout = new Output()
  const stdin = new Input()
  let frames = 0
  const ink = new ScreenInstance({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false, onFrame: () => { frames++ } })
  instances.set(stdout as never, ink)
  const scrollRef = React.createRef<ScrollHandle>()
  const insertRef: InsertRef = { current: null }
  const startedAt = { current: Date.now() - 42_000 }
  const paused = { current: 0 }
  const pauseStart = { current: null as number | null }
  const responseLength = { current: 0 }
  const outputTokens = { current: null as number | null }
  function Transcript(): ReactNode {
    return h(Text, null, Array.from({ length: 6 }, (_, i) => `specimen transcript row ${i + 1}`).join('\n'))
  }
  function Harness(): ReactNode {
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0 } as never),
      h(FullscreenLayout, {
        scrollRef,
        scrollable: h(Transcript),
        statusBand: h(SpinnerWithVerb, {
          mode: 'thinking', loadingStartTimeRef: startedAt, totalPausedMsRef: paused, pauseStartTimeRef: pauseStart,
          spinnerTip: null, responseLengthRef: responseLength, outputTokensRef: outputTokens, overrideColor: null, overrideShimmerColor: null,
          overrideMessage: null, still: false, spinnerSuffix: null, verbose: false, hasActiveTools: false, activeToolCount: 0,
          activeToolLabel: null, leaderIsIdle: false,
        }),
        statusBandActive: true,
        bottom: h(Composer, {
          debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 0, onShowRewindPicker: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async () => {},
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        }),
      }),
    )
  }
  ink.render(h(App, { initialState: { ...getDefaultAppState(), expandedView: 'none' }, getFpsMetrics: () => undefined }, h(Harness)))
  const frame = (): string => stripAnsi(ink.lastFrameText())
  await until(`${name}: the cockpit mounts with the composer and the lanes rail`, () => insertRef.current !== null && stdin.isRaw && frame().includes('lanes'))
  await until(`${name}: the vitals bus carries the fixture ledger (${work.mission.length} rows)`, () => vitals.getVitals().version > 0 && vitals.getVitals().tasks.length === work.mission.length, 15_000)
  const seen = frames
  await until(`${name}: the cockpit composed two more frames after the ledger landed (the working strip's clock keeps them coming)`, () => frames >= seen + 2)
  return {
    ink,
    stdin,
    frame,
    frames: () => frames,
    close: async () => { ink.unmount(); await ink.waitUntilExit(); instances.delete(stdout as never) },
  }
}
function file(name: string, frame: string): void {
  if (!FRAMES) return
  mkdirSync(FRAMES, { recursive: true })
  writeFileSync(join(FRAMES, name), frame + '\n')
  console.log(`frame written: ${join(FRAMES, name)}`)
}
function dumpRail(name: string, frame: string, since: number): void {
  if (failures === since) return
  console.log(`${name}: the lanes rail as painted (first ${LANES_W} columns)`)
  for (const line of railColumns(frame)) if (line.trim() !== '') console.log(`  ${line.trimEnd()}`)
  const strip = frame.split('\n').filter(line => /next: |Chart the reef|Refit the tide|Sound the harbor|Stow the survey/.test(line))
  for (const line of strip) console.log(`  ${line.trim()}`)
}
function railCard(name: string, frame: string): void {
  const rail = railText(frame)
  check(`${name}: the rail paints no TASKS card`, !/TASKS/.test(rail) && !/no open tasks/.test(rail), railHits(frame, /TASKS|no open tasks/), 'the lanes rail must not paint a TASKS card; the ledger belongs to the working strip and the ctrl+t tree, so remove the card from the rail sections built in src/screen/cockpit-gauges/helmLanesModel.ts')
  check(`${name}: the rail publishes no ledger rows of its own`, missionLabels().length === 0, missionLabels().join(', '), 'getHelmRows(lanes) in src/screen/cockpit/helmFocus.ts must not list mission: rows; stop the lanes model from publishing the task ledger as rail rows')
}
function runsDoor(name: string, frame: string): void {
  const rail = railText(frame)
  check(`${name}: RUNS counts the one live shell`, /RUNS · 1 live/.test(rail), railHits(frame, /RUNS/), 'the RUNS section (label RUNS, count live) is built in src/screen/cockpit-gauges/helm-lanes-model/sections.ts; it must count the one running shell row')
  check(`${name}: the run row names the shell with its live elapsed verb`, new RegExp(`${SHELL_NAME} · shell 12m`).test(rail), railHits(frame, /shell/), 'the run row text comes from the RUNS section in src/screen/cockpit-gauges/helm-lanes-model/sections.ts; it must read name, then shell, then the elapsed minutes')
  const door = lanesRows().find(row => row.label === `run:${SHELL_ID}`)
  check(`${name}: the run row opens its card on the /runs board`, door !== undefined && door.kind === 'command' && door.command === `/runs ${SHELL_ID}`, JSON.stringify(door ?? null), 'the RUNS section in src/screen/cockpit-gauges/helm-lanes-model/sections.ts must publish a row labelled run:<id> with kind command and command /runs <id>')
}

console.log(`helm tasks-card proof — product root ${ROOT} at ${COLS}x${ROWS}`)

{
  const since = failures
  const world = await mount('busy-empty', { rows: [shellRow()], mission: [] })
  const frame = world.frame()
  file('busy-empty-ledger-178x51.txt', frame)
  check('the fixture owns the files door (the scratch project) and the rail paints no seat row', !/\(you\)/.test(railText(frame)) && /FILES · fixture-project/.test(railText(frame)), railHits(frame, /\(you\)|FILES/), 'with no seats the lanes rail paints no (you) row and its FILES door names the project folder; check the sections in src/screen/cockpit-gauges/helm-lanes-model/sections.ts')
  runsDoor('busy-empty', frame)
  railCard('busy-empty', frame)
  dumpRail('busy-empty', frame, since)
  await world.close()
}

{
  const since = failures
  const world = await mount('busy-ledger', { rows: [shellRow()], mission: LEDGER })
  const frame = world.frame()
  file('busy-ledger-178x51.txt', frame)
  runsDoor('busy-ledger', frame)
  railCard('busy-ledger', frame)
  check('busy-ledger: the rail paints none of the ledger rows', !/Charting the reef|Refit the tide|Sound the harb/.test(railText(frame)), railHits(frame, /reef|tide|harb/), 'ledger subjects belong in the working strip and the ctrl+t tree only; remove them from the lanes rail in src/screen/cockpit-gauges/helmLanesModel.ts')
  check('busy-ledger: the working strip narrates the next pending task (the ledger reached the spinner)', frame.includes('next: Refit the tide gauges'), '', 'the working strip in src/screen/spinner/Spinner.tsx must print next: and the first pending task subject; check that the vitals bus tasks reach it')
  check('busy-ledger: the ledger tree is closed until the operator opens it', !frame.includes('Stow the survey gear'), '', 'the completed row must show only in the ctrl+t ledger tree; a closed tree must not list it, so check the working strip and rail for a completed-task leak')
  dumpRail('busy-ledger', frame, since)
  const sinceTree = failures
  const before = world.frames()
  world.stdin.push('\u0014')
  const opened = await until('ctrl+t: the ledger tree opens inline in the cockpit (the completed row only the tree lists)', () => world.frame().includes('Stow the survey gear'))
  const tree = world.frame()
  file('ctrl-t-ledger-tree-178x51.txt', tree)
  check('ctrl+t: the tree lists the in-progress and queued rows too', tree.includes('Chart the reef current') && tree.includes('Refit the tide gauges') && tree.includes('Sound the harbor depth'), '', 'the ctrl+t ledger tree must list every ledger row; check that ctrl+t reaches the cockpit key handler (GlobalKeybindingHandlers in src/screen/chat/useGlobalKeybindings.tsx) and opens the tree')
  railCard('ctrl+t', tree)
  runsDoor('ctrl+t', tree)
  if (opened) {
    world.stdin.push('\u0014')
    await until('ctrl+t again: the tree closes (the toggle stays the operator\'s)', () => !world.frame().includes('Stow the survey gear') && world.frames() > before)
  }
  dumpRail('ctrl+t', tree, sinceTree)
  await world.close()
}

{
  const since = failures
  const world = await mount('solo-ledger', { rows: [], mission: LEDGER })
  const frame = world.frame()
  file('solo-ledger-178x51.txt', frame)
  const rail = railText(frame)
  check('solo-ledger: no RUNS section without a live process', !/RUNS/.test(rail), railHits(frame, /RUNS/), 'the RUNS section in src/screen/cockpit-gauges/helm-lanes-model/sections.ts must be omitted when the work roster has no live rows')
  railCard('solo-ledger', frame)
  check('solo-ledger: the rail paints none of the ledger rows', !/Charting the reef|Refit the tide|Sound the harb/.test(rail), railHits(frame, /reef|tide|harb/), 'ledger subjects belong in the working strip and the ctrl+t tree only; remove them from the lanes rail in src/screen/cockpit-gauges/helmLanesModel.ts')
  check('solo-ledger: a ledger alone leaves the solo layout in place (the NEXT hints paint)', /NEXT/.test(rail) && /\/health/.test(rail) && /\/memory/.test(rail), railHits(frame, /NEXT|\/health|\/memory/), 'a ledger alone must not switch the rail off the solo layout; the NEXT section is built in src/screen/cockpit-gauges/helm-lanes-model/sections.ts')
  dumpRail('solo-ledger', frame, since)
  await world.close()
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error/.test(line)), faults.join('\n'), 'a component threw while rendering; the fault text above names it, so fix the hook order or render error in that component under src/components')
console.log(`helm tasks-card: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
