#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crew-ledger-'))
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
process.env.MERCURY_CHANNEL_ROOM = `crew-ledger-${process.pid}`
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
const ESC = '\x1b'
const ENTER = '\r'
const DOWN = '\x1b[B'
const FOCUS_IN = '\x1b[I'
const press = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M`
const release = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}m`

const ATLAS = { id: 'a-atlas', name: 'atlas', tokens: 171_700 }
const BIRCH = { id: 'a-birch', name: 'birch', tokens: 173_800 }
const CEDAR = { id: 'a-cedar', name: 'cedar', tokens: 152_700 }
const DELTA = { id: 'a-delta', name: 'delta', tokens: 90_500 }
const LOCAL_ID = 'a-local'
const LOCAL_NAME = 'local'
const INTERRUPTED_WORDS = 'interrupted by the operator on its screen'
const CREW_STOP_WORDS = 'stopped from the crew view'
const CLEAR_KEY = 'c clear'
const NAMES = /\b(atlas|birch|cedar|delta|local)\b/
const VIEW_ROW = (row: string): boolean => NAMES.test(row) && row.includes('claude-fable-5-1')

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const sizeArg = arg('--size')
const SIZES: Array<[number, number]> = sizeArg === undefined ? [[269, 70], [178, 51]] : [sizeArg.split('x').map(Number) as [number, number]]

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
  columns: number
  rows: number
  constructor(columns: number, rows: number) { super(); this.columns = columns; this.rows = rows }
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
const hardLimit = setTimeout(() => { console.error('crew-ledger exceeded its deadline'); process.exit(1) }, 360_000)
hardLimit.unref()

const NOW = Date.now()
type RosterRow = Record<string, unknown> & { id: string; status: string }
const lane = (facts: { id: string; name: string; tokens: number }, index: number, status = 'running'): RosterRow => ({
  id: facts.id,
  agentId: facts.id,
  kind: 'agent' as const,
  name: facts.name,
  status,
  startTime: NOW - 354_000 - index * 1000,
  ...(status === 'running' ? {} : { endTime: NOW - 60_000 }),
  description: `${facts.name} — a lane of the wave`,
  model: 'claude-fable-5-1',
  agentType: 'mercury-general',
  inputTokens: facts.tokens,
  outputTokens: 2_400,
  totalTokens: facts.tokens + 2_400,
  contextTokens: facts.tokens,
  ...(status === 'running' ? { phase: { phase: 'reasoning' as const, sinceMs: NOW - 27_000 } } : {}),
})
const freshRows = (): RosterRow[] => [lane(ATLAS, 0), lane(BIRCH, 1), lane(CEDAR, 2), lane(DELTA, 3, 'completed')]
let rosterRows: RosterRow[] = freshRows()
const workListeners = new Set<() => void>()
let roster = { rows: rosterRows, mission: [], samples: [], reported: true }
const publishRoster = (): void => {
  roster = { ...roster, rows: [...rosterRows] }
  for (const listener of workListeners) listener()
}
const settle = (id: string, patch: Record<string, unknown>): void => {
  rosterRows = rosterRows.map(row => (row.id === id ? { ...row, ...patch } : row))
  publishRoster()
}
const evict = (...ids: string[]): void => {
  rosterRows = rosterRows.filter(row => !ids.includes(row.id))
  publishRoster()
}
const landed = (id: string): void => settle(id, { status: 'completed', endTime: Date.now(), phase: undefined })
const killed = (id: string, stopReason: string): void => settle(id, { status: 'killed', endTime: Date.now(), phase: undefined, stopReason })
type AgentCall = { verb: string; agentId: string; note?: string; at: number }
const agentCalls: AgentCall[] = []
const resumes = (): AgentCall[] => agentCalls.filter(call => call.verb === 'resume')
const stops = (): AgentCall[] => agentCalls.filter(call => call.verb === 'stop')
let resumeReceipt: Record<string, unknown> = { outcome: 'applied', detail: '{"queued":true}' }

