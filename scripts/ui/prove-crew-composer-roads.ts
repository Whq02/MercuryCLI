#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crew-composer-roads-'))
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
process.env.MERCURY_CHANNEL_ROOM = `crew-composer-roads-${process.pid}`
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
const ESC = '\x1b'
const ENTER = '\r'
const press = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M`
const release = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}m`
const FOCUS_IN = '\x1b[I'

const ATLAS = { id: 'a-atlas', name: 'Lane atlas', tokens: 171_700 }
const BIRCH = { id: 'a-birch', name: 'Lane birch', tokens: 173_800 }
const CEDAR = { id: 'a-cedar', name: 'Lane cedar', tokens: 152_700 }
const LOCAL_ID = 'a-local'
const LOCAL_NAME = 'Lane local'
const LOCAL_LINE = 'local line once'
const SUGGESTION = 'refactor the parser next'

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
const hardLimit = setTimeout(() => { console.error('crew-composer-roads exceeded its deadline'); process.exit(1) }, 300_000)
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
  agentType: 'mercury-crew',
  inputTokens: facts.tokens,
  outputTokens: 2_400,
  totalTokens: facts.tokens + 2_400,
  contextTokens: facts.tokens,
  ...(status === 'running' ? { phase: { phase: 'reasoning' as const, sinceMs: NOW - 27_000 } } : {}),
})
const rosterRows: RosterRow[] = [lane(ATLAS, 0), lane(BIRCH, 1), lane(CEDAR, 2, 'completed')]
const workListeners = new Set<() => void>()
let roster = { rows: rosterRows, mission: [], samples: [], reported: true }
const pokeRoster = (): void => {
  roster = { ...roster, rows: [...roster.rows] }
  for (const listener of workListeners) listener()
}
type AgentCall = { verb: string; agentId: string; note?: string; at: number }
const agentCalls: AgentCall[] = []
const resumes = (): AgentCall[] => agentCalls.filter(call => call.verb === 'resume')
const stops = (): AgentCall[] => agentCalls.filter(call => call.verb === 'stop')
let resumeDelayMs = 0
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
const { createStreamingTailStore } = await import('../../src/utils/messages/streamingTailStore.ts')
const { resetHelmFocusForTest } = await import('../../src/utils/cockpit/helmFocus.ts')
const { TranscriptSwap } = await import('../../src/components/CrewmateTranscript.tsx')
const crewmateView = await import('../../src/state/crewmateViewHelpers.ts')
const { createTaskStateBase } = await import('../../src/Task.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const { getAgentTranscriptPath } = await import('../../src/utils/sessionStorage/paths.ts')
const { asAgentId } = await import('../../src/types/ids.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { processBashCommand } = await import('../../src/utils/processUserInput/processBashCommand.tsx')
const { UserTextMessage } = await import('../../src/components/messages/UserTextMessage.tsx')
const { composerTargetTaskId } = await import('../../src/state/selectors.ts')
const { REFOCUS_CLICK_WINDOW_MS } = await import('../../src/ink/components/App.tsx')
const CLOCK_SLEW_MS = 50
const h = React.createElement

const resting = noSessionConnector() as unknown as Record<string, unknown>
const tailStore = createStreamingTailStore()
const overrides: Record<string, unknown> = {
  sessionId: () => SESSION_ID,
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { workListeners.add(listener); return () => { workListeners.delete(listener) } },
  stopAgent: async (agentId: string, note?: string) => { agentCalls.push({ verb: 'stop', agentId, note, at: Date.now() }); return { outcome: 'applied' } },
  resumeAgent: (agentId: string, note?: string) => new Promise(resolve => {
    agentCalls.push({ verb: 'resume', agentId, note, at: Date.now() })
    setTimeout(() => resolve(resumeReceipt), resumeDelayMs)
  }),
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

const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stampOf = (n: number): string => new Date(NOW - 300_000 + n * 1000).toISOString()
function seedRow(agentId: string, n: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { isSidechain: true, agentId, entrypoint: 'cli', cwd: process.cwd(), sessionId: SESSION_ID, version: '1.0.0', gitBranch: 'main', parentUuid: n === 0 ? null : uuidOf(n - 1), uuid: uuidOf(n), timestamp: stampOf(n), ...extra }
}
const userRow = (agentId: string, n: number, text: string): Record<string, unknown> => seedRow(agentId, n, { type: 'user', message: { role: 'user', content: text } })
const assistantRow = (agentId: string, n: number, text: string): Record<string, unknown> => seedRow(agentId, n, { type: 'assistant', message: { id: `msg_${agentId}_${n}`, type: 'message', role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
function seedHosted(agentId: string, rows: Record<string, unknown>[]): string {
  const file = join(getProjectDir(CWD), SESSION_ID, 'subagents', `agent-${agentId}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(rows as never, SESSION_ID))
  return file
}
seedHosted(ATLAS.id, [userRow(ATLAS.id, 0, 'atlas — the picker pop-up'), assistantRow(ATLAS.id, 1, 'ATLAS-ROW 1 — the seam is the session mount.')])
seedHosted(BIRCH.id, [userRow(BIRCH.id, 0, 'birch — the drives say what they drive'), assistantRow(BIRCH.id, 1, 'BIRCH-ROW 1 — the drives named.')])
seedHosted(CEDAR.id, [userRow(CEDAR.id, 0, 'cedar — the jump pill'), assistantRow(CEDAR.id, 1, 'CEDAR-ROW 1 — done, the pill shrinks.')])

type Scene = {
  lines: () => string[]
  push: (data: string) => void
  state: () => Record<string, unknown>
  setState: (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => void
  submits: string[]
  close: () => Promise<void>
}
const stateRef = { current: null as null | { getState: () => unknown; setState: (updater: (prev: never) => never) => void } }
const submits: string[] = []
const shellResults: Array<Awaited<ReturnType<typeof processBashCommand>>> = []
const scrollRef = React.createRef<{ getScrollTop: () => number; isSticky: () => boolean; scrollTo: (y: number) => void }>()

function Transcript({ messages }: { messages: Awaited<ReturnType<typeof processBashCommand>>['messages'] }): React.ReactNode {
  const rows: string[] = []
  for (let index = 0; index < 40; index++) rows.push(`14:49:${String(20 + index).padStart(2, '0')} [Mercury] LEAD-ROW ${index} — a row of the lead's transcript`)
  return h(Box, { flexDirection: 'column' }, h(Text, null, rows.join('\n')),
    ...messages.flatMap(message => message.type === 'user' && typeof message.message.content === 'string'
      ? [h(UserTextMessage, { key: message.uuid, addMargin: false, verbose: false, param: { type: 'text', text: message.message.content } })]
      : []))
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
  const [shellMessages, setShellMessages] = React.useState<Awaited<ReturnType<typeof processBashCommand>>['messages']>([])
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(KeybindingSetup, null,
    h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
    h(FullscreenLayout, {
      scrollRef,
      scrollable: h(TranscriptSwap, { lead: h(Transcript, { messages: shellMessages }), tools: [], commands: [], screen: 'prompt', scrollRef, agentDefinitions: { activeAgents: [], allAgents: [] }, trackStickyPrompt: true }),
      statusBand: h(Text, null, 'waiting on 2 agents'),
      statusBandActive: true,
      modalScrollRef,
      bottom: h(Box, { flexDirection: 'column' },
        h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 1, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async (text: string, helpers: { clearBuffer: () => void; resetHistory: () => void; setCursorOffset: (offset: number) => void }) => {
            submits.push(text)
            if (pending.mode() !== 'bash') return
            pending.clearForSubmit(text)
            pending.edit('')
            pending.setMode('prompt')
            helpers.clearBuffer()
            helpers.resetHistory()
            helpers.setCursorOffset(0)
            const result = await processBashCommand(text.trim(), [], [], {
              options: { verbose: false },
              abortController: new AbortController(),
              getAppState: store.getState,
              setAppState: store.setState,
            } as never, () => {})
            shellResults.push(result)
            setShellMessages(prev => [...prev, ...result.messages])
          },
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        } as never),
        h(FocusedSessionStatusRow),
      ),
    } as never),
  )
}

async function mount(cols: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
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
  const focusTaken = await until(() => stdin.readableLength === 0, 2000)
  const focusedAt = Date.now()
  check(`the input reader took the focus-in at ${cols}x${rows}`, focusTaken, `${stdin.readableLength} bytes still queued on stdin`)
  const windowPassed = await until(() => Date.now() - focusedAt > REFOCUS_CLICK_WINDOW_MS + CLOCK_SLEW_MS, (REFOCUS_CLICK_WINDOW_MS + CLOCK_SLEW_MS) * 4)
  check(`the clock has left the refocus-click window (${REFOCUS_CLICK_WINDOW_MS}ms) before the first click at ${cols}x${rows}`, windowPassed, `${Date.now() - focusedAt}ms since the focus-in`)
  return {
    lines: () => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n'),
    push: data => stdin.push(data),
    state: () => (stateRef.current?.getState() ?? {}) as Record<string, unknown>,
    setState: updater => stateRef.current?.setState(updater as never),
    submits,
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
const composerRowAt = (lines: string[]): number => lines.findIndex(line => /^│?[❯›] /.test(line))
const composerText = (lines: string[]): string => {
  const row = composerRowAt(lines)
  return row < 0 ? '(no composer row)' : lines[row]!.trim()
}
const footerOf = (lines: string[]): string => {
  const row = composerRowAt(lines)
  return row < 0 ? '' : lines.slice(row + 1, row + 8).map(line => line.trim()).filter(line => line !== '' && !/^[╰─╯╭╮]+$/.test(line)).join('\n')
}
const statusRowOf = (lines: string[]): string => {
  const row = lines.findIndex(line => /proof · |main chat: |viewing Lane|composer → | ready/.test(line) && !/^│[❯›]/.test(line))
  return row < 0 ? '' : lines[row]!.trim()
}
const headerOf = (lines: string[], railCols: number): string => (lines.find(line => /VIEW/.test(cells(line).slice(railCols, -railCols).join(''))) ?? '').trim()
const centreOf = (lines: string[], railCols: number): string[] => lines.map(line => cells(line).slice(railCols, -railCols).join(''))
const save = (name: string, cols: number, rows: number, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${cols}x${rows}.txt`), `${lines.join('\n')}\n`)
}
async function typeWords(scene: Scene, words: string): Promise<void> {
  for (const ch of words) { scene.push(ch); await sleep(25) }
  await until(() => pending.text().endsWith(words), 4000)
  await sleep(150)
}
const railRowsAround = (lines: string[], railCols: number, row: number, reach = 3): string[] => {
  const from = row < 0 ? 0 : Math.max(0, row - reach)
  const to = row < 0 ? Math.min(lines.length, 24) : Math.min(lines.length, row + reach + 1)
  return lines.slice(from, to).map((line, index) => `${String(from + index).padStart(3)}${from + index === row ? ' ›' : '  '} ${railText(line, railCols)}`)
}
type RailClick = { row: number; landed: boolean; rows: string[] }
async function clickRail(scene: Scene, needle: string, railCols: number, landed: () => boolean): Promise<RailClick> {
  const lines = scene.lines()
  const row = railRow(lines, needle, railCols)
  if (row < 0) {
    const rows = railRowsAround(lines, railCols, row)
    console.log(`no rail row carries ${JSON.stringify(needle)} — the rail rows read:\n${rows.join('\n')}`)
    return { row, landed: false, rows }
  }
  scene.push(press(8, row) + release(8, row))
  const opened = await until(landed, 4000)
  const rows = railRowsAround(opened ? scene.lines() : lines, railCols, row)
  if (!opened) console.log(`the click on rail row ${row} (${JSON.stringify(needle)}) did not land — the rail rows it read:\n${rows.join('\n')}`)
  await sleep(150)
  return { row, landed: opened, rows }
}
const waitForCall = (count: () => number, expected: number, ms = 3000): Promise<boolean> => until(() => count() >= expected, ms)

async function run(cols: number, rows: number): Promise<void> {
  section(`════ ${cols}x${rows} ════`)
  agentCalls.length = 0
  submits.length = 0
  shellResults.length = 0
  resumeDelayMs = 0
  resumeReceipt = { outcome: 'applied', detail: '{"queued":true}' }
  const scene = await mount(cols, rows)
  const railCols = railColsOf(scene.lines())
  console.log(`the lanes rail is ${railCols} columns wide`)
  const tag = (name: string): string => `${name} at ${cols}x${rows}`

  section(`§1 ${tag('the hosted send road: the composer is taken when ↵ lands, never when the runner answers')}`)
  {
    const click = await clickRail(scene, String((ATLAS.tokens / 1000).toFixed(1)), railCols, () => scene.state().viewingAgentTaskId === ATLAS.id)
    check('one click on the atlas row opens it in the view', click.row >= 0 && click.landed && scene.state().viewingAgentTaskId === ATLAS.id, `row ${click.row} · viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)} · the rail rows read: ${click.rows.map(line => line.trim()).join(' ↵ ')}`)
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes('ATLAS-ROW')), 6000)
    resumeDelayMs = 700
    const FIRST = 'first line to atlas'
    await typeWords(scene, FIRST)
    check('the line is the composer text before ↵', pending.text() === FIRST, JSON.stringify(pending.text()))
    scene.push(ENTER)
    const called = await waitForCall(() => resumes().length, 1)
    await sleep(120)
    save('01-sent-before-receipt', cols, rows, scene.lines())
    check('↵ sent the line to the viewed crewmate through the connector, once', called && resumes().length === 1 && resumes()[0]!.agentId === ATLAS.id && resumes()[0]!.note === FIRST, JSON.stringify(resumes()))
    check('the composer is empty at once — the line left when ↵ landed, before the runner answered', pending.text() === '', `composer text ${JSON.stringify(pending.text())} · row ${composerText(scene.lines())}`)
    const SECOND = 'second'
    await typeWords(scene, SECOND)
    check('the operator typed the next words while the runner was still answering', pending.text().endsWith(SECOND), JSON.stringify(pending.text()))
    await sleep(900)
    save('01-typed-during-round-trip', cols, rows, scene.lines())
    check('the words typed during the round trip are still the composer text when the receipt lands (never wiped by a late clear)', pending.text() === SECOND, `composer text ${JSON.stringify(pending.text())} · row ${composerText(scene.lines())}`)
    check('the receipt names the plate and the queue', scene.lines().some(line => line.includes(`[you → ${ATLAS.name}]`) && line.includes('queued to')), footerOf(scene.lines()).replace(/\s+/g, ' ').slice(0, 200))
    pending.edit('')
    await sleep(150)
    const AGAIN = 'again please'
    await typeWords(scene, AGAIN)
    const before = resumes().length
    scene.push(ENTER)
    await waitForCall(() => resumes().length, before + 1)
    await sleep(80)
    scene.push(ENTER)
    await sleep(1000)
    const againCalls = resumes().filter(call => call.note === AGAIN)
    check('a second ↵ during the round trip sends nothing — the line went once (no double text)', againCalls.length === 1, `resume calls carrying the line: ${againCalls.length} — ${JSON.stringify(resumes().slice(before))}`)
    check('the composer is empty after the two ↵', pending.text() === '', JSON.stringify(pending.text()))
    resumeDelayMs = 0
  }

  section(`§2 ${tag('a refusal hands the line back — in front of anything typed since')}`)
  {
    resumeDelayMs = 500
    resumeReceipt = { outcome: 'refused', detail: 'the runner is older than this screen' }
    const KEEP = 'keep me'
    await typeWords(scene, KEEP)
    scene.push(ENTER)
    await waitForCall(() => resumes().filter(call => call.note === KEEP).length, 1)
    await sleep(100)
    scene.push('x')
    await sleep(900)
    save('02-refused', cols, rows, scene.lines())
    check('the refused line is back in the composer with the keystroke typed since after it', pending.text() === `${KEEP}x`, `composer text ${JSON.stringify(pending.text())}`)
    check('the refusal is said with the crewmate\'s name and the draft-stays words', scene.lines().some(line => line.includes(`${ATLAS.name} did not take the message`) && line.includes('the draft stays')), footerOf(scene.lines()).replace(/\s+/g, ' ').slice(0, 200))
    pending.edit('')
    await sleep(150)
    resumeDelayMs = 0
    resumeReceipt = { outcome: 'applied', detail: '{"queued":true}' }
  }

  section(`§3 ${tag('the pin on atlas while birch is viewed: every surface names the composer\'s target, esc names the viewed one')}`)
  {
    crewmateView.setMainChat(ATLAS.id, scene.setState as never)
    await sleep(300)
    const click = await clickRail(scene, String((BIRCH.tokens / 1000).toFixed(1)), railCols, () => scene.state().viewingAgentTaskId === BIRCH.id)
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes('BIRCH-ROW')), 6000)
    await sleep(300)
    const frame = scene.lines()
    save('03-pinned-atlas-viewing-birch', cols, rows, frame)
    check('birch is viewed while atlas stays pinned', click.row >= 0 && click.landed && scene.state().viewingAgentTaskId === BIRCH.id && scene.state().mainChatTaskId === ATLAS.id, `row ${click.row} · viewing=${String(scene.state().viewingAgentTaskId)} pinned=${String(scene.state().mainChatTaskId)} · the rail rows read: ${click.rows.map(line => line.trim()).join(' ↵ ')}`)
    check('the header says birch is viewed', /VIEW · Lane birch · viewing/.test(headerOf(frame, railCols)), headerOf(frame, railCols))
    check('the composer placeholder names the pinned target: message Lane atlas', composerText(frame).includes(`message ${ATLAS.name}`), composerText(frame).slice(0, 80))
    const footer = footerOf(frame).replace(/\s+/g, ' ')
    check('the footer says ↵ sends to Lane atlas', /sends to Lane atlas/.test(footer), footer.slice(0, 260))
    check('the footer says esc interrupts Lane birch — the VIEWED crewmate, the one the key cuts', /esc interrupts? Lane birch/.test(footer) && !/esc interrupts? Lane atlas/.test(footer), footer.slice(0, 260))
    const status = statusRowOf(frame)
    console.log(`the status row: "${status}"`)
    check('the status row names the composer\'s target: atlas, the main chat — never "composer → Lane birch"', /Lane atlas/.test(status) && !/composer → Lane birch/.test(status), `the status row reads "${status}"`)
    const TO_PIN = 'to the pin'
    await typeWords(scene, TO_PIN)
    scene.push(ENTER)
    await waitForCall(() => resumes().filter(call => call.note === TO_PIN).length, 1)
    const sent = resumes().find(call => call.note === TO_PIN)
    check('↵ sends to the pinned crewmate (atlas), not the viewed one', sent !== undefined && sent.agentId === ATLAS.id, JSON.stringify(sent))
    const stopsBefore = stops().length
    scene.push(ESC)
    await sleep(400)
    check('esc interrupts the VIEWED crewmate (birch) alone', stops().length === stopsBefore + 1 && stops()[stops().length - 1]!.agentId === BIRCH.id, JSON.stringify(stops().slice(stopsBefore)))
    check('the interrupt receipt names birch', scene.lines().some(line => line.includes(`${BIRCH.name} interrupted`)), footerOf(scene.lines()).replace(/\s+/g, ' ').slice(0, 200))
  }

  section(`§4 ${tag('the pin on atlas with Mercury Lead in the view: the footer promises only what esc does; an empty ↵ sends nothing')}`)
  {
    const click = await clickRail(scene, LEAD_ROW, railCols, () => scene.state().viewingAgentTaskId === undefined)
    await sleep(300)
    const frame = scene.lines()
    save('04-pinned-atlas-lead-view', cols, rows, frame)
    check('the lead\'s chat is the view while atlas stays pinned', click.row >= 0 && click.landed && scene.state().viewingAgentTaskId === undefined && scene.state().mainChatTaskId === ATLAS.id, `row ${click.row} · viewing=${String(scene.state().viewingAgentTaskId)} pinned=${String(scene.state().mainChatTaskId)} · the rail rows read: ${click.rows.map(line => line.trim()).join(' ↵ ')}`)
    const footer = footerOf(frame).replace(/\s+/g, ' ')
    check('the footer says ↵ sends to Lane atlas · m on Mercury Lead returns the main chat', /sends to Lane atlas/.test(footer) && /m on Mercury Lead returns the main chat/.test(footer), footer.slice(0, 260))
    check('the footer does NOT say esc interrupts Lane atlas — esc on the lead\'s screen is the lead\'s own interrupt', !/esc interrupts? Lane atlas/.test(footer), footer.slice(0, 260))
    const status = statusRowOf(frame)
    console.log(`the status row: "${status}"`)
    check('the status row says main chat: Lane atlas · Mercury Lead waits in the rail', /main chat: Lane atlas/.test(status) && /Mercury Lead waits in the rail/.test(status), `the status row reads "${status}"`)
    const stopsBefore = stops().length
    scene.push(ESC)
    await sleep(400)
    check('esc on the lead\'s screen stops no crewmate', stops().length === stopsBefore, JSON.stringify(stops().slice(stopsBefore)))
    scene.setState(prev => ({ ...prev, promptSuggestion: { text: SUGGESTION, promptId: 'p-1', shownAt: Date.now() - 5000, acceptedAt: 0, generationRequestId: null } }))
    await sleep(300)
    const resumesBefore = resumes().length
    scene.push(ENTER)
    await sleep(700)
    const leaked = resumes().slice(resumesBefore)
    check('an empty ↵ with the lead\'s prompt suggestion on record sends nothing to the pinned crewmate', leaked.length === 0 && !submits.includes(SUGGESTION), `resume calls ${JSON.stringify(leaked)} · submits ${JSON.stringify(submits)}`)
    scene.setState(prev => ({ ...prev, promptSuggestion: { text: null, promptId: null, shownAt: 0, acceptedAt: 0, generationRequestId: null } }))
    crewmateView.clearMainChat(scene.setState as never)
    await sleep(300)
    check('m on Mercury Lead hands the main chat back (the pin is gone)', scene.state().mainChatTaskId === undefined)
  }

  section(`§5 ${tag('esc on a crewmate that is not running: no stop sent, the view goes back to Mercury Lead')}`)
  {
    crewmateView.enterCrewmateView(CEDAR.id, scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === CEDAR.id, 4000)
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes('CEDAR-ROW')), 6000)
    await sleep(300)
    check('cedar (completed on the roster, opened from the crew pop-up\'s road) is viewed', scene.state().viewingAgentTaskId === CEDAR.id && headerOf(scene.lines(), railCols).includes(CEDAR.name), `viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)} · header ${headerOf(scene.lines(), railCols)}`)
    const idleFooter = footerOf(scene.lines()).replace(/\s+/g, ' ')
    check('the footer on the landed crewmate says esc goes back to Mercury Lead, never esc interrupts Lane cedar', /esc[^·]*back[^·]*Mercury Lead/.test(idleFooter) && !/esc interrupts? Lane cedar/.test(idleFooter), idleFooter.slice(0, 260))
    check('the footer says ↵ resumes Lane cedar with your line (the runner resumes a landed hosted crewmate from its transcript), never "↵ sends to Lane cedar"', /↵ resumes Lane cedar with your line/.test(idleFooter) && !/↵ sends to Lane cedar/.test(idleFooter), idleFooter.slice(0, 260))
    const stopsBefore = stops().length
    scene.push(ESC)
    await sleep(500)
    save('05-idle-crewmate-esc', cols, rows, scene.lines())
    const words = footerOf(scene.lines()).replace(/\s+/g, ' ')
    check('esc on the idle crewmate sends no stop to the runner', stops().length === stopsBefore, JSON.stringify(stops().slice(stopsBefore)))
    check('esc on the crewmate that is not running goes back to Mercury Lead', scene.state().viewingAgentTaskId === undefined && centreOf(scene.lines(), railCols).some(line => line.includes('LEAD-ROW')), `viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)}`)
    check('the composer says cedar is landed and the view is back on Mercury Lead (never "interrupted — its turn is cut")', scene.lines().some(line => line.includes(`${CEDAR.name} is landed`) && line.includes(LEAD_ROW)) && !scene.lines().some(line => line.includes(`${CEDAR.name} interrupted`)), words.slice(0, 260))
  }

  section(`§6 ${tag('the local road: a line to an idle local agent is refused and kept; a line to a running one paints once when its delivery lands')}`)
  {
    const base = {
      ...createTaskStateBase(LOCAL_ID, 'local_agent', LOCAL_NAME),
      type: 'local_agent' as const,
      agentId: LOCAL_ID,
      prompt: 'work quietly',
      agentType: 'mercury-crew',
      isBackgrounded: true,
      messages: [],
    }
    const file = getAgentTranscriptPath(asAgentId(LOCAL_ID))
    rmSync(file, { force: true })
    scene.setState(prev => ({ ...prev, tasks: { ...(prev.tasks as Record<string, unknown>), [LOCAL_ID]: { ...base, status: 'completed' } } }))
    await sleep(200)
    crewmateView.enterCrewmateView(LOCAL_ID, scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === LOCAL_ID, 4000)
    await sleep(400)
    const IDLE_LINE = 'to the idle local'
    const idleLocalFooter = footerOf(scene.lines()).replace(/\s+/g, ' ')
    check('the footer on a landed LOCAL crewmate says ↵ is refused and names the resume door (r in /crewmates), never "↵ sends to Lane local"', /↵ refused — r in \/crewmates resumes Lane local/.test(idleLocalFooter) && !/↵ sends to Lane local/.test(idleLocalFooter), idleLocalFooter.slice(0, 260))
    await typeWords(scene, IDLE_LINE)
    scene.push(ENTER)
    await sleep(700)
    save('06-idle-local-send', cols, rows, scene.lines())
    const idleTask = (scene.state().tasks as Record<string, { operatorMessages?: string[] }>)[LOCAL_ID]
    check('a line to a local agent between turns is not queued into a lane nobody drains', (idleTask?.operatorMessages ?? []).length === 0, `operatorMessages=${JSON.stringify(idleTask?.operatorMessages)}`)
    check('the line stays in the composer and the receipt says the crewmate is between turns', pending.text() === IDLE_LINE && scene.lines().some(line => line.includes('between turns') || line.includes('did not take the message')), `composer text ${JSON.stringify(pending.text())} · ${footerOf(scene.lines()).replace(/\s+/g, ' ').slice(0, 200)}`)
    pending.edit('')
    await sleep(150)
    scene.setState(prev => ({ ...prev, tasks: { ...(prev.tasks as Record<string, unknown>), [LOCAL_ID]: { ...(prev.tasks as Record<string, Record<string, unknown>>)[LOCAL_ID], status: 'running', operatorMessages: [], messages: [] } } }))
    await sleep(300)
    await typeWords(scene, LOCAL_LINE)
    scene.push(ENTER)
    await sleep(600)
    const runningTask = (scene.state().tasks as Record<string, { operatorMessages?: string[] }>)[LOCAL_ID]
    check('a line to a RUNNING local agent rides the operator lane once', JSON.stringify(runningTask?.operatorMessages) === JSON.stringify([LOCAL_LINE]), JSON.stringify(runningTask?.operatorMessages))
    const plated = (): string[] => centreOf(scene.lines(), railCols).filter(line => line.includes(LOCAL_LINE))
    check('the queued line paints at once in the crewmate\'s transcript with the operator\'s plate', plated().length === 1 && plated()[0]!.includes(`[you → ${LOCAL_NAME}]`), plated().join(' | ').slice(0, 200))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, encodeSeedTranscript([userRow(LOCAL_ID, 0, 'local — work quietly'), assistantRow(LOCAL_ID, 1, 'LOCAL-ROW 1 — working.'), userRow(LOCAL_ID, 2, LOCAL_LINE)] as never, SESSION_ID))
    pokeRoster()
    await until(() => centreOf(scene.lines(), railCols).some(line => line.includes('LOCAL-ROW 1')), 6000)
    await sleep(400)
    save('06-local-delivered', cols, rows, scene.lines())
    console.log(`the crewmate's rows carrying the line: ${plated().map(line => line.trim().slice(0, 80)).join(' | ')}`)
    check('once the delivery lands on disk the line paints exactly once (the landed row, never a second copy from the live tail)', plated().length === 1, `${plated().length} rows carry the line`)
    crewmateView.exitCrewmateView(scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === undefined, 4000)
  }

  section(`§7 ${tag('a bang command belongs to the lead shell, never to the composer target')}`)
  for (const entry of [
    { label: 'viewed crewmate, bang line', viewed: ATLAS.id, pinned: undefined, input: 'line' },
    { label: 'pinned crewmate with another viewed, pasted bang', viewed: BIRCH.id, pinned: ATLAS.id, input: 'paste' },
    { label: 'pinned local crewmate, bash mode', viewed: LOCAL_ID, pinned: LOCAL_ID, input: 'mode' },
  ] as const) {
    pending.edit('')
    pending.setMode('prompt')
    crewmateView.clearMainChat(scene.setState as never)
    crewmateView.enterCrewmateView(entry.viewed, scene.setState as never)
    if (entry.pinned !== undefined) crewmateView.setMainChat(entry.pinned, scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === entry.viewed, 4000)
    await sleep(400)
    const targetBefore = composerTargetTaskId(scene.state() as never)
    const tasksBefore = JSON.stringify(scene.state().tasks)
    const files = [
      join(getProjectDir(CWD), SESSION_ID, 'subagents', `agent-${ATLAS.id}.jsonl`),
      join(getProjectDir(CWD), SESSION_ID, 'subagents', `agent-${BIRCH.id}.jsonl`),
      getAgentTranscriptPath(asAgentId(LOCAL_ID)),
    ]
    const transcriptsBefore = files.map(file => readFileSync(file, 'utf8'))
    const resumesBefore = resumes().length
    const submitsBefore = submits.length
    const resultsBefore = shellResults.length
    if (entry.input !== 'mode') {
      scene.push(entry.input === 'paste' ? '\x1b[200~! echo hi\x1b[201~' : '! echo hi')
      await until(() => pending.mode() === 'bash' && pending.text().trim() === 'echo hi', 4000)
    } else {
      pending.setMode('bash')
      await sleep(150)
      await typeWords(scene, 'echo hi')
    }
    await sleep(250)
    check(`${entry.label}: the bang entry is shell mode before Enter`, pending.mode() === 'bash' && pending.text().trim() === 'echo hi', `mode=${pending.mode()} text=${JSON.stringify(pending.text())}`)
    scene.push(ENTER)
    await until(() => shellResults.length > resultsBefore || resumes().length > resumesBefore || JSON.stringify(scene.state().tasks) !== tasksBefore, 6000)
    await sleep(250)
    const leaked = resumes().slice(resumesBefore)
    const crewRows = centreOf(scene.lines(), railCols).filter(line => line.includes('echo hi'))
    console.log(`${entry.label}: crewmate delivery=${JSON.stringify(leaked.map(({ agentId, note }) => ({ agentId, note })))}; crewmate rows=${JSON.stringify(crewRows.map(line => line.trim()))}`)
    check(`${entry.label}: the send took the lead road exactly once, not the crewmate road`, submits.length === submitsBefore + 1 && submits.at(-1)?.trim() === 'echo hi' && leaked.length === 0, `lead=${JSON.stringify(submits.slice(submitsBefore))} crewmate=${JSON.stringify(leaked)}`)
    const result = shellResults[resultsBefore]
    const shellRows = result?.messages.flatMap(message => message.type === 'user' && typeof message.message.content === 'string' ? [message.message.content] : []) ?? []
    console.log(`${entry.label}: lead shell rows=${JSON.stringify(shellRows)}`)
    check(`${entry.label}: the real shell printed hi and exited zero without querying a model`, result?.shouldQuery === false && shellRows.includes('<bash-input>echo hi</bash-input>') && shellRows.some(row => row.startsWith('<bash-stdout>hi</bash-stdout>') && row.includes('<bash-exit-code>0</bash-exit-code>')), JSON.stringify(shellRows))
    check(`${entry.label}: the crewmates' transcripts and queues are untouched`, crewRows.length === 0 && JSON.stringify(scene.state().tasks) === tasksBefore && files.every((file, index) => readFileSync(file, 'utf8') === transcriptsBefore[index]), crewRows.join(' | '))
    check(`${entry.label}: the viewed crewmate and pinned target are unchanged`, scene.state().viewingAgentTaskId === entry.viewed && scene.state().mainChatTaskId === entry.pinned && composerTargetTaskId(scene.state() as never) === targetBefore, `viewed=${String(scene.state().viewingAgentTaskId)} pinned=${String(scene.state().mainChatTaskId)}`)
    check(`${entry.label}: the sent shell line has left the composer`, pending.text() === '', JSON.stringify(pending.text()))
    save(`07-${entry.input}-crewmate`, cols, rows, scene.lines())
    crewmateView.exitCrewmateView(scene.setState as never)
    await until(() => scene.state().viewingAgentTaskId === undefined, 4000)
    await sleep(400)
    const lead = centreOf(scene.lines(), railCols)
    const bangRows = lead.filter(line => line.includes('! echo hi'))
    check(`${entry.label}: the bang row paints in the lead transcript, never under an operator-to-crewmate plate`, result !== undefined && bangRows.length === shellResults.length && bangRows.every(line => !line.includes('[you →')) && lead.some(line => /└\s+hi\s*│?$/.test(line)) && lead.some(line => line.includes('exit 0')), bangRows.map(line => line.trim()).join(' | '))
    save(`07-${entry.input}-lead`, cols, rows, scene.lines())
  }
  crewmateView.clearMainChat(scene.setState as never)

  await scene.close()
}

for (const [cols, rows] of SIZES) await run(cols, rows)

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\ncrew-composer-roads: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
