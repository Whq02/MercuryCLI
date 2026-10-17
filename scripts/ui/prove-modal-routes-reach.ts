#!/usr/bin/env bun
// gate-watch: src/commands/** src/components/FullscreenLayout.tsx src/components/mercury-ui/components.tsx src/components/mercury-ui/InteractiveRow.tsx src/components/mercury-ui/CursorRow.tsx src/components/mercury-ui/useCursorFollow.ts src/components/mercury-ui/NavigablePanes.tsx src/components/RouterBoard.tsx src/components/CustomSelect/select.tsx src/components/design-system/ListItem.tsx
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'modal-routes-reach-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
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
const { ScrollKeybindingHandler } = await import('../../src/components/ScrollKeybindingHandler.tsx')
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const { getCommands } = await import('../../src/commands.ts')
const { getEngineModel } = await import('../../src/utils/model/model.ts')
const settingsPopup = await import('../../src/utils/cockpit/settingsPopup.ts')
const commandPopup = await import('../../src/utils/cockpit/commandPopup.ts')
const modelPickerPopup = await import('../../src/utils/cockpit/modelPickerPopup.ts')
const h = React.createElement

const DOWN = '\x1b[B'
const DOWNS = 12
const SIZES: Array<[number, number]> = [[64, 20], [80, 24], [100, 30], [177, 49]]
const RESIZE_STOPS: Array<[number, number]> = [[64, 20], [100, 30], [177, 49]]
const NOT_A_VIEW = new Set(['exit', 'logout', 'zen', 'keysetup', 'rename', 'title', 'crewmates'])

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const frameDir = arg('--frames')
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })
const onlyRoute = arg('--route')
let failures = 0
let checks = 0
function check(label: string, good: boolean, detail = ''): void {
  checks++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms))
class Output extends EventEmitter {
  isTTY = true
  columns = 80
  rows = 24
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
const hardLimit = setTimeout(() => { console.error('modal-routes-reach exceeded its deadline'); process.exit(1) }, 900_000)
hardLimit.unref()

const resetPopups = (): void => {
  settingsPopup.closeSettingsPopup()
  modelPickerPopup.releaseModelPickerPopup()
  const claim = commandPopup.commandPopupClaim()
  if (claim !== null) commandPopup.releaseCommandPopup(claim.token)
}
const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}

const commands = await getCommands(process.cwd())
const routes = commands.filter(command => command.type === 'local-jsx' && !NOT_A_VIEW.has(command.name) && (onlyRoute === undefined || command.name === onlyRoute))
console.log(`routes: ${routes.map(command => command.name).join(' ')}`)

type Scene = { lines: () => string[]; push: (data: string) => void; resize: (cols: number, rows: number) => Promise<void>; faults: () => string[]; close: () => Promise<void> }

async function openRoute(command: (typeof routes)[number], cols: number, rows: number): Promise<Scene | null> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const state = getDefaultAppState()
  const context = {
    messages: [], options: { engineModel: getEngineModel(), theme: 'dark', commands, tools: [], mcpClients: [], mcpResources: {}, debug: false, verbose: false, mainLoopModel: getEngineModel(), maxThinkingTokens: 0, agentDefinitions: { activeAgents: [], allAgents: [] }, isNonInteractiveSession: false },
    getAppState: () => state, setAppState: () => {}, setMessages: () => {}, onChangeAPIKey: () => {},
    abortController: new AbortController(), readFileState: new Map(), setToolJSX: () => {},
  }
  let element: React.ReactNode = null
  try {
    const loaded = typeof command.call === 'function' ? command.call : (await command.load()).call
    element = await loaded(() => {}, context as never, '')
  } catch (error) {
    check(`/${command.name} opens without throwing at ${cols}x${rows}`, false, String(error).slice(0, 200))
    resetPopups()
    return null
  }
  const popupOpen = settingsPopup.settingsPopupRequest() !== null
  if ((element === null || element === undefined) && !popupOpen) {
    resetPopups()
    return null
  }
  const stdout = new Output()
  stdout.columns = cols
  stdout.rows = rows
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  const scrollRef = React.createRef<null>()
  const modalScrollRef = React.createRef<null>()
  const insertRef = { current: null } as React.MutableRefObject<unknown>
  const faults: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')) }
  function Transcript(): React.ReactNode { return h(Text, null, Array.from({ length: 3 }, (_, index) => `13:00:0${index + 1} [op] task ${index + 1}`).join('\n')) }
  function Harness(): React.ReactNode {
    const { controls, focus } = useCompactWorkControls()
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const [screen, setScreen] = React.useState('prompt')
    return h(KeybindingSetup, null,
      h(GlobalKeybindingHandlers, { screen, setScreen, showAllInTranscript: false, setShowAllInTranscript: () => {}, messageCount: 0, compactWork: controls } as never),
      h(ScrollKeybindingHandler, { scrollRef, isActive: true, modalScrollRef, modalUp: true } as never),
      h(FullscreenLayout, {
        scrollRef, modalScrollRef, modalActive: true,
        scrollable: h(Transcript),
        statusBand: h(Text, null, 'activity specimen'),
        statusBandActive: false,
        modal: element === null || element === undefined ? undefined : h(Box, { width: '100%', flexDirection: 'column' }, element),
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: state.toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 0, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async () => {},
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: true, insertTextRef: insertRef,
        } as never),
      } as never),
    )
  }
  ink.render(h(App, { initialState: state, getFpsMetrics: () => undefined } as never, h(Harness)))
  await sleep(700)
  return {
    lines: () => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n'),
    push: data => stdin.push(data),
    resize: async (nextCols, nextRows) => {
      stdout.columns = nextCols
      stdout.rows = nextRows
      stdout.emit('resize')
      await sleep(500)
    },
    faults: () => faults,
    close: async () => {
      console.error = originalError
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
      resetPopups()
    },
  }
}

