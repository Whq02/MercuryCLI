#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock } from 'bun:test'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'agent-view-frames-'))
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
process.env.MERCURY_CHANNEL_ROOM = `agent-view-frames-${process.pid}`
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

const COLS = 269
const ROWS = 70
const SESSION_ID = 'lead-session'
const LEAD_ROW = 'Mercury Lead'
const CREW_TITLE = 'Mercury — crew'
const MAIN_CHAT_KEY = 'm main chat'
const FOCUS_IN = '\x1b[I'
const ESC = '\x1b'
const TAB = '\t'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const press = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M`
const release = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}m`

const LANES: Array<[string, number, string]> = [
  ['atlas', 171_700, 'the model picker in a session draws as a bottom sheet; it must be the floating pop-up the files menu uses'],
  ['birch', 173_800, 'the named drives say what they drive'],
  ['cedar', 152_700, 'the jump pill at the bottom of the transcript'],
  ['delta', 90_500, 'a forked sub-agent is told its own scratchpad folder'],
  ['ember', 137_100, 'the five deny sites compose through one refusal'],
  ['fjord', 154_200, "an Esc that waits for an operator's own failure hook up to that hook's timeout: a cut-specific budget"],
  ['grove', 163_000, 'the pause gate scopes to the run'],
  ['heron', 113_900, 'the estate walk reads native paths'],
  ['iris', 140_300, 'the picker look questions'],
  ['juniper', 187_400, 'a headless seat says which calls need an operator'],
  ['kestrel', 104_500, 'the turn after an abort must not stall'],
  ['lumen', 145_500, 'a parked ask with no client is denied at once'],
  ['marsh', 136_900, 'dictation as hold-to-talk on the space key'],
  ['nettle', 129_300, 'the generated bundled modules are recognised by name'],
  ['osprey', 66_700, 'the parity bus proof'],
]

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
const hardLimit = setTimeout(() => { console.error('agent-view-frames exceeded its deadline'); process.exit(1) }, 240_000)
hardLimit.unref()

const NOW = Date.now()
const rosterRows = LANES.map(([lane, context, brief], index) => ({
  id: `a-${lane}`,
  agentId: `a-${lane}`,
  kind: 'agent' as const,
  name: `Lane ${lane}`,
  status: 'running',
  startTime: NOW - 354_000 - index * 1000,
  description: `Lane ${lane} — ${brief}`,
  model: 'claude-fable-5-1',
  agentType: 'mercury-general',
  inputTokens: context,
  outputTokens: 2_400,
  totalTokens: context + 2_400,
  contextTokens: context,
  phase: { phase: 'reasoning' as const, sinceMs: NOW - 27_000 },
}))
const workListeners = new Set<() => void>()
const roster = { rows: rosterRows, mission: [], samples: [], reported: true }
const agentCalls: Array<{ verb: string; agentId: string; note?: string }> = []

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
const { resetHelmFocusForTest } = await import('../../src/utils/cockpit/helmFocus.ts')
const teammatesCommand = await import('../../src/commands/teammates/teammates.tsx')
const h = React.createElement

const resting = noSessionConnector() as unknown as Record<string, unknown>
const overrides: Record<string, unknown> = {
  sessionId: () => SESSION_ID,
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { workListeners.add(listener); return () => { workListeners.delete(listener) } },
  stopAgent: async (agentId: string) => { agentCalls.push({ verb: 'stop', agentId }); return { outcome: 'applied' } },
  resumeAgent: async (agentId: string, note?: string) => { agentCalls.push({ verb: 'resume', agentId, note }); return { outcome: 'applied', detail: '{"queued":true}' } },
}
const fake = new Proxy(resting, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
})
setFocusedSessionConnector(fake as never)

type Scene = { lines: () => string[]; push: (data: string) => void; state: () => Record<string, unknown>; submits: string[]; setModal: (node: React.ReactNode) => void; close: () => Promise<void> }

const stateRef = { current: null as null | { getState: () => unknown } }
const modalRef = { current: null as null | ((node: React.ReactNode) => void) }
const submits: string[] = []

