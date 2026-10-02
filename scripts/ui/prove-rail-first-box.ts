#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'rail-first-box-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_CRITTER_IDLE = '0'
process.env.MERCURY_CRITTER_GAZE = '0'
process.env.MERCURY_CRITTER_SLEEP = '0'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_OPERATOR = 'sam'
process.env.BROWSER = '/usr/bin/true'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

const SESSION_ID = 'rail-first-box-session'
const SIZES: Array<[number, number]> = [[178, 51], [80, 21]]
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
  setEncoding(): this { return this }
  setRawMode(value: boolean): this { this.isRaw = value; return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): string | null { return null }
  get readableLength(): number { return 0 }
}
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }
const hardLimit = setTimeout(() => { console.error('rail-first-box exceeded its deadline'); process.exit(1) }, 120_000)
hardLimit.unref()

const NOW = Date.now()
type RosterRow = Record<string, unknown> & { id: string; status: string }
const CREW: Array<[string, number]> = [['atlas', 940], ['fjord', 840]]
const rosterRows = (): RosterRow[] =>
  CREW.map(([name, context], index) => ({
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
const workListeners = new Set<() => void>()
const roster = { rows: rosterRows(), mission: [], samples: [], reported: true }

const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
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
const { railPlanAt } = await import('../../src/utils/helmGeometry.ts')
const h = React.createElement

const resting = noSessionConnector() as unknown as Record<string, unknown>
const overrides: Record<string, unknown> = {
  sessionId: () => SESSION_ID,
  workRoster: () => roster,
  subscribeWork: (listener: () => void) => { workListeners.add(listener); return () => { workListeners.delete(listener) } },
  interrupt: () => false,
}
const fake = new Proxy(resting, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
  },
})
setFocusedSessionConnector(fake as never)

function Transcript(): React.ReactNode {
  return h(Text, null, Array.from({ length: 3 }, (_, index) => `13:00:0${index + 1} [sam] ❯ task ${index + 1}`).join('\n'))
}

async function renderAt(columns: number, rows: number): Promise<string[]> {
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  resetHelmFocusForTest()
  pending.edit('')
  pending.setMode('prompt')
  const stdout = new Output(columns, rows)
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output(columns, rows) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  const insertRef = { current: null } as React.MutableRefObject<import('../../src/components/PromptInput/PromptInput.tsx').PromptInputProps['insertTextRef']['current']>
  function Harness(): React.ReactNode {
    const { controls, focus } = useCompactWorkControls()
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
      h(FullscreenLayout, {
        scrollable: h(Transcript),
        statusBand: h(Text, null, 'waiting on 2 agents'),
        statusBandActive: true,
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 1, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async () => {},
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        } as never),
      } as never),
    )
  }
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness)))
  try {
    const text = (): string => stripAnsi(ink.lastFrameText())
    const painted = await until(() => insertRef.current !== null && text().includes('Type a prompt'))
    check(`${columns}x${rows}: the layout paints its composer placeholder`, painted, text().slice(0, 400))
    let last = ''
    let stable = 0
    const deadline = Date.now() + 8000
    while (stable < 12 && Date.now() < deadline) {
      await sleep(50)
      const next = text()
      stable = next === last ? stable + 1 : 0
      last = next
    }
    return text().replace(/\n$/, '').split('\n')
  } finally {
    ink.unmount()
    await ink.waitUntilExit()
    instances.delete(stdout as never)
  }
}

const railHeaders = (lines: string[], width: number): string[] =>
  lines
    .map(line => line.slice(0, width))
    .map(slice => /^[│ ]\s*\S\s([A-Z]+)(?:\s·\s|\s*│)/.exec(slice)?.[1] ?? null)
    .filter((label): label is string => label !== null)

for (const [columns, rows] of SIZES) {
  const lines = await renderAt(columns, rows)
  if (frameDir !== undefined) writeFileSync(join(frameDir, `rail-first-box-${columns}x${rows}.txt`), `${lines.join('\n')}\n`)
  const frame = lines.join('\n')
  check(`${columns}x${rows}: no SEAT box paints anywhere`, !/SEAT ·/.test(frame) && !/\bSEAT\b/.test(frame))
  check(`${columns}x${rows}: no seat self row paints (no "(you)" row, no peer count)`, !/\(you\)/.test(frame) && !/\d+ peers?\b/.test(frame))
  if (columns >= 150) {
    const lanesW = railPlanAt(columns, true).lanesW
    const headers = railHeaders(lines, lanesW)
    check(`${columns}x${rows}: the lanes rail paints with its banner on the first row`, (lines[0] ?? '').includes('lanes'), lines[0] ?? '')
    check(`${columns}x${rows}: the rail's first box is CREW`, headers[0] === 'CREW', `boxes: ${headers.join(' › ') || 'none'}`)
    check(`${columns}x${rows}: the crew rows stand in the CREW box`, /✶ Mercury Lead/.test(frame) && /atlas/.test(frame) && /fjord/.test(frame))
  } else {
    check(`${columns}x${rows}: the narrow layout paints no lanes rail`, !(lines[0] ?? '').includes('lanes'), lines[0] ?? '')
  }
}
console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error/.test(line)), faults.join('\n'))
rmSync(HOME, { recursive: true, force: true })
console.log(`rail-first-box: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
