#!/usr/bin/env bun
// gate-watch: src/commands/health/HealthCertificate.tsx src/commands/health/health.tsx src/components/CommandPopupSlot.tsx src/utils/cockpit/commandPopup.ts src/components/FullscreenLayout.tsx src/components/PopupGutter.tsx
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'health-popup-frames-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME
process.env.MERCURY_HEALTH_STATE_DIR = join(HOME, 'health-state')
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
const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const healthCommand = await import('../../src/commands/health/health.tsx')
const certificate = await import('../../src/commands/health/HealthCertificate.tsx')
const { CommandPopupLease } = await import('../../src/components/CommandPopupSlot.tsx')
const { claimCommandPopup } = await import('../../src/utils/cockpit/commandPopup.ts')
const h = React.createElement

const TITLE = 'Mercury · health'
const COMPOSER = 'Type a prompt'
const VERDICT = /(OK|ATTENTION|FAILED)/
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const HOME_KEY = '\x1b[H'
const PAGE_DOWN = '\x1b[6~'
const WHEEL_UP = '\x1b[<64;10;10M'
const WHEEL_DOWN = '\x1b[<65;10;10M'
const ENTER = '\r'
const ESC = '\x1b'
const CLICK_OUTSIDE = '\x1b[<0;3;3M\x1b[<0;3;3m'
const SIZES: Array<[number, number]> = [[178, 51], [80, 24], [100, 30], [64, 20]]
const LEGEND = '↵ details'
const DESTRUCTIVE = 'DESTRUCTIVE — this discards state'
const FIX_KEY = 'f'
const DEEP_KEY = 'd'
const RERUN_KEY = 'r'

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
  columns = 178
  rows = 51
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
const hardLimit = setTimeout(() => { console.error('health-popup-frames exceeded its deadline'); process.exit(1) }, 420_000)
hardLimit.unref()

type Window = { top: number; bottom: number; left: number; right: number; width: number; height: number; rows: string[] }