const TRANSCRIPT_NEEDLE = 'TRANSCRIPT-ROW'
function Transcript(): React.ReactNode {
  const rows = ['14:49:11 [Mercury] ● ▪ Update records/LANE-VOICE-HOLD.md · +1/-1', '  └ Added 1 line, removed 1 line', '14:49:16 [Mercury] Brief re-trued. Now the correction batch and the log line.']
  for (let index = 0; index < 52; index++) rows.push(`14:49:${String(20 + index).padStart(2, '0')} [Mercury] ${TRANSCRIPT_NEEDLE} ${index} — a row of the lead's transcript under the crew window`)
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
  const [modal, setModal] = React.useState<React.ReactNode>(null)
  modalRef.current = setModal
  const insertRef = React.useRef<unknown>(null)
  const modalScrollRef = React.useRef(null)
  return h(KeybindingSetup, null,
    h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
    h(FullscreenLayout, {
      scrollable: h(Transcript),
      statusBand: h(Text, null, 'waiting on 15 agents · 1 shell'),
      statusBandActive: true,
      modal: modal === null ? undefined : h(Box, { width: '100%', flexDirection: 'column' }, modal),
      modalScrollRef,
      bottom: h(PromptInput, {
        compactWork: controls, compactFocus: focus,
        debug: false, ideSelection: undefined, toolPermissionContext: getDefaultAppState().toolPermissionContext,
        setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
        isLoading: false, verbose: false, submitCount: 1, onShowMessageSelector: () => {},
        mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
        onExit: () => {}, getToolUseContext: () => ({} as never),
        onSubmit: async (text: string) => { submits.push(text) },
        isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
        hasSuppressedDialogs: false, isLocalJSXCommandActive: modal !== null, insertTextRef: insertRef,
      } as never),
    } as never),
  )
}

async function mount(): Promise<Scene> {
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  resetHelmFocusForTest()
  pending.edit('')
  pending.setMode('prompt')
  const stdout = new Output()
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness)))
  const painted = await until(() => ink.lastFrameText() !== '' && stripAnsi(ink.lastFrameText()).includes('CREW'))
  check('the cockpit painted with the crew lane', painted, stripAnsi(ink.lastFrameText()).slice(0, 300))
  await sleep(400)
  return {
    lines: () => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n'),
    push: data => stdin.push(data),
    state: () => (stateRef.current?.getState() ?? {}) as Record<string, unknown>,
    submits,
    setModal: node => modalRef.current?.(node),
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}

