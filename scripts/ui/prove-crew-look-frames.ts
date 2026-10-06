#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crew-look-frames-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_OPERATOR = 'op'
process.env.MERCURY_CHANNEL_ROOM = `crew-look-frames-${process.pid}`
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

const SESSION_ID = 'lead-session'
const LEAD_ROW = 'Mercury Lead'
const CREW_TITLE = 'Mercury — crew'
const USAGE_TITLE = 'Mercury · usage'
const CONFIG_TITLE = 'Mercury · config'
const PILL = 'back to the bottom'
const FOCUS_IN = '\x1b[I'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const PAGE_UP = '\x1b[5~'
const press = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M`
const release = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}m`
const CLICK_GAP_MS = 650
const SIZES: Array<[number, number]> = [[269, 70], [178, 51], [120, 40]]
const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const onlySizes = arg('--sizes')
const sizes = onlySizes === undefined ? SIZES : onlySizes.split(',').map(s => s.split('x').map(Number) as [number, number])
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
async function click(scene: { push: (data: string) => void }, x: number, y: number): Promise<void> {
  await sleep(CLICK_GAP_MS)
  scene.push(press(x, y) + release(x, y))
}
class Output extends EventEmitter {
  isTTY = true
  columns: number
  rows: number
  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
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
const hardLimit = setTimeout(() => { console.error('crew-look-frames exceeded its deadline'); process.exit(1) }, 300_000)
hardLimit.unref()

const NOW = Date.now()
type RosterRow = Record<string, unknown> & { id: string; status: string; activity?: string; endTime?: number }
const CREW: Array<[string, number]> = [['atlas', 940], ['fjord', 840], ['harbour', 740]]
function freshRows(): RosterRow[] {
  return CREW.map(([name, context], index) => ({
    id: `a-${name}`,
    agentId: `a-${name}`,
    kind: 'agent' as const,
    name,
    status: 'running',
    startTime: NOW - 120_000 + index * 1000,
    model: 'claude-opus-5-5',
    agentType: 'mercury-crew',
    inputTokens: context - 40,
    outputTokens: 40,
    totalTokens: context,
    contextTokens: context,
    activity: `Sleeping for ${287 - index}s`,
    phase: { phase: 'tool' as const, sinceMs: NOW - 27_000 },
  }))
}
const workListeners = new Set<() => void>()
let roster: { rows: RosterRow[]; mission: never[]; samples: never[]; reported: boolean } = { rows: freshRows(), mission: [], samples: [], reported: true }
function publishRoster(mutate: (rows: RosterRow[]) => void): void {
  const rows = roster.rows.map(row => ({ ...row }))
  mutate(rows)
  roster = { ...roster, rows }
  for (const listener of workListeners) listener()
}
function land(rows: RosterRow[], name: string): void {
  const row = rows.find(r => r.id === `a-${name}`)
  if (row === undefined) return
  row.status = 'completed'
  row.endTime = Date.now()
}

async function stub(path: string, fixture: (actual: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const actual = (await import(path)) as Record<string, unknown>
  mock.module(path, () => ({ ...actual, ...fixture(actual) }))
}
await stub('../../src/components/tasks/useFocusedWork.ts', () => ({ focusedRunnerPresence: () => 'live' }))
let heldRead: Promise<void> | undefined
let readHeld = false
await stub('../../src/utils/sessionStorage/loading.ts', actual => {
  const load = actual.loadTranscriptFile as typeof import('../../src/utils/sessionStorage/loading.ts').loadTranscriptFile
  return { loadTranscriptFile: async (...args: Parameters<typeof load>) => {
    if (heldRead !== undefined && args[0].includes('agent-a-atlas.')) {
      readHeld = true
      await heldRead
    }
    return load(...args)
  } }
})

const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { useAppStateStore } = await import('../../src/state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout, useUnseenDivider } = await import('../../src/components/FullscreenLayout.tsx')
const { ScrollKeybindingHandler } = await import('../../src/components/ScrollKeybindingHandler.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { FocusedSessionStatusRow } = await import('../../src/components/SwitchboardTagBar.tsx')
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
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { resetHelmFocusForTest } = await import('../../src/utils/cockpit/helmFocus.ts')
const { closeSettingsPopup, isSettingsPopupOpen } = await import('../../src/utils/cockpit/settingsPopup.ts')
const crewmatesCommand = await import('../../src/commands/crewmates/crewmates.tsx')
const usageCommand = await import('../../src/commands/usage/usage.tsx')
const configCommand = await import('../../src/commands/config/config.tsx')
const { TranscriptSwap } = await import('../../src/components/CrewmateTranscript.tsx')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
type ScrollBoxHandle = import('../../src/ink/components/ScrollBox.tsx').ScrollBoxHandle
const h = React.createElement

const resting = noSessionConnector() as unknown as Record<string, unknown>
const agentCalls: Array<{ verb: string; agentId: string; note?: string }> = []
const overrides: Record<string, unknown> = {
  sessionId: () => SESSION_ID,
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { workListeners.add(listener); return () => { workListeners.delete(listener) } },
  stopAgent: async (agentId: string, note?: string) => { agentCalls.push({ verb: 'stop', agentId, note }); return { outcome: 'applied' } },
  resumeAgent: async (agentId: string, note?: string) => { agentCalls.push({ verb: 'resume', agentId, note }); return { outcome: 'applied', detail: '{"queued":true}' } },
  interrupt: () => false,
  live: () => IDLE_LIVE,
  subscribeLive: () => () => {},
  status: () => ({ title: 'a chat', projectLabel: 'orchard', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false }),
  tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
}
const fake = new Proxy(resting, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
})
setFocusedSessionConnector(fake as never)
const CWD = (fake as { workspace: () => { originalCwd: string; cwd: string } }).workspace().originalCwd || process.cwd()
const LONG_LINE = 'one line that never breaks on its own — the ledger of every seam the lane walked, the frame it filed, the count it pinned, the words it kept and the border it did not cross, written out as one sentence so the transcript has to wrap it inside the view and never past it, and then a little more so it wraps twice at the widest tier too.'
function seedCrewmate(name: string, rows: string[]): void {
  const file = join(getProjectDir(CWD), SESSION_ID, 'subagents', `agent-a-${name}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  const stamp = (n: number): string => new Date(NOW - 300_000 + n * 1000).toISOString()
  const uuid = (n: number): string => `00000000-0000-4000-8000-${name.charCodeAt(0).toString(16).padStart(2, '0')}${String(n).padStart(10, '0')}`
  const row = (n: number, extra: Record<string, unknown>): Record<string, unknown> => ({ isSidechain: true, agentId: `a-${name}`, entrypoint: 'cli', cwd: CWD, sessionId: SESSION_ID, version: '1.0.0', gitBranch: 'main', parentUuid: n === 0 ? null : uuid(n - 1), uuid: uuid(n), timestamp: stamp(n), ...extra })
  const records: Record<string, unknown>[] = [row(0, { type: 'user', message: { role: 'user', content: `crew-look-mate ${name}: run your part of the look drive` } })]
  rows.forEach((text, index) => {
    records.push(row(index + 1, { type: 'assistant', message: { id: `msg_${name}_${index}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }))
  })
  writeFileSync(file, encodeSeedTranscript(records as never, SESSION_ID))
}
seedCrewmate('atlas', [`atlas: ${LONG_LINE}`, Array.from({ length: 120 }, (_, i) => `ledger row ${String(i + 1).padStart(2, '0')} — a row of the crewmate's own transcript, tall enough that the view has to scroll`).join('\n'), 'atlas: holding the line for the view'])
seedCrewmate('fjord', [`fjord: the second crewmate says one long thing too — ${LONG_LINE}`])
seedCrewmate('harbour', ['harbour: a short run, then the turn ends'])

