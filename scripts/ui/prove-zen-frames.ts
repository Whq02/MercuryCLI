#!/usr/bin/env bun
// gate-watch: src/utils/cockpit/zenMode.ts src/hooks/useLayoutTier.ts src/context/layoutChromeContext.tsx src/components/FullscreenLayout.tsx src/utils/helmGeometry.ts src/utils/settings/types.ts
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'zen-frames-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
delete process.env.MERCURY_EFFORT_LEVEL
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
const { Box, Text } = await import('../../src/ink.ts')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
const { useCompactWorkControls } = await import('../../src/components/tasks/CompactWorkSummary.tsx')
const { GlobalKeybindingHandlers } = await import('../../src/hooks/useGlobalKeybindings.tsx')
const { LAYOUT_BREAKPOINTS, resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { useLayoutChrome } = await import('../../src/context/layoutChromeContext.tsx')
const { CockpitBottomStatus } = await import('../../src/context/cockpitActiveContext.tsx')
const { MercuryFrame } = await import('../../src/components/MercuryFrame.tsx')
const { FocusedSessionStatusRow } = await import('../../src/components/SwitchboardTagBar.tsx')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const { railPlan, resetRailTier } = await import('../../src/utils/helmGeometry.ts')
const { setZenMode, zenModeOn } = await import('../../src/utils/cockpit/zenMode.ts')
const { getSettingsFilePathForSource } = await import('../../src/utils/settings/settings.ts')
const h = React.createElement

const COMPOSER = 'Type a prompt'
const SIZES: Array<[number, number]> = [[177, 49], [100, 30], [80, 24], [64, 20]]

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
  columns = 177
  rows = 49
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
const hardLimit = setTimeout(() => { console.error('zen-frames exceeded its deadline'); process.exit(1) }, 240_000)
hardLimit.unref()

const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}
const settingsPath = (): string => getSettingsFilePathForSource('userSettings')!
const savedZen = (): unknown => {
  const path = settingsPath()
  if (!existsSync(path)) return undefined
  return (JSON.parse(readFileSync(path, 'utf8')) as { view?: { zen?: unknown } }).view?.zen
}

type Scene = { lines: () => string[]; push: (data: string) => void; settle: (ms?: number) => Promise<void>; close: () => Promise<void> }

async function openScene(cols: number, rows: number): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  resetRailTier()
  pending.edit('')
  pending.setMode('prompt')
  const insertRef = { current: null } as React.MutableRefObject<unknown>
  function Transcript(): React.ReactNode {
    return h(Text, null, Array.from({ length: 3 }, (_, index) => `13:00:0${index + 1} [op] ❯ task ${index + 1}`).join('\n'))
  }
  function Harness(): React.ReactNode {
    const { controls, focus } = useCompactWorkControls()
    const { isCompact } = useLayoutChrome()
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    const strip = h(Text, null, 'activity specimen')
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
      h(FullscreenLayout, {
        scrollable: h(Transcript),
        statusBand: strip,
        statusBandActive: false,
        bottom: h(Box, { flexDirection: 'column' },
          h(Box, { flexDirection: isCompact ? 'column-reverse' : 'column' },
            h(MercuryFrame, { model: getEngineModel() }),
            h(CockpitBottomStatus, null, strip),
          ),
          isCompact ? null : h(FocusedSessionStatusRow),
          h(PromptInput, {
            compactWork: controls, compactFocus: focus,
            debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
            setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
            isLoading: false, verbose: false, submitCount: 0, onShowMessageSelector: () => {},
            mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
            onExit: () => {}, getToolUseContext: () => ({} as never),
            onSubmit: async () => {},
            isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
            hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
          } as never),
        ),
      } as never),
    )
  }
  const stdout = new Output()
  stdout.columns = cols
  stdout.rows = rows
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness)))
  const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
  const painted = await until(() => lines().join('\n').includes(COMPOSER))
  check(`the chat painted at ${cols}x${rows}`, painted, lines().slice(0, 4).join(' | '))
  await sleep(400)
  return {
    lines,
    push: data => stdin.push(data),
    settle: async (ms = 500) => { await sleep(ms) },
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}

