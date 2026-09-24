#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ReactNode } from 'react'
import stripAnsi from 'strip-ansi'
import type { SeatStatusV1, SessionLiveV1 } from '../../src/services/engine-connector/seatLive.ts'
import type { EngineConnectorV1, WorkRowV1 } from '../../src/services/engine-connector/types.ts'
import type { Message } from '../../src/types/message.ts'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const ROOT = resolve(arg('--root') ?? join(import.meta.dir, '..', '..'))
const framesArg = arg('--frames')
const FRAMES = framesArg === undefined ? undefined : resolve(framesArg)
const COLS = 178
const ROWS = 51
const ROW_COLS = 120
const COMMAND = 'sleep 200'
const RUNNING_ROW = 'Running 1 bash command'
const SETTLED_ROW = 'Ran 1 bash command'
const COMMAND_LINE = `$ ${COMMAND}`
const EXPANDED_ROW = `Bash ${COMMAND}`
const EXPANDED_HEAD = 'Expanded group (1 call)'
const TASK_ID = 'b7f3a2'
const WORDS = 'run in background'
const RECEIPT = 'Running in the background — see /tasks'
const MEMBER_RECEIPT = 'Running in the background'
const CANNOT_RENDER = 'could not be rendered'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const SCRATCH = mkdtempSync(join(tmpdir(), 'shell-background-hint-'))
const PROJECT = join(SCRATCH, 'fixture-project')
const HOME = join(SCRATCH, 'home')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(HOME, { recursive: true })
process.chdir(PROJECT)
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_OPERATOR = 'sam'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.BROWSER = '/usr/bin/true'

const src = (rel: string): string => join(ROOT, 'src', rel)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const React = (await import(Bun.resolveSync('react', join(ROOT, 'src')))).default as typeof import('react')
const { default: Ink } = await import(src('ink/ink.tsx'))
const { Box } = await import(src('ink.ts'))
const { App } = await import(src('components/App.tsx'))
const { getDefaultAppState } = await import(src('state/AppStateStore.ts'))
const { KeybindingSetup } = await import(src('keybindings/KeybindingProviderSetup.tsx'))
const { FullscreenLayout } = await import(src('components/FullscreenLayout.tsx'))
const { default: PromptInput } = await import(src('components/PromptInput/PromptInput.tsx'))
const { SpinnerWithVerb } = await import(src('components/Spinner.tsx'))
const { FocusedSessionStatusRow } = await import(src('components/SwitchboardTagBar.tsx'))
const { CancelRequestHandler, backgroundShellNotice } = await import(src('hooks/useCancelRequest.ts'))
const { resetChromeModeLatchForTests } = await import(src('hooks/useLayoutTier.ts'))
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import(src('context/surfaceRoute.ts'))
const { enableConfigs, saveCurrentProjectConfig, saveGlobalConfig } = await import(src('utils/config.ts'))
const pending = await import(src('input-core/pending-input.ts'))
const { default: instances } = await import(src('ink/instances.ts'))
const slot = await import(src('services/engine-connector/focusedConnector.ts'))
const { noSessionConnector } = await import(src('services/engine-connector/noSessionConnector.ts'))
const { IDLE_LIVE } = await import(src('services/engine-connector/seatLive.ts'))
const signal = await import(src('services/engine-connector/shellRunning.ts'))
const helm = await import(src('utils/cockpit/helmFocus.ts'))
const row = await import(src('components/messages/AssistantToolUseMessage.tsx'))
const { MessageRow, hasContentAfterIndex } = await import(src('components/MessageRow.tsx'))
const { isAssistantContinuationRow } = await import(src('components/Messages.tsx'))
const { NameplateContinuationContext } = await import(src('components/messages/TranscriptNameplate.tsx'))
const { RowErrorBoundary } = await import(src('components/RowErrorBoundary.tsx'))
const { deriveTranscriptRows } = await import(src('components/concourse/workerTranscriptFold.ts'))
const { getTools } = await import(src('tools.ts'))
const { BashTool } = await import(src('tools/BashTool/BashTool.tsx'))
const { FileReadTool } = await import(src('tools/FileReadTool/FileReadTool.ts'))
const { useTerminalSize } = await import(src('hooks/useTerminalSize.ts'))
const { activeToolVerb } = await import(src('utils/cockpit/toolVerb.ts'))
const { getBindingDisplayText } = await import(src('keybindings/resolver.ts'))
const { loadKeybindingsSync, invalidateKeybindingsCache } = await import(src('keybindings/loadUserBindings.ts'))
const { kitShortcut } = await import(src('components/design-system/KeyboardShortcutHint.tsx'))
const { getPlatform } = await import(src('utils/platform.ts'))
const { settingsChangeDetector } = await import(src('utils/settings/changeDetector.ts'))
const { getSettingsSnapshot, settingsRevision } = await import(src('utils/settings/snapshot.ts'))
const { getInitialSettings } = await import(src('utils/settings/settings.ts'))
const { publishEphemeralProgress, clearEphemeralProgress } = await import(src('state/ephemeralProgressStore.ts'))
const { keyHintLabel } = await import(src('components/mercury-ui/keyHintLabel.ts'))

enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const h = React.createElement
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
}
async function until(label: string, predicate: () => boolean, budgetMs = 8000): Promise<boolean> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, budgetMs)
  while (!predicate() && !expired) await new Promise<void>(resolveTick => setTimeout(resolveTick, 10))
  clearTimeout(timer)
  const good = predicate()
  check(label, good)
  return good
}
async function settle(ms = 120): Promise<void> {
  await new Promise<void>(resolveTick => setTimeout(resolveTick, ms))
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
  get readableLength(): number { return this.chunks.reduce((n, value) => n + value.length, 0) }
  push(value: string): void { this.chunks.push(value); this.emit('readable') }
}
const hardLimit = setTimeout(() => { console.error('shell background hint proof exceeded its deadline'); process.exit(1) }, 170_000)
hardLimit.unref()
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }

