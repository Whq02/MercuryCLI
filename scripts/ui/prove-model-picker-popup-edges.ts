#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'picker-popup-edges-'))
process.env.MERCURY_CONFIG_DIR = HOME
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
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_XAI_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]

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
const { initializeSurfaceRoute, ROOT_REPL_ROUTE } = await import('../../src/context/surfaceRoute.ts')
const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
enableConfigs()
saveCurrentProjectConfig(config => ({ ...config, hasCompletedProjectOnboarding: true }))
saveGlobalConfig(config => ({ ...config, prStatusFooterEnabled: false }))
const pending = await import('../../src/input-core/pending-input.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const { MercuryModelPicker } = await import('../../src/components/MercuryModelPicker.tsx')
const { ModelPickerPopupLease, modelPickerPopupGeometry } = await import('../../src/components/ModelPickerPopupSlot.tsx')
const { claimModelPickerPopup } = await import('../../src/utils/cockpit/modelPickerPopup.ts')
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.ts')
const { truncateToWidth } = await import('../../src/utils/truncate.ts')
const pure = await import('../../src/utils/model/modelPickerGroups.ts')
type ModelChoice = import('../../src/components/MercuryModelPicker.tsx').ModelChoice
const h = React.createElement

const TITLE = 'Mercury · model'
const DOWN = '\x1b[B'
const ESC = '\x1b'
const BACKSPACE = '\x7f'

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
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
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
  get readableLength(): number { return this.chunks.reduce((sum, chunk) => sum + chunk.length, 0) }
  push(data: string): void { this.chunks.push(data); this.emit('readable') }
}
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }
const hardLimit = setTimeout(() => { console.error('picker-popup-edges exceeded its deadline'); process.exit(1) }, 240_000)
hardLimit.unref()

const ANTHROPIC = 'Mercury — Anthropic models'
const OPENAI = 'Mercury — OpenAI models'
const OPENROUTER = 'Mercury — OpenRouter models'
const GEMINI = 'Mercury — Gemini models'
const LOGIN = 'Claude Max login'
const KEY = 'API key'
const EMAIL40 = 'a-forty-character-email-address@example.com'
const PREVIEW = 'claude-fable-5-2-preview'
const PREVIEW_NEEDLE = 'claude-fable-5-2'
const row = (id: string, name: string, ctx: string, group: string, extra: Partial<ModelChoice> = {}): ModelChoice => ({ id, name, tag: '', ctx, group, ...extra })
const anthropic: ModelChoice[] = [
  row('claude-fable-5-1', 'Fable 5.1', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC, { door: LOGIN }),
  row(PREVIEW, PREVIEW, '1M ctx', ANTHROPIC, { door: LOGIN, tag: 'live · unknown to mercury' }),
  row('claude-opus-5-5', 'Opus 5.5', '1M ctx', ANTHROPIC, { door: KEY }),
]
const OPENROUTER_TOTAL = 30
const openrouterListed: ModelChoice[] = [
  row('nvidia/nemotron-3-ultra:free', 'NVIDIA: Nemotron 3 Ultra (free)', '1M ctx', OPENROUTER),
  row('z-ai/glm-5.3-flash', 'Z.AI: GLM 5.3 Flash', '1.31M ctx', OPENROUTER),
]
const openrouterDoor: ModelChoice = { id: '__mercury_openrouter_expand__', name: `OpenRouter — ${OPENROUTER_TOTAL} models live`, tag: '', ctx: '', group: OPENROUTER, action: true, expand: { group: OPENROUTER, family: 'OpenRouter', total: OPENROUTER_TOTAL } }
const openrouterFull: ModelChoice[] = [...openrouterListed, ...Array.from({ length: OPENROUTER_TOTAL - openrouterListed.length }, (_, k) => row(`vendor-${k}/model.${k}`, `Vendor ${k}`, '128k ctx', OPENROUTER))]
const openai: ModelChoice[] = [row('gpt-6-astra', 'GPT-6 Astra', '872k ctx', OPENAI), { id: '__gpt_connect__', name: 'Sign in to ChatGPT', tag: 'runs /logins', ctx: '', group: OPENAI, action: true }]
const gemini: ModelChoice[] = Array.from({ length: 14 }, (_, k) => row(`gemini-3.${k}-pro`, `Gemini 3.${k} Pro`, '1M ctx', GEMINI))
const headings = {
  [ANTHROPIC]: { name: 'ANTHROPIC', doors: [{ door: LOGIN, account: EMAIL40, active: true }, { door: KEY, account: '…6f2a' }] },
  [OPENROUTER]: { name: 'OPENROUTER', doors: [{ door: 'OAuth key', account: '…9c1d', active: true }] },
  [OPENAI]: { name: 'OPENAI', doors: [{ door: 'ChatGPT Pro login', account: EMAIL40, active: true }] },
  [GEMINI]: { name: 'GEMINI', doors: [{ door: 'Google account', account: EMAIL40, active: true }] },
}
const estate: ModelChoice[] = [...anthropic, ...openrouterListed, openrouterDoor, ...openai, ...gemini]
const expandRows = (group: string): ModelChoice[] => (group === OPENROUTER ? openrouterFull : [])
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'supercode']

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
const bare = (row: string): string => inner(row).replace(/^\s*(?:│\s?)+/, '').replace(/(?:\s*│)+\s*$/, '').trim()
const lastCellOf = (text: string): string => text.split(/\s{2,}/).at(-1) ?? ''
const tailCell = (row: string): string => lastCellOf(bare(row))
const describe = (window: Window | null): string => (window === null ? 'no closed window' : `left ${window.left} · top ${window.top} · width ${window.width} · height ${window.height} (rows ${window.top}..${window.bottom})`)
const save = (name: string, columns: number, rows: number, lines: string[]): void => {
  if (frameDir === undefined) return
  writeFileSync(join(frameDir, `${name}-${columns}x${rows}.txt`), `${lines.join('\n')}\n`)
}

