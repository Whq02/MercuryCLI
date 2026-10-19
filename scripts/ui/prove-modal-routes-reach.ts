#!/usr/bin/env bun
// gate-watch: src/commands/** src/components/CritterSelect.tsx src/components/FullscreenLayout.tsx src/components/mercury-ui/components.tsx src/components/mercury-ui/InteractiveRow.tsx src/components/mercury-ui/CursorRow.tsx src/components/mercury-ui/useCursorFollow.ts src/components/mercury-ui/NavigablePanes.tsx src/components/CustomSelect/select.tsx src/components/design-system/ListItem.tsx
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
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
const { setActiveMission } = await import('../../src/guards/mission.ts')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
const { SandboxManager } = await import('../../src/utils/sandbox/sandbox-adapter.ts')
const sandboxListsModes = SandboxManager.checkDependencies().errors.length === 0
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { mkdirSync: mkdirp } = await import('node:fs')
const { dirname } = await import('node:path')
const h = React.createElement

const DOWN = '\x1b[B'
const RIGHT = '\x1b[C'
const DOWNS = 12
const SIZES: Array<[number, number]> = [[64, 20], [80, 24], [100, 30], [177, 49]]
const RESIZE_STOPS: Array<[number, number]> = [[64, 20], [100, 30], [177, 49]]
const NOT_A_VIEW = new Set(['exit', 'logout', 'zen', 'keysetup', 'rename', 'title', 'crewmates', 'browse', 'contract', 'mission'])
const TEXT_ROUTES = ['contract', 'mission']
const MARK: Readonly<Record<string, string>> = {
  defaultprovider: 'Default provider', hooks: 'configured hooks', permissions: 'Permissions:', export: 'Export conversation', sandbox: 'Sandbox', saturn: 'saturn scheduler',
  keys: 'input atlas', workbench: 'Mercury — prompts', console: 'Mercury — console', sessions: 'Mercury · resume', copy: 'Mercury — copy', mcp: 'Mercury — mcp', mission: 'Mission',
  context: 'Mercury — context', feedback: 'Feedback — which kind', samples: 'SAMPLES · this session', showcase: 'Mercury — showcase',
}
const markOf = (name: string): RegExp => {
  const word = MARK[name]
  if (word !== undefined) return new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`Mercury [—·] ${name}`)
}
const SEED_SESSION = '00000000-0000-4000-8000-00000000c0de'
const seedMessages = (): unknown[] => [
  { type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: '2026-06-19T12:00:00.000Z', message: { role: 'user', content: 'show me the greeter twice' } },
  { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000002', timestamp: '2026-06-19T12:00:01.000Z', message: { id: 'msg_copy_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Two forms of the greeter.\n\n```ts\nexport const greet = (name: string): string => `Hello, ${name}`\n```\n\n```sh\necho hello\n```' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
]

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
async function until(predicate: () => boolean, ms = 15000): Promise<boolean> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, ms)
  while (!predicate() && !expired) await sleep(20)
  clearTimeout(timer)
  return predicate()
}
async function settled(lines: () => string[], ticks = 3): Promise<void> {
  let last = lines().join('\n')
  let stable = 0
  for (let index = 0; index < 60 && stable < ticks; index++) {
    await sleep(60)
    const now = lines().join('\n')
    stable = now === last ? stable + 1 : 0
    last = now
  }
}
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

setIsInteractive(true)
process.env.MERCURY_SAMPLES = '1'
process.env.MERCURY_DEV_SURFACES = '1'
delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
const commands = await getCommands(process.cwd())
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
const routes = commands.filter(command => command.type === 'local-jsx' && !NOT_A_VIEW.has(command.name) && (onlyRoute === undefined || command.name === onlyRoute))
console.log(`routes: ${routes.map(command => command.name).join(' ')}`)
const expectedRoutes = ['agents', 'appearance', 'caching', 'capabilities', 'console', 'context', 'copy', 'critter', 'daemon', 'defaultprovider', 'diff', 'effort', 'export', 'extensions', 'feedback', 'health', 'help', 'hooks', 'keys', 'logins', 'mcp', 'memory', 'model', 'palette', 'permissions', 'realms', 'run', 'runs', 'samples', 'sandbox', 'saturn', 'sessions', 'showcase', 'skills', 'submodels', 'trace', 'workbench', 'workflows']
if (onlyRoute === undefined) check('every view route the compositor census knows is in the walk (the nine that never paint a view are named)', expectedRoutes.every(name => routes.some(command => command.name === name)), expectedRoutes.filter(name => !routes.some(command => command.name === name)).join(' '))