async function stub(path: string, fixture: (actual: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const actual = (await import(path)) as Record<string, unknown>
  mock.module(path, () => ({ ...actual, ...fixture(actual) }))
}
await stub('../../src/components/tasks/useFocusedWork.ts', () => ({ focusedRunnerPresence: () => 'live' }))

const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { useAppStateStore } = await import('../../src/state/AppState.tsx')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { FocusedSessionStatusRow } = await import('../../src/components/SwitchboardTagBar.tsx')
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
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.ts')
const { resetHelmFocusForTest } = await import('../../src/utils/cockpit/helmFocus.ts')
const { TranscriptSwap } = await import('../../src/components/CrewmateTranscript.tsx')
const teammateView = await import('../../src/state/teammateViewHelpers.ts')
const crewmateQueue = await import('../../src/components/tasks/crewmateQueue.ts')
const crewViewStore = await import('../../src/utils/cockpit/crewView.ts')
const { createTaskStateBase } = await import('../../src/Task.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { asAgentId } = await import('../../src/types/ids.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const h = React.createElement

const resting = noSessionConnector() as unknown as Record<string, unknown>
const tailStore = createStreamingTailStore()
const overrides: Record<string, unknown> = {
  sessionId: () => SESSION_ID,
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { workListeners.add(listener); return () => { workListeners.delete(listener) } },
  stopAgent: async (agentId: string, note?: string) => { agentCalls.push({ verb: 'stop', agentId, note, at: Date.now() }); return { outcome: 'applied' } },
  resumeAgent: async (agentId: string, note?: string) => { agentCalls.push({ verb: 'resume', agentId, note, at: Date.now() }); return resumeReceipt },
  interrupt: () => { leadInterrupts += 1; return false },
  live: () => IDLE_LIVE,
  subscribeLive: () => () => {},
  tail: () => tailStore,
  status: () => ({ title: 'the lead', projectLabel: 'proof', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false }),
}
let leadInterrupts = 0
const fake = new Proxy(resting, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
})
setFocusedSessionConnector(fake as never)
const CWD = (fake as { workspace: () => { originalCwd: string; cwd: string } }).workspace().originalCwd || process.cwd()

let seq = 100
const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stampOf = (n: number): string => new Date(NOW - 300_000 + n * 1000).toISOString()
function seedRow(agentId: string, n: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { isSidechain: true, agentId, entrypoint: 'cli', cwd: process.cwd(), sessionId: SESSION_ID, version: '1.0.0', gitBranch: 'main', parentUuid: n === 0 ? null : uuidOf(n - 1), uuid: uuidOf(n), timestamp: stampOf(n), ...extra }
}
const userRow = (agentId: string, n: number, text: string): Record<string, unknown> => seedRow(agentId, n, { type: 'user', message: { role: 'user', content: text } })
const assistantRow = (agentId: string, n: number, text: string): Record<string, unknown> => seedRow(agentId, n, { type: 'assistant', message: { id: `msg_${agentId}_${n}`, type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
const hostedFile = (agentId: string): string => join(getProjectDir(CWD), SESSION_ID, 'subagents', `agent-${agentId}.jsonl`)
const seeded = new Map<string, Record<string, unknown>[]>()
function seedHosted(agentId: string, rows: Record<string, unknown>[]): void {
  const file = hostedFile(agentId)
  mkdirSync(dirname(file), { recursive: true })
  seeded.set(agentId, rows)
  writeFileSync(file, encodeSeedTranscript(rows as never, SESSION_ID))
}
function landLine(agentId: string, text: string): void {
  const rows = [...(seeded.get(agentId) ?? []), userRow(agentId, seq++, text)]
  seedHosted(agentId, rows)
}
function seedAll(): void {
  seq = 100
  seedHosted(ATLAS.id, [userRow(ATLAS.id, 0, 'atlas — the picker pop-up'), ...Array.from({ length: 60 }, (_, n) => assistantRow(ATLAS.id, n + 1, `ATLAS-ROW ${n + 1} — ${n === 0 ? 'the seam is the session mount.' : 'a row of the crewmate\'s own transcript, tall enough that the view has to scroll.'}`))])
  seedHosted(BIRCH.id, [userRow(BIRCH.id, 0, 'birch — the drives say what they drive'), assistantRow(BIRCH.id, 1, 'BIRCH-ROW 1 — the drives named.')])
  seedHosted(CEDAR.id, [userRow(CEDAR.id, 0, 'cedar — the jump pill'), assistantRow(CEDAR.id, 1, 'CEDAR-ROW 1 — the pill shrinks.')])
  seedHosted(DELTA.id, [userRow(DELTA.id, 0, 'delta — the scratchpad'), assistantRow(DELTA.id, 1, 'DELTA-ROW 1 — done, the folder is named.')])
}

type Scene = {
  lines: () => string[]
  push: (data: string) => void
  state: () => Record<string, unknown>
  setState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void
  close: () => Promise<void>
}
const stateRef = { current: null as null | { getState: () => unknown; setState: (updater: (prev: never) => never) => void } }
const submits: string[] = []
const scrollRef = React.createRef<{ getScrollTop: () => number; isSticky: () => boolean; scrollTo: (y: number) => void }>()

function Transcript(): React.ReactNode {
  const rows: string[] = []
  for (let index = 0; index < 40; index++) rows.push(`14:49:${String(20 + index).padStart(2, '0')} [Mercury] LEAD-ROW ${index} — a row of the lead's transcript`)
  return h(Text, null, rows.join('\n'))
}
function Harness(): React.ReactNode {
  const { controls, focus } = useCompactWorkControls()
  const store = useAppStateStore()
  stateRef.current = store as never
  const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
  const [searching, setSearching] = React.useState(false)
  const [help, setHelp] = React.useState(false)
  const [bashes, setBashes] = React.useState<string | boolean>(false)
  const [screen, setScreen] = React.useState('prompt')
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(KeybindingSetup, null,
    h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
    h(FullscreenLayout, {
      scrollRef,
      scrollable: h(TranscriptSwap, { lead: h(Transcript), tools: [], commands: [], screen: 'prompt', scrollRef, agentDefinitions: { activeAgents: [], allAgents: [] }, trackStickyPrompt: true }),
      statusBand: h(Text, null, 'waiting on 3 agents'),
      statusBandActive: true,
      modalScrollRef,
      bottom: h(Box, { flexDirection: 'column' },
        h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, ideSelection: undefined, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 1, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async (text: string) => { submits.push(text) },
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        } as never),
        h(FocusedSessionStatusRow),
      ),
    } as never),
  )
}

async function mount(cols: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  resetHelmFocusForTest()
  pending.edit('')
  pending.setMode('prompt')
  const stdout = new Output(cols, rows)
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output(cols, rows) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness)))
  const painted = await until(() => ink.lastFrameText() !== '' && stripAnsi(ink.lastFrameText()).includes('CREW'))
  check(`the cockpit painted with the crew lane at ${cols}x${rows}`, painted, stripAnsi(ink.lastFrameText()).slice(0, 300))
  await sleep(400)
  stdin.push(FOCUS_IN)
  await sleep(200)
  return {
    lines: () => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n'),
    push: data => stdin.push(data),
    state: () => (stateRef.current?.getState() ?? {}) as Record<string, unknown>,
    setState: updater => stateRef.current?.setState(updater as never),
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}