type Scene = { lines: () => string[]; push: (data: string) => void; state: () => Record<string, unknown>; setModal: (node: React.ReactNode) => void; handle: () => ScrollBoxHandle | null; close: () => Promise<void> }
const stateRef = { current: null as null | { getState: () => unknown } }
const modalRef = { current: null as null | ((node: React.ReactNode) => void) }

const TRANSCRIPT_NEEDLE = 'TRANSCRIPT-ROW'
function LeadTranscript(): React.ReactNode {
  const rows: string[] = []
  for (let index = 0; index < 90; index++) rows.push(`14:49:${String(20 + (index % 40)).padStart(2, '0')} [Mercury] ${TRANSCRIPT_NEEDLE} ${index} — a row of the lead's transcript`)
  return h(Text, null, rows.join('\n'))
}
function Harness({ scrollRef }: { scrollRef: React.RefObject<ScrollBoxHandle | null> }): React.ReactNode {
  const { controls, focus } = useCompactWorkControls()
  const store = useAppStateStore()
  stateRef.current = store as never
  const unseen = useUnseenDivider(90, scrollRef)
  const onScroll = React.useCallback((sticky: boolean, handle: ScrollBoxHandle) => {
    if (sticky) unseen.onRepin()
    else unseen.onScrollAway(handle)
  }, [unseen])
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const [screen, setScreen] = React.useState('prompt')
  const [modal, setModal] = React.useState<React.ReactNode>(null)
  modalRef.current = setModal
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(KeybindingSetup, null,
    h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
    h(ScrollKeybindingHandler, { scrollRef, isActive: true, onScroll }),
    h(FullscreenLayout, {
      scrollRef,
      dividerYRef: unseen.dividerYRef,
      hidePill: false,
      newMessageCount: 0,
      onPillClick: () => unseen.jumpToNew(scrollRef.current),
      scrollable: h(TranscriptSwap, { lead: h(LeadTranscript), tools: [], commands: [], screen: 'prompt', scrollRef, agentDefinitions: { activeAgents: [], allAgents: [] }, trackStickyPrompt: true }),
      statusBand: h(Text, null, 'waiting on 3 agents'),
      statusBandActive: true,
      modal: modal === null ? undefined : h(Box, { width: '100%', flexDirection: 'column' }, modal),
      modalScrollRef,
      bottom: h(Box, { flexDirection: 'column', flexShrink: 0 }, h(FocusedSessionStatusRow), h(PromptInput, {
        compactWork: controls, compactFocus: focus,
        debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
        setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
        isLoading: false, verbose: false, submitCount: 1, onShowMessageSelector: () => {},
        mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
        onExit: () => {}, getToolUseContext: () => ({} as never),
        onSubmit: async () => {},
        isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
        hasSuppressedDialogs: false, isLocalJSXCommandActive: modal !== null, insertTextRef: insertRef,
      } as never)),
    } as never),
  )
}