const AFTER_MS = (signal as { BACKGROUND_HINT_AFTER_MS?: number }).BACKGROUND_HINT_AFTER_MS ?? 100_000
const seedStamp = row._seedToolStartStamp as (id: string, at: number) => void
const CHORD = kitShortcut(getBindingDisplayText('chat:backgroundShell', 'Chat', loadKeybindingsSync(), getPlatform() as never) ?? 'shift+b')
const HINT = `${CHORD} ${WORDS}`
const FOOTER_HINT = keyHintLabel('⇧b background the command')
const STATUS_HINT = keyHintLabel('⇧b backgrounds')
const STATUS_PLAIN = keyHintLabel('esc interrupts · ⇧← back')
const T0 = 1_760_000_000_000
const iso = (at: number): string => new Date(at).toISOString()
const STATUS: SeatStatusV1 = { title: 'a chat', projectLabel: 'mercury', interrupting: false, hardStopping: false, wait: null, quietMs: 1_000, watchdogMs: 90_000, phaseMs: 110_000, toolBudgetMs: 120_000, stuck: false }
type Rec = Record<string, unknown>
const assistantRow = (uuid: string, at: number, content: unknown[]): Rec => ({
  type: 'assistant',
  uuid,
  timestamp: iso(at),
  requestId: 'req_fixture_1',
  message: { id: 'msg_fixture_1', type: 'message', role: 'assistant', model: 'fixture-model', content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
})
const toolUse = (id: string, name: string, input: Record<string, unknown>): unknown => ({ type: 'tool_use', id, name, input })
function runningRecords(toolId: string, command: string): Rec[] {
  return [
    { type: 'user', uuid: `u-${toolId}-1`, timestamp: iso(T0), message: { role: 'user', content: 'run the long build and tell me what it prints' } },
    assistantRow(`a-${toolId}-1`, T0 + 1_000, [{ type: 'text', text: 'Running the long build now; this one takes a few minutes.' }]),
    assistantRow(`a-${toolId}-2`, T0 + 2_000, [toolUse(toolId, 'Bash', { command, description: 'a long build' })]),
  ]
}
function backgroundedRecords(toolId: string, command: string): Rec[] {
  return [
    ...runningRecords(toolId, command),
    {
      type: 'user',
      uuid: `u-${toolId}-2`,
      timestamp: iso(T0 + 112_000),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: `The operator moved this command to the background as task ${TASK_ID}; it is still running, and its output arrives as a notification when it completes. Output: /tmp/${TASK_ID}.out.` }] },
      toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: TASK_ID, backgroundedByUser: true },
    },
  ]
}
function readingRecords(toolId: string): Rec[] {
  return [
    { type: 'user', uuid: `u-${toolId}-1`, timestamp: iso(T0), message: { role: 'user', content: 'read the notes' } },
    assistantRow(`a-${toolId}-2`, T0 + 2_000, [toolUse(toolId, 'Read', { file_path: join(PROJECT, 'notes.md') })]),
  ]
}
const runningLive = (toolId: string): SessionLiveV1 => ({ ...IDLE_LIVE, inFlight: true, phase: 'tool', agentsWaiting: 0, inProgressToolUseIDs: new Set([toolId]), turnStartedAtMs: Date.now() - 115_000 })
const thinkingLive = (): SessionLiveV1 => ({ ...IDLE_LIVE, inFlight: true, phase: 'thinking', agentsWaiting: 0, inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: Date.now() - 115_000 })
const shellRow = (command: string): WorkRowV1 => ({ id: 'sh-fixture-1', kind: 'shell', name: command, status: 'running', startTime: Date.now() - 110_000, command } as WorkRowV1)
function publishShellTick(toolId: string, elapsedTimeSeconds: number): void {
  publishEphemeralProgress({
    type: 'progress',
    uuid: randomUUID(),
    timestamp: iso(Date.now()),
    toolUseID: toolId,
    parentToolUseID: toolId,
    data: { type: 'bash_progress', output: '', fullOutput: '', elapsedTimeSeconds, totalLines: 0 },
  } as never)
}

type Seat = EngineConnectorV1 & {
  presses: number
  setLive(next: SessionLiveV1): void
  setRecords(next: Rec[]): void
  settle(): void
}
function seatFixture(sessionId: string, toolId: string, command: string, initial: { live: SessionLiveV1; records: Rec[] }): Seat {
  const recordListeners = new Set<() => void>()
  const liveListeners = new Set<() => void>()
  let records = initial.records
  let live = initial.live
  const roster = { rows: [shellRow(command)], mission: [] as never[], samples: [] as never[], reported: true }
  const seat = Object.assign(Object.create(noSessionConnector()), {
    presses: 0,
    sessionId: () => sessionId,
    records: () => records,
    subscribeRecords: (listener: () => void) => {
      recordListeners.add(listener)
      return () => {
        recordListeners.delete(listener)
      }
    },
    turnActive: () => live.inFlight,
    modelFacts: () => ({ effective: 'fixture-model', effectiveSource: 'live', main: 'fixture-model', setting: null, sessionPin: null, effort: null, effortSent: null, pendingSwitch: null }),
    subscribeModel: () => () => {},
    workRoster: () => roster,
    subscribeWork: () => () => {},
    live: () => live,
    subscribeLive: (listener: () => void) => {
      liveListeners.add(listener)
      return () => {
        liveListeners.delete(listener)
      }
    },
    status: () => STATUS,
    tail: () => ({ subscribe: () => () => {}, getSnapshot: () => null, read: () => null }),
    backgroundShell: async () => {
      seat.presses += 1
      queueMicrotask(() => seat.settle())
      return { outcome: 'applied' as const, detail: '{"taken":1}' }
    },
    setLive(next: SessionLiveV1): void {
      live = next
      for (const listener of liveListeners) listener()
    },
    setRecords(next: Rec[]): void {
      records = next
      for (const listener of recordListeners) listener()
    },
    settle(): void {
      clearEphemeralProgress()
      seat.setRecords(backgroundedRecords(toolId, command))
      seat.setLive(thinkingLive())
    },
  }) as Seat
  return seat
}