const cells = (line: string): string[] => Array.from(line)
function railColsOf(lines: string[]): number {
  const header = lines.find(line => line.includes('CREW')) ?? ''
  const chars = cells(header)
  for (let x = 1; x < chars.length; x++) if (chars[x] === '│') return x + 1
  return 32
}
const railText = (line: string, railCols: number): string => cells(line).slice(0, railCols).join('')
const railRow = (lines: string[], needle: string, railCols: number): number => lines.findIndex(line => railText(line, railCols).includes(needle))
const railRowText = (lines: string[], needle: string, railCols: number): string => {
  const row = railRow(lines, needle, railCols)
  return row < 0 ? '(no row)' : railText(lines[row]!, railCols).replace(/[│]/g, '').trim()
}
function crewBox(lines: string[], railCols: number): { header: string; rows: string[] } | null {
  const headerRow = railRow(lines, 'CREW', railCols)
  if (headerRow < 0) return null
  const rows: string[] = []
  for (let y = headerRow + 1; y < lines.length; y++) {
    const text = railText(lines[y]!, railCols)
    if (/[╰╭]/.test(text) || /^│\s*[▤◐◆◉✶◇○◌·]?\s*(WORK|RUNS|WORKBENCH|FILES|SATURN|RECENT|MISSION|NEXT)\b/.test(text.replace(/[│]/g, '│'))) break
    const bare = text.replace(/[│]/g, '').trim()
    if (bare === '') break
    rows.push(bare)
  }
  return { header: railText(lines[headerRow]!, railCols).replace(/[│]/g, '').trim(), rows }
}
const composerRowAt = (lines: string[]): number => lines.findIndex(line => /^│?[❯›] /.test(line))
const composerText = (lines: string[]): string => {
  const row = composerRowAt(lines)
  return row < 0 ? '(no composer row)' : lines[row]!.trim()
}
const footerOf = (lines: string[]): string => {
  const row = composerRowAt(lines)
  return row < 0 ? '' : lines.slice(row + 1, row + 8).map(line => line.trim()).filter(line => line !== '' && !/^[╰─╯╭╮]+$/.test(line)).join('\n')
}
const headerOf = (lines: string[], railCols: number): string => (lines.find(line => /VIEW/.test(cells(line).slice(railCols, -railCols).join(''))) ?? '').trim()
const centreOf = (lines: string[], railCols: number): string[] => lines.map(line => cells(line).slice(railCols, -railCols).join(''))
const cardOf = (lines: string[], railCols: number): string => centreOf(lines, railCols).slice(1, 6).join(' ').replace(/\s+/g, ' ')
const save = (name: string, cols: number, rows: number, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${cols}x${rows}.txt`), `${lines.join('\n')}\n`)
}
async function typeWords(scene: Scene, words: string): Promise<void> {
  for (const ch of words) { scene.push(ch); await sleep(25) }
  await until(() => pending.text().endsWith(words), 4000)
  await sleep(150)
}
async function clickRail(scene: Scene, needle: string, railCols: number): Promise<number> {
  const lines = scene.lines()
  const composer = composerRowAt(lines)
  const row = railRow(composer < 0 ? lines : lines.slice(0, composer), needle, railCols)
  if (row < 0) return row
  scene.push(press(8, row) + release(8, row))
  await sleep(450)
  return row
}
type Window = { rows: string[]; top: number; left: number }
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
  return { top, left, rows: lines.slice(top, bottom + 1).map(line => cells(line).slice(left, right + 1).join('')) }
}
const crewViewRow = (window: Window | null, name: string): string => (window?.rows.find(row => VIEW_ROW(row) && row.includes(name)) ?? '(no row)').replace(/[│]/g, '').replace(/\s+/g, ' ').trim()
const crewViewKeys = (window: Window | null): string => (window?.rows.map(row => row.trim()).find(row => row.includes('esc close')) ?? '').replace(/[│]/g, '').trim()
const waitForCall = (count: () => number, expected: number, ms = 3000): Promise<boolean> => until(() => count() >= expected, ms)

async function run(cols: number, rows: number): Promise<void> {
  section(`════ ${cols}x${rows} ════`)
  agentCalls.length = 0
  submits.length = 0
  crewmateQueue.resetCrewmateQueueForTest()
  rosterRows = freshRows()
  resumeReceipt = { outcome: 'applied', detail: '{"queued":true}' }
  seedAll()
  publishRoster()
  const scene = await mount(cols, rows)
  const railCols = railColsOf(scene.lines())
  console.log(`the lanes rail is ${railCols} columns wide`)
  const tag = (name: string): string => `${name} at ${cols}x${rows}`
  const box = (): { header: string; rows: string[] } | null => crewBox(scene.lines(), railCols)
  const describeBox = (): string => {
    const b = box()
    return b === null ? 'NO CREW BOX ON THE RAIL' : `${b.header} → ${b.rows.join(' | ')}`
  }
  const inBox = (name: string): boolean => (box()?.rows ?? []).some(row => row.includes(name))
  const boxRow = (name: string): string => (box()?.rows ?? []).find(row => row.includes(name)) ?? '(no row)'

  section(`§1 ${tag('the CREW box lists every crewmate with its state word, Mercury Lead first')}`)
  {
    await sleep(300)
    save('01-at-rest', cols, rows, scene.lines())
    const b = box()
    console.log(`the CREW box: ${describeBox()}`)
    check('the CREW box stands and Mercury Lead is its first row', b !== null && (b.rows[0] ?? '').includes(LEAD_ROW), describeBox())
    check('the three running crewmates are listed', b !== null && ['atlas', 'birch', 'cedar'].every(name => b.rows.some(row => NAMES.test(row) && row.includes(name))), describeBox())
    check('the crewmate that already landed (delta) is listed with its state word: landed', b !== null && b.rows.some(row => row.includes('delta') && row.includes('landed')), describeBox())
    check('the box counts every crewmate the session has had (4 agents)', b !== null && b.header.includes('4 agents'), describeBox())
  }

  section(`§1b ${tag('esc on a landed crewmate the runner still lists goes back to Mercury Lead')}`)
  {
    teammateView.enterTeammateView(DELTA.id, scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === DELTA.id, 4000)
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes('DELTA-ROW')), 6000)
    await sleep(400)
    save('01b-delta-viewed', cols, rows, scene.lines())
    check('delta (landed, still on the roster) is viewed with its transcript', scene.state().viewingAgentTaskId === DELTA.id && headerOf(scene.lines(), railCols).includes(DELTA.name), `viewing=${String(scene.state().viewingAgentTaskId)} · header ${headerOf(scene.lines(), railCols)}`)
    const landedFooter = footerOf(scene.lines()).replace(/\s+/g, ' ')
    console.log(`the footer on the landed crewmate: ${landedFooter.slice(0, 200)}`)
    check('the footer says what ↵ does to a landed hosted crewmate — ↵ resumes delta with your line — never "↵ sends to delta"', /↵ resumes delta with your line/.test(landedFooter) && !/↵ sends to delta/.test(landedFooter), landedFooter.slice(0, 240))
    const RESUME_LINE = 'delta, one more folder'
    resumeReceipt = { outcome: 'applied' }
    await typeWords(scene, RESUME_LINE)
    scene.push(ENTER)
    await waitForCall(() => resumes().filter(call => call.note === RESUME_LINE).length, 1)
    await sleep(500)
    save('01b-delta-resumed', cols, rows, scene.lines())
    const resumeCall = resumes().find(call => call.note === RESUME_LINE)
    check('↵ on the landed crewmate resumes it with the line through the connector (the runner resumes it from its transcript), the target never falls back to the lead', resumeCall !== undefined && resumeCall.agentId === DELTA.id && submits.length === 0, `${JSON.stringify(resumeCall)} · submits ${JSON.stringify(submits)}`)
    check('the receipt says delta was between turns and resumed with the message', scene.lines().some(line => line.includes('delta was between turns') && line.includes('resumed with your message')), footerOf(scene.lines()).replace(/\s+/g, ' ').slice(0, 240))
    check('the line paints in delta\'s transcript at once, marked queued, until the runner writes it', centreOf(scene.lines(), railCols).some(line => line.includes(RESUME_LINE) && /\bqueued\b/.test(line)), centreOf(scene.lines(), railCols).filter(line => line.includes(RESUME_LINE)).join(' | ').slice(0, 200))
    landLine(DELTA.id, RESUME_LINE)
    publishRoster()
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes(RESUME_LINE) && !/\bqueued\b/.test(line)), 8000)
    check('…and is the landed row once, the queued mark gone', centreOf(scene.lines(), railCols).filter(line => line.includes(RESUME_LINE)).length === 1, centreOf(scene.lines(), railCols).filter(line => line.includes(RESUME_LINE)).join(' | ').slice(0, 200))
    resumeReceipt = { outcome: 'applied', detail: '{"queued":true}' }
    const stopsBefore = stops().length
    scene.push(ESC)
    await sleep(600)
    save('01b-esc-on-delta', cols, rows, scene.lines())
    console.log(`after esc on delta: viewing=${String(scene.state().viewingAgentTaskId)} · header "${headerOf(scene.lines(), railCols)}" · ${footerOf(scene.lines()).replace(/\s+/g, ' ').slice(0, 200)}`)
    check('esc on the landed crewmate goes back to Mercury Lead (no crewmate viewed, the lead\'s rows back)', scene.state().viewingAgentTaskId === undefined && centreOf(scene.lines(), railCols).some(line => line.includes('LEAD-ROW')), `viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)} · header "${headerOf(scene.lines(), railCols)}"`)
    check('no stop was sent for the landed crewmate', stops().length === stopsBefore, JSON.stringify(stops().slice(stopsBefore)))
    check('the receipt says delta is landed and the view is back on Mercury Lead — never "between turns — nothing to interrupt"', scene.lines().some(line => line.includes(`${DELTA.name} is landed`) && line.includes(LEAD_ROW)) && !scene.lines().some(line => line.includes('nothing to interrupt')), footerOf(scene.lines()).replace(/\s+/g, ' ').slice(0, 240))
  }

  section(`§2 ${tag('the crewmates settle and the runner evicts their rows: the box keeps them, each with its state word')}`)
  {
    killed(BIRCH.id, INTERRUPTED_WORDS)
    killed(CEDAR.id, CREW_STOP_WORDS)
    await sleep(500)
    save('02-settled', cols, rows, scene.lines())
    console.log(`after the settles: ${describeBox()}`)
    check('the interrupted crewmate (birch, the operator\'s esc) reads interrupted', boxRow('birch').includes('interrupted'), `birch's row reads "${boxRow('birch')}"`)
    check('the crewmate stopped from the crew view (cedar) reads stopped', boxRow('cedar').includes('stopped'), `cedar's row reads "${boxRow('cedar')}"`)
    check('the running crewmate (atlas) still reads its running verb', inBox('atlas') && !/landed|stopped|interrupted/.test(boxRow('atlas')), `atlas's row reads "${boxRow('atlas')}"`)
    evict(BIRCH.id, CEDAR.id, DELTA.id)
    await sleep(600)
    save('02-evicted', cols, rows, scene.lines())
    console.log(`after the runner evicted birch, cedar and delta: ${describeBox()}`)
    const b = box()
    check('the runner\'s eviction does not empty the box: birch, cedar and delta stay listed with their words', b !== null && b.rows.some(row => row.includes('birch') && row.includes('interrupted')) && b.rows.some(row => row.includes('cedar') && row.includes('stopped')) && b.rows.some(row => row.includes('delta') && row.includes('landed')), describeBox())
    check('Mercury Lead is still the first row', b !== null && (b.rows[0] ?? '').includes(LEAD_ROW), describeBox())
  }

  section(`§3 ${tag('the crew view lists the finished crewmates greyed with their words; c clears a finished row, never a running one')}`)
  {
    crewViewStore.openCrewView()
    const opened = await until(() => scene.lines().some(line => line.includes(CREW_TITLE)), 8000)
    check('the crew view painted', opened, scene.lines().slice(-12).join(' | ').slice(0, 300))
    await sleep(500)
    save('03-crew-view', cols, rows, scene.lines())
    let window = windowOf(scene.lines(), CREW_TITLE)
    console.log(`the crew view's rows: ${window?.rows.filter(VIEW_ROW).map(row => row.replace(/[│]/g, '').replace(/\s+/g, ' ').trim()).join(' | ')}`)
    console.log(`the crew view's key row: "${crewViewKeys(window)}"`)
    check('the crew view lists all four crewmates (the runner carries only atlas)', window !== null && ['atlas', 'birch', 'cedar', 'delta'].every(name => window!.rows.some(row => VIEW_ROW(row) && row.includes(name))), window?.rows.filter(row => VIEW_ROW(row) || row.includes('no sub-agents')).map(row => row.trim()).join(' | ').slice(0, 300) ?? 'no window')
    check('the finished rows carry their state words in the view: birch interrupted · cedar stopped · delta landed', crewViewRow(window, 'birch').includes('interrupted') && crewViewRow(window, 'cedar').includes('stopped') && crewViewRow(window, 'delta').includes('landed'), [crewViewRow(window, 'birch'), crewViewRow(window, 'cedar'), crewViewRow(window, 'delta')].join(' | ').slice(0, 300))
    check('the title counts the four crewmates', window !== null && window.rows.some(row => row.includes('4 sub-agents')), window?.rows.slice(0, 2).join(' | ') ?? 'no window')
    const keysOnRunning = crewViewKeys(window)
    check(`the key row on the running row (atlas, the cursor's rest) does not offer ${CLEAR_KEY}`, keysOnRunning !== '' && !keysOnRunning.includes(CLEAR_KEY), keysOnRunning)
    scene.push('c')
    await sleep(500)
    window = windowOf(scene.lines(), CREW_TITLE)
    check('c on the running crewmate clears nothing: atlas stays listed', window !== null && window.rows.some(row => VIEW_ROW(row) && row.includes('atlas')) && inBox('atlas'), window?.rows.filter(VIEW_ROW).join(' | ').slice(0, 200) ?? 'no window')
    check('the view says a running crewmate is stopped, not cleared', window !== null && window.rows.some(row => /running/.test(row) && /clear/.test(row)), window?.rows.map(row => row.trim()).filter(row => /clear/.test(row)).join(' | ').slice(0, 200) ?? 'no window')
    for (let step = 0; step < 3; step++) { scene.push(DOWN); await sleep(60) }
    await sleep(300)
    window = windowOf(scene.lines(), CREW_TITLE)
    const keysOnDelta = crewViewKeys(window)
    console.log(`the key row on delta: "${keysOnDelta}"`)
    check(`the key row on a finished row offers ${CLEAR_KEY}`, keysOnDelta.includes(CLEAR_KEY), keysOnDelta)
    check('the cursor rests on delta (the landed row)', /^[▸❯]/.test(crewViewRow(window, 'delta')), crewViewRow(window, 'delta'))
    scene.push('c')
    await sleep(600)
    save('03-cleared-delta', cols, rows, scene.lines())
    window = windowOf(scene.lines(), CREW_TITLE)
    console.log(`after c on delta — the view: ${window?.rows.filter(VIEW_ROW).map(row => row.replace(/[│]/g, '').replace(/\s+/g, ' ').trim()).join(' | ')} · the rail: ${describeBox()}`)
    check('c on the landed row clears it from the view', window !== null && !window.rows.some(row => VIEW_ROW(row) && row.includes('delta')) && window.rows.some(row => VIEW_ROW(row) && row.includes('birch')), window?.rows.filter(VIEW_ROW).join(' | ').slice(0, 200) ?? 'no window')
    check('the cleared row leaves the CREW box too, the others stay', !inBox('delta') && inBox('birch') && inBox('cedar'), describeBox())
    check('the view says the row was cleared and its transcript stays on disk', window !== null && window.rows.some(row => row.includes('delta cleared')), window?.rows.map(row => row.trim()).filter(row => /cleared/.test(row)).join(' | ').slice(0, 200) ?? 'no window')
    scene.push(ESC)
    await until(() => !scene.lines().some(line => line.includes(CREW_TITLE)), 4000)
    check('esc closes the crew view', !scene.lines().some(line => line.includes(CREW_TITLE)))
  }

  section(`§4 ${tag('esc on a crewmate that is not running goes back to Mercury Lead; esc on a running one still interrupts it alone')}`)
  {
    teammateView.enterTeammateView(BIRCH.id, scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === BIRCH.id, 4000)
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes('BIRCH-ROW')), 6000)
    await sleep(400)
    save('04-birch-viewed', cols, rows, scene.lines())
    check('birch (interrupted, evicted by the runner) opens in the view with its transcript', scene.state().viewingAgentTaskId === BIRCH.id && headerOf(scene.lines(), railCols).includes(BIRCH.name) && centreOf(scene.lines(), railCols).some(line => line.includes('BIRCH-ROW')), `viewing=${String(scene.state().viewingAgentTaskId)} · header ${headerOf(scene.lines(), railCols)}`)
    const card = cardOf(scene.lines(), railCols)
    console.log(`birch's card: ${card.slice(0, 240)}`)
    check('the card says birch is interrupted (its state word), greyed, and does not promise esc interrupts or x stop', card.includes('interrupted') && !card.includes('esc interrupts') && !card.includes('x stop'), card.slice(0, 240))
    const footer = footerOf(scene.lines()).replace(/\s+/g, ' ')
    console.log(`the footer: ${footer.slice(0, 240)}`)
    check('the footer says esc goes back to Mercury Lead, never esc interrupts birch', /esc[^·]*back[^·]*Mercury Lead/.test(footer) && !/esc interrupts? birch/.test(footer), footer.slice(0, 240))
    const stopsBefore = stops().length
    scene.push(ESC)
    await sleep(600)
    save('04-esc-on-birch', cols, rows, scene.lines())
    check('esc on the crewmate that is not running goes back to Mercury Lead (no crewmate viewed)', scene.state().viewingAgentTaskId === undefined, `viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)} · header "${headerOf(scene.lines(), railCols)}"`)
    check('the lead\'s rows are back in the centre', centreOf(scene.lines(), railCols).some(line => line.includes('LEAD-ROW')) && !centreOf(scene.lines(), railCols).some(line => line.includes('BIRCH-ROW')))
    check('no stop was sent for the crewmate that was not running', stops().length === stopsBefore, JSON.stringify(stops().slice(stopsBefore)))
    check('the receipt says birch is interrupted and the view is back on Mercury Lead', scene.lines().some(line => line.includes(`${BIRCH.name} is interrupted`) && line.includes(LEAD_ROW)), footerOf(scene.lines()).replace(/\s+/g, ' ').slice(0, 240))
    check('birch keeps its row in the CREW box after the return', inBox('birch'), describeBox())
    const atlasRow = await clickRail(scene, 'atlas', railCols)
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes('ATLAS-ROW')), 6000)
    await sleep(300)
    check('one click on atlas (running) opens it in the view', atlasRow >= 0 && scene.state().viewingAgentTaskId === ATLAS.id, `row ${atlasRow} · viewing=${String(scene.state().viewingAgentTaskId)}`)
    const runningFooter = footerOf(scene.lines()).replace(/\s+/g, ' ')
    check('on the running crewmate the footer still says esc interrupts atlas', /esc interrupts? atlas/.test(runningFooter), runningFooter.slice(0, 240))
    const stopsBeforeAtlas = stops().length
    scene.push(ESC)
    await sleep(600)
    save('04-esc-on-atlas', cols, rows, scene.lines())
    check('esc on the running crewmate interrupts it alone: one stop, its id, the operator-interrupt note', stops().length === stopsBeforeAtlas + 1 && stops()[stops().length - 1]!.agentId === ATLAS.id && stops()[stops().length - 1]!.note === 'operator-interrupt' && leadInterrupts === 0, JSON.stringify(stops().slice(stopsBeforeAtlas)))
    check('the view stays on the running crewmate after the interrupt', scene.state().viewingAgentTaskId === ATLAS.id, `viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)}`)
  }

  section(`§5 ${tag('a line to a hosted crewmate paints in its transcript at once, marked queued, and becomes the landed row — exactly one')}`)
  {
    const LINE = 'atlas, land the picker first'
    const carrying = (): string[] => centreOf(scene.lines(), railCols).filter(line => line.includes(LINE))
    await typeWords(scene, LINE)
    scene.push(ENTER)
    await waitForCall(() => resumes().filter(call => call.agentId === ATLAS.id).length, 1)
    await sleep(500)
    save('05-queued-at-once', cols, rows, scene.lines())
    console.log(`the rows carrying the line: ${carrying().map(line => line.trim().slice(0, 100)).join(' | ')}`)
    const atlasResumes = (): AgentCall[] => resumes().filter(call => call.agentId === ATLAS.id)
    check('↵ sent the line to atlas through the connector, once', atlasResumes().length === 1 && atlasResumes()[0]!.note === LINE, JSON.stringify(resumes()))
    check('the line paints in the crewmate\'s transcript at once, plated [you → atlas] and marked queued', carrying().length === 1 && carrying()[0]!.includes(`[you → ${ATLAS.name}]`) && /\bqueued\b/.test(carrying()[0]!), carrying().length === 0 ? 'no row carries the line — only the receipt shows' : carrying().join(' | ').slice(0, 200))
    const rowIndexOf = (): number => centreOf(scene.lines(), railCols).findIndex(line => line.includes(LINE))
    const plateColumnOf = (): number => (centreOf(scene.lines(), railCols).find(line => line.includes(LINE)) ?? '').indexOf('[you →')
    const LIVE_COUNTER = /\b\d+[dhms](?: \d+[hms])*\b/
    const maskLiveWords = (line: string): string => {
      const still = line.replace(/\b\d\d:\d\d:\d\d\b|\bqueued  /g, '········')
      if (!VIEW_ROW(still)) return still
      const counter = still.search(LIVE_COUNTER)
      return counter < 0 ? still : `${still.slice(0, counter)}·`
    }
    const masked = (): string[] => centreOf(scene.lines(), railCols).map(maskLiveWords)
    const queuedRow = rowIndexOf()
    const queuedPlateColumn = plateColumnOf()
    const queuedTranscript = masked()
    const cardRow = centreOf(scene.lines(), railCols).find(VIEW_ROW) ?? ''
    const counters = cardRow.match(new RegExp(LIVE_COUNTER.source, 'g')) ?? []
    const replant = (reasoning: string, running: string): string => {
      let seen = 0
      return cardRow.replace(new RegExp(LIVE_COUNTER.source, 'g'), () => (seen++ === 0 ? reasoning : running))
    }
    const plants = [replant('1m 20s', '6m 57s'), replant('1m 21s', '6m 58s'), replant('59s', '6m 59s'), replant('1m 0s', '7m 0s')]
    console.log(`the crewmate card row before the landing: "${cardRow.trim().slice(0, 120)}" · its live counters: ${counters.join(', ') || 'none'}`)
    check('the comparison ignores a tick of the card\'s live counters between the two frames (a slow frame straddles a second boundary): reasoning 1m 20s → 1m 21s, 59s → 1m 0s, the running time behind them', counters.length >= 1 && plants.every(row => maskLiveWords(row) === maskLiveWords(cardRow)), counters.length === 0 ? 'no live counter on the card row' : `masked "${maskLiveWords(plants[1]!).trim().slice(0, 100)}" vs "${maskLiveWords(cardRow).trim().slice(0, 100)}"`)
    landLine(ATLAS.id, LINE)
    publishRoster()
    const landedOnce = await until(() => carrying().length === 1 && !/\bqueued\b/.test(carrying()[0]!), 8000)
    await sleep(300)
    save('05-landed', cols, rows, scene.lines())
    console.log(`after the runner wrote the row: ${carrying().map(line => line.trim().slice(0, 100)).join(' | ')} · row ${queuedRow} → ${rowIndexOf()} · plate column ${queuedPlateColumn} → ${plateColumnOf()}`)
    check('once the delivery lands on disk the line is the normal row — exactly one, the queued mark gone', landedOnce && carrying().length === 1, `${carrying().length} rows carry the line: ${carrying().map(line => line.trim().slice(0, 80)).join(' | ')}`)
    check('the landed twin occupies the queued row\'s own row and plate column — the queued mark stood where the clock stands, the transcript never reflows when it lands', rowIndexOf() === queuedRow && plateColumnOf() === queuedPlateColumn && queuedPlateColumn > 0, `row ${queuedRow} → ${rowIndexOf()} · plate column ${queuedPlateColumn} → ${plateColumnOf()}`)
    const landedTranscript = masked()
    const firstDiff = landedTranscript.findIndex((line, index) => line !== queuedTranscript[index])
    check('every other transcript row paints exactly where it did before the landing (the clock column and the card\'s live counters aside)', firstDiff < 0, `first differing row ${firstDiff}: "${(queuedTranscript[firstDiff] ?? '').trim().slice(0, 80)}" → "${(landedTranscript[firstDiff] ?? '').trim().slice(0, 80)}"`)
    const SECOND = 'atlas, then the footer'
    scrollRef.current?.scrollTo(2)
    await sleep(300)
    const scrolledTop = scrollRef.current?.getScrollTop() ?? -1
    const topRowOf = (): string => centreOf(scene.lines(), railCols).find(line => /ATLAS-ROW|\[you → atlas\]/.test(line)) ?? ''
    const scrolledTopRow = topRowOf()
    await typeWords(scene, SECOND)
    scene.push(ENTER)
    await waitForCall(() => resumes().filter(call => call.agentId === ATLAS.id).length, 2)
    await sleep(500)
    const queuedTop = scrollRef.current?.getScrollTop() ?? -1
    const queuedTopRow = topRowOf()
    landLine(ATLAS.id, SECOND)
    publishRoster()
    await sleep(3200)
    save('05-scrolled-landing', cols, rows, scene.lines())
    console.log(`the scrolled view across a queued line and its landing: scrollTop ${scrolledTop} → ${queuedTop} → ${scrollRef.current?.getScrollTop()} · top row "${scrolledTopRow.trim().slice(0, 40)}" → "${queuedTopRow.trim().slice(0, 40)}" → "${topRowOf().trim().slice(0, 40)}"`)
    check(`a scrolled transcript keeps its scroll top and its top row while a line queues below the viewport (scrollTop ${scrolledTop})`, scrolledTop === 2 && queuedTop === scrolledTop && queuedTopRow === scrolledTopRow, `scrollTop ${scrolledTop} → ${queuedTop} · top row "${scrolledTopRow.trim().slice(0, 60)}" → "${queuedTopRow.trim().slice(0, 60)}"`)
    check('…and across the landing of that line (the queued row and its landed twin occupy the same rows, so nothing above moves)', scrollRef.current?.getScrollTop() === scrolledTop && topRowOf() === scrolledTopRow, `scrollTop ${scrolledTop} → ${scrollRef.current?.getScrollTop()} · top row "${scrolledTopRow.trim().slice(0, 60)}" → "${topRowOf().trim().slice(0, 60)}"`)
    scrollRef.current?.scrollToBottom()
    await sleep(300)
    check('the second line landed once at the bottom, the queued mark gone', centreOf(scene.lines(), railCols).filter(line => line.includes(SECOND)).length === 1 && !centreOf(scene.lines(), railCols).some(line => line.includes(SECOND) && /\bqueued\b/.test(line)), centreOf(scene.lines(), railCols).filter(line => line.includes(SECOND)).join(' | ').slice(0, 200))
  }

  section(`§6 ${tag('a refused delivery: the queued row says so instead of vanishing; the draft comes back')}`)
  {
    const LINE = 'atlas, one more'
    const carrying = (): string[] => centreOf(scene.lines(), railCols).filter(line => line.includes(LINE) || line.includes('did not take'))
    resumeReceipt = { outcome: 'refused', detail: 'the runner is older than this screen' }
    await typeWords(scene, LINE)
    scene.push(ENTER)
    await waitForCall(() => resumes().filter(call => call.note === LINE).length, 1)
    await sleep(700)
    save('06-refused', cols, rows, scene.lines())
    console.log(`the rows after the refusal: ${carrying().map(line => line.trim().slice(0, 120)).join(' | ')}`)
    check('the refused line is back in the composer', pending.text() === LINE, `composer text ${JSON.stringify(pending.text())}`)
    check('the queued row stays and says the crewmate did not take it, with the runner\'s reason', carrying().some(line => line.includes(LINE)) && carrying().some(line => line.includes('did not take') && line.includes('older than this screen')), carrying().length === 0 ? 'no row — the queued row vanished' : carrying().join(' | ').slice(0, 300))
    pending.edit('')
    await sleep(150)
    resumeReceipt = { outcome: 'applied', detail: '{"queued":true}' }
  }

  section(`§7 ${tag('the local road: the synthetic row is marked queued and its landed twin replaces it')}`)
  {
    const LINE = 'local line once'
    const base = {
      ...createTaskStateBase(LOCAL_ID, 'local_agent', LOCAL_NAME),
      type: 'local_agent' as const,
      agentId: LOCAL_ID,
      prompt: 'work quietly',
      agentType: 'mercury-general',
      model: 'claude-fable-5-1',
      isBackgrounded: true,
      messages: [],
      status: 'running',
    }
    const file = getAgentTranscriptPath(asAgentId(LOCAL_ID))
    rmSync(file, { force: true })
    scene.setState(prev => ({ ...prev, tasks: { ...(prev.tasks as Record<string, unknown>), [LOCAL_ID]: base } }))
    await sleep(300)
    teammateView.enterTeammateView(LOCAL_ID, scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === LOCAL_ID, 4000)
    await sleep(400)
    await typeWords(scene, LINE)
    scene.push(ENTER)
    await sleep(600)
    const carrying = (): string[] => centreOf(scene.lines(), railCols).filter(line => line.includes(LINE))
    save('07-local-queued', cols, rows, scene.lines())
    console.log(`the local crewmate's rows carrying the line: ${carrying().map(line => line.trim().slice(0, 100)).join(' | ')}`)
    check('the line to a running local crewmate paints at once, plated and marked queued', carrying().length === 1 && carrying()[0]!.includes(`[you → ${LOCAL_NAME}]`) && /\bqueued\b/.test(carrying()[0]!), carrying().join(' | ').slice(0, 200))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, encodeSeedTranscript([userRow(LOCAL_ID, 0, 'local — work quietly'), assistantRow(LOCAL_ID, 1, 'LOCAL-ROW 1 — working.'), userRow(LOCAL_ID, 2, LINE)] as never, SESSION_ID))
    publishRoster()
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes('LOCAL-ROW 1')), 6000)
    await until(() => carrying().length === 1 && !/\bqueued\b/.test(carrying()[0]!), 6000)
    await sleep(300)
    save('07-local-landed', cols, rows, scene.lines())
    check('once the delivery lands the local line is the normal row — exactly one, the queued mark gone', carrying().length === 1 && !/\bqueued\b/.test(carrying()[0]!), carrying().join(' | ').slice(0, 200))
    check('the local crewmate is listed in the CREW box beside the hosted ones', inBox(LOCAL_NAME), describeBox())
    await clickRail(scene, LEAD_ROW, railCols)
    await until(() => scene.state().viewingAgentTaskId === undefined, 4000)
    scene.setState(prev => ({ ...prev, tasks: { ...(prev.tasks as Record<string, unknown>), [LOCAL_ID]: { ...(prev.tasks as Record<string, Record<string, unknown>>)[LOCAL_ID], status: 'completed', endTime: Date.now() } } }))
    await sleep(400)
    check('the local crewmate that landed reads landed in the CREW box', boxRow(LOCAL_NAME).includes('landed'), boxRow(LOCAL_NAME))
    teammateView.enterTeammateView(LOCAL_ID, scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === LOCAL_ID, 4000)
    await sleep(400)
    save('07-local-landed-viewed', cols, rows, scene.lines())
    const localFooter = footerOf(scene.lines()).replace(/\s+/g, ' ')
    console.log(`the footer on the landed local crewmate: ${localFooter.slice(0, 200)} · composer row "${composerText(scene.lines()).slice(0, 80)}" · header "${headerOf(scene.lines(), railCols).slice(0, 80)}"`)
    check('the footer on a landed LOCAL crewmate says ↵ is refused and names the resume door — never "↵ sends to local"', /↵ refused — r in \/crewmates resumes local/.test(localFooter) && !/↵ sends to local/.test(localFooter) && /esc back to Mercury Lead/.test(localFooter), localFooter.slice(0, 240))
    await clickRail(scene, LEAD_ROW, railCols)
    await until(() => scene.state().viewingAgentTaskId === undefined, 4000)
    await sleep(900)
  }

  section(`§8 ${tag('a line queued to a crewmate that ends before it lands says so; the last crewmate finishes and is evicted: the box stands, every row greyed, until the operator clears them all')}`)
  {
    const LINE = 'atlas, after you land'
    const carrying = (): string[] => centreOf(scene.lines(), railCols).filter(line => line.includes(LINE) || line.includes('ended before it landed'))
    const atlasRailRow = await clickRail(scene, 'atlas', railCols)
    const atlasViewed = await until(() => scene.state().viewingAgentTaskId === ATLAS.id, 4000)
    await sleep(300)
    check('one click on atlas in the rail opens it in the view before the line is sent', atlasViewed, `row ${atlasRailRow} · viewing=${String(scene.state().viewingAgentTaskId)} · rail ${describeBox()}`)
    await typeWords(scene, LINE)
    scene.push(ENTER)
    await waitForCall(() => resumes().filter(call => call.note === LINE).length, 1)
    await sleep(400)
    check('the line paints queued on atlas', carrying().some(line => line.includes(LINE) && /\bqueued\b/.test(line)), carrying().join(' | ').slice(0, 200))
    landed(ATLAS.id)
    await sleep(400)
    evict(ATLAS.id)
    const strandedSaid = await until(() => carrying().some(line => line.includes('ended before it landed')), 22000)
    await sleep(300)
    save('08-stranded', cols, rows, scene.lines())
    console.log(`after atlas ended without taking the line: ${carrying().map(line => line.trim().slice(0, 120)).join(' | ')}`)
    check('the queued row says the crewmate ended before the line landed, instead of vanishing', strandedSaid && carrying().some(line => line.includes(LINE)), carrying().length === 0 ? 'no row carries the line' : carrying().join(' | ').slice(0, 300))
    await clickRail(scene, LEAD_ROW, railCols)
    await until(() => scene.state().viewingAgentTaskId === undefined, 4000)
    await sleep(400)
    save('08-all-finished', cols, rows, scene.lines())
    console.log(`after atlas landed and was evicted: ${describeBox()}`)
    const b = box()
    check('the CREW box still stands after the last crewmate finished (Mercury Lead first, every crewmate listed greyed)', b !== null && (b.rows[0] ?? '').includes(LEAD_ROW) && ['atlas', 'birch', 'cedar'].every(name => b.rows.some(row => NAMES.test(row) && row.includes(name))), describeBox())
    check('atlas reads landed', boxRow('atlas').includes('landed'), boxRow('atlas'))
    crewViewStore.openCrewView()
    await until(() => scene.lines().some(line => line.includes(CREW_TITLE)), 8000)
    await sleep(400)
    let window = windowOf(scene.lines(), CREW_TITLE)
    const listed = (): number => (window?.rows.filter(VIEW_ROW).length ?? 0)
    console.log(`the crew view lists ${listed()} rows: ${window?.rows.filter(VIEW_ROW).map(row => row.replace(/[│]/g, '').replace(/\s+/g, ' ').trim()).join(' | ')}`)
    check('the crew view lists the four finished crewmates (three hosted, one local)', listed() === 4, window?.rows.filter(VIEW_ROW).join(' | ').slice(0, 300) ?? 'no window')
    for (let n = 0; n < 4; n++) {
      scene.push('c')
      await sleep(450)
      window = windowOf(scene.lines(), CREW_TITLE)
    }
    save('08-all-cleared', cols, rows, scene.lines())
    console.log(`after c four times — the view lists ${listed()} rows · the rail: ${describeBox()}`)
    check('c on each finished row clears it: the view lists none', listed() === 0, window?.rows.filter(VIEW_ROW).join(' | ').slice(0, 300) ?? 'no window')
    scene.push(ESC)
    await until(() => !scene.lines().some(line => line.includes(CREW_TITLE)), 4000)
    await sleep(300)
    check('the CREW box goes only now, when no crewmate is listed', box() === null, describeBox())
  }

  await scene.close()
}

for (const [cols, rows] of SIZES) await run(cols, rows)

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\ncrew-ledger: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