const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${COLS}x${ROWS}.txt`), `${lines.join('\n')}\n`)
}
const cells = (line: string): string[] => Array.from(line)
const RAIL_COLS = 32
const railText = (line: string): string => cells(line).slice(0, RAIL_COLS).join('')
const railRow = (lines: string[], needle: string): number => lines.findIndex(line => railText(line).includes(needle))
const headerRow = (lines: string[]): string => (lines.find(line => /VIEW/.test(cells(line).slice(RAIL_COLS, COLS - RAIL_COLS).join(''))) ?? '').trim()
const centre = (line: string): string => cells(line).slice(RAIL_COLS, COLS - RAIL_COLS).join('')
const composerRow = (lines: string[]): number => lines.findIndex(line => /^│[❯›]/.test(line))

type Window = { top: number; bottom: number; left: number; right: number; width: number; height: number; rows: string[] }
function windowOf(lines: string[], title: string): Window | null {
  const titleRow = lines.findIndex(line => line.includes(title))
  if (titleRow < 0) return null
  const titleCells = cells(lines[titleRow]!)
  const titleAt = titleCells.join('').indexOf(title)
  let left = -1
  for (let x = titleAt; x >= 0; x--) {
    if (titleCells[x] === '│') { left = x; break }
  }
  if (left < 0) return null
  let top = -1
  for (let y = titleRow; y >= 0; y--) {
    if (cells(lines[y]!)[left] === '╭') { top = y; break }
  }
  if (top < 0) return null
  const right = cells(lines[top]!).indexOf('╮', left + 1)
  if (right < 0) return null
  let bottom = -1
  for (let y = top + 1; y < lines.length; y++) {
    if (cells(lines[y]!)[left] === '╰') { bottom = y; break }
  }
  if (bottom < 0) return null
  const rows = lines.slice(top, bottom + 1).map(line => cells(line).slice(left, right + 1).join(''))
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1, rows }
}
const describe = (window: Window | null): string => (window === null ? 'no closed window' : `left ${window.left} · top ${window.top} · width ${window.width} · height ${window.height} (rows ${window.top}..${window.bottom})`)

const scene = await mount()

section(`§1 screen 1 at ${COLS}x${ROWS}: Mercury Lead, the default`)
let frame = scene.lines()
save('screen-1-lead', frame)
const crewHeader = railRow(frame, 'CREW')
const leadRow = crewHeader >= 0 ? railText(frame[crewHeader + 1] ?? '').trim() : ''
console.log(`the CREW lane's first row: "${leadRow}"`)
check(`the lead's CREW row is first and reads "${LEAD_ROW}"`, crewHeader >= 0 && leadRow.includes(LEAD_ROW), `the row reads "${leadRow}"`)
check('the lead\'s row carries no verb (the mock: "✶ Mercury Lead" alone)', leadRow.includes(LEAD_ROW) && !/ · /.test(leadRow), `the row reads "${leadRow}"`)
check('the lead\'s row wears the view mark › while its chat is the view', /›/.test(leadRow), `the row reads "${leadRow}"`)
const pickerRow = railRow(frame, '171.7k')
check('the atlas lane is a CREW row (its context tokens name it)', pickerRow >= 0, frame.slice(crewHeader, crewHeader + 9).map(railText).join(' | '))
check('no crewmate is viewed at rest', scene.state().viewingAgentTaskId === undefined)
check('no main chat is pinned at rest', scene.state().mainChatTaskId === undefined, `mainChatTaskId=${String(scene.state().mainChatTaskId)}`)

section('§2 screen 2: a click on a CREW row opens that agent in the view')
scene.push(FOCUS_IN)
await sleep(300)
scene.push(press(8, pickerRow) + release(8, pickerRow))
await sleep(500)
frame = scene.lines()
save('screen-2-viewing', frame)
const viewedAfterClick = scene.state().viewingAgentTaskId
const rowAfterClick = railText(frame[pickerRow] ?? '').trim()
const banner = railText(frame[0] ?? '').trim()
console.log(`after one click: viewingAgentTaskId=${String(viewedAfterClick)} · the row reads "${rowAfterClick}" · the rail banner reads "${banner}" · submits=${JSON.stringify(scene.submits)}`)
check('one click on a CREW row opens that agent in the view (viewingAgentTaskId is the row\'s agent)', viewedAfterClick === 'a-atlas', `viewingAgentTaskId=${String(viewedAfterClick)} — the rail banner reads "${banner}"`)
check('the rail marks the viewed row ◉', /◉/.test(rowAfterClick), `the row reads "${rowAfterClick}"`)
check('the view mark › moved to the viewed row', /›/.test(rowAfterClick), `the row reads "${rowAfterClick}"`)
const leadRowViewing = railText(frame[crewHeader + 1] ?? '').trim()
check('Mercury Lead lost the view mark', leadRowViewing.includes(LEAD_ROW) && !/›/.test(leadRowViewing), `the lead's row reads "${leadRowViewing}"`)
const header2 = headerRow(frame)
console.log(`the view header: "${header2}"`)
check('the view header names the crewmate and says viewing', /VIEW · Lane atlas · viewing/.test(header2), `the header reads "${header2}"`)
const cardRows = frame.slice(2, 6).map(centre).join(' ')
check('the card carries the crewmate\'s facts (its name, its model)', cardRows.includes('Lane atlas') && cardRows.includes('claude-fable-5-1'), cardRows.trim().slice(0, 200))
check('the card names the keys: m main chat · esc back to Mercury Lead', cardRows.includes('m main chat') && cardRows.includes('esc back to Mercury Lead'), cardRows.trim().slice(0, 200))
const composer2 = composerRow(frame)
check('the composer stays on screen under the view', composer2 > 0, 'no composer row')
const footer2 = frame.slice(composer2, composer2 + 6).join('\n')
check('the footer says ↵ sends to the crewmate and esc goes back to Mercury Lead', /sends to Lane atlas/.test(footer2) && /esc back to Mercury Lead/.test(footer2), footer2.replace(/\s+/g, ' ').slice(0, 300))
check('the click dispatched no command (no /tasks board opened)', scene.submits.length === 0, `submits=${JSON.stringify(scene.submits)}`)
if (viewedAfterClick === undefined) {
  scene.push(press(8, pickerRow) + release(8, pickerRow))
  await sleep(500)
  console.log(`after a second click: viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)} · submits=${JSON.stringify(scene.submits)}`)
}
scene.push(ESC)
await sleep(400)
frame = scene.lines()
save('screen-2-back', frame)
check('esc goes back to Mercury Lead (no crewmate viewed)', scene.state().viewingAgentTaskId === undefined, `viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)}`)
check('the header reads the plain view again', /VIEW/.test(headerRow(frame)) && !/viewing/.test(headerRow(frame)), headerRow(frame))
check('the composer target went back to the lead (no main chat pinned)', scene.state().mainChatTaskId === undefined)

