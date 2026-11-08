#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crew-view-commands-'))
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
process.env.MERCURY_CHANNEL_ROOM = `crew-view-commands-${process.pid}`
process.env.FORCE_COLOR = '3'
delete process.env.MERCURY_RECESS
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.BROWSER = '/usr/bin/true'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

const SESSION_ID = 'lead-session'
const LEAD_ROW = 'Mercury Lead'
const ESC = '\x1b'
const ENTER = '\r'
const FOCUS_IN = '\x1b[I'

const CREW_MODEL = 'claude-fable-5-1'
const ATLAS = { id: 'a-atlas', name: 'Lane atlas', tokens: 171_700 }
const CEDAR = { id: 'a-cedar', name: 'Lane cedar', tokens: 152_700 }
const LOCAL_ID = 'a-local'
const LOCAL_NAME = 'Lane local'
const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-4-6'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const sizeArg = arg('--size')
const SIZES: Array<[number, number]> = sizeArg === undefined ? [[269, 70], [178, 51]] : [sizeArg.split('x').map(Number) as [number, number]]
const WIDE_ENOUGH_FOR_THE_WHOLE_ROW = 240

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
const hardLimit = setTimeout(() => { console.error('crew-view-commands exceeded its deadline'); process.exit(1) }, 300_000)
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
  model: CREW_MODEL,
  agentType: 'mercury-crew',
  effort: 'high',
  inputTokens: facts.tokens,
  outputTokens: 2_400,
  totalTokens: facts.tokens + 2_400,
  contextTokens: facts.tokens,
  costUSD: 0.42,
  toolUses: 7,
  ...(status === 'running' ? { phase: { phase: 'reasoning' as const, sinceMs: NOW - 27_000 } } : {}),
})
const roster = { rows: [lane(ATLAS, 0), lane(CEDAR, 1, 'completed')], mission: [], samples: [], reported: true }
const workListeners = new Set<() => void>()
type SeatCall = { verb: string; args: unknown[] }
const seatCalls: SeatCall[] = []
const callsOf = (verb: string): SeatCall[] => seatCalls.filter(call => call.verb === verb)

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
const { builtinCommands, isCommandEnabled } = await import('../../src/commands.ts')
const { isSettingsPopupOpen, settingsPopupRequest } = await import('../../src/utils/cockpit/settingsPopup.ts')
const { getInitialSettings } = await import('../../src/utils/settings/settings.ts')
const { REFOCUS_CLICK_WINDOW_MS } = await import('../../src/ink/components/App.tsx')
const CLOCK_SLEW_MS = 50
const h = React.createElement

const resting = noSessionConnector() as unknown as Record<string, unknown>
const tailStore = createStreamingTailStore()
const WORKSPACE = join(HOME, 'mercury')
mkdirSync(join(WORKSPACE, '.git'), { recursive: true })
writeFileSync(join(WORKSPACE, '.git', 'HEAD'), 'ref: refs/heads/main\n')
const MAIN_MODEL = 'claude-opus-5-5'
const mainFacts = { effective: MAIN_MODEL, effectiveSource: 'live' as const, main: MAIN_MODEL, setting: null, sessionPin: null, effort: 'high', effortSent: 'high', pendingSwitch: null }
const overrides: Record<string, unknown> = {
  workspace: () => ({ cwd: WORKSPACE, originalCwd: WORKSPACE, projectRoot: WORKSPACE }),
  sessionId: () => SESSION_ID,
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { workListeners.add(listener); return () => { workListeners.delete(listener) } },
  stopAgent: async (agentId: string, note?: string) => { seatCalls.push({ verb: 'stop', args: [agentId, note] }); return { outcome: 'applied' } },
  resumeAgent: async (agentId: string, note?: string) => { seatCalls.push({ verb: 'resume', args: [agentId, note] }); return { outcome: 'applied', detail: '{"queued":true}' } },
  sendWords: async (text: string) => { seatCalls.push({ verb: 'sendWords', args: [text] }); return { state: 'accepted' } },
  dispatchSlash: async (line: string) => { seatCalls.push({ verb: 'dispatchSlash', args: [line] }); return { state: 'accepted' } },
  setModel: async (setting: unknown) => { seatCalls.push({ verb: 'setModel', args: [setting] }); return { state: 'applied' } },
  setEffort: async (level: string) => { seatCalls.push({ verb: 'setEffort', args: [level] }); return { state: 'applied' } },
  modelFacts: () => mainFacts,
  interrupt: () => false,
  live: () => IDLE_LIVE,
  subscribeLive: () => () => {},
  tail: () => tailStore,
  status: () => ({ title: 'the lead', projectLabel: 'proof', interrupting: false, hardStopping: false, wait: null, quietMs: null, watchdogMs: null, phaseMs: null, toolBudgetMs: null, stuck: false }),
}
const fake = new Proxy(resting, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
})
setFocusedSessionConnector(fake as never)
const CWD = WORKSPACE

const uuidOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const stampOf = (n: number): string => new Date(NOW - 300_000 + n * 1000).toISOString()
function seedRow(agentId: string, n: number, extra: Record<string, unknown>): Record<string, unknown> {
  return { isSidechain: true, agentId, entrypoint: 'cli', cwd: process.cwd(), sessionId: SESSION_ID, version: '1.0.0', gitBranch: 'main', parentUuid: n === 0 ? null : uuidOf(n - 1), uuid: uuidOf(n), timestamp: stampOf(n), ...extra }
}
const userRow = (agentId: string, n: number, text: string): Record<string, unknown> => seedRow(agentId, n, { type: 'user', message: { role: 'user', content: text } })
const assistantRow = (agentId: string, n: number, text: string): Record<string, unknown> => seedRow(agentId, n, { type: 'assistant', message: { id: `msg_${agentId}_${n}`, type: 'message', role: 'assistant', model: CREW_MODEL, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
const hostedDir = join(getProjectDir(CWD), SESSION_ID, 'subagents')
function seedHosted(agentId: string, rows: Record<string, unknown>[]): string {
  const file = join(hostedDir, `agent-${agentId}.jsonl`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, encodeSeedTranscript(rows as never, SESSION_ID))
  return file
}
seedHosted(ATLAS.id, [userRow(ATLAS.id, 0, 'atlas — the picker pop-up'), assistantRow(ATLAS.id, 1, 'ATLAS-ROW 1 — the seam is the session mount.')])
seedHosted(CEDAR.id, [userRow(CEDAR.id, 0, 'cedar — the jump pill'), assistantRow(CEDAR.id, 1, 'CEDAR-ROW 1 — done, the pill shrinks.')])
const hostedRecord = (agentId: string): string => join(hostedDir, `agent-${agentId}.meta.json`)
writeFileSync(hostedRecord(ATLAS.id), JSON.stringify({ agentType: 'mercury-crew', model: CREW_MODEL, effort: 'high' }))
const localTranscript = getAgentTranscriptPath(asAgentId(LOCAL_ID))
mkdirSync(dirname(localTranscript), { recursive: true })
writeFileSync(localTranscript, encodeSeedTranscript([userRow(LOCAL_ID, 0, 'local — work quietly'), assistantRow(LOCAL_ID, 1, 'LOCAL-ROW 1 — working.')] as never, SESSION_ID))
const localRecord = localTranscript.replace(/\.jsonl$/, '.meta.json')
rmSync(localRecord, { force: true })
const readRecord = (file: string): Record<string, unknown> | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null)

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
const commands = builtinCommands().filter(command => {
  try {
    return isCommandEnabled(command)
  } catch {
    return false
  }
})

function Transcript(): React.ReactNode {
  const rows: string[] = []
  for (let index = 0; index < 40; index++) rows.push(`14:49:${String(20 + index).padStart(2, '0')} [Mercury] LEAD-ROW ${index} — a row of the lead's transcript`)
  return h(Box, { flexDirection: 'column' }, h(Text, null, rows.join('\n')))
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
      scrollable: h(TranscriptSwap, { lead: h(Transcript), tools: [], commands, screen: 'prompt', scrollRef, agentDefinitions: { activeAgents: [], allAgents: [] }, trackStickyPrompt: true }),
      statusBand: h(Text, null, 'waiting on 1 crewmate'),
      statusBandActive: true,
      modalScrollRef,
      bottom: h(Box, { flexDirection: 'column' },
        h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands, agents: [],
          isLoading: false, verbose: false, submitCount: 1, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async (text: string) => {
            submits.push(text)
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
  check('the input reader took the focus-in', focusTaken, `${stdin.readableLength} bytes still queued on stdin`)
  await until(() => Date.now() - focusedAt > REFOCUS_CLICK_WINDOW_MS + CLOCK_SLEW_MS, (REFOCUS_CLICK_WINDOW_MS + CLOCK_SLEW_MS) * 4)
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

const screenWords = (scene: Scene): string => scene.lines().map(line => line.trim()).join(' ').replace(/\s+/g, ' ')
const packedWords = (scene: Scene): string => scene.lines().join('').replace(/\s+/g, '')
const statusRowOf = (scene: Scene): string => (scene.lines().find(line => /viewing Lane|composer → | ready/.test(line) && !/^│?[❯›]/.test(line)) ?? '').trim()
let frameTag = ''
const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${frameTag}.txt`), `${lines.join('\n')}\n`)
}
async function typeWords(scene: Scene, words: string): Promise<void> {
  for (const ch of words) { scene.push(ch); await sleep(20) }
  await until(() => pending.text().endsWith(words), 4000)
  await sleep(150)
}
async function clearNotices(scene: Scene): Promise<void> {
  scene.setState(prev => ({ ...prev, notifications: { current: null, queue: [] } }))
  await sleep(150)
}
async function command(scene: Scene, line: string, landed: () => boolean, ms = 6000): Promise<boolean> {
  await clearNotices(scene)
  pending.edit('')
  await sleep(100)
  await typeWords(scene, line)
  scene.push(ENTER)
  const ok = await until(landed, ms)
  await sleep(250)
  return ok
}
async function view(scene: Scene, taskId: string, marker: string): Promise<void> {
  crewmateView.enterCrewmateView(taskId, scene.setState as never)
  await until(() => scene.state().viewingAgentTaskId === taskId, 4000)
  await until(() => screenWords(scene).includes(marker), 6000)
  await sleep(300)
}
async function leave(scene: Scene): Promise<void> {
  crewmateView.exitCrewmateView(scene.setState as never)
  await until(() => scene.state().viewingAgentTaskId === undefined, 4000)
  await sleep(300)
}
const mainSeatUntouched = (scene: Scene, label: string, submitsBefore: number): void => {
  const state = scene.state()
  const seatVerbs = seatCalls.filter(call => call.verb === 'setModel' || call.verb === 'setEffort' || call.verb === 'sendWords' || call.verb === 'dispatchSlash')
  check(`${label}: the main seat is untouched — no connector model, effort or words verb, no session submit, no pending switch, the session model override as it was`, seatVerbs.length === 0 && submits.length === submitsBefore && state.pendingModelSwitch === null && state.engineModelForSession === null, `verbs=${JSON.stringify(seatVerbs)} submits=${JSON.stringify(submits.slice(submitsBefore))} pending=${JSON.stringify(state.pendingModelSwitch)} override=${String(state.engineModelForSession)}`)
}

function resetRecords(): void {
  writeFileSync(hostedRecord(ATLAS.id), JSON.stringify({ agentType: 'mercury-crew', model: CREW_MODEL, effort: 'high' }))
  rmSync(hostedRecord(CEDAR.id), { force: true })
  rmSync(localRecord, { force: true })
}

async function drive(COLS: number, ROWS: number): Promise<void> {
section(`════ ${COLS}x${ROWS} ════`)
frameTag = `${COLS}x${ROWS}`
resetRecords()
const scene = await mount(COLS, ROWS)
const settingsBefore = JSON.stringify(getInitialSettings().engine ?? {})
const effortBefore = scene.state().effortValue

section('§1 a running hosted crewmate in the view: the per-agent commands act on it, the main seat stays')
{
  await view(scene, ATLAS.id, 'ATLAS-ROW')
  const status = statusRowOf(scene)
  const statusLine = scene.lines().find(line => line.includes('composer → Lane atlas')) ?? ''
  check('the status row says the composer goes to the crewmate and stays within its width', /viewing Lane atlas · composer → Lane atlas/.test(status) && [...statusLine].length <= COLS, `${status} (${[...statusLine].length} cells)`)
  if (COLS >= WIDE_ENOUGH_FOR_THE_WHOLE_ROW) check('the status row says the commands go to the crewmate too (the row has the room here)', /composer → Lane atlas · commands → Lane atlas · 1 crewmate running/.test(status), status)
  let submitsBefore = submits.length
  const landed = await command(scene, `/model ${HAIKU}`, () => readRecord(hostedRecord(ATLAS.id))?.model === HAIKU)
  save('01-model-at-atlas', scene.lines())
  check(`(a) /model ${HAIKU} at the selected running crewmate records the model on its own record, for its next turn`, landed && readRecord(hostedRecord(ATLAS.id))?.model === HAIKU, JSON.stringify(readRecord(hostedRecord(ATLAS.id))))
  check("(a) the receipt names the crewmate and says it switches at its next turn", screenWords(scene).includes('Lane atlas switches to Haiku 5.5 at its next turn'), screenWords(scene).slice(-400))
  mainSeatUntouched(scene, '(a)', submitsBefore)
  check('(a) the composer is empty after the command', pending.text() === '', JSON.stringify(pending.text()))

  submitsBefore = submits.length
  const opened = await command(scene, '/model', () => isSettingsPopupOpen() && settingsPopupRequest()?.view === 'model')
  await sleep(600)
  save('01-model-picker-at-atlas', scene.lines())
  const words = screenWords(scene)
  check('(a) /model with no argument opens the picker for the crewmate — its line names the crewmate and the next-turn rule', opened && words.includes('Lane atlas — a pick switches it at its next turn'), words.slice(0, 600))
  check('(a) the picker shows the crewmate\'s recorded model as its current row', scene.lines().some(line => /Haiku 5\.5\s+claude-haiku-5-5\s+current/.test(line)), scene.lines().filter(line => line.includes('current')).join(' | ').slice(0, 400))
  scene.push(ESC)
  const closed = await until(() => !isSettingsPopupOpen(), 4000)
  await sleep(300)
  check('(a) esc closes the picker and the receipt says the crewmate stays on its model', closed && screenWords(scene).includes('Lane atlas stays on Haiku 5.5'), screenWords(scene).slice(-300))
  mainSeatUntouched(scene, '(a, picker)', submitsBefore)

  submitsBefore = submits.length
  const effortLanded = await command(scene, '/effort low', () => readRecord(hostedRecord(ATLAS.id))?.effortOverride === 'low')
  save('01-effort-at-atlas', scene.lines())
  const record = readRecord(hostedRecord(ATLAS.id))
  check('(b) /effort low at the selected crewmate records low on its own record and keeps the model it had', effortLanded && record?.effortOverride === 'low' && record.effort === 'low' && record.model === HAIKU, JSON.stringify(record))
  check('(b) the receipt says the crewmate runs low from its next turn', screenWords(scene).includes('Lane atlas runs low from its next turn'), screenWords(scene).slice(-300))
  check("(b) the user's saved effort and the main seat's effort value did not move", JSON.stringify(getInitialSettings().engine ?? {}) === settingsBefore && scene.state().effortValue === effortBefore, `${JSON.stringify(getInitialSettings().engine)} · ${String(scene.state().effortValue)}`)
  mainSeatUntouched(scene, '(b)', submitsBefore)

  await command(scene, '/effort', () => screenWords(scene).includes('Lane atlas runs low on'))
  check('(b) /effort alone reads the crewmate\'s effort and names the levels its model takes', screenWords(scene).includes('Lane atlas runs low on Haiku 5.5') && screenWords(scene).includes('/effort '), screenWords(scene).slice(-300))

  submitsBefore = submits.length
  const compactLanded = await command(scene, '/compact', () => readRecord(hostedRecord(ATLAS.id))?.compactOnResume === true)
  save('01-compact-at-atlas', scene.lines())
  check('(c) /compact at the selected hosted crewmate records the compaction on its record (its runner reads it before its next turn) and never reaches the main seat', compactLanded && readRecord(hostedRecord(ATLAS.id))?.compactOnResume === true, JSON.stringify(readRecord(hostedRecord(ATLAS.id))))
  check('(c) the receipt says whose transcript compacts and when', screenWords(scene).includes('Lane atlas compacts when it resumes'), screenWords(scene).slice(-300))
  mainSeatUntouched(scene, '(c)', submitsBefore)

  submitsBefore = submits.length
  await command(scene, '/context', () => screenWords(scene).includes('Lane atlas · '))
  save('01-context-at-atlas', scene.lines())
  check("(d) /context shows the crewmate's numbers: its context tokens of its model's window", /Lane atlas · Fable 5\.1 · context 171\.7k of \S+ \(\d+%\)/.test(screenWords(scene)), screenWords(scene).slice(-300))
  mainSeatUntouched(scene, '(d, context)', submitsBefore)
  await command(scene, '/usage', () => screenWords(scene).includes('171.7k in'))
  save('01-usage-at-atlas', scene.lines())
  check("(d) /usage shows the crewmate's spend: tokens in and out, cost and tool uses", /Laneatlas·Fable5\.1·171\.7kin·2\.4kout·\$0\.4200·7tooluses·/.test(packedWords(scene)), screenWords(scene).slice(-300))
  mainSeatUntouched(scene, '(d, usage)', submitsBefore)

  submitsBefore = submits.length
  const helpRan = await command(scene, '/help', () => submits.length > submitsBefore)
  save('01-help-at-atlas', scene.lines())
  check('(e) /help at a crewmate runs for the session as before', helpRan && submits[submits.length - 1] === '/help', JSON.stringify(submits.slice(submitsBefore)))
  check('(e) …and the receipt says it ran for this session, not the crewmate', screenWords(scene).includes('/help runs for this session, not Lane atlas'), screenWords(scene).slice(-300))
  const crewRan = await command(scene, '/crewmates', () => submits.length > submitsBefore + 1)
  check('(e) /crewmates at a crewmate runs for the session with the same line', crewRan && submits[submits.length - 1] === '/crewmates' && screenWords(scene).includes('/crewmates runs for this session, not Lane atlas'), `${JSON.stringify(submits.slice(submitsBefore))} · ${screenWords(scene).slice(-200)}`)
  check('(e) the global commands left the crewmate\'s record alone', JSON.stringify(readRecord(hostedRecord(ATLAS.id))) === JSON.stringify({ agentType: 'mercury-crew', model: HAIKU, effort: 'low', effortOverride: 'low', compactOnResume: true }), JSON.stringify(readRecord(hostedRecord(ATLAS.id))))
  await leave(scene)
}

section('§2 a finished hosted crewmate in the view: the same commands are recorded for its next resume')
{
  await view(scene, CEDAR.id, 'CEDAR-ROW')
  const submitsBefore = submits.length
  const landed = await command(scene, `/model ${SONNET}`, () => readRecord(hostedRecord(CEDAR.id))?.model === SONNET)
  save('02-model-at-cedar', scene.lines())
  check(`(a) /model ${SONNET} at a finished crewmate with no record yet writes one with its agent type and the model`, landed && readRecord(hostedRecord(CEDAR.id))?.model === SONNET && readRecord(hostedRecord(CEDAR.id))?.agentType === 'mercury-crew', JSON.stringify(readRecord(hostedRecord(CEDAR.id))))
  check("(a) the receipt says the model is recorded for the crewmate's next resume", screenWords(scene).includes("Sonnet 5.5 recorded for Lane cedar's next resume"), screenWords(scene).slice(-300))
  const effortLanded = await command(scene, '/effort max', () => readRecord(hostedRecord(CEDAR.id))?.effortOverride === 'max')
  check("(b) /effort max at a finished crewmate is recorded for its next resume", effortLanded && screenWords(scene).includes("effort max recorded for Lane cedar's next resume"), `${JSON.stringify(readRecord(hostedRecord(CEDAR.id)))} · ${screenWords(scene).slice(-200)}`)
  const compactLanded = await command(scene, '/compact', () => readRecord(hostedRecord(CEDAR.id))?.compactOnResume === true)
  check('(c) /compact at a finished crewmate is recorded for its next resume and says so', compactLanded && screenWords(scene).includes('Lane cedar compacts when it resumes'), screenWords(scene).slice(-300))
  mainSeatUntouched(scene, '§2', submitsBefore)
  check("the running crewmate's record did not move while the finished one was addressed", readRecord(hostedRecord(ATLAS.id))?.model === HAIKU, JSON.stringify(readRecord(hostedRecord(ATLAS.id))))
  await leave(scene)
}

section('§3 a running in-process crewmate: /compact flags its task for the next turn boundary; /model lands on its record')
{
  const base = {
    ...createTaskStateBase({ task_id: LOCAL_ID, task_type: 'local_agent', description: LOCAL_NAME }),
    type: 'local_agent' as const,
    agentId: LOCAL_ID,
    prompt: 'work quietly',
    agentType: 'mercury-crew',
    model: CREW_MODEL,
    isBackgrounded: true,
    messages: [],
  }
  scene.setState(prev => ({ ...prev, tasks: { ...(prev.tasks as Record<string, unknown>), [LOCAL_ID]: { ...base, status: 'running' } } }))
  await sleep(200)
  await view(scene, LOCAL_ID, 'LOCAL-ROW')
  const submitsBefore = submits.length
  const taskOf = (): Record<string, unknown> | undefined => (scene.state().tasks as Record<string, Record<string, unknown>>)[LOCAL_ID]
  const flagged = await command(scene, '/compact', () => taskOf()?.compactRequested === true)
  save('03-compact-at-local', scene.lines())
  check('(c) /compact at a running in-process crewmate flags its task — its own query compacts at the next turn boundary', flagged && taskOf()?.compactRequested === true, JSON.stringify(taskOf()?.compactRequested))
  check('(c) the receipt says the crewmate compacts at its next turn', screenWords(scene).includes('Lane local compacts at its next turn'), screenWords(scene).slice(-300))
  check('(c) the flag is the task\'s alone — its record on disk carries no compaction and the queued lanes are empty', readRecord(localRecord)?.compactOnResume === undefined && ((taskOf()?.operatorMessages as string[] | undefined) ?? []).length === 0, `${JSON.stringify(readRecord(localRecord))} · ${JSON.stringify(taskOf()?.operatorMessages)}`)
  const landed = await command(scene, `/model ${OPUS}`, () => readRecord(localRecord)?.model === OPUS)
  check(`(a) /model ${OPUS} at the running in-process crewmate records the model beside its transcript, for its next turn`, landed && readRecord(localRecord)?.model === OPUS && screenWords(scene).includes('Lane local switches to Opus 4.6 at its next turn'), `${JSON.stringify(readRecord(localRecord))} · ${screenWords(scene).slice(-200)}`)
  check('(a) the running task\'s own model is untouched until its next turn', taskOf()?.model === CREW_MODEL, String(taskOf()?.model))
  mainSeatUntouched(scene, '§3', submitsBefore)
  await leave(scene)
}

section('§4 esc back to Mercury Lead: the commands return to the main seat')
{
  check('the view is back on the lead', scene.state().viewingAgentTaskId === undefined && !/viewing Lane/.test(statusRowOf(scene)), statusRowOf(scene))
  const atlasBefore = JSON.stringify(readRecord(hostedRecord(ATLAS.id)))
  const cedarBefore = JSON.stringify(readRecord(hostedRecord(CEDAR.id)))
  const localBefore = JSON.stringify(readRecord(localRecord))
  const submitsBefore = submits.length
  const ran = await command(scene, `/model ${SONNET}`, () => submits.length > submitsBefore)
  save('04-model-at-lead', scene.lines())
  check(`(f) /model ${SONNET} on the lead's screen takes the session's own command road again`, ran && submits[submits.length - 1] === `/model ${SONNET}`, JSON.stringify(submits.slice(submitsBefore)))
  check('(f) no crewmate record moved', JSON.stringify(readRecord(hostedRecord(ATLAS.id))) === atlasBefore && JSON.stringify(readRecord(hostedRecord(CEDAR.id))) === cedarBefore && JSON.stringify(readRecord(localRecord)) === localBefore)
  check('(f) no "runs for this session, not" line on the lead\'s own screen', !screenWords(scene).includes('runs for this session, not'), screenWords(scene).slice(-300))
}

await scene.close()
}

for (const [cols, rows] of SIZES) await drive(cols, rows)

section("§5 the crewmate's own compaction: the flag on its task makes its query fold at the next request boundary, once")
{
  await stub('../../src/services/compact/compact.ts', () => ({
    compactConversation: async (messages: unknown[], context: { agentId?: string }, _cacheSafe: unknown, _suppress: boolean, _instructions: string | undefined, isAutoCompact: boolean) => {
      seatCalls.push({ verb: 'compactConversation', args: [messages.length, context.agentId] })
      const { createCompactBoundaryMessage } = await import('../../src/utils/messages/systemMessages.ts')
      return { boundaryMarker: createCompactBoundaryMessage(isAutoCompact ? 'auto' : 'manual', 1234), summaryMessages: [], attachments: [], hookResults: [], preCompactTokenCount: 1234, postCompactTokenCount: 10 }
    },
  }))
  await stub('../../src/services/compact/sessionMemoryCompact.ts', () => ({
    shouldUseSessionMemoryCompaction: () => false,
    trySessionMemoryCompaction: async () => null,
  }))
  const { autoCompactIfNeeded } = await import('../../src/services/compact/autoCompact.ts')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
  const tasks: Record<string, Record<string, unknown>> = {
    [LOCAL_ID]: { id: LOCAL_ID, type: 'local_agent', agentId: LOCAL_ID, status: 'running', compactRequested: true },
  }
  let appState: Record<string, unknown> = { tasks, toolPermissionContext: getDefaultAppState().toolPermissionContext }
  const setAppState = (updater: (prev: Record<string, unknown>) => Record<string, unknown>): void => {
    appState = updater(appState)
  }
  const context = {
    agentId: LOCAL_ID,
    getAppState: () => appState,
    setAppState,
    setAppStateForTasks: setAppState,
    abortController: new AbortController(),
    options: { engineModel: CREW_MODEL, isNonInteractiveSession: false, tools: [], mcpClients: [], commands: [] },
    readFileState: new Map(),
    messages: [],
  }
  const messages = [createUserMessage({ content: 'count to three' }), createAssistantMessage({ content: 'one' }), createUserMessage({ content: 'and then?' }), createAssistantMessage({ content: 'two' })]
  const cacheSafe = { systemPrompt: ['a crewmate'], userContext: {}, systemContext: {}, toolUseContext: context as never, forkContextMessages: messages }
  const folded = await autoCompactIfNeeded(messages as never, context as never, cacheSafe as never, 'agent:builtin:mercury-crew')
  const foldCalls = callsOf('compactConversation')
  check('the flagged crewmate\'s query folds at its next request boundary — the compaction ran on its own messages with its agent id, under the threshold', folded.wasCompacted === true && foldCalls.length === 1 && foldCalls[0]!.args[0] === messages.length && foldCalls[0]!.args[1] === LOCAL_ID, `${JSON.stringify({ wasCompacted: folded.wasCompacted, refusal: folded.refusal })} · ${JSON.stringify(foldCalls)}`)
  check('the fold is a manual one on the crewmate\'s record (the boundary says manual)', folded.compactionResult?.boundaryMarker.compactMetadata.trigger === 'manual', String(folded.compactionResult?.boundaryMarker.compactMetadata.trigger))
  check('the flag is taken as the fold begins — the task no longer asks', (appState.tasks as Record<string, Record<string, unknown>>)[LOCAL_ID]!.compactRequested === undefined, JSON.stringify((appState.tasks as Record<string, unknown>)[LOCAL_ID]))
  const again = await autoCompactIfNeeded(messages as never, context as never, cacheSafe as never, 'agent:builtin:mercury-crew')
  check('the next boundary folds nothing — one ask, one fold', again.wasCompacted === false && callsOf('compactConversation').length === 1, JSON.stringify({ wasCompacted: again.wasCompacted, refusal: again.refusal, calls: callsOf('compactConversation').length }))
  check("a crewmate whose task does not ask is left to the threshold", (await autoCompactIfNeeded(messages as never, { ...context, agentId: 'a-other' } as never, cacheSafe as never, 'agent:builtin:mercury-crew')).wasCompacted === false)
}

section("§6 the resume: a finished crewmate's recorded compaction reaches the task that runs its next turn")
{
  const { registerAsyncAgent } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
  const compactionRequestedOf = (task: unknown): boolean => (task as { compactRequested?: unknown } | undefined)?.compactRequested === true
  let appState: Record<string, unknown> = { tasks: {} }
  const setAppState = (updater: (prev: Record<string, unknown>) => Record<string, unknown>): void => {
    appState = updater(appState)
  }
  const registered = registerAsyncAgent({ agentId: 'a-resumed', description: 'Lane resumed', prompt: 'carry on', setAppState: setAppState as never, model: CREW_MODEL, compactRequested: true } as never)
  check('a task registered for a resume with the flag asks for the fold', compactionRequestedOf(registered) && compactionRequestedOf((appState.tasks as Record<string, unknown>)['a-resumed']))
  const plain = registerAsyncAgent({ agentId: 'a-plain', description: 'Lane plain', prompt: 'carry on', setAppState: setAppState as never, model: CREW_MODEL })
  check('a task registered without it does not', !compactionRequestedOf(plain))
  const resume = readFileSync(join(import.meta.dir, '..', '..', 'src', 'tools', 'AgentTool', 'resumeAgent.ts'), 'utf8')
  check("the resume reads the record's compactOnResume (and a running task's own flag) into the task it registers, and its metadata rewrite drops the flag", /const compactRequested = meta\?\.compactOnResume === true \|\| \(isLocalAgentTask\(previousTask\) && previousTask\.compactRequested === true\)/.test(resume) && /\.\.\.\(compactRequested \? \{ compactRequested: true \} : \{\}\),\n  \}\)/.test(resume) && !/compactOnResume: /.test(resume.slice(resume.indexOf('await writeAgentMetadata'))))
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\ncrew-view-commands: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
