#!/usr/bin/env bun

import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'
import { releaseScratchHome } from '../lib/settingsPopupHarness.ts'

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
const { default: zenCommand } = await import('../../src/commands/zen/index.ts')
const { call: callZen, executeZen } = await import('../../src/commands/zen/zen.tsx')
const { builtinCommands } = await import('../../src/commands.ts')
const { COMMAND_DOMAINS } = await import('../../src/components/HelpV2/commandDomains.ts')
const { closeSettingsPopup, openSettingsPopup } = await import('../../src/utils/cockpit/settingsPopup.ts')
const { configPopupRequest } = await import('../../src/commands/config/config.tsx')
const { CONFIG_POPUP_HINT } = await import('../../src/components/Settings/Config.tsx')
const { getVitals } = await import('../../src/state/vitalsBus.ts')
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

section('§1 zen off, on, off at the four pinned sizes — the rails as the plan gives them, then none, then back')
for (const [cols, rows] of SIZES) {
  const scene = await openScene(cols, rows)
  const before = scene.lines()
  save(`zen-off-${cols}x${rows}`, before)
  check(`${cols}x${rows}: the setting starts off and the file carries no zen key`, !zenModeOn() && savedZen() === undefined, String(savedZen()))
  cockpitReadsAsPlanned(`${cols}x${rows} zen off`, before, cols, rows)
  check(`${cols}x${rows}: zen on saves`, setZenMode(true) === null)
  await scene.settle()
  const counted = await until(() => /sessions? on/.test(summaryRow(scene.lines())))
  check(`${cols}x${rows}: the status row counts the session once the vitals bus has published`, counted, JSON.stringify({ row: summaryRow(scene.lines()), sessions: getVitals().sessions.state, version: getVitals().version }))
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

section('§2 the command: /zen on · /zen off · bare /zen · /zen maybe, the file and the layout after each; the roster, the help domain, the composer hint')
{
  const registered = builtinCommands().find(command => command.name === 'zen')
  check('/zen is registered beside /effort with the one-line description /help lists', registered !== undefined && registered.type === 'local-jsx' && registered.description === zenCommand.description && /rails/.test(registered.description), String(registered?.description))
  check('/zen carries the argument hint [on|off] and runs at once (a view command never waits on the turn)', zenCommand.argumentHint === '[on|off]' && zenCommand.immediate === true, String(zenCommand.argumentHint))
  check('/help files /zen under the appearance & cockpit domain', COMMAND_DOMAINS.some(domain => domain.key === 'appearance' && domain.names.includes('zen')))
  check('the value column reads the saved setting (off now)', zenCommand.currentValue?.() === 'off', String(zenCommand.currentValue?.()))

  const scene = await openScene(177, 49)
  const before = scene.lines()
  const done: Array<[string | undefined, unknown]> = []
  const onDone = (result?: string, options?: unknown): void => { done.push([result, options]) }
  const context = { messages: [], options: { engineModel: getEngineModel() }, getAppState: () => getDefaultAppState(), setAppState: () => {} }
  const run = async (args: string): Promise<string | undefined> => {
    const count = done.length
    await callZen(onDone, context as never, args)
    await scene.settle()
    return done.length > count ? done[count]![0] : undefined
  }
  check('/zen on answers in the status row\'s register and saves', (await run('on')) === 'zen on — rails hidden · saved for later boots' && savedZen() === true && zenCommand.currentValue?.() === 'on', `${done.at(-1)?.[0]} · file ${String(savedZen())}`)
  zenReadsRight('after /zen on', scene.lines(), 177)
  check('/zen on again is a no-op that says so', (await run('on')) === 'zen is already on' && savedZen() === true, String(done.at(-1)?.[0]))
  check('/zen maybe names the two valid words and changes nothing', (await run('maybe')) === 'Valid options: on|off — "maybe" is not a zen option.' && savedZen() === true, String(done.at(-1)?.[0]))
  zenReadsRight('after /zen maybe', scene.lines(), 177)
  check('/zen off answers and the key leaves the file', (await run('off')) === 'zen off — rails back · saved for later boots' && savedZen() === undefined && zenCommand.currentValue?.() === 'off', `${done.at(-1)?.[0]} · file ${String(savedZen())}`)
  check('after /zen off the frame is the first frame again', scene.lines().join('\n') === before.join('\n'))
  check('/zen off again is a no-op that says so', (await run('off')) === 'zen is already off' && savedZen() === undefined, String(done.at(-1)?.[0]))
  check('bare /zen flips on', (await run('')) === 'zen on — rails hidden · saved for later boots' && savedZen() === true, String(done.at(-1)?.[0]))
  zenReadsRight('after bare /zen', scene.lines(), 177)
  check('bare /zen flips off again', (await run('  ')) === 'zen off — rails back · saved for later boots' && savedZen() === undefined, String(done.at(-1)?.[0]))
  check('after the second bare /zen the frame is the first frame again', scene.lines().join('\n') === before.join('\n'))
  check('the words are the same whatever the case', executeZen('MAYBE').message === 'Valid options: on|off — "MAYBE" is not a zen option.' && executeZen('ON').message === 'zen on — rails hidden · saved for later boots' && executeZen('Off').message === 'zen off — rails back · saved for later boots' && savedZen() === undefined)

  scene.push('/zen')
  await scene.settle()
  const typed = scene.lines()
  save('composer-zen-typed', typed)
  check('typing /zen lists the command with its description under the composer', typed.some(line => line.includes('/zen') && line.includes('Zen mode')), typed.slice(composerRow(typed) - 1, composerRow(typed) + 6).join(' | '))
  scene.push(' ')
  await scene.settle()
  const hinted = scene.lines()
  save('composer-zen-hint', hinted)
  check('the composer shows the greyed argument hint [on|off] after /zen (the cursor cell between)', hinted.some(line => /^│❯ \/zen\s{1,2}\[on\|off\]/.test(line)), hinted.filter(line => line.includes('/zen')).join(' | '))
  await scene.close()
}

section('§3 the /config row "Zen mode — rails hidden" reads the same setting: → flips it live, ↵ saves it, esc reverts it')
{
  const ROW = 'Zen mode — rails hidden'
  const rowValue = (frame: string[]): string | undefined => frame.map(line => new RegExp(`${ROW}\\s+(on|off)\\b`).exec(line)?.[1]).find(value => value !== undefined)
  const scene = await openScene(177, 49)
  const context = { messages: [], options: { engineModel: getEngineModel() }, getAppState: () => getDefaultAppState(), setAppState: () => {} }
  const open = async (): Promise<void> => {
    openSettingsPopup(configPopupRequest(context as never))
    check('the /config popup painted over the chat', await until(() => scene.lines().join('\n').includes(CONFIG_POPUP_HINT), 8000))
    await scene.settle(300)
    scene.push('/')
    await scene.settle(150)
    for (const letter of 'zen') { scene.push(letter); await scene.settle(80) }
    scene.push('\r')
    await scene.settle(300)
  }
  await open()
  const found = scene.lines()
  save('config-zen-row-off', found)
  check(`the search lands on the row "${ROW}" reading off`, rowValue(found) === 'off', found.filter(line => line.includes('Zen')).join(' | '))
  scene.push('\x1b[C')
  await scene.settle()
  const flipped = scene.lines()
  save('config-zen-row-on', flipped)
  check('→ flips the row to on and the file reads true', rowValue(flipped) === 'on' && savedZen() === true, `${rowValue(flipped)} · file ${String(savedZen())}`)
  check('the layout follows at once under the popup (no rails, the zen chip)', !hasRail(flipped, 'lanes') && !hasRail(flipped, 'vitals') && zenChipRow(flipped) >= 0, flipped.slice(0, 2).join(' | '))
  scene.push('\r')
  await scene.settle()
  const saved = scene.lines()
  save('config-zen-saved', saved)
  check('↵ saves and closes; zen stays on', !saved.join('\n').includes(CONFIG_POPUP_HINT) && savedZen() === true && zenModeOn())
  zenReadsRight('after the /config save', saved, 177, /^set zen mode to on/)
  await open()
  check('reopened, the row reads on', rowValue(scene.lines()) === 'on', scene.lines().filter(line => line.includes('Zen')).join(' | '))
  scene.push('\x1b[C')
  await scene.settle()
  check('→ flips it off again live', rowValue(scene.lines()) === 'off' && savedZen() === undefined && hasRail(scene.lines(), 'lanes'), `${rowValue(scene.lines())} · file ${String(savedZen())}`)
  scene.push('\x1b')
  await scene.settle()
  check('esc reverts the unsaved flip: the file reads true and the rails hide again', savedZen() === true && zenModeOn() && !hasRail(scene.lines(), 'lanes'), `file ${String(savedZen())}`)
  scene.push('\x1b')
  await scene.settle()
  check('a second esc closes the popup', !scene.lines().join('\n').includes(CONFIG_POPUP_HINT))
  closeSettingsPopup()
  check('/zen off from the command reads the same setting the row wrote', (executeZen('off').message) === 'zen off — rails back · saved for later boots' && savedZen() === undefined)
  await scene.settle()
  check('the chat is back to its first frame', hasRail(scene.lines(), 'lanes') && hasRail(scene.lines(), 'vitals') && zenChipRow(scene.lines()) < 0)
  await scene.close()
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
await releaseScratchHome(HOME)
console.log(`\nzen-frames: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