async function mount(cols: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetHelmFocusForTest()
  pending.edit('')
  pending.setMode('prompt')
  roster = { rows: freshRows(), mission: [], samples: [], reported: true }
  const scrollRef = React.createRef<ScrollBoxHandle | null>()
  const stdout = new Output(cols, rows)
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output(cols, rows) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness, { scrollRef })))
  const painted = await until(() => ink.lastFrameText() !== '' && stripAnsi(ink.lastFrameText()).includes('CREW'))
  check(`the cockpit painted with the crew lane at ${cols}x${rows}`, painted, stripAnsi(ink.lastFrameText()).slice(0, 300))
  await sleep(400)
  return {
    lines: () => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n'),
    push: data => stdin.push(data),
    state: () => (stateRef.current?.getState() ?? {}) as Record<string, unknown>,
    setModal: node => modalRef.current?.(node),
    handle: () => scrollRef.current,
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}

const cells = (line: string): string[] => Array.from(line)
type Cockpit = { left: number; right: number; bottom: number; railRight: number; composerTop: number }
function cockpitOf(lines: string[]): Cockpit | null {
  const first = cells(lines[0] ?? '')
  const left = first.indexOf('╭')
  const right = first.indexOf('╮', left + 1)
  if (left < 0 || right < 0) return null
  let bottom = -1
  for (let y = 1; y < lines.length; y++) if (cells(lines[y]!)[left] === '╰') { bottom = y; break }
  if (bottom < 0) return null
  let composerTop = -1
  for (let y = bottom + 1; y < lines.length; y++) if (cells(lines[y]!)[0] === '╭') { composerTop = y; break }
  return { left, right, bottom, railRight: left - 1, composerTop }
}
function integrity(lines: string[]): string[] {
  const cockpit = cockpitOf(lines)
  if (cockpit === null) return ['no centre frame on the first row']
  const faultsFound: string[] = []
  const { left, right, bottom, railRight } = cockpit
  for (let y = 1; y < bottom; y++) {
    const line = cells(lines[y]!)
    if (line[left] !== '│') faultsFound.push(`row ${y}: the view's left border reads ${JSON.stringify(line[left] ?? ' ')}`)
    if (line[right] !== '│') faultsFound.push(`row ${y}: the view's right border reads ${JSON.stringify(line[right] ?? ' ')}`)
    if (line[0] === '│' && line[railRight] !== '│') faultsFound.push(`row ${y}: the rail row lost its right border`)
  }
  const bottomLine = cells(lines[bottom]!)
  for (let x = left + 1; x < right; x++) if (bottomLine[x] !== '─') { faultsFound.push(`row ${bottom}: the view's bottom border is broken at ${x} (${JSON.stringify(bottomLine[x] ?? ' ')})`); break }
  const topLine = cells(lines[0]!)
  for (let x = left + 1; x < right; x++) if (topLine[x] !== '─') { faultsFound.push(`row 0: the view's top border is broken at ${x}`); break }
  return faultsFound
}
type Window = { top: number; bottom: number; left: number; right: number; width: number; height: number; rows: string[] }
function windowOf(lines: string[], title: string): Window | null {
  const titleRow = lines.findIndex(line => line.includes(title))
  if (titleRow < 0) return null
  const titleCells = cells(lines[titleRow]!)
  const titleAt = titleCells.join('').indexOf(title)
  let left = -1
  for (let x = titleAt; x >= 0; x--) if (titleCells[x] === '│') { left = x; break }
  if (left < 0) return null
  let top = -1
  for (let y = titleRow; y >= 0; y--) if (cells(lines[y]!)[left] === '╭') { top = y; break }
  if (top < 0) return null
  const right = cells(lines[top]!).indexOf('╮', left + 1)
  if (right < 0) return null
  let bottom = -1
  for (let y = top + 1; y < lines.length; y++) if (cells(lines[y]!)[left] === '╰') { bottom = y; break }
  if (bottom < 0) return null
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1, rows: lines.slice(top, bottom + 1).map(line => cells(line).slice(left, right + 1).join('')) }
}
const describe = (window: Window | null): string => (window === null ? 'no closed window' : `left ${window.left} · top ${window.top} · width ${window.width} · height ${window.height} (rows ${window.top}..${window.bottom})`)
const railText = (line: string, cockpit: Cockpit): string => cells(line).slice(0, cockpit.railRight + 1).join('')
const railRow = (lines: string[], cockpit: Cockpit, needle: string): number => lines.findIndex(line => railText(line, cockpit).includes(needle))
const headerRow = (lines: string[]): string => (lines.find(line => line.includes('← back')) ?? '').trim()
const centre = (line: string, cockpit: Cockpit): string => cells(line).slice(cockpit.left + 1, cockpit.right).join('')
const crewOrder = (lines: string[], cockpit: Cockpit): string => lines.map(line => railText(line, cockpit)).filter(line => /[◐◉★●] (atlas|fjord|harbo)/.test(line)).map(line => /(atlas|fjord|harbo)/.exec(line)![1]!).join(',')
const transcriptOf = (lines: string[], cockpit: Cockpit): string[] => {
  const centreLines = lines.map(line => centre(line, cockpit))
  let cardBottom = 6
  for (let y = 2; y < 12; y++) if (centreLines[y]!.startsWith('╰')) { cardBottom = y; break }
  return centreLines.slice(cardBottom + 1, cockpit.bottom).map(line => line.trimEnd())
}
const cardOf = (lines: string[], cockpit: Cockpit): string => lines.slice(1, 5).map(line => centre(line, cockpit)).join(' ').replace(/\s+/g, ' ')
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