const tools = getTools(getDefaultAppState().toolPermissionContext)
const EMPTY = new Set<string>()
const baseLookups = (over: Record<string, unknown> = {}): unknown => ({
  siblingToolUseIDs: new Map(),
  progressMessagesByToolUseID: new Map(),
  inProgressHookCounts: new Map(),
  resolvedHookCounts: new Map(),
  toolResultByToolUseID: new Map(),
  toolUseByToolUseID: new Map(),
  normalizedMessageCount: 1,
  resolvedToolUseIDs: new Set<string>(),
  erroredToolUseIDs: new Set<string>(),
  deniedToolUseIDs: new Set<string>(),
  ...over,
})
type Scene = {
  id: string
  name: string
  input: Record<string, unknown>
  tool: unknown
  running: boolean
  painted: string
  shouldAnimate?: boolean
  isTranscriptMode?: boolean
  withKeybindings?: boolean
}
function sceneElement(scene: Scene): ReactNode {
  const node = h(row.AssistantToolUseMessage as never, {
    param: { type: 'tool_use', id: scene.id, name: scene.name, input: scene.input },
    tools: [scene.tool],
    verbose: false,
    inProgressToolUseIDs: scene.running ? new Set([scene.id]) : new Set<string>(),
    shouldAnimate: scene.shouldAnimate ?? true,
    shouldShowDot: true,
    isTranscriptMode: scene.isTranscriptMode ?? false,
    lookups: baseLookups(scene.running ? {} : { resolvedToolUseIDs: new Set([scene.id]) }) as never,
  } as never)
  return scene.withKeybindings === false ? node : h(KeybindingSetup, null, node)
}

type World = { ink: InstanceType<typeof Ink>; stdin: Input; frame: () => string; lines: () => string[]; close: () => Promise<void> }
async function mountTree(columns: number, rows: number, tree: ReactNode): Promise<World> {
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  helm.resetHelmFocusForTest()
  pending.edit('')
  pending.setMode('prompt')
  const stdout = new Output(columns, rows)
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output(columns, rows) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: { ...getDefaultAppState(), expandedView: 'none' }, getFpsMetrics: () => undefined }, tree))
  const frame = (): string => stripAnsi(ink.lastFrameText())
  return {
    ink,
    stdin,
    frame,
    lines: () => frame().split('\n').map(line => line.replace(/\s+$/, '')),
    close: async () => { ink.unmount(); await ink.waitUntilExit(); instances.delete(stdout as never) },
  }
}
let setRowScene: ((scene: Scene) => void) | null = null
function RowHarness({ initial }: { initial: Scene }): ReactNode {
  const [scene, set] = React.useState(initial)
  setRowScene = set
  return sceneElement(scene)
}
type RowsView = { expanded: boolean; screen: 'prompt' | 'transcript' }
let setRowsView: ((view: RowsView) => void) | null = null
function transcriptRows(seat: Seat, view: RowsView, columns: number): ReactNode {
  const live = seat.live()
  const derived = deriveTranscriptRows(seat.records() as Message[], tools)
  return h(Box, { flexDirection: 'column' }, ...derived.collapsed.map((m, i) =>
    h(NameplateContinuationContext.Provider, { key: (m as { uuid: string }).uuid, value: isAssistantContinuationRow(derived.collapsed as never, i) },
      h(RowErrorBoundary, null,
        h(MessageRow, {
          message: m as never,
          isUserContinuation: m.type === 'user' && derived.collapsed[i - 1]?.type === 'user',
          hasContentAfter: m.type === 'collapsed_read_search' && hasContentAfterIndex(derived.collapsed as never, i, tools, EMPTY),
          tools,
          commands: [],
          verbose: false,
          inProgressToolUseIDs: live.inProgressToolUseIDs,
          streamingToolUseIDs: EMPTY,
          screen: view.screen as never,
          canAnimate: true,
          lastThinkingBlockId: null,
          latestBashOutputUUID: null,
          columns,
          isLoading: live.inFlight,
          lookups: derived.lookups,
          clickExpanded: view.expanded && m.type === 'collapsed_read_search',
        }),
      ),
    ),
  ))
}
function useSeat(seat: Seat): void {
  React.useSyncExternalStore(seat.subscribeLive as never, seat.live as never, seat.live as never)
  React.useSyncExternalStore(seat.subscribeRecords as never, seat.records as never, seat.records as never)
}
function RowsHarness({ seat }: { seat: Seat }): ReactNode {
  const [view, set] = React.useState<RowsView>({ expanded: false, screen: 'prompt' })
  setRowsView = set
  useSeat(seat)
  const { columns } = useTerminalSize()
  return h(KeybindingSetup, null, transcriptRows(seat, view, columns))
}
function file(name: string, frame: string): void {
  if (!FRAMES) return
  mkdirSync(FRAMES, { recursive: true })
  writeFileSync(join(FRAMES, name), frame + '\n')
  console.log(`frame written: ${join(FRAMES, name)}`)
}
const hintLines = (lines: string[]): number[] => lines.map((line, index) => (line.includes(HINT) ? index : -1)).filter(index => index >= 0)
const rowLine = (lines: string[], marker: string): number => lines.findIndex(line => line.includes(marker))
const around = (lines: string[], marker: string, span = 4): string => {
  const at = rowLine(lines, marker)
  return at < 0 ? `(${marker} not painted)` : lines.slice(at, at + span).join(' ⏎ ')
}
function shellRowShape(name: string, lines: string[], tail: string): void {
  const at = rowLine(lines, RUNNING_ROW)
  const cmd = rowLine(lines, COMMAND_LINE)
  const hint = hintLines(lines)[0] ?? -1
  check(`${name}: the collapsed running row says ${RUNNING_ROW}… with its fold hint and its own tail`, at >= 0 && /Running 1 bash command… \S.* 1 operation/.test(lines[at] ?? ''), lines[at] ?? '(absent)')
  check(`${name}: the row's tail ${tail === '' ? 'names no elapsed (no progress tick yet)' : `reads the runner's elapsed ${tail}`}`, tail === '' ? !/1 operation ·/.test(lines[at] ?? '') : (lines[at] ?? '').includes(`1 operation${tail}`), lines[at] ?? '(absent)')
  check(`${name}: the └ ${COMMAND_LINE} line sits right under the row`, cmd === at + 1 && /└ \$ sleep 200(\s|$)/.test(lines[cmd] ?? ''), around(lines, RUNNING_ROW))
  check(`${name}: the hint sits right under the command line, one dim line in the footer grammar`, hint === cmd + 1 && hintLines(lines).length === 1, around(lines, RUNNING_ROW))
  check(`${name}: the hint is indented under the command (the $ column)`, hint > 0 && (lines[hint] ?? '').indexOf(HINT) === (lines[cmd] ?? '').indexOf('$'), `${JSON.stringify(lines[cmd] ?? '')} / ${JSON.stringify(lines[hint] ?? '')}`)
}

console.log(`shell background hint proof — product root ${ROOT}; the resolved chord reads ${JSON.stringify(CHORD)}; threshold ${AFTER_MS} ms`)

section('§0 the settings snapshot — a change reaches every reader whatever the fan-out order')
{
  const early = settingsChangeDetector.subscribe(() => { getInitialSettings() })
  const before = settingsRevision()
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ backgroundKey: false }))
  settingsChangeDetector.notifyChange('userSettings')
  check('a listener that reloads the pipeline ahead of the snapshot readers does not hide the change from them', settingsRevision() === before + 1 && getSettingsSnapshot().settings.backgroundKey === false, `revision ${before} → ${settingsRevision()}, backgroundKey ${String(getSettingsSnapshot().settings.backgroundKey)}`)
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({}))
  settingsChangeDetector.notifyChange('userSettings')
  check('…and the change back reaches them too', settingsRevision() === before + 2 && getSettingsSnapshot().settings.backgroundKey === undefined, `revision ${settingsRevision()}`)
  const same = settingsRevision()
  check('a reload with unchanged content keeps the revision (the same snapshot object)', getSettingsSnapshot() === getSettingsSnapshot() && settingsRevision() === same)
  early()
}