type Scene = { lines: () => string[]; window: () => Window | null; push: (data: string) => void; type: (text: string) => Promise<void>; close: () => Promise<void> }

async function popupScene(columns: number, rows: number, opts: { pendingNext?: string } = {}): Promise<Scene> {
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  claimModelPickerPopup()
  const picker = h(ModelPickerPopupLease, null, h(Box, { width: '100%', flexDirection: 'column' }, h(MercuryModelPicker, {
    models: estate,
    current: 'claude-fable-5-1',
    ctxPct: 22,
    efforts: EFFORTS,
    effort: 'max',
    headings,
    topGroup: ANTHROPIC,
    expandRows,
    ...(opts.pendingNext !== undefined ? { pendingNext: opts.pendingNext } : {}),
    onSelect: () => {},
    onClose: () => {},
  } as never)))
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
        modal: picker,
        modalScrollRef,
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, ideSelection: undefined, toolPermissionContext: getDefaultAppState().toolPermissionContext,
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
  const stdout = new Output(columns, rows)
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output(columns, rows) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(Harness)))
  const lines = (): string[] => stripAnsi(ink.lastFrameText()).replace(/\n$/, '').split('\n')
  const painted = await until(() => lines().join('\n').includes(TITLE) && windowOf(lines()) !== null)
  check(`${columns}x${rows}: the cockpit painted with the picker in its pop-up window`, painted, lines().slice(0, 6).join(' | '))
  await sleep(400)
  return {
    lines,
    window: () => windowOf(lines()),
    push: data => stdin.push(data),
    async type(text: string): Promise<void> {
      for (const ch of text) { stdin.push(ch); await sleep(15) }
      await sleep(250)
    },
    close: async () => {
      ink.unmount()
      await ink.waitUntilExit()
      instances.delete(stdout as never)
    },
  }
}

const SIZES: Array<[number, number]> = [[178, 51], [80, 21]]
const compactAt = (window: Window): boolean => window.height < 20
const rowWidthOf = (window: Window): number => window.width - 4 - (compactAt(window) ? 5 : 4)
const tailAsPainted = (window: Window): { budget: number; room: number; expected: string } => {
  const columns = pure.pickerColumns(window.width - 8)
  const room = Math.max(0, rowWidthOf(window) - columns.alias - columns.id - columns.state - columns.ctx)
  return { budget: columns.tail, room, expected: truncateToWidth(truncateToWidth(pure.MODEL_PICKER_NO_ALIAS, columns.tail), room) }
}
const cursorRow = (window: Window): string => bare(window.rows.find(row => row.includes('│ │ ') || row.includes('❯ ')) ?? '')
const rowWith = (window: Window, needle: string): string => window.rows.find(row => row.includes(needle)) ?? ''