const cells = (line: string): string[] => Array.from(line)
const hasRail = (frame: string[], rail: 'lanes' | 'vitals'): boolean => frame.slice(0, 2).some(line => line.includes(rail))
const centreBorderAt = (frame: string[], column: number): boolean => frame.slice(1, 4).every(line => cells(line)[column] === '│')
const fullWidthRule = (frame: string[], cols: number): boolean => frame.some(line => line === '─'.repeat(cols))
const composerRow = (frame: string[]): number => frame.findIndex(line => line.includes(COMPOSER))
const composerWhole = (frame: string[], cols: number): boolean => {
  const row = composerRow(frame)
  if (row < 1) return false
  const top = cells(frame[row - 1]!)
  const bottom = cells(frame[row + 1] ?? '')
  return top[0] === '╭' && top[cols - 1] === '╮' && bottom[0] === '╰' && bottom[cols - 1] === '╯'
}
const summaryRow = (frame: string[]): string => frame[frame.length - 1] ?? ''

function cockpitReadsAsPlanned(label: string, frame: string[], cols: number, rows: number): void {
  const cockpit = cols >= LAYOUT_BREAKPOINTS.cockpitMin && rows >= LAYOUT_BREAKPOINTS.cockpitMinRows
  if (!cockpit) {
    check(`${label}: below the cockpit size the chat is rail-less as before (no lanes rail, no vitals rail, the band rule spans the width)`, !hasRail(frame, 'lanes') && !hasRail(frame, 'vitals') && fullWidthRule(frame, cols), frame.slice(0, 4).join(' | '))
    return
  }
  const plan = railPlan(cols)
  const shape = plan.vitals ? 'both rails' : plan.lanesW < 24 ? 'the slim lanes rail' : 'the lanes rail alone'
  check(`${label}: ${shape} exactly as railPlan gives them at ${cols} columns (lanes ${plan.lanesW} wide${plan.vitals ? `, vitals ${plan.vitalsW} wide` : ''})`, hasRail(frame, 'lanes') && hasRail(frame, 'vitals') === plan.vitals && centreBorderAt(frame, plan.lanesW) && (!plan.vitals || centreBorderAt(frame, cols - 1 - plan.vitalsW)), frame.slice(0, 3).map(line => line.slice(0, 60)).join(' | '))
}

function zenReadsRight(label: string, frame: string[], cols: number): void {
  check(`${label}: no lanes rail and no vitals rail`, !hasRail(frame, 'lanes') && !hasRail(frame, 'vitals'), frame.slice(0, 2).join(' | '))
  check(`${label}: the chat takes the full width (the band rule spans ${cols} columns, the transcript starts at the edge)`, fullWidthRule(frame, cols) && frame.some(line => line.startsWith('13:00:01 [op]')), frame.slice(0, 6).join(' | '))
  check(`${label}: the composer is whole across the width`, composerWhole(frame, cols), frame.slice(composerRow(frame) - 1, composerRow(frame) + 2).join(' | '))
  check(`${label}: the status row is whole (the sessions summary at the last row)`, /sessions? on/.test(summaryRow(frame)) && cells(summaryRow(frame)).length === cols, summaryRow(frame))
}

section('§1 zen off, on, off at the four pinned sizes — the rails as the plan gives them, then none, then back')
for (const [cols, rows] of SIZES) {
  const scene = await openScene(cols, rows)
  const before = scene.lines()
  save(`zen-off-${cols}x${rows}`, before)
  check(`${cols}x${rows}: the setting starts off and the file carries no zen key`, !zenModeOn() && savedZen() === undefined, String(savedZen()))
  cockpitReadsAsPlanned(`${cols}x${rows} zen off`, before, cols, rows)
  check(`${cols}x${rows}: zen on saves`, setZenMode(true) === null)
  await scene.settle()
  const during = scene.lines()
  save(`zen-on-${cols}x${rows}`, during)
  check(`${cols}x${rows}: the file reads view.zen true`, savedZen() === true, String(savedZen()))
  zenReadsRight(`${cols}x${rows} zen on`, during, cols)
  check(`${cols}x${rows}: zen off saves`, setZenMode(false) === null)
  await scene.settle()
  const after = scene.lines()
  save(`zen-back-${cols}x${rows}`, after)
  check(`${cols}x${rows}: the file carries no zen key again`, savedZen() === undefined, String(savedZen()))
  check(`${cols}x${rows}: zen off repaints the frame exactly as it was`, after.join('\n') === before.join('\n'), after.slice(0, 3).map(line => line.slice(0, 60)).join(' | '))
  cockpitReadsAsPlanned(`${cols}x${rows} zen back off`, after, cols, rows)
  await scene.close()
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\nzen-frames: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