section('§1 the seam — one owner for the words and the threshold, two renderers, the classic road untouched')
{
  const rowSrc = read('src/components/messages/AssistantToolUseMessage.tsx')
  const collapsed = read('src/components/messages/CollapsedReadSearchContent.tsx')
  const messageSrc = read('src/components/Message.tsx')
  const signalSrc = read('src/services/engine-connector/shellRunning.ts')
  const snapshotSrc = read('src/utils/settings/snapshot.ts')
  const ui = read('src/tools/BashTool/UI.tsx')
  const bash = read('src/tools/BashTool/BashTool.tsx')
  const footer = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
  const tag = read('src/components/SwitchboardTagBar.tsx')
  const cancel = read('src/hooks/useCancelRequest.ts')
  check('the threshold is one named constant of 100 seconds, owned by the shell-running signal', AFTER_MS === 100_000 && signalSrc.includes('export const BACKGROUND_HINT_AFTER_MS = 100_000') && signalSrc.split('100_000').length === 2 && !rowSrc.includes('100_000') && !collapsed.includes('100_000'))
  check('the words, the action and the receipt words live beside it', signalSrc.includes(`export const BACKGROUND_HINT_WORDS = '${WORDS}'`) && signalSrc.includes("export const BACKGROUND_HINT_ACTION = 'chat:backgroundShell'") && signalSrc.includes(`export const BACKGROUND_MOVED_WORDS = '${RECEIPT}'`))
  check("the per-row question rides the same signal owner as the chord's", signalSrc.includes('export function focusedShellToolRunning(id: string): boolean') && signalSrc.includes('return live.inFlight && live.inProgressToolUseIDs.has(id)') && signalSrc.includes('useSyncExternalStore(subscribeShellRunning, read, read)') && signalSrc.includes('export function useFocusedShellRunning(): boolean'))
  const pick = (signal as { firstRunningShellId?: (entries: Array<{ id: string; name: string }>, inProgress: Set<string>) => string | null }).firstRunningShellId
  const moved = (signal as { movedToBackgroundByOperator?: (result: unknown) => boolean }).movedToBackgroundByOperator
  check('the member picker names the first running Bash member and no other tool', typeof pick === 'function' && pick([{ id: 'r1', name: 'Read' }, { id: 'b1', name: 'Bash' }, { id: 'b2', name: 'Bash' }], new Set(['r1', 'b1', 'b2'])) === 'b1' && pick([{ id: 'r1', name: 'Read' }], new Set(['r1'])) === null && pick([{ id: 'b1', name: 'Bash' }], new Set()) === null)
  check("the receipt reader keys on the operator's own move, never the model's launch", typeof moved === 'function' && moved({ backgroundTaskId: 'x', backgroundedByUser: true }) && !moved({ backgroundTaskId: 'x' }) && !moved(undefined) && !moved('text'))
  check('the one leaf lives with the start-stamp map and reads the owner', rowSrc.includes('export function RunningShellBackgroundHint({ id }: { id: string }): React.ReactNode') && rowSrc.includes("useActionAffordance(BACKGROUND_HINT_ACTION, 'Chat')") && rowSrc.includes('useFocusedShellToolRunning(id)') && rowSrc.includes('Date.now() - startedAt < BACKGROUND_HINT_AFTER_MS') && rowSrc.includes('<KeyboardShortcutHint shortcut={chord} action={BACKGROUND_HINT_WORDS} />') && !rowSrc.includes('⇧b') && !rowSrc.includes("'shift+b'"))
  check('the leaf honours the backgroundKey setting like the two existing paints and rides the elapsed tick', rowSrc.includes('getSettingsSnapshot().settings.backgroundKey !== false') && rowSrc.includes('useSyncExternalStore(settingsChangeDetector.subscribe, settingsRevision, settingsRevision)') && rowSrc.includes('useNowTick(offered && focused && !reducedMotion ? ELAPSED_TICK_MS : null)'))
  check('the standalone tool row mounts the leaf under a running Bash row only', rowSrc.includes("{running && shouldAnimate && !isTranscriptMode && param.name === BASH_TOOL_NAME ? (\n        <RunningShellBackgroundHint id={param.id} />"))
  check('the collapsed row mounts the same leaf for the one running shell member, in both its forms', collapsed.includes("import { RunningShellBackgroundHint } from './AssistantToolUseMessage.js'") && collapsed.includes('const shellId = active && shouldAnimate && !isTranscriptMode ? firstRunningShellId(memberEntries, inProgressToolUseIDs) : null') && collapsed.includes('{shellId !== null ? <RunningShellBackgroundHint id={shellId} /> : null}') && collapsed.includes('{entry.id === shellId ? <RunningShellBackgroundHint id={entry.id} /> : null}'))
  check("the collapsed row paints the receipt of the operator's move under itself", collapsed.includes('<Text dimColor>{BACKGROUND_MOVED_WORDS}</Text>') && collapsed.includes('movedToBackgroundByOperator('))
  check('the collapsed row learns the transcript-viewer fact from its caller', collapsed.includes('isTranscriptMode = false,') && messageSrc.includes('isTranscriptMode={isTranscriptMode}\n            tools={tools}'))
  check('the settings snapshot keys its staleness on the cache object, not on its absence', snapshotSrc.includes('sessionCache === lastSessionCache') && snapshotSrc.includes('lastSessionCache = getSessionSettingsCache()'))
  check('the classic road is untouched: BackgroundHint still binds task:background and paints after the quiet window', ui.includes("useShortcutDisplay('task:background', 'Task', 'ctrl+b')") && ui.includes('<KeyboardShortcutHint shortcut={chord} action="run in background" parens={false} />') && bash.includes('Date.now() - startedAt >= QUIET_WINDOW_MS && setToolJSX') && bash.includes('setToolJSX({ jsx: <BackgroundHint />'))
  check('the chord, its owner and the two existing paints are as shipped', cancel.includes("'chat:backgroundShell',") && cancel.includes('isActive: isEscapeActive && shellRunning && getSettingsSnapshot().settings.backgroundKey !== false') && footer.includes(`shortcut={keyHintLabel('⇧b')} action="background the command"`) && tag.includes("keyHintLabel('⇧b backgrounds')"))
}