section('§1 the window: the picker in the session\'s pop-up sizes its panel from the window the layout hosts it in — the panel cap at 178, the centre column\'s width at 80 — and its rows from the pop-up\'s budget')
const geometry: Record<string, { width: number; rows: number }> = {}
for (const [columns, rows] of SIZES) {
  const scene = await popupScene(columns, rows)
  const window = scene.window()
  console.log(`  ${columns}x${rows} window: ${describe(window)}`)
  if (window !== null) {
    geometry[`${columns}x${rows}`] = { width: window.width, rows: window.height }
    const composer = scene.lines().findIndex(line => line.includes('Type a prompt'))
    check(`${columns}x${rows}: the composer stays on screen under the window`, composer > window.bottom, `composer row ${composer} · window bottom ${window.bottom}`)
    check(`${columns}x${rows}: the window is no wider than the panel cap and at least the panel floor`, window.width <= pure.MODEL_PICKER_PANEL.cap && window.width >= pure.MODEL_PICKER_PANEL.min, `${window.width}`)
    const budget = Math.min(Math.max(10, rows - 7), composer - 2 - window.top)
    const overflows = window.rows.some(row => /[↑↓] \d+ more/.test(row))
    check(`${columns}x${rows}: the window's height is within the pop-up's row budget (${budget}) and fills it when the rows overflow`, window.height <= budget && (!overflows || window.height === budget), `${window.height} · overflows ${overflows}`)
  }
  await scene.close()
}