function windowOf(lines: string[]): Window | null {
  const titleRow = lines.findIndex(line => line.includes(TITLE))
  if (titleRow < 0) return null
  const titleAt = lines[titleRow]!.indexOf(TITLE)
  const left = lines[titleRow]!.lastIndexOf('│', titleAt)
  if (left < 0) return null
  let top = -1
  for (let y = titleRow; y >= 0; y--) {
    if (Array.from(lines[y]!)[left] === '╭') { top = y; break }
  }
  if (top < 0) return null
  const right = Array.from(lines[top]!).indexOf('╮', left + 1)
  if (right < 0) return null
  let bottom = -1
  for (let y = top + 1; y < lines.length; y++) {
    if (Array.from(lines[y]!)[left] === '╰') { bottom = y; break }
  }
  if (bottom < 0) return null
  const rows = lines.slice(top, bottom + 1).map(line => Array.from(line).slice(left, right + 1).join(''))
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1, rows }
}
const inner = (row: string): string => Array.from(row).slice(2, -2).join('').replace(/\s+$/, '')
const describe = (window: Window | null): string => (window === null ? 'no closed window' : `left ${window.left} · top ${window.top} · width ${window.width} · height ${window.height} (rows ${window.top}..${window.bottom})`)
const wholeBottom = (window: Window): boolean => Array.from(window.rows[window.height - 1]!).at(-1) === '╯'
const cursorRow = (window: Window): string | undefined => window.rows.map(inner).find(row => row.startsWith('▸ '))
const cursorLabel = (window: Window): string | undefined => cursorRow(window)?.slice(4, 4 + 18).trim()
const checkRows = (window: Window): string[] => window.rows.map(inner).filter(row => /^(▸|\s) [✓✕▲○◌·⊘] /.test(row))
const counter = (window: Window): number | null => {
  const m = /· (\d+)\/(\d+)\s*$/.exec(inner(window.rows[window.height - 2]!))
  return m ? Number(m[1]) : null
}
const save = (name: string, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}.txt`), `${lines.join('\n')}\n`)
}

type Scene = { lines: () => string[]; push: (data: string) => void; resize: (cols: number, rows: number) => Promise<void>; done: () => unknown[][]; close: () => Promise<void> }

type ReportFixture = Parameters<typeof certificate.MercuryHealthCertificate>[0]['report']

async function openScene(cols: number, rows: number, fixture?: ReportFixture): Promise<Scene> {
  initializeSurfaceRoute(ROOT_CHAT_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const done: unknown[][] = []
  const element = fixture === undefined
    ? await healthCommand.call((...args: unknown[]) => { done.push(args) }, { messages: [], options: {} } as never, '')
    : h(CommandPopupLease, { token: claimCommandPopup(certificate.healthPopupShape()) }, h(certificate.MercuryHealthCertificate, { onClose: () => { done.push([]) }, report: fixture }))
  const insertRef = { current: null } as React.MutableRefObject<unknown>
  const modalScrollRef = React.createRef<null>()
  function Transcript(): React.ReactNode {
    return h(Text, null, Array.from({ length: 3 }, (_, index) => `13:00:0${index + 1} [op] ❯ task ${index + 1}`).join('\n'))
  }
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
        statusBand: h(Text, null, 'activity specimen'),
        statusBandActive: false,
        modal: h(Box, { width: '100%', flexDirection: 'column' }, element),
        modalScrollRef,
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
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
  const stdout = new Output()
  stdout.columns = cols
  stdout.rows = rows
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness)))
  const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
  const painted = await until(() => lines().join('\n').includes(TITLE) && lines().join('\n').includes(COMPOSER))
  check(`the session painted the popup at ${cols}x${rows}`, painted, lines().slice(0, 6).join(' | '))
  const settled = await until(() => {
    const window = windowOf(lines())
    return window !== null && VERDICT.test(window.rows[1] ?? '')
  }, 60000)
  check(`the certificate settled with a verdict at ${cols}x${rows}`, settled, (windowOf(lines())?.rows ?? []).slice(0, 3).join(' | '))
  await sleep(400)
  return {
    lines,
    push: data => stdin.push(data),
    resize: async (nextCols, nextRows) => {
      stdout.columns = nextCols
      stdout.rows = nextRows
      stdout.emit('resize')
      await sleep(500)
    },
    done: () => done,
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}

function frameReadsRight(label: string, lines: string[], cols: number, rows: number, cursorAt?: string): Window | null {
  const window = windowOf(lines)
  console.log(`${label}: ${describe(window)}`)
  check(`${label}: one closed bordered window titled ${TITLE}`, window !== null && wholeBottom(window), lines.slice(0, 8).join(' | '))
  if (window === null) return null
  check(`${label}: the window lies inside the terminal (${cols}x${rows})`, window.right < cols && window.bottom < rows && window.left >= 0 && window.top >= 0, describe(window))
  check(`${label}: the verdict chip sits on the title row beside the lockup`, VERDICT.test(inner(window.rows[1]!)) && inner(window.rows[1]!).includes(`${TITLE} · `), inner(window.rows[1]!))
  const expected = certificate.healthPopupLayout(window.height, 0, 1000)
  check(`${label}: no provenance lecture or duplicate detail hint`, !window.rows.some(row => row.includes('every claim names its evidence') || inner(row) === LEGEND))
  const countsRow = window.rows.map(inner).find(row => /^\d+ checks/.test(row))
  check(`${label}: the ${expected.compact ? 'compact' : 'full'} chrome (${window.height} rows: ${expected.compact ? 'the provenance and counts lines yield to the rows' : 'provenance line, counts line, a blank, then the rows'})`, (countsRow !== undefined) === !expected.compact, countsRow ?? '(no counts row)')
  const footer = inner(window.rows[window.height - 2]!)
  check(`${label}: the hint footer is the window's last inner row`, footer.startsWith('↑↓ move · ↵ unfold') && footer.includes(certificate.HEALTH_POPUP_CLOSE_HINT.slice(0, 10)), footer)
  check(`${label}: the check rows are the list and the cursor row is inside the window`, checkRows(window).length > 0 && cursorRow(window) !== undefined, `${checkRows(window).length} rows · cursor ${cursorRow(window) ?? '(none)'}`)
  if (cursorAt !== undefined) check(`${label}: the cursor row stays where it was left (${cursorAt})`, cursorLabel(window) === cursorAt, cursorLabel(window) ?? '(none)')
  const composerRow = lines.findIndex(line => line.includes(COMPOSER))
  check(`${label}: the composer stays visible under the popup`, composerRow > window.bottom, `composer row ${composerRow}`)
  check(`${label}: the title paints once (nothing of the popup outside the frame)`, lines.filter(line => line.includes(TITLE)).length === 1)
  return window
}

section('§1 the popup at every size the product supports, each opened fresh')
for (const [cols, rows] of SIZES) {
  const scene = await openScene(cols, rows)
  const frame = scene.lines()
  save(`health-${cols}x${rows}`, frame)
  const window = frameReadsRight(`${cols}x${rows}`, frame, cols, rows)
  if (window !== null) {
    const first = checkRows(window)[0]
    check(`${cols}x${rows}: the cursor opens on the first check row`, first !== undefined && first.startsWith('▸ '), first ?? '(no rows)')
    if (cols >= 100) check(`${cols}x${rows}: the lanes rail stays visible left of the window`, frame.findIndex(line => line.includes('lanes')) >= 0 && Array.from(frame[window.top + 2] ?? '').slice(0, window.left).join('').trim() !== '')
  }
  await scene.close()
}