section('§2 the standalone tool row (the plain chrome) — the hint under a running Bash row past the threshold, and nowhere else')
{
  const seatA = seatFixture('session-a', 'toolu_a', COMMAND, { live: runningLive('toolu_a'), records: runningRecords('toolu_a', COMMAND) })
  slot.setFocusedSessionConnector(seatA)
  const marker = (name: string): string => `${COMMAND} && echo ${name}`
  const scene = (id: string, name: string, over: Partial<Scene> = {}): Scene => ({ id, name: 'Bash', input: { command: marker(name), description: 'a long build' }, tool: BashTool, running: true, painted: marker(name), ...over })
  seedStamp('toolu_a', Date.now() - AFTER_MS - 5_000)
  const world = await mountTree(ROW_COLS, 40, h(RowHarness, { initial: scene('toolu_a', 'old') }))
  await until('the row harness mounted', () => setRowScene !== null)
  const show = async (next: Scene, agoMs: number | null): Promise<string[]> => {
    if (agoMs !== null) seedStamp(next.id, Date.now() - agoMs)
    seatA.setLive(runningLive(next.id))
    setRowScene?.(next)
    await until(`${next.painted.split(' ').pop()}: the row painted`, () => world.frame().includes(next.painted))
    await settle()
    return world.lines()
  }
  const old = await show(scene('toolu_a', 'old'), AFTER_MS + 5_000)
  check('a 105 s-old running Bash row paints the hint under itself', hintLines(old).length === 1, around(old, marker('old')))
  const rowAt = rowLine(old, marker('old'))
  const hintAt = hintLines(old)[0] ?? -1
  check('the hint sits under the row, below the running line', hintAt > rowAt && hintAt - rowAt <= 3 && old.slice(rowAt + 1, hintAt).some(line => line.includes('running')), around(old, marker('old')))
  check('the hint is one dim line indented under the row\'s response connector', (old[hintAt] ?? '').trimEnd() === `    ${HINT}`, JSON.stringify(old[hintAt] ?? ''))
  check('the elapsed tail still names the age beside the hint', /· 10[5-9]s/.test(old[rowAt] ?? ''), old[rowAt] ?? '')
  console.log(`  old row: ${around(old, marker('old'))}`)

  const young = await show(scene('toolu_b', 'young'), 30_000)
  check('a 30 s-old running Bash row paints no hint (the elapsed tail alone)', hintLines(young).length === 0 && /· 3\ds/.test(young[rowLine(young, marker('young'))] ?? ''), around(young, marker('young')))

  const edge = await show(scene('toolu_c', 'edge'), AFTER_MS - 5_000)
  check('five seconds short of the threshold: no hint yet', hintLines(edge).length === 0, around(edge, marker('edge')))

  const crossing = await show(scene('toolu_d', 'crossing'), AFTER_MS - 1_500)
  check('a row about to cross the threshold paints no hint on its first frame', hintLines(crossing).length === 0, around(crossing, marker('crossing')))
  await until('the hint appears by itself once the row crosses the threshold (the tick, no outside repaint)', () => hintLines(world.lines()).length === 1, 6000)

  const other = await show({ id: 'toolu_e', name: 'Read', input: { file_path: join(PROJECT, 'notes.md') }, tool: FileReadTool, running: true, painted: 'notes.md' }, AFTER_MS + 5_000)
  check('a 105 s-old running Read row paints no hint', hintLines(other).length === 0 && !other.some(line => line.includes(WORDS)), around(other, 'notes.md'))

  const done = await show(scene('toolu_f', 'done', { running: false }), AFTER_MS + 5_000)
  check('a completed Bash row paints no hint and no elapsed tail', hintLines(done).length === 0 && !/· 1\d\ds/.test(done[rowLine(done, marker('done'))] ?? ''), around(done, marker('done')))

  const viewer = await show(scene('toolu_g', 'viewer', { isTranscriptMode: true }), AFTER_MS + 5_000)
  check('the transcript viewer (where the chord is inactive) paints no hint', hintLines(viewer).length === 0, around(viewer, marker('viewer')))

  const still = await show(scene('toolu_h', 'still', { shouldAnimate: false }), AFTER_MS + 5_000)
  check('a row that cannot animate (a dialog or the selector holds the screen) paints no hint', hintLines(still).length === 0, around(still, marker('still')))

  const again = await show(scene('toolu_i', 'again'), AFTER_MS + 5_000)
  check('a fresh 105 s row paints the hint again', hintLines(again).length === 1, around(again, marker('again')))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ backgroundKey: false }))
  settingsChangeDetector.notifyChange('userSettings')
  await until('backgroundKey: false takes the hint away on the mounted row', () => hintLines(world.lines()).length === 0)
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({}))
  settingsChangeDetector.notifyChange('userSettings')
  await until('the setting back on brings the hint back', () => hintLines(world.lines()).length === 1)

  const seatB = seatFixture('session-b', 'toolu_other', COMMAND, { live: IDLE_LIVE, records: [] })
  slot.setFocusedSessionConnector(seatB)
  await until('a hop to a seat that does not run this shell takes the hint away (the row itself unchanged)', () => hintLines(world.lines()).length === 0)
  slot.setFocusedSessionConnector(seatA)
  await until('a hop back restores it', () => hintLines(world.lines()).length === 1)
  seatA.setLive(thinkingLive())
  await until("the focused seat's live set letting the tool go takes the hint away", () => hintLines(world.lines()).length === 0)
  seatA.setLive(runningLive('toolu_i'))
  await until('and the set carrying it again brings it back', () => hintLines(world.lines()).length === 1)

  const bare = await show(scene('toolu_j', 'bare', { withKeybindings: false }), AFTER_MS + 5_000)
  check('with no keybinding provider (nothing resolvable) the row advertises nothing', hintLines(bare).length === 0 && !bare.some(line => line.includes(WORDS)), around(bare, marker('bare')))
  await world.close()

  writeFileSync(join(HOME, 'keybindings.json'), JSON.stringify({ bindings: [{ context: 'Chat', bindings: { 'shift+b': null } }] }))
  invalidateKeybindingsCache()
  const unbound = await mountTree(ROW_COLS, 40, h(RowHarness, { initial: scene('toolu_k', 'unbound') }))
  seedStamp('toolu_k', Date.now() - AFTER_MS - 5_000)
  seatA.setLive(runningLive('toolu_k'))
  await until('unbound: the row painted', () => unbound.frame().includes(marker('unbound')))
  await settle()
  const unboundLines = unbound.lines()
  check("the operator's own unbind of the chord leaves the row silent (no dead key advertised)", hintLines(unboundLines).length === 0 && !unboundLines.some(line => line.includes(WORDS)), around(unboundLines, marker('unbound')))
  await unbound.close()
  rmSync(join(HOME, 'keybindings.json'), { force: true })
  invalidateKeybindingsCache()
  slot._resetFocusedSessionConnectorForTesting()
}

