#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { releaseScratchHome } from '../lib/settingsPopupHarness.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'composer-strip-'))
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
const { default: zenCommand } = await import('../../src/commands/zen/index.ts')
const { call: callZen, executeZen } = await import('../../src/commands/zen/zen.tsx')
const { builtinCommands } = await import('../../src/commands.ts')
const { COMMAND_DOMAINS } = await import('../../src/components/HelpV2/commandDomains.ts')
const { closeSettingsPopup, openSettingsPopup } = await import('../../src/utils/cockpit/settingsPopup.ts')
const { configPopupRequest } = await import('../../src/commands/config/config.tsx')
const { CONFIG_POPUP_HINT } = await import('../../src/components/Settings/Config.tsx')
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
const hardLimit = setTimeout(() => { console.error('composer-down-to-strip exceeded its deadline'); process.exit(1) }, 240_000)
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
            setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [zenCommand], agents: [],
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
const zenChipRow = (frame: string[]): number => frame.findIndex(line => /(^|·\s)zen(\s·|\s*$)/.test(line))

function cockpitReadsAsPlanned(label: string, frame: string[], cols: number, rows: number): void {
  const cockpit = cols >= LAYOUT_BREAKPOINTS.cockpitMin && rows >= LAYOUT_BREAKPOINTS.cockpitMinRows
  check(`${label}: no zen chip while zen is off`, zenChipRow(frame) < 0, frame[zenChipRow(frame)] ?? '')
  if (!cockpit) {
    check(`${label}: below the cockpit size the chat is rail-less as before (no lanes rail, no vitals rail, the band rule spans the width)`, !hasRail(frame, 'lanes') && !hasRail(frame, 'vitals') && fullWidthRule(frame, cols), frame.slice(0, 4).join(' | '))
    return
  }
  const plan = railPlan(cols)
  const shape = plan.vitals ? 'both rails' : plan.lanesW < 24 ? 'the slim lanes rail' : 'the lanes rail alone'
  check(`${label}: ${shape} exactly as railPlan gives them at ${cols} columns (lanes ${plan.lanesW} wide${plan.vitals ? `, vitals ${plan.vitalsW} wide` : ''})`, hasRail(frame, 'lanes') && hasRail(frame, 'vitals') === plan.vitals && centreBorderAt(frame, plan.lanesW) && (!plan.vitals || centreBorderAt(frame, cols - 1 - plan.vitalsW)), frame.slice(0, 3).map(line => line.slice(0, 60)).join(' | '))
}

function zenReadsRight(label: string, frame: string[], cols: number, lastRow: RegExp = /sessions? on/): void {
  check(`${label}: no lanes rail and no vitals rail`, !hasRail(frame, 'lanes') && !hasRail(frame, 'vitals'), frame.slice(0, 2).join(' | '))
  check(`${label}: the chat takes the full width (the band rule spans ${cols} columns, the transcript starts at the edge)`, fullWidthRule(frame, cols) && frame.some(line => line.startsWith('13:00:01 [op]')), frame.slice(0, 6).join(' | '))
  check(`${label}: the composer is whole across the width`, composerWhole(frame, cols), frame.slice(composerRow(frame) - 1, composerRow(frame) + 2).join(' | '))
  check(`${label}: the status row is whole (${lastRow.source} at the last row)`, lastRow.test(summaryRow(frame)) && cells(summaryRow(frame)).length === cols, summaryRow(frame))
  const chipRow = zenChipRow(frame)
  check(`${label}: the zen chip sits on the status row above the composer`, chipRow >= 0 && chipRow < composerRow(frame) && chipRow > composerRow(frame) - 4, chipRow < 0 ? 'no zen chip' : `chip row ${chipRow}, composer row ${composerRow(frame)}`)
}


const DOWN = '\x1b[B'
const UP = '\x1b[A'
const FOCUSED_HINT = '↵ details · esc back'
const stripRow = (frame: string[]): string => frame[frame.length - 1] ?? ''
const STRIP = /sessions? on · .*monitors? here · .*crewmates? here|^S:\d+ · M:\d+ · C:\d+/
const stripFocused = (frame: string[]): boolean => STRIP.test(stripRow(frame)) && stripRow(frame).includes(FOCUSED_HINT)
const press = (x: number, y: number): string => `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`