section('§2 the keys at 80x24: ↑↓, the wheel, ↵ → ← on a row, ⇞⇟, Home, then esc')
{
  const scene = await openScene(80, 24)
  const win = (): Window => windowOf(scene.lines())!
  const at = (): string => cursorLabel(win()) ?? '(none)'
  const first = at()
  scene.push(DOWN)
  await sleep(300)
  const second = at()
  check('↓ moves the cursor to the next check row', second !== first && second !== '(none)', `${first} → ${second}`)
  scene.push(WHEEL_DOWN)
  await sleep(300)
  const third = at()
  check('the mouse wheel down moves the cursor one row down', third !== second && third !== '(none)', `${second} → ${third}`)
  scene.push(WHEEL_UP)
  await sleep(300)
  check('the mouse wheel up moves the cursor one row up', at() === second, at())
  scene.push(UP)
  await sleep(300)
  check('↑ moves the cursor one row up', at() === first, at())
  scene.push(UP)
  await sleep(300)
  check('↑ at the first row clamps (never wraps)', at() === first, at())
  scene.push(DOWN)
  await sleep(300)
  const beforeOpen = cursorRow(win())!
  scene.push(ENTER)
  await sleep(400)
  const opened = cursorRow(win())!
  check('↵ unfolds the row\'s evidence in place (the evidence leaves the row\'s tail and opens beneath it)', opened.length < beforeOpen.length && win().rows.map(inner).some(row => row.startsWith('    ') && row.trim() !== ''), opened)
  save('health-80x24-unfolded', scene.lines())
  scene.push(LEFT)
  await sleep(400)
  check('← folds the row again', cursorRow(win()) === beforeOpen, cursorRow(win()) ?? '(none)')
  scene.push(RIGHT)
  await sleep(400)
  check('→ unfolds it again', cursorRow(win())!.length < beforeOpen.length, cursorRow(win()) ?? '(none)')
  scene.push(ENTER)
  await sleep(400)
  check('↵ on an unfolded row folds it', cursorRow(win()) === beforeOpen, cursorRow(win()) ?? '(none)')
  const beforePage = at()
  const topBefore = checkRows(win())[0]
  scene.push(PAGE_DOWN)
  await sleep(400)
  const visibleAfter = checkRows(win())
  check('⇟ pages the cursor a viewport down: the cursor row changed and the rows scrolled under it', at() !== beforePage && visibleAfter[0] !== topBefore && !visibleAfter.includes(topBefore!), `${beforePage} → ${at()} · top ${topBefore} → ${visibleAfter[0]}`)
  check('the viewport follows the cursor: the cursor row is still inside the window', cursorRow(win()) !== undefined)
  check('the footer sheds its tail whole at this width (no half segment)', !/·\s*$/.test(inner(win().rows[win().height - 2]!)) && (counter(win()) !== null || inner(win().rows[win().height - 2]!).endsWith('…') || inner(win().rows[win().height - 2]!).endsWith('deep')), inner(win().rows[win().height - 2]!))
  scene.push(HOME_KEY)
  await sleep(400)
  check('Home brings the cursor back to the first check', at() === first, at())
  scene.push(ESC)
  const closed = await until(() => scene.done().length > 0, 5000)
  check('esc closes the popup', closed, JSON.stringify(scene.done()))
  await scene.close()
}

section('§3 a click outside the popup closes it')
{
  const scene = await openScene(178, 51)
  scene.push(DOWN)
  await sleep(300)
  scene.push(CLICK_OUTSIDE)
  const closed = await until(() => scene.done().length > 0, 5000)
  check('a click on the chat beside the popup closes it like esc', closed, JSON.stringify(scene.done()))
  await scene.close()
}

section('§4 a live resize while the popup is open')
{
  const scene = await openScene(178, 51)
  scene.push(DOWN)
  await sleep(300)
  scene.push(DOWN)
  await sleep(300)
  const cursorBefore = cursorLabel(windowOf(scene.lines())!)
  const stops: Array<[number, number]> = [[80, 24], [64, 20], [100, 30], [178, 51]]
  for (const [cols, rows] of stops) {
    await scene.resize(cols, rows)
    const frame = scene.lines()
    save(`health-resize-${cols}x${rows}`, frame)
    frameReadsRight(`resize → ${cols}x${rows}`, frame, cols, rows, cursorBefore)
  }
  await scene.close()
}