section('§3 the real transcript road (the fold) — the collapsed running row, its expanded form, the viewer, and the receipt after the move')
{
  const seat = seatFixture('session-rows', 'toolu_rows', COMMAND, { live: runningLive('toolu_rows'), records: runningRecords('toolu_rows', COMMAND) })
  slot.setFocusedSessionConnector(seat)
  seedStamp('toolu_rows', Date.now() - 110_000)
  const world = await mountTree(ROW_COLS, 40, h(RowsHarness, { seat }))
  await until('rows: the fold paints the running shell as the collapsed row', () => world.frame().includes(RUNNING_ROW))
  await until(`rows: the fold paints the command line under it`, () => world.frame().includes(COMMAND_LINE))
  await until('rows: the hint paints under the collapsed running row', () => hintLines(world.lines()).length === 1)
  await settle()
  const quiet = world.lines()
  shellRowShape('rows · before any progress tick', quiet, '')
  check('rows: the standalone Bash row form never paints on this road', !quiet.some(line => /Bash {9}sleep 200/.test(line)))
  check('rows: no row degraded', !quiet.some(line => line.includes(CANNOT_RENDER)))
  console.log(`  rows collapsed: ${around(quiet, RUNNING_ROW)}`)
  publishShellTick('toolu_rows', 110)
  await until("rows: the runner's progress tick reaches the row's own tail", () => /1 operation · 110s/.test(world.frame()))
  await settle()
  const ticked = world.lines()
  shellRowShape('rows · after the tick', ticked, ' · 110s')
  file(`rows-collapsed-${ROW_COLS}.txt`, ticked.join('\n'))

  setRowsView?.({ expanded: true, screen: 'prompt' })
  await until('rows · expanded in place: the fold opens into its member rows', () => world.frame().includes(EXPANDED_HEAD) && world.frame().includes(EXPANDED_ROW))
  await until('rows · expanded in place: the hint paints under the running member row', () => hintLines(world.lines()).length === 1)
  await settle()
  const expanded = world.lines()
  const memberAt = rowLine(expanded, EXPANDED_ROW)
  check('rows · expanded in place: the hint sits right under the member row', (hintLines(expanded)[0] ?? -1) === memberAt + 1, around(expanded, EXPANDED_HEAD, 4))
  check('rows · expanded in place: the collapsed sentence is gone', !expanded.some(line => line.includes(RUNNING_ROW)))
  console.log(`  rows expanded: ${around(expanded, EXPANDED_HEAD, 4)}`)
  file(`rows-expanded-${ROW_COLS}.txt`, expanded.join('\n'))

  setRowsView?.({ expanded: false, screen: 'transcript' })
  await until('rows · the transcript viewer: the fold shows its member rows there too', () => world.frame().includes(EXPANDED_HEAD) && world.frame().includes(EXPANDED_ROW))
  await settle()
  const viewer = world.lines()
  check('rows · the transcript viewer: no hint (the chord is inactive on that screen)', hintLines(viewer).length === 0 && !viewer.some(line => line.includes(WORDS)), around(viewer, EXPANDED_HEAD, 4))

  setRowsView?.({ expanded: false, screen: 'prompt' })
  await until('rows · back on the prompt screen: the collapsed row and its hint return', () => world.frame().includes(RUNNING_ROW) && hintLines(world.lines()).length === 1)

  check("the chord's receipt reader paints no notice for an applied move — the canvas shows it", backgroundShellNotice({ outcome: 'applied', detail: '{"taken":1}' } as never) === null)
  const receipt = await seat.backgroundShell()
  check('the seat door answers applied for the press', receipt.outcome === 'applied' && seat.presses === 1)
  await until(`rows · after the move: the row settles to ${SETTLED_ROW}`, () => world.frame().includes(SETTLED_ROW))
  await until('rows · after the move: the receipt names the background run and its door', () => world.frame().includes(RECEIPT))
  await settle()
  const after = world.lines()
  const settledAt = rowLine(after, SETTLED_ROW)
  check('rows · after the move: the receipt sits right under the settled row', rowLine(after, RECEIPT) === settledAt + 1, around(after, SETTLED_ROW, 4))
  check('rows · after the move: the hint, the command line and the elapsed tail are gone', hintLines(after).length === 0 && !after.some(line => line.includes(COMMAND_LINE)) && !after.some(line => line.includes('· 110s')), around(after, SETTLED_ROW, 4))
  check('rows · after the move: no row degraded', !after.some(line => line.includes(CANNOT_RENDER)))
  console.log(`  rows after the move: ${around(after, SETTLED_ROW, 4)}`)
  file(`rows-after-move-${ROW_COLS}.txt`, after.join('\n'))

  setRowsView?.({ expanded: true, screen: 'prompt' })
  await until("rows · expanded after the move: the member's own result renderer paints the background receipt", () => world.frame().includes(EXPANDED_ROW) && world.frame().includes(MEMBER_RECEIPT))
  check('rows · expanded after the move: no hint', hintLines(world.lines()).length === 0)
  await world.close()

  const reading = seatFixture('session-read', 'toolu_read', COMMAND, { live: runningLive('toolu_read'), records: readingRecords('toolu_read') })
  slot.setFocusedSessionConnector(reading)
  seedStamp('toolu_read', Date.now() - 110_000)
  const readWorld = await mountTree(ROW_COLS, 40, h(RowsHarness, { seat: reading }))
  await until('rows · a running Read: the fold paints the reading row', () => readWorld.frame().includes('Reading 1 file'))
  await settle()
  const readLines = readWorld.lines()
  check('rows · a running Read past the threshold paints no hint', hintLines(readLines).length === 0 && !readLines.some(line => line.includes(WORDS)), around(readLines, 'Reading 1 file'))
  await readWorld.close()
  slot._resetFocusedSessionConnectorForTesting()
}

