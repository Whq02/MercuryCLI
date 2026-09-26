#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'frame-fill-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_HELM_HOME = '1'
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
process.env.MERCURY_BOOT_PREFLIGHT = '0'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_LIVE_CLOCK = '0'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.BROWSER = '/usr/bin/true'

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
const h = React.createElement
const ROOT = join(import.meta.dir, '..', '..')
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
async function until(predicate: () => boolean): Promise<boolean> {
  let expired = false
  const timer = setTimeout(() => { expired = true }, 15000)
  while (!predicate() && !expired) await new Promise<void>(resolve => setImmediate(resolve))
  clearTimeout(timer)
  return predicate()
}
class Output extends EventEmitter {
  isTTY = true
  columns = 120
  rows = 40
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
type Shape = {
  rows: number
  inkRows: number
  firstInkRow: number
  lastInkRow: number
  frameTop: number
  centreBottom: number
  composerTop: number
  outlineRows: number
}
function shapeOf(lines: string[]): Shape {
  const ink = lines.map((line, index) => (line.trim() === '' ? -1 : index)).filter(index => index >= 0)
  const composerRow = lines.findIndex(line => line.includes('Type a prompt'))
  const composerTop = composerRow - 1
  let centreBottom = -1
  for (let index = composerTop - 1; index >= 0; index--) {
    if (lines[index]!.includes('╰')) { centreBottom = index; break }
  }
  const frameTop = lines.findIndex(line => line.includes('╭'))
  let outlineRows = 0
  for (let index = frameTop; index <= centreBottom; index++) if (/[╭╰│]/.test(lines[index] ?? '')) outlineRows++
  return {
    rows: lines.length,
    inkRows: ink.length,
    firstInkRow: ink[0] ?? -1,
    lastInkRow: ink[ink.length - 1] ?? -1,
    frameTop,
    centreBottom,
    composerTop,
    outlineRows,
  }
}
const describe = (shape: Shape): string =>
  `${shape.rows} rows · ink rows ${shape.inkRows} · first ink row ${shape.firstInkRow} · last ink row ${shape.lastInkRow} · frame top ${shape.frameTop} · centre bottom border row ${shape.centreBottom} · composer top border row ${shape.composerTop} · outline rows ${shape.outlineRows}`
const stored = JSON.parse(readFileSync(join(ROOT, 'design-system/live/grids/frame--120x40--dark--truecolor--full.grid.json'), 'utf8')) as { rows: number; text: string[] }
const storedShape = shapeOf(stored.text)
console.log(`stored 120x40 grid: ${describe(storedShape)}`)
check('the stored 120x40 grid fills its 40 rows from the frame top to the last row', storedShape.rows === 40 && storedShape.frameTop === 0 && storedShape.firstInkRow === 0 && storedShape.lastInkRow === 39 && storedShape.centreBottom === 33 && storedShape.composerTop === 35)
const faults: string[] = []
const originalError = console.error
console.error = (...args: unknown[]): void => { faults.push(args.map(String).join(' ')); originalError(...args) }
const hardLimit = setTimeout(() => { console.error('frame-fill exceeded its deadline'); process.exit(1) }, 120_000)
hardLimit.unref()
async function renderAt(columns: number, rows: number): Promise<string[]> {
  initializeSurfaceRoute(ROOT_REPL_ROUTE)
  resetChromeModeLatchForTests()
  pending.edit('')
  pending.setMode('prompt')
  const stdout = new Output()
  stdout.columns = columns
  stdout.rows = rows
  const stdin = new Input()
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output() as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  const insertRef = { current: null } as React.MutableRefObject<import('../../src/components/PromptInput/PromptInput.tsx').PromptInputProps['insertTextRef']['current']>
  function Transcript(): React.ReactNode {
    return h(Text, null, Array.from({ length: 3 }, (_, index) => `13:00:0${index + 1} [sam] ❯ task ${index + 1}`).join('\n'))
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
        bottom: h(PromptInput, {
          compactWork: controls, compactFocus: focus,
          debug: false, ideSelection: undefined, toolPermissionContext: getDefaultAppState().toolPermissionContext,
          setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [],
          isLoading: false, verbose: false, submitCount: 0, onShowMessageSelector: () => {},
          mcpClients: [], vimMode, setVimMode, showBashesDialog: bashes, setShowBashesDialog: setBashes,
          onExit: () => {}, getToolUseContext: () => ({} as never),
          onSubmit: async () => {},
          isSearchingHistory: searching, setIsSearchingHistory: setSearching, helpOpen: help, setHelpOpen: setHelp,
          hasSuppressedDialogs: false, isLocalJSXCommandActive: false, insertTextRef: insertRef,
        }),
      }),
    )
  }
  ink.render(h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined }, h(Harness)))
  try {
    const painted = await until(() => insertRef.current !== null && ink.lastFrameText().includes('Type a prompt') && ink.lastFrameText().includes('lanes'))
    check(`${columns}x${rows}: the cockpit paints its composer placeholder and the lanes header`, painted, ink.lastFrameText().slice(0, 400))
    await new Promise<void>(resolve => setTimeout(resolve, 150))
    return ink.lastFrameText().replace(/\n$/, '').split('\n')
  } finally {
    ink.unmount()
    await ink.waitUntilExit()
    instances.delete(stdout as never)
  }
}
const SIZES: Array<[number, number]> = [[120, 40], [178, 51], [200, 60], [269, 70]]
const shapes = new Map<string, Shape>()
for (const [columns, rows] of SIZES) {
  const lines = await renderAt(columns, rows)
  const shape = shapeOf(lines)
  shapes.set(`${columns}x${rows}`, shape)
  console.log(`${columns}x${rows}: ${describe(shape)}`)
  if (frameDir !== undefined) writeFileSync(join(frameDir, `frame-fill-${columns}x${rows}.txt`), `${lines.join('\n')}\n`)
  check(`${columns}x${rows}: the frame's rows equal the terminal's rows`, shape.rows === rows, `${shape.rows} rows for a ${rows}-row terminal`)
  check(`${columns}x${rows}: the first row is the frame's top (no blank rows above)`, shape.frameTop === 0 && shape.firstInkRow === 0 && lines[0]!.includes('lanes'), `frame top ${shape.frameTop}, first ink row ${shape.firstInkRow}`)
  check(`${columns}x${rows}: the last row is the frame's bottom (no blank rows below)`, shape.lastInkRow === rows - 1, `last ink row ${shape.lastInkRow}`)
  check(`${columns}x${rows}: the outline spans every row from the frame top to the centre column's bottom border`, shape.outlineRows === shape.centreBottom + 1, `${shape.outlineRows} outline rows over ${shape.centreBottom + 1}`)
  check(`${columns}x${rows}: every row is at most ${columns} cells wide`, lines.every(line => [...line.replace(/\x1b\[[0-9;]*m/g, '')].length <= columns))
}
const base = shapes.get('120x40')!
for (const [columns, rows] of SIZES) {
  const shape = shapes.get(`${columns}x${rows}`)!
  check(`${columns}x${rows}: the bottom block keeps the height it has at 120x40 and the centre column takes every remaining row`, rows - shape.centreBottom === 40 - base.centreBottom && rows - shape.composerTop === 40 - base.composerTop, `centre bottom at ${rows - shape.centreBottom} from the end (120x40: ${40 - base.centreBottom}), composer top at ${rows - shape.composerTop} from the end (120x40: ${40 - base.composerTop})`)
}
check('120x40: the source render and the stored grid share the fill facts (rows, frame top, first and last ink rows)', base.rows === storedShape.rows && base.frameTop === storedShape.frameTop && base.firstInkRow === storedShape.firstInkRow && base.lastInkRow === storedShape.lastInkRow, `${describe(base)} vs ${describe(storedShape)}`)
console.error = originalError
clearTimeout(hardLimit)
check('no render or hook-order fault occurred', !faults.some(line => /render fault|Rendered (?:more|fewer) hooks|Minified React error/.test(line)), faults.join('\n'))
rmSync(HOME, { recursive: true, force: true })
console.log(`frame-fill: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