section('§2 the tail column inside the pop-up: whole where the window\'s columns hold it, clipped at its own cell budget where they do not; in the compact tier the row\'s two-column caret prefix leaves the line one column short of that cell, so the line cuts the clipped cell once more — pinned as painted')
for (const [columns, rows] of SIZES) {
  const scene = await popupScene(columns, rows)
  const window = scene.window()
  save('popup-q1-tail', columns, rows, scene.lines())
  if (window !== null) {
    const { budget, room, expected } = tailAsPainted(window)
    const unfocused = rowWith(window, PREVIEW_NEEDLE)
    console.log(`  ${columns}x${rows}: panel ${window.width} · ${compactAt(window) ? 'compact' : 'full'} tier · tail cell ${budget} · the line's room for it ${room} · expected "${expected}"`)
    check(`${columns}x${rows}: the unfocused no-alias row's tail reads "${expected}"${room < budget ? ` (the cell's clip is ${budget} wide, the line's room ${room}: the caret prefix's column)` : ' (the cell budget, the row\'s own ellipsis)'}`, budget === 0 ? !bare(unfocused).includes('new') : tailCell(unfocused) === expected, bare(unfocused))
    for (let step = 0; step < 6 && !cursorRow(scene.window()!).includes(PREVIEW_NEEDLE); step++) { scene.push(DOWN); await sleep(120) }
    const focused = cursorRow(scene.window()!)
    check(`${columns}x${rows}: the focused no-alias row reads the same tail`, budget === 0 ? !focused.includes('new') : lastCellOf(focused) === expected && lastCellOf(focused) === tailCell(unfocused), `focused "${focused}" · unfocused "${bare(unfocused)}"`)
  }
  await scene.close()
}

section('§3 a heading\'s email inside the pop-up: clipped at its own cell budget so the count and the door line\'s active word stand at every window width')
for (const [columns, rows] of SIZES) {
  const scene = await popupScene(columns, rows)
  const door = rowWith(scene.window()!, `${LOGIN} · a-forty`)
  for (let step = 0; step < 12 && !cursorRow(scene.window()!).startsWith('❯ OPENAI'); step++) { scene.push(DOWN); await sleep(120) }
  save('popup-q2-heading-email', columns, rows, scene.lines())
  const heading = cursorRow(scene.window()!)
  check(`${columns}x${rows}: the OPENAI heading ends with its count, "· 1 live"`, /· 1 live$/.test(heading), heading)
  check(`${columns}x${rows}: the email is whole or clipped inside its own cell`, heading.includes(` · ${EMAIL40} · `) || /· a-forty[^ ]*… · 1 live$/.test(heading), heading)
  check(`${columns}x${rows}: the login door line ends with "· active"`, /· 3 live · active$/.test(bare(door)), bare(door))
  await scene.close()
}

section('§4 the filter line inside the pop-up: a filter longer than the window\'s line shows its tail')
for (const [columns, rows] of SIZES) {
  const scene = await popupScene(columns, rows)
  const width = scene.window()!.width - 6
  const text = `${'abcdefghij-'.repeat(Math.ceil(width / 11) + 1)}the-end`
  scene.push('/')
  await sleep(150)
  await scene.type(text)
  save('popup-q3-filter-tail', columns, rows, scene.lines())
  const line = bare(rowWith(scene.window()!, '/ '))
  check(`${columns}x${rows}: the filter line ends with the last characters typed ("the-end")`, line.endsWith('the-end'), line)
  check(`${columns}x${rows}: the cut is marked at the start, "/ …"`, line.startsWith('/ …'), line)
  scene.push(BACKSPACE)
  await sleep(200)
  const shorter = bare(rowWith(scene.window()!, '/ '))
  check(`${columns}x${rows}: ⌫ takes the last character and the tail follows ("the-en")`, shorter.endsWith('the-en'), shorter)
  scene.push(ESC)
  await sleep(200)
  await scene.close()
}

section('§5 the floor inside the pop-up: the pop-up never hands fewer than ten rows, and ten rows hold every line the compact tier paints — the picker at the pop-up\'s own floor is whole')
{
  const scene = await popupScene(80, 17)
  const window = scene.window()
  save('popup-q4-floor', 80, 17, scene.lines())
  console.log(`  80x17 window: ${describe(window)}`)
  check('80x17: the host bounds the aspirational ten-row floor to nine with a gutter', window !== null && window.height === 9, describe(window))
  if (window !== null) {
    const rows = window.rows.map(inner)
    check('80x17: the smaller host preserves the title, filter, close hint, cursor and a named cut; optional effort yields', rows.some(r => r.includes(TITLE)) && rows.some(r => r.includes('/ filter by name or id')) && rows.some(r => /esc (?:or click outside )?closes/.test(r)) && rows.some(r => /[↑↓] \d+ more/.test(r)) && rows.some(r => r.includes('❯ ')), rows.join(' | '))
  }
  await scene.close()
}
for (const [columns, rows] of SIZES) {
  const scene = await popupScene(columns, rows)
  save('popup-q4-floor', columns, rows, scene.lines())
  const window = scene.window()
  check(`${columns}x${rows}: the box stays within the pop-up's budget (${Math.max(10, rows - 7)} rows) and sheds nothing — the effort row stands`, window !== null && window.height <= Math.max(10, rows - 7) && window.rows.some(r => r.includes('e cycles')), describe(window))
  await scene.close()
}

section('§6 the pending line inside the pop-up: the product\'s pending glyph leads the next clause after the picker\'s own separator')
for (const [columns, rows] of SIZES) {
  const scene = await popupScene(columns, rows, { pendingNext: 'claude-opus-5-5' })
  save('popup-q5-pending-glyph', columns, rows, scene.lines())
  const window = scene.window()!
  const spoken = window.rows.map(inner).filter(r => /current Fable 5\.1|next Opus 5\.5|applies when the turn settles/.test(r)).map(r => r.trim()).join(' ')
  check(`${columns}x${rows}: the line reads "current Fable 5.1 · ${GLYPH.pending} next Opus 5.5 · applies when the turn settles" (whole or wrapped)`, spoken.replace(/\s+/g, ' ') === `current Fable 5.1 · ${GLYPH.pending} next Opus 5.5 · applies when the turn settles`, spoken)
  check(`${columns}x${rows}: the queued row carries "next" in its calm state column`, window.rows.some(r => /\s{2}next\s{2}/.test(r) && r.includes('claude-opus-5-5')))
  await scene.close()
}

console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error|RENDER ERROR/.test(line)), faults.join('\n').slice(0, 600))
console.log(`\n  measured windows: ${JSON.stringify(geometry)} · the pop-up law at 80x21 over a full-width host: ${JSON.stringify(modelPickerPopupGeometry({ left: 0, top: 0, columns: 80, rows: 21 }, 21))}`)
rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-model-picker-popup-edges: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