const sessionFile = workerTranscriptPath({ sessionId: SEED_SESSION, workspaceId: process.cwd() })
mkdirp(dirname(sessionFile), { recursive: true })
writeFileSync(sessionFile, encodeSeedTranscript(seedMessages().map(row => ({ isSidechain: false, entrypoint: 'cli', cwd: process.cwd(), sessionId: SEED_SESSION, version: '1.0.0', gitBranch: 'main', parentUuid: null, ...(row as Record<string, unknown>) })), SEED_SESSION))
function seedConnector(): void {
  const resting = noSessionConnector()
  const roster = { clients: [{ name: 'fixture-tools', type: 'connected' }, { name: 'fixture-search', type: 'failed', error: 'the connect deadline passed' }] }
  const samples = Array.from({ length: 14 }, (_, index) => ({ id: `sample-${index + 1}`, title: `sample ${index + 1} — the greeter's page`, version: index + 1, state: index % 3 === 0 ? 'approved' : index % 3 === 1 ? 'open' : 'changes-needed', updatedAt: '2026-06-19T12:00:00.000Z', glyph: '◇', url: `http://127.0.0.1:1/sample-${index + 1}` }))
  const work = { rows: [], mission: [], samples, reported: true }
  const seeded = new Proxy(resting, {
    get(target, prop, receiver) {
      if (prop === 'mcpRoster') return () => roster
      if (prop === 'workRoster') return () => work
      if (prop === 'subscribeWork') return () => () => {}
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  setFocusedSessionConnector(seeded as never)
}

type Scene = { lines: () => string[]; push: (data: string) => void; resize: (cols: number, rows: number) => Promise<void>; faults: () => string[]; close: () => Promise<void> }

async function openRoute(command: (typeof routes)[number], cols: number, rows: number): Promise<Scene | null> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  if (command.name === 'mcp' || command.name === 'samples') seedConnector()
  else releaseFocusedSessionConnector()
  const state = getDefaultAppState()
  const context = {
    messages: command.name === 'copy' || command.name === 'feedback' ? seedMessages() : [], options: { engineModel: getEngineModel(), theme: 'dark', commands, tools: [], mcpClients: [], mcpResources: {}, debug: false, verbose: false, maxThinkingTokens: 0, agentDefinitions: { activeAgents: [], allAgents: [] }, isNonInteractiveSession: false },
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
  const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
  const mark = markOf(command.name)
  const painted = await until(() => lines().some(line => mark.test(line)) && !lines().some(line => /Loading conversations|loading…|examining the harness/.test(line)) && (!markerExpected(command.name, cols, 'open', lines()) || markerPainted(lines(), command.name)))
  check(`/${command.name} paints its own mark at ${cols}x${rows} (${mark.source})`, painted, lines().slice(0, 8).map(line => line.replace(/\s+$/, '')).join(' | ').slice(0, 300))
  await settled(lines)
  return {
    lines,
    push: data => stdin.push(data),
    resize: async (nextCols, nextRows) => {
      stdout.columns = nextCols
      stdout.rows = nextRows
      stdout.emit('resize')
      await until(() => lines().length === nextRows && lines().some(line => mark.test(line)))
      await settled(lines)
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
const glyphMarker = (lines: string[]): boolean => region(lines).some(line => /(^|[│ ])[❯▸]\s*\S/.test(line) && !line.includes('Type a prompt') && !line.includes('[op]'))
const boxedMarker = (lines: string[]): boolean => {
  const rows = region(lines)
  return rows.some((line, index) => /^│\s*╭─+╮\s*│/.test(line) && /^│\s*│ \S/.test(rows[index + 1] ?? ''))
}
const MARKER_ALWAYS = new Set(['accounts', 'appearance', 'caching', 'capabilities', 'console', 'critter', 'defaultprovider', 'effort', 'export', 'feedback', 'health', 'hooks', 'keys', 'logins', 'memory', 'model', 'palette', 'samples', ...(sandboxListsModes ? ['sandbox'] : []), 'sessions', 'showcase', 'submodels'])
const MARKER_AFTER_WALK = new Set(['permissions'])
const MARKER_WIDE_NAV = new Set(['extensions', 'workbench'])
const diffListsFiles = (lines: string[]): boolean => region(lines).some(line => /Mercury — diff · \d+ files? /.test(line))
const markerExpected = (name: string, cols: number, stage: 'open' | 'walked', frame: string[] = []): boolean =>
  MARKER_ALWAYS.has(name) || (MARKER_AFTER_WALK.has(name) && stage === 'walked') || (MARKER_WIDE_NAV.has(name) && cols >= 177) || (name === 'diff' && diffListsFiles(frame))
const markerPainted = (lines: string[], name = ''): boolean => glyphMarker(lines) || (name === 'model' && boxedMarker(lines))
const fullFrameOpen = (lines: string[]): boolean => lines.some((line, index) => /^╭─+╮\s*$/.test(line) && /^│ .*Mercury — /.test(lines[index + 1] ?? ''))
const fullFrameClosed = (lines: string[]): boolean => lines.some(line => /^╰─+╯\s*$/.test(line))
const describe = (lines: string[]): string => region(lines).slice(0, 6).map(line => line.replace(/\s+$/, '')).join(' | ').slice(0, 300)

function cardWhole(frame: string[], name: string): boolean {
  const nameRow = frame.findIndex(line => line.includes(name))
  if (nameRow < 0) return false
  const column = frame[nameRow]!.lastIndexOf('│', frame[nameRow]!.indexOf(name))
  if (column < 0) return false
  const launch = frame[nameRow + 1] ?? ''
  const bottom = frame[nameRow + 2] ?? ''
  return launch.slice(column).includes('❯ launch') && Array.from(bottom)[column] === '╰'
}
function familyWhole(frame: string[], head: string, nextHead: string, lineCount: number): boolean {
  const headRow = frame.findIndex(line => line.includes(`▸ ${head}`))
  if (headRow < 0) return false
  const column = frame[headRow]!.indexOf('▸')
  const nextRow = frame.findIndex((line, index) => index > headRow && line.slice(column).startsWith(`  ${nextHead}`))
  const lines = frame.slice(headRow + 1, nextRow > headRow ? nextRow : frame.length)
  const family = lines.filter(line => line.slice(column).startsWith('   '))
  const closing = nextRow > headRow || /esc close/.test(lines[family.length] ?? '')
  return family.length === lineCount && closing
}

function frameLaws(label: string, scene: Scene, cols: number, rows: number): string[] {
  const lines = scene.lines()
  check(`${label}: the frame has the terminal's rows and no row wider than its columns`, lines.length === rows && lines.every(line => width(line) <= cols), `${lines.length} rows · widest ${Math.max(...lines.map(width))}`)
  if (fullFrameOpen(lines)) check(`${label}: the full-width frame closes inside the terminal (its bottom border is painted)`, fullFrameClosed(lines), describe(lines))
  return lines
}

if (onlyRoute === undefined) {
  setActiveMission('the proof walks every route')
  for (const name of TEXT_ROUTES) {
    const command = commands.find(candidate => candidate.name === name && candidate.type === 'local-jsx')
    const done: unknown[][] = []
    const loaded = command === undefined ? null : typeof command.call === 'function' ? command.call : (await command.load()).call
    const element = loaded === null ? undefined : await loaded((...args: unknown[]) => { done.push(args) }, { messages: [], options: { commands }, getAppState: () => getDefaultAppState(), setAppState: () => {} } as never, '')
    check(`/${name} is a text command in a view's clothes: its call paints nothing and answers through onDone (so it stays out of the walk)`, command !== undefined && (element === null || element === undefined) && done.length === 1, `element ${element === null ? 'null' : typeof element} · done ${JSON.stringify(done).slice(0, 120)}`)
  }
}

for (const command of routes) {
  const name = `/${command.name}`
  for (const [cols, rows] of SIZES) {
    const label = `${name} ${cols}x${rows}`
    const scene = await openRoute(command, cols, rows)
    if (scene === null) continue
    const opening = frameLaws(`${label} open`, scene, cols, rows)
    save(`${command.name}-${cols}x${rows}-open`, opening)
    check(`${label}: the selection marker on open reads as the table says (${markerExpected(command.name, cols, 'open', opening) ? 'painted' : 'none'})`, markerPainted(opening, command.name) === markerExpected(command.name, cols, 'open', opening), describe(opening))
    for (let index = 0; index < DOWNS; index++) { scene.push(DOWN); await sleep(60) }
    await settled(scene.lines)
    const moved = frameLaws(`${label} after ↓ ×${DOWNS}`, scene, cols, rows)
    save(`${command.name}-${cols}x${rows}-down`, moved)
    if (markerExpected(command.name, cols, 'walked', moved)) check(`${label}: after ↓ ×${DOWNS} the selected row is still painted (the panel followed it)`, markerPainted(moved, command.name), describe(moved))
    else check(`${label}: after ↓ ×${DOWNS} no selection marker appears (the table says none)`, !markerPainted(moved, command.name), describe(moved))
    check(`${label}: no render fault`, !scene.faults().some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), scene.faults().join(' | ').slice(0, 300))
    await scene.close()
  }
  const scene = await openRoute(command, 177, 49)
  if (scene === null) continue
  for (let index = 0; index < 3; index++) { scene.push(DOWN); await sleep(60) }
  await settled(scene.lines)
  for (const [cols, rows] of RESIZE_STOPS) {
    await scene.resize(cols, rows)
    const frame = frameLaws(`${name} resize → ${cols}x${rows}`, scene, cols, rows)
    const hasMarker = markerExpected(command.name, cols, 'walked', frame)
    if (hasMarker) check(`${name} resize → ${cols}x${rows}: the selected row is still painted`, markerPainted(frame, command.name), describe(frame))
    scene.push(DOWN)
    await settled(scene.lines)
    if (hasMarker) check(`${name} resize → ${cols}x${rows}: ↓ keeps the selected row painted`, markerPainted(scene.lines(), command.name), describe(scene.lines()))
  }
  check(`${name} resize: no render fault`, !scene.faults().some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), scene.faults().join(' | ').slice(0, 300))
  await scene.close()
}

const critter = routes.find(command => command.name === 'critter')
if (critter !== undefined) {
  const scene = await openRoute(critter, 64, 20)
  if (scene !== null) {
    for (let index = 0; index < 2; index++) { scene.push(DOWN); await sleep(120) }
    await settled(scene.lines)
    const frame = scene.lines()
    save('critter-64x20-down-2', frame)
    const nameRow = frame.findIndex(line => line.includes('[3] '))
    check('/critter 64x20: ↓ ×2 brings the third card whole into view (its name row and its bottom border painted)', nameRow >= 0 && /^╰/.test(frame[nameRow + 2] ?? ''), describe(frame))
    await scene.close()
  }
  const wide = await openRoute(critter, 177, 49)
  if (wide !== null) {
    for (let index = 0; index < 2; index++) { wide.push(RIGHT); await sleep(120) }
    await settled(wide.lines)
    check('/critter 177x49: → ×2 selects the third card (the grid is one row there)', wide.lines().some(line => line.includes('[3] jellyfish')), describe(wide.lines()))
    for (const [cols, rows] of [[64, 20], [177, 49], [64, 20]] as Array<[number, number]>) {
      await wide.resize(cols, rows)
      const frame = wide.lines()
      save(`critter-resize-${cols}x${rows}-card-3`, frame)
      check(`/critter resize → ${cols}x${rows} with card 3 selected: the card is whole (its name, its ❯ launch row and its bottom border painted)`, cardWhole(frame, '[3] jellyfish'), describe(frame))
    }
    await wide.close()
  }
}

const caching = routes.find(command => command.name === 'caching')
if (caching !== undefined) {
  const scene = await openRoute(caching, 64, 20)
  if (scene !== null) {
    for (let index = 0; index < 4; index++) { scene.push(DOWN); await sleep(120) }
    await settled(scene.lines)
    const frame = scene.lines()
    save('caching-64x20-down-4', frame)
    check('/caching 64x20: ↓ ×4 keeps the focused family painted (the panel followed it under the fold)', markerPainted(frame, 'caching'), describe(frame))
    await scene.close()
  }
  const wide = await openRoute(caching, 177, 49)
  if (wide !== null) {
    for (let index = 0; index < 2; index++) { wide.push(DOWN); await sleep(120) }
    await settled(wide.lines)
    check('/caching 177x49: ↓ ×2 selects the Gemini family', wide.lines().some(line => /▸ Gemini/.test(line)), describe(wide.lines()))
    const wrapped = (cols: number): number => cols >= 100 ? 3 : 6
    for (const [cols, rows] of [[64, 20], [177, 49], [64, 20]] as Array<[number, number]>) {
      await wide.resize(cols, rows)
      const frame = wide.lines()
      save(`caching-resize-${cols}x${rows}-gemini`, frame)
      check(`/caching resize → ${cols}x${rows} with Gemini selected: the family's ${wrapped(cols)} lines are whole, the next family's head or the footer right after them`, familyWhole(frame, 'Gemini', 'DeepSeek', wrapped(cols)), describe(frame))
    }
    await wide.close()
  }
}

clearTimeout(hardLimit)
rmSync(HOME, { recursive: true, force: true })
console.log(`\nmodal-routes-reach: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