section(`§4 both views at ${COLS}x${ROWS} — the cockpit and the wide non-cockpit view, the press through the chord, the receipt`)
async function chromeWorld(name: string, helmHome: '0' | '1'): Promise<void> {
  process.env.MERCURY_HELM_HOME = helmHome
  const toolId = `toolu_${name}`
  const seat = seatFixture(`session-${name}`, toolId, COMMAND, { live: runningLive(toolId), records: runningRecords(toolId, COMMAND) })
  slot.setFocusedSessionConnector(seat)
  seedStamp(toolId, Date.now() - 110_000)
  publishShellTick(toolId, 110)
  const scrollRef = React.createRef<import('../../src/ink/components/ScrollBox.tsx').ScrollBoxHandle>()
  const insertRef = { current: null } as import('../../src/components/PromptInput/PromptInput.tsx').PromptInputProps['insertTextRef']
  const startedAt = { current: Date.now() - 115_000 }
  const paused = { current: 0 }
  const pauseStart = { current: null as number | null }
  const responseLength = { current: 0 }
  const outputTokens = { current: null as number | null }
  const apiMetrics = { current: [] as Array<{ ttftMs: number; firstTokenTime: number; lastTokenTime: number; responseLengthBaseline: number; endResponseLength: number }> }
  function Transcript(): ReactNode {
    useSeat(seat)
    const { columns } = useTerminalSize()
    return transcriptRows(seat, { expanded: false, screen: 'prompt' }, columns)
  }
  function Harness(): ReactNode {
    useSeat(seat)
    const live = seat.live()
    const records = seat.records() as Message[]
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const running = live.inProgressToolUseIDs.size > 0
    return h(KeybindingSetup, null,
      h(CancelRequestHandler, { screen: 'prompt' as never, focusedTurnActive: live.inFlight }),
      h(FullscreenLayout, {
        scrollRef,
        scrollable: h(Transcript),
        statusBand: h(SpinnerWithVerb, {
          mode: running ? 'tool-use' : 'thinking', loadingStartTimeRef: startedAt, totalPausedMsRef: paused, pauseStartTimeRef: pauseStart,
          spinnerTip: null, responseLengthRef: responseLength, outputTokensRef: outputTokens, overrideColor: null, overrideShimmerColor: null,
          overrideMessage: null, still: false, spinnerSuffix: null, verbose: false, hasActiveTools: running, activeToolCount: live.inProgressToolUseIDs.size,
          activeToolLabel: activeToolVerb(records, live.inProgressToolUseIDs) ?? null, leaderIsIdle: false, apiMetricsRef: apiMetrics,
        } as never),
        statusBandActive: true,
        bottom: h(Box, { flexDirection: 'column' },
          h(FocusedSessionStatusRow),
          h(PromptInput, {
            debug: false, ideSelection: undefined, toolPermissionContext: getDefaultAppState().toolPermissionContext,
            setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
            isLoading: live.inFlight, verbose: false, submitCount: 0, onShowMessageSelector: () => {},
            mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
            onExit: () => {}, getToolUseContext: () => ({} as never),
            onSubmit: async () => {},
            isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
            hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
          } as never),
        ),
      }),
    )
  }
  const world = await mountTree(COLS, ROWS, h(Harness))
  await until(`${name}: the chrome mounts with the composer armed`, () => insertRef.current !== null && world.stdin.isRaw && world.frame().length > 0)
  if (helmHome === '1') await until(`${name}: the lanes rail paints (the cockpit)`, () => world.frame().includes('SEAT'))
  else await until(`${name}: no lanes rail paints (the wide non-cockpit view)`, () => world.frame().length > 0 && !world.frame().includes('SEAT'))
  await until(`${name}: the fold paints the running shell as the collapsed row`, () => world.frame().includes(RUNNING_ROW) && world.frame().includes(COMMAND_LINE))
  await until(`${name}: the hint paints under the row`, () => hintLines(world.lines()).length === 1)
  await until(`${name}: the footer names the chord beside esc interrupt`, () => world.frame().includes(FOOTER_HINT))
  await until(`${name}: the status row names the chord on the way back`, () => world.frame().includes(STATUS_HINT))
  await settle(300)
  const before = world.lines()
  file(`${name}-shell-110s-${COLS}x${ROWS}.txt`, before.join('\n'))
  console.log(`${name} · the shell 110 s in\n${before.join('\n')}`)
  shellRowShape(name, before, ' · 110s')
  check(`${name}: the frame fits ${COLS}x${ROWS}`, before.length <= ROWS && before.every(line => line.length <= COLS), `${before.length} rows`)
  check(`${name}: no row degraded`, !before.some(line => line.includes(CANNOT_RENDER)))
  world.stdin.push('B')
  await until(`${name}: the press reaches the seat's background door once`, () => seat.presses === 1)
  await until(`${name}: the row settles to ${SETTLED_ROW} and the receipt names the background run and its door`, () => world.frame().includes(SETTLED_ROW) && world.frame().includes(RECEIPT))
  await until(`${name}: the hint is gone after the move`, () => hintLines(world.lines()).length === 0)
  await until(`${name}: the footer and the status row stop naming the chord`, () => !world.frame().includes(FOOTER_HINT) && !world.frame().includes(STATUS_HINT))
  await settle(300)
  const after = world.lines()
  file(`${name}-after-press-${COLS}x${ROWS}.txt`, after.join('\n'))
  console.log(`${name} · after the press\n${after.join('\n')}`)
  check(`${name}: the receipt sits right under the settled row`, rowLine(after, RECEIPT) === rowLine(after, SETTLED_ROW) + 1, around(after, SETTLED_ROW, 4))
  check(`${name}: the command line and the elapsed tail are gone with the running state`, !after.some(line => line.includes(COMMAND_LINE)) && !after.some(line => line.includes('· 110s')), around(after, SETTLED_ROW, 4))
  check(`${name}: the turn goes on and the way back keeps esc`, after.some(line => line.includes(STATUS_PLAIN)), after.filter(line => line.includes('back')).join(' | '))
  check(`${name}: the letter never landed in the composer`, !after.some(line => /❯ B\b/.test(line)), after.filter(line => line.includes('❯')).join(' | '))
  check(`${name}: no row degraded after the move`, !after.some(line => line.includes(CANNOT_RENDER)))
  await world.close()
  slot._resetFocusedSessionConnectorForTesting()
}
await chromeWorld('cockpit', '1')
await chromeWorld('compact', '0')

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error/.test(line)), faults.join('\n'))
rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nshell background hint: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