section('§3 screen 3: /teammates opens the crew view as a floating pop-up')
let done = 0
const element = await teammatesCommand.call(() => { done++ }, { messages: [], options: {} } as never, '')
if (element !== null && element !== undefined) scene.setModal(element)
const opened = await until(() => scene.lines().some(line => line.includes(CREW_TITLE)), 8000)
check('the crew view painted', opened, scene.lines().slice(-12).join(' | ').slice(0, 300))
await sleep(500)
frame = scene.lines()
save('screen-3-crew-popup', frame)
const crewWindow = windowOf(frame, CREW_TITLE)
console.log(`the crew window: ${describe(crewWindow)}`)
check('the crew view is one closed bordered window', crewWindow !== null)
if (crewWindow !== null) {
  check('the window floats inside the centre (its left edge is right of the lanes rail)', crewWindow.left > RAIL_COLS, `left ${crewWindow.left}`)
  check('the window is narrower than the centre (a pop-up, not a face)', crewWindow.width < COLS - 2 * RAIL_COLS - 4, `width ${crewWindow.width}`)
  check('the window hangs below the view header (not anchored to the terminal\'s bottom)', crewWindow.top > 1 && crewWindow.bottom < ROWS - 6, `rows ${crewWindow.top}..${crewWindow.bottom}`)
  const keyRow = crewWindow.rows.map(row => row.trim()).find(row => row.includes('esc close')) ?? ''
  console.log(`the crew view's key row: "${keyRow}"`)
  check(`the key row carries "${MAIN_CHAT_KEY}"`, keyRow.includes(MAIN_CHAT_KEY), `the key row reads "${keyRow}"`)
  check('the key row keeps x stop · p pause · n new named agent · esc close', /x x stop|x stop/.test(keyRow) && keyRow.includes('p pause') && keyRow.includes('n new named agent') && keyRow.includes('esc close'), keyRow)
  check('the rows are the crew\'s own (fifteen sub-agents, the count in the title)', crewWindow.rows.some(row => row.includes('15 running')) && crewWindow.rows.filter(row => row.includes('Lane ')).length === 15, crewWindow.rows.slice(1, 6).join(' | '))
  const bleed = crewWindow.rows.filter(row => row.includes(TRANSCRIPT_NEEDLE))
  check('the window is opaque: no transcript row shows through it', bleed.length === 0, bleed.slice(0, 2).join(' | '))
  check('the transcript still paints beside the window (the cockpit is dimmed, not blanked)', frame.some(line => line.includes(TRANSCRIPT_NEEDLE)), 'no transcript row on the frame')
}
check('the composer stays on screen around the pop-up', composerRow(frame) > 0, 'no composer row')
check('the lanes rail stays on screen beside the pop-up', railRow(frame, 'CREW') >= 0, 'no CREW lane')