section('§5 the fix card inside the popup: a destructive consent card never pushes the frame past its rows')
{
  const remedy = {
    plan: 'end the stale Mercury processes this box still runs (the sweep sends them the end signal and reads the table again)',
    class: 'destructive' as const,
    apply: async () => ({ ok: true, note: 'swept' }),
    verify: async () => ({ ok: true, note: 'none left' }),
  }
  const fixtureCert = (depth: 'fast' | 'deep') => ({
    verdict: 'caution' as const,
    ranAt: new Date().toISOString(),
    head: { sha: 'abc1234def', branch: 'lane/fixture', dirty: false },
    version: '1.0.0',
    durationMs: 12,
    depth,
    sections: [
      { id: 'processes', title: 'PROCESSES', checks: [
        { id: 'process-sweep', label: 'Mercury processes', status: 'warn' as const, evidence: '3 stale · 1 cannot end', fix: 'sweep the stale processes', remedy },
        { id: 'boots', label: 'Boots complete', status: 'ok' as const, evidence: 'no pending attempts' },
      ] },
      { id: 'git', title: 'GIT', checks: [
        { id: 'tree', label: 'Working tree', status: 'ok' as const, evidence: 'clean' },
      ] },
    ],
  })
  const depths: string[] = []
  const fixture: ReportFixture = async opts => {
    depths.push(opts?.depth ?? 'fast')
    return fixtureCert(opts?.depth ?? 'fast') as never
  }
  for (const [cols, rows] of SIZES) {
    const scene = await openScene(cols, rows, fixture)
    const before = windowOf(scene.lines())
    check(`${cols}x${rows}: the fixture certificate paints with the fix key offered on its fixable row`, before !== null && inner(before.rows[before.height - 2]!).includes('f fix'), before === null ? 'no window' : inner(before.rows[before.height - 2]!))
    scene.push(FIX_KEY)
    await sleep(400)
    const frame = scene.lines()
    save(`health-fixcard-${cols}x${rows}`, frame)
    const window = windowOf(frame)
    check(`${cols}x${rows}: f opens the destructive consent card inside the popup`, window !== null && window.rows.some(row => inner(row).includes(DESTRUCTIVE) || inner(row).includes('fix · Mercury processes')), window === null ? frame.slice(0, 12).join(' | ') : window.rows.map(inner).filter(row => row.includes('fix')).join(' | '))
    const composerRow = frame.findIndex(line => line.includes(COMPOSER))
    const budget = certificate.healthPopupShape().rows(rows)
    check(`${cols}x${rows}: with the card open the popup's bottom border is painted whole, inside its row budget, above the composer`, window !== null && wholeBottom(window) && window.height <= budget && window.bottom < composerRow, window === null ? 'the bottom border is clipped' : `height ${window.height} (budget ${budget}, was ${before?.height}) · bottom ${window.bottom} · composer ${composerRow}`)
    if (window !== null) {
      check(`${cols}x${rows}: the footer stays the last inner row above the card's frame`, inner(window.rows[window.height - 2]!).startsWith('↑↓ move') || inner(window.rows[window.height - 2]!).includes('esc'), inner(window.rows[window.height - 2]!))
      const compact = certificate.healthPopupLayout(window.height, 0, 1000).compact
      check(`${cols}x${rows}: ${compact ? 'the compact popup gives the card its room and the rows yield (the card is modal)' : 'at least one check row stays visible beside the card'}`, compact ? window.rows.some(row => inner(row).startsWith('╰')) : checkRows(window).length >= 1, `${checkRows(window).length} rows`)
    }
    scene.push(ESC)
    await sleep(300)
    await scene.close()
  }
  section('§6 r re-runs at the depth last run: d sets deep, r repeats it')
  depths.length = 0
  const scene = await openScene(80, 24, fixture)
  check('the first run is the fast certificate', depths.join(',') === 'fast', depths.join(','))
  scene.push(DEEP_KEY)
  await until(() => depths.length >= 2, 5000)
  await sleep(300)
  check('d re-runs deep', depths.join(',') === 'fast,deep', depths.join(','))
  scene.push(RERUN_KEY)
  await until(() => depths.length >= 3, 5000)
  await sleep(300)
  check('r after d re-runs DEEP again (the depth last run, as before)', depths.join(',') === 'fast,deep,deep', depths.join(','))
  await scene.close()
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
rmSync(HOME, { recursive: true, force: true })
console.log(`\nhealth-popup-frames: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