const width = (line: string): number => Array.from(line.replace(/\s+$/, '')).length
function region(lines: string[]): string[] {
  const separator = lines.findIndex(line => /^▔+\s*$/.test(line))
  if (separator >= 0) return lines.slice(separator + 1)
  const titleRow = lines.findIndex(line => line.includes('Mercury · '))
  if (titleRow >= 0) {
    const left = lines[titleRow]!.lastIndexOf('│', lines[titleRow]!.indexOf('Mercury · '))
    if (left >= 0) {
      let top = titleRow
      while (top > 0 && lines[top]![left] !== '╭') top--
      let bottom = titleRow
      while (bottom < lines.length - 1 && lines[bottom]![left] !== '╰') bottom++
      return lines.slice(top, bottom + 1).map(line => line.slice(left))
    }
  }
  return lines
}
const markerPainted = (lines: string[]): boolean => region(lines).some(line => /(^|[│ ])[❯▸]\s+\S/.test(line) && !line.includes('Type a prompt') && !line.includes('[op]'))
const fullFrameOpen = (lines: string[]): boolean => lines.some((line, index) => /^╭─+╮\s*$/.test(line) && /^│ .*Mercury — /.test(lines[index + 1] ?? ''))
const fullFrameClosed = (lines: string[]): boolean => lines.some(line => /^╰─+╯\s*$/.test(line))
const describe = (lines: string[]): string => region(lines).slice(0, 6).map(line => line.replace(/\s+$/, '')).join(' | ').slice(0, 300)

function frameLaws(label: string, scene: Scene, cols: number, rows: number): string[] {
  const lines = scene.lines()
  check(`${label}: the frame has the terminal's rows and no row wider than its columns`, lines.length === rows && lines.every(line => width(line) <= cols), `${lines.length} rows · widest ${Math.max(...lines.map(width))}`)
  if (fullFrameOpen(lines)) check(`${label}: the full-width frame closes inside the terminal (its bottom border is painted)`, fullFrameClosed(lines), describe(lines))
  return lines
}

for (const command of routes) {
  const name = `/${command.name}`
  const markerAt = new Map<string, boolean>()
  for (const [cols, rows] of SIZES) {
    const label = `${name} ${cols}x${rows}`
    const scene = await openRoute(command, cols, rows)
    if (scene === null) continue
    const opening = frameLaws(`${label} open`, scene, cols, rows)
    save(`${command.name}-${cols}x${rows}-open`, opening)
    const hasMarker = markerPainted(opening)
    markerAt.set(`${cols}x${rows}`, hasMarker)
    for (let index = 0; index < DOWNS; index++) { scene.push(DOWN); await sleep(60) }
    await sleep(350)
    const moved = frameLaws(`${label} after ↓ ×${DOWNS}`, scene, cols, rows)
    save(`${command.name}-${cols}x${rows}-down`, moved)
    if (hasMarker) check(`${label}: after ↓ ×${DOWNS} the selected row is still painted (the panel followed it)`, markerPainted(moved), describe(moved))
    check(`${label}: no render fault`, !scene.faults().some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), scene.faults().join(' | ').slice(0, 300))
    await scene.close()
  }
  const scene = await openRoute(command, 177, 49)
  if (scene === null) continue
  for (let index = 0; index < 3; index++) { scene.push(DOWN); await sleep(60) }
  await sleep(300)
  for (const [cols, rows] of RESIZE_STOPS) {
    await scene.resize(cols, rows)
    const frame = frameLaws(`${name} resize → ${cols}x${rows}`, scene, cols, rows)
    const hasMarker = markerAt.get(`${cols}x${rows}`) === true
    if (hasMarker) check(`${name} resize → ${cols}x${rows}: the selected row is still painted`, markerPainted(frame), describe(frame))
    scene.push(DOWN)
    await sleep(300)
    if (hasMarker) check(`${name} resize → ${cols}x${rows}: ↓ keeps the selected row painted`, markerPainted(scene.lines()), describe(scene.lines()))
  }
  check(`${name} resize: no render fault`, !scene.faults().some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), scene.faults().join(' | ').slice(0, 300))
  await scene.close()
}

clearTimeout(hardLimit)
rmSync(HOME, { recursive: true, force: true })
console.log(`\nmodal-routes-reach: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