section('§4 screen 4: m on a crewmate makes it the main chat')
for (let step = 0; step < 5; step++) {
  scene.push(DOWN)
  await sleep(40)
}
await sleep(200)
scene.push('m')
await sleep(600)
frame = scene.lines()
save('screen-4-main-chat', frame)
const pinned = scene.state().mainChatTaskId
console.log(`after m: mainChatTaskId=${String(pinned)} · viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)}`)
check('m pins the selected crewmate as the main chat (mainChatTaskId)', pinned === 'a-fjord', `mainChatTaskId=${String(pinned)}`)
check('m opens that crewmate in the view', scene.state().viewingAgentTaskId === 'a-fjord', `viewingAgentTaskId=${String(scene.state().viewingAgentTaskId)}`)
check('the pop-up closed on m', !frame.some(line => line.includes(CREW_TITLE)), 'the crew window still paints')
const starRow = railRow(frame, '★')
const starText = starRow >= 0 ? railText(frame[starRow]!).trim() : ''
console.log(`the ★ row: "${starText}"`)
check('the rail marks the main chat row ★', starRow >= 0 && starText.includes('154.2k'), starRow >= 0 ? starText : 'no ★ row in the rail')
const header4 = headerRow(frame)
console.log(`the view header: "${header4}"`)
check('the view header says main chat for the crewmate', /★ VIEW · Lane fjord · main chat/.test(header4), `the header reads "${header4}"`)
const card4 = frame.slice(2, 6).map(centre).join(' ')
check('the card says THE MAIN CHAT in the crewmate\'s row', card4.includes('THE MAIN CHAT') && card4.includes('Lane fjord'), card4.trim().slice(0, 200))
const composer4 = composerRow(frame)
const composerText = composer4 >= 0 ? frame[composer4]!.trim() : ''
check('the composer placeholder reads "message Lane fjord"', composerText.includes('message Lane fjord'), `the composer row reads "${composerText.slice(0, 80)}"`)
const footer4 = frame.slice(composer4, composer4 + 6).join('\n')
check('the footer says ↵ sends to the crewmate · m on Mercury Lead returns the main chat', /sends to Lane fjord/.test(footer4) && /m on Mercury Lead returns the main chat/.test(footer4), footer4.replace(/\s+/g, ' ').slice(0, 300))
if (frame.some(line => line.includes(CREW_TITLE))) {
  scene.push(ESC)
  await sleep(400)
  check('esc closes the crew view', !scene.lines().some(line => line.includes(CREW_TITLE)) || done > 0)
}

section('§5 m on Mercury Lead hands the main chat back')
scene.push(TAB)
await sleep(300)
for (let step = 0; step < 8; step++) {
  scene.push(UP)
  await sleep(40)
}
await sleep(250)
const leadCursorRow = railText(scene.lines()[crewHeader + 1] ?? '').trim()
check('Tab then ↑ rests the rail cursor on Mercury Lead', /❯/.test(leadCursorRow) && leadCursorRow.includes(LEAD_ROW), `the lead's row reads "${leadCursorRow}"`)
scene.push('m')
await sleep(500)
frame = scene.lines()
save('screen-5-handed-back', frame)
console.log(`after Tab, m on the lead's row: mainChatTaskId=${String(scene.state().mainChatTaskId)} · rail banner "${railText(frame[0] ?? '').trim()}"`)
check('m on Mercury Lead hands the main chat back', scene.state().mainChatTaskId === undefined, `mainChatTaskId=${String(scene.state().mainChatTaskId)}`)
check('no ★ row remains in the rail', railRow(frame, '★') < 0)
scene.push(ESC)
await sleep(300)

await scene.close()
console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\nagent-view-frames: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