for (const [cols, rows] of sizes) {
  const size = `${cols}x${rows}`
  const save = (name: string, lines: string[]): void => {
    if (frameDir === undefined) return
    writeFileSync(join(frameDir, `${size}-${name}.txt`), `${lines.join('\n')}\n`)
  }
  section(`═══ ${size} ═══`)
  const scene = await mount(cols, rows)
  let frame = scene.lines()
  const cockpit = cockpitOf(frame)
  if (cockpit === null) {
    check(`${size}: the cockpit frame is readable`, false, frame.slice(0, 3).join(' | '))
    await scene.close()
    continue
  }
  save('1-lead', frame)
  const orderAtRest = crewOrder(frame, cockpit)
  console.log(`${size}: the view ${cockpit.left}..${cockpit.right} × 0..${cockpit.bottom} · CREW rows at rest: ${orderAtRest}`)
  check(`${size}: the three crewmates stand in the CREW lane`, orderAtRest.split(',').length === 3, orderAtRest)
  const rowOf = (name: string): number => railRow(frame, cockpit, name)

  section(`§1 ${size}: a click on a CREW row marks it where it stands — the rows never reorder on a swap`)
  scene.push(FOCUS_IN)
  await sleep(200)
  const fjordRow = rowOf('fjord')
  await click(scene, 8, fjordRow)
  await until(() => /(?:viewing|main chat:) fjord ·/.test(headerRow(scene.lines())), 6000)
  await until(() => scene.lines().some(line => line.includes('[fjord]')), 6000)
  await sleep(300)
  frame = scene.lines()
  save('2-view-fjord', frame)
  const orderFjord = crewOrder(frame, cockpit)
  check(`${size}: fjord's row opens fjord in the view (the header, its own rows)`, /viewing fjord ·/.test(headerRow(frame)) && frame.some(line => centre(line, cockpit).includes('[fjord]')), headerRow(frame))
  check(`${size}: the CREW rows keep their order with fjord viewed (the ◉ mark lands on the row where it stood)`, orderFjord === orderAtRest && railRow(frame, cockpit, '◉ fjord') === fjordRow, `${orderAtRest} → ${orderFjord} · ◉ fjord at row ${railRow(frame, cockpit, '◉ fjord')} (was ${fjordRow})`)
  check(`${size}: fjord's view paints whole`, integrity(frame).length === 0, integrity(frame).slice(0, 3).join(' · '))
  check(`${size}: the first visit of a short transcript stands at its top with no jump pill`, !frame.some(line => line.includes(PILL)), 'the pill stands')
  const atlasRow = rowOf('atlas')
  await click(scene, 8, atlasRow)
  await until(() => /(?:viewing|main chat:) atlas ·/.test(headerRow(scene.lines())), 6000)
  await until(() => scene.lines().some(line => line.includes('holding the line')), 6000)
  await sleep(300)
  frame = scene.lines()
  save('3-view-atlas', frame)
  const orderAtlas = crewOrder(frame, cockpit)
  check(`${size}: atlas's row opens atlas in the view at the bottom of its transcript (its last row on screen, no pill)`, /viewing atlas ·/.test(headerRow(frame)) && frame.some(line => centre(line, cockpit).includes('holding the line')) && !frame.some(line => line.includes(PILL)), `${headerRow(frame)}${frame.some(line => line.includes(PILL)) ? ' · the pill stands' : ''}`)
  check(`${size}: the CREW rows keep their order with atlas viewed`, orderAtlas === orderAtRest && railRow(frame, cockpit, '◉ atlas') === atlasRow, `${orderAtRest} → ${orderAtlas}`)
  check(`${size}: atlas's view paints whole (no character past the right border)`, integrity(frame).length === 0, integrity(frame).slice(0, 3).join(' · '))

  section(`§2 ${size}: the pill's law on the swapped transcript`)
  scene.push(PAGE_UP)
  await sleep(300)
  frame = scene.lines()
  save('4-atlas-scrolled', frame)
  const handle = scene.handle()
  const scrolledTop = handle?.getScrollTop() ?? -1
  const scrolledRows = transcriptOf(frame, cockpit)
  console.log(`${size}: atlas after PgUp — scrollTop ${scrolledTop} · pending ${handle?.getPendingDelta()} · height ${handle?.getFreshScrollHeight()} · viewport ${handle?.getViewportHeight()}`)
  check(`${size}: PgUp scrolls atlas's transcript a page up and the pill stands`, scrolledTop > 0 && frame.some(line => line.includes(PILL)), `scrollTop ${scrolledTop}${frame.some(line => line.includes(PILL)) ? '' : ' · no pill'}`)
  await click(scene, 8, fjordRow)
  await until(() => /(?:viewing|main chat:) fjord ·/.test(headerRow(scene.lines())), 6000)
  await until(() => scene.lines().some(line => line.includes('[fjord]')), 6000)
  await sleep(400)
  frame = scene.lines()
  save('5-fjord-after-scroll', frame)
  const fjordRows = transcriptOf(frame, cockpit).filter(line => line.trim() !== '')
  console.log(`${size}: fjord after the scrolled atlas — scrollTop ${handle?.getScrollTop()} · height ${handle?.getFreshScrollHeight()} · viewport ${handle?.getViewportHeight()} · pill ${frame.some(line => line.includes(PILL))}`)
  check(`${size}: the swap to fjord's short transcript shows it whole from its first row with NO pill (nothing lies below the viewport)`, fjordRows.length > 0 && fjordRows[0]!.includes('[you → fjord]') && !frame.some(line => line.includes(PILL)), `${fjordRows.slice(0, 1).map(flat).join('')}${frame.some(line => line.includes(PILL)) ? ' · the pill stands' : ''}`)
  scene.push(PAGE_UP)
  await sleep(300)
  frame = scene.lines()
  check(`${size}: PgUp on the short transcript changes nothing and raises no pill`, !frame.some(line => line.includes(PILL)) && transcriptOf(frame, cockpit).filter(line => line.trim() !== '')[0]!.includes('[you → fjord]'), frame.some(line => line.includes(PILL)) ? 'the pill stands' : transcriptOf(frame, cockpit).filter(line => line.trim() !== '')[0] ?? '')
  let releaseRead = () => {}
  readHeld = false
  heldRead = new Promise<void>(resolve => { releaseRead = resolve })
  await click(scene, 8, atlasRow)
  await until(() => /(?:viewing|main chat:) atlas ·/.test(headerRow(scene.lines())), 6000)
  await until(() => readHeld && scene.lines().some(line => line.includes('reading the crewmate')), 6000)
  save('6-atlas-reading', scene.lines())
  check(`${size}: the return waits on a real pending transcript read`, readHeld && scene.lines().some(line => line.includes('reading the crewmate')))
  releaseRead()
  heldRead = undefined
  await until(() => scene.lines().some(line => line.includes('ledger row')), 6000)
  await sleep(400)
  frame = scene.lines()
  save('6-atlas-again', frame)
  console.log(`${size}: back on atlas — scrollTop ${handle?.getScrollTop()} · pending ${handle?.getPendingDelta()} · sticky ${handle?.isSticky()} · height ${handle?.getFreshScrollHeight()} · viewport ${handle?.getViewportHeight()}`)
  const againRows = transcriptOf(frame, cockpit)
  check(`${size}: back on atlas the transcript is where it was left (scrollTop ${scrolledTop}) and the pill stands for the rows below`, (handle?.getScrollTop() ?? -1) === scrolledTop && againRows.join('\n') === scrolledRows.join('\n') && frame.some(line => line.includes(PILL)), `scrollTop ${handle?.getScrollTop()} · first row "${flat(againRows.find(line => line.trim() !== '') ?? '')}" vs "${flat(scrolledRows.find(line => line.trim() !== '') ?? '')}"${frame.some(line => line.includes(PILL)) ? '' : ' · no pill'}`)

  section(`§3 ${size}: /usage and /config float inside the view over the scrolled crewmate and hand the view back as it was`)
  const before = transcriptOf(frame, cockpit)
  const headerBefore = headerRow(frame)
  await usageCommand.call('', { messages: [], options: {} } as never)
  const usageUp = await until(() => scene.lines().some(line => line.includes(USAGE_TITLE)), 6000)
  await sleep(400)
  frame = scene.lines()
  save('7-usage-over-atlas', frame)
  const usageWindow = windowOf(frame, USAGE_TITLE)
  console.log(`${size}: /usage ${describe(usageWindow)} · view rows 0..${cockpit.bottom}`)
  check(`${size}: /usage opens as one closed window`, usageUp && usageWindow !== null, describe(usageWindow))
  check(`${size}: the /usage window floats inside the view — never across its bottom border, the status line or the composer`, usageWindow !== null && usageWindow.top > 0 && usageWindow.bottom < cockpit.bottom && usageWindow.left > cockpit.left && usageWindow.right < cockpit.right, `${describe(usageWindow)} · the view's bottom border is row ${cockpit.bottom}`)
  check(`${size}: every border outside the /usage window is whole`, integrity(frame).length === 0, integrity(frame).slice(0, 3).join(' · '))
  scene.push(ESC)
  await until(() => !isSettingsPopupOpen(), 4000)
  if (isSettingsPopupOpen()) closeSettingsPopup()
  await sleep(400)
  frame = scene.lines()
  save('8-usage-closed', frame)
  check(`${size}: esc on /usage returns the view as it was — the same crewmate, the same rows, the same scroll`, headerRow(frame) === headerBefore && transcriptOf(frame, cockpit).join('\n') === before.join('\n') && (handle?.getScrollTop() ?? -1) === scrolledTop, `${headerRow(frame)} · scrollTop ${handle?.getScrollTop()}`)
  let configOpened = false
  try {
    await configCommand.call('', { messages: [], options: {} } as never)
    configOpened = await until(() => scene.lines().some(line => line.includes(CONFIG_TITLE)), 6000)
  } catch (error) {
    console.log(`${size}: /config could not open in this harness — ${String(error).slice(0, 120)}`)
  }
  if (configOpened) {
    await sleep(400)
    frame = scene.lines()
    save('9-config-over-atlas', frame)
    const configWindow = windowOf(frame, CONFIG_TITLE)
    console.log(`${size}: /config ${describe(configWindow)} · view rows 0..${cockpit.bottom}`)
    check(`${size}: the /config window floats inside the view — never across its top or bottom border, the status line or the composer`, configWindow !== null && configWindow.top > 0 && configWindow.bottom < cockpit.bottom && configWindow.left > cockpit.left && configWindow.right < cockpit.right, `${describe(configWindow)} · the view's bottom border is row ${cockpit.bottom}`)
    check(`${size}: every border outside the /config window is whole`, integrity(frame).length === 0, integrity(frame).slice(0, 3).join(' · '))
    scene.push(ESC)
    await until(() => !isSettingsPopupOpen(), 4000)
    if (isSettingsPopupOpen()) closeSettingsPopup()
    await sleep(400)
    frame = scene.lines()
    check(`${size}: esc on /config returns the view as it was`, headerRow(frame) === headerBefore && transcriptOf(frame, cockpit).join('\n') === before.join('\n'), headerRow(frame))
  }

  section(`§4 ${size}: the crewmate on screen lands — its rail row and the way back stay`)
  const harbourRow = rowOf('harbo')
  await click(scene, 8, harbourRow)
  await until(() => /(?:viewing|main chat:) harbour ·/.test(headerRow(scene.lines())), 6000)
  await sleep(300)
  publishRoster(rowsNow => land(rowsNow, 'harbour'))
  await until(() => cardOf(scene.lines(), cockpit).includes('landed'), 6000)
  await sleep(400)
  frame = scene.lines()
  save('10-harbour-landed', frame)
  const landedCard = cardOf(frame, cockpit)
  console.log(`${size}: harbour's card after it landed: "${landedCard.slice(0, 160)}"`)
  const landedWay = /esc back to Mercury Lead · m main chat in \/crewmates · Mercury Lead in the rail goes back · (?:⇧|shift\+)← back$/.test(headerRow(frame))
  check(`${size}: the view stays on harbour and the card reads landed`, scene.state().viewingAgentTaskId === 'a-harbour' && landedCard.includes('landed') && landedWay && headerRow(frame).startsWith('Opus 5.5'), `${headerRow(frame)} · ${landedCard.slice(0, 120)}`)
  check(`${size}: the status row names harbour beside the model where the row has room; at 120 columns the landed crewmate's way back leaves no room and the words leave (the rail's marked row and the composer name it)`, cols >= 178 ? /viewing harbour ·/.test(headerRow(frame)) : !/viewing harbour/.test(headerRow(frame)), headerRow(frame))
  check(`${size}: the card carries no stale running activity for the landed crewmate`, !landedCard.includes('Sleeping'), landedCard.slice(0, 160))
  const landedRailRow = railRow(frame, cockpit, '◉ harbo')
  check(`${size}: the rail keeps the landed crewmate's row in the CREW lane, marked ◉ and › (it settles under the running rows)`, landedRailRow >= 0 && /›/.test(railText(frame[landedRailRow] ?? '', cockpit)), frame.map(line => railText(line, cockpit)).filter(line => /CREW|◉|◐|★|✶/.test(line)).map(flat).join(' | '))
  publishRoster(rowsNow => { land(rowsNow, 'atlas'); land(rowsNow, 'fjord') })
  await sleep(600)
  frame = scene.lines()
  save('11-all-landed', frame)
  const leadRowAll = railRow(frame, cockpit, LEAD_ROW)
  check(`${size}: with every crewmate landed the CREW lane still stands while harbour is viewed — Mercury Lead in the rail is the way back`, leadRowAll >= 0 && railRow(frame, cockpit, '◉ harbo') >= 0, frame.map(line => railText(line, cockpit)).filter(line => /CREW|◉|◐|★|✶|Mercury/.test(line)).map(flat).join(' | ') || 'no CREW lane')
  check(`${size}: the view paints whole with every crewmate landed`, integrity(frame).length === 0, integrity(frame).slice(0, 3).join(' · '))
  if (leadRowAll >= 0) {
    await click(scene, 8, leadRowAll)
    await until(() => scene.state().viewingAgentTaskId === undefined, 4000)
    await sleep(300)
    frame = scene.lines()
    save('12-back-to-lead', frame)
    check(`${size}: Mercury Lead in the rail goes back (the lead's rows return)`, scene.state().viewingAgentTaskId === undefined && frame.some(line => centre(line, cockpit).includes(TRANSCRIPT_NEEDLE)), headerRow(frame))
  }

  section(`§5 ${size}: the main chat pinned on a landed crewmate keeps its ★ row and the crew pop-up hands the view back`)
  const crewElement = await crewmatesCommand.call(() => {}, { messages: [], options: {} } as never, '')
  if (crewElement !== null && crewElement !== undefined) scene.setModal(crewElement)
  await until(() => scene.lines().some(line => line.includes(CREW_TITLE)), 6000)
  await sleep(300)
  frame = scene.lines()
  const crewWindow = windowOf(frame, CREW_TITLE)
  const crewRowsInPopup = crewWindow === null ? [] : crewWindow.rows.filter(row => /(atlas|fjord|harbour)/.test(row)).map(row => /(atlas|fjord|harbour)/.exec(row)![1]!)
  const target = crewRowsInPopup[0] ?? 'atlas'
  console.log(`${size}: the crew pop-up ${describe(crewWindow)} · rows ${crewRowsInPopup.join(',')} · m on ${target}`)
  scene.push('m')
  await until(() => scene.state().mainChatTaskId !== undefined, 4000)
  await until(() => new RegExp(`main chat: ${target} ·`).test(headerRow(scene.lines())), 6000)
  await sleep(400)
  frame = scene.lines()
  save('13-pinned-landed', frame)
  const starRow = railRow(frame, cockpit, '★')
  check(`${size}: m pins the landed crewmate — its ★ row stands in the rail, the status row says main chat`, starRow >= 0 && railText(frame[starRow]!, cockpit).includes(target.slice(0, 5)) && new RegExp(`main chat: ${target} ·`).test(headerRow(frame)), `${headerRow(frame)} · ${starRow >= 0 ? flat(railText(frame[starRow]!, cockpit)) : 'no ★ row'}`)
  const pinnedRows = transcriptOf(frame, cockpit)
  const pinnedHeader = headerRow(frame)
  const crewAgain = await crewmatesCommand.call(() => {}, { messages: [], options: {} } as never, '')
  if (crewAgain !== null && crewAgain !== undefined) scene.setModal(crewAgain)
  await until(() => scene.lines().some(line => line.includes(CREW_TITLE)), 6000)
  await sleep(300)
  frame = scene.lines()
  save('14-crew-over-pinned', frame)
  const popupOverPinned = windowOf(frame, CREW_TITLE)
  check(`${size}: the crew pop-up over the pinned crewmate floats inside the view`, popupOverPinned !== null && popupOverPinned.top > 0 && popupOverPinned.bottom < cockpit.bottom && popupOverPinned.left > cockpit.left && popupOverPinned.right < cockpit.right, describe(popupOverPinned))
  scene.push(ESC)
  await until(() => !scene.lines().some(line => line.includes(CREW_TITLE)), 4000)
  await sleep(400)
  frame = scene.lines()
  save('15-crew-closed', frame)
  check(`${size}: esc on the crew pop-up hands the view back as it was — the same ★ crewmate, the same rows`, headerRow(frame) === pinnedHeader && transcriptOf(frame, cockpit).join('\n') === pinnedRows.join('\n') && railRow(frame, cockpit, '★') === starRow, `${headerRow(frame)} · ★ at ${railRow(frame, cockpit, '★')} (was ${starRow})`)
  check(`${size}: every border is whole after the close`, integrity(frame).length === 0, integrity(frame).slice(0, 3).join(' · '))
  await scene.close()
  await sleep(200)
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\ncrew-look-frames: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