for (const [cols, rows, zen] of [[80, 24, false], [64, 20, false], [64, 20, true], [80, 24, true], [100, 30, true], [177, 49, true]] as Array<[number, number, boolean]>) {
  const label = `${cols}x${rows}${zen ? ' zen' : ''}`
  setZenMode(zen)
  const scene = await openScene(cols, rows)
  await scene.settle(300)
  section(`§1 ${label}: ↓ on the empty composer's last line hands focus to the strip; ↑ returns`)
  check(`${label}: the strip is the last row, unfocused`, await until(() => STRIP.test(stripRow(scene.lines())) && !stripFocused(scene.lines())), stripRow(scene.lines()))
  scene.push(DOWN)
  check(`${label}: ↓ focuses the strip (its hint reads ${FOCUSED_HINT})`, await until(() => stripFocused(scene.lines())), stripRow(scene.lines()))
  scene.push(UP)
  check(`${label}: ↑ from the strip returns to the composer`, await until(() => !stripFocused(scene.lines())), stripRow(scene.lines()))
  scene.push('a')
  await scene.settle(300)
  check(`${label}: the composer takes the keys again`, scene.lines().some(line => /│❯ a\s/.test(line)) && !stripFocused(scene.lines()), scene.lines().find(line => line.includes('❯')) ?? '')
  scene.push('\x7f')
  await scene.settle(200)

  section(`§2 ${label}: refusals — a multi-line composer, a history walk, a typed word on the strip, the click road`)
  scene.push('one')
  scene.push('\x1b[13;2u')
  await scene.settle(200)
  if (scene.lines().some(line => line.includes('│❯ one'))) {
    scene.push('two')
    await scene.settle(200)
    const twoLines = scene.lines().filter(line => /│\s*(❯ one|two)\s/.test(line)).length === 2
    if (twoLines) {
      scene.push(UP)
      await scene.settle(200)
      scene.push(DOWN)
      await scene.settle(300)
      check(`${label}: ↓ inside a multi-line composer moves the cursor, never the focus`, !stripFocused(scene.lines()) && scene.lines().some(line => line.includes('two')), stripRow(scene.lines()))
    }
    for (let i = 0; i < 6; i++) scene.push('\x7f')
    for (let i = 0; i < 3; i++) scene.push('\x7f')
    await scene.settle(200)
  }
  pending.edit('')
  await scene.settle(200)
  scene.push(DOWN)
  await until(() => stripFocused(scene.lines()))
  scene.push('q')
  check(`${label}: a typed letter on the strip returns to the composer and lands in it`, await until(() => !stripFocused(scene.lines()) && scene.lines().some(line => /│❯ q\s/.test(line))), scene.lines().find(line => line.includes('❯')) ?? '')
  scene.push('\x7f')
  await scene.settle(200)
  scene.push(press(2, rows - 1))
  check(`${label}: a click on the strip still focuses it`, await until(() => stripFocused(scene.lines())), stripRow(scene.lines()))
  scene.push('\x1b')
  check(`${label}: esc leaves the strip`, await until(() => !stripFocused(scene.lines())), stripRow(scene.lines()))
  await scene.close()
}

section('§3 the cockpit layout (100x30 and 177x49 with rails shown, no strip): ↓ on the empty composer changes nothing')
for (const [cols, rows] of [[100, 30], [177, 49]] as Array<[number, number]>) {
  setZenMode(false)
  const scene = await openScene(cols, rows)
  await scene.settle(300)
  const before = scene.lines().join('\n')
  check(`${cols}x${rows}: no counts strip paints below the composer`, !/sessions? on · /.test(stripRow(scene.lines())), stripRow(scene.lines()))
  scene.push(DOWN)
  await scene.settle(400)
  check(`${cols}x${rows}: the frame after ↓ is the frame before`, scene.lines().join('\n') === before)
  await scene.close()
}

setZenMode(false)
clearTimeout(hardLimit)
check('no render fault', faults.length === 0, faults.join(' | ').slice(0, 300))
releaseScratchHome(HOME)
console.log(`\n${failures === 0 ? '✅' : '❌'} composer-down-to-strip — ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
