#!/usr/bin/env bun
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, pinScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.ts'
import type { DOMElement } from '../../src/ink.js'

const REPO = join(import.meta.dir, '..', '..')
process.chdir(REPO)
const HOME = pinScratchHome('mercury-settings-popup-host-fit')
const frameDir = ((): string | undefined => {
  const index = process.argv.indexOf('--frames')
  return index < 0 ? undefined : process.argv[index + 1]
})()
if (frameDir) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const React = await import('react')
const { Box, Text } = await import('../../src/ink.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const slot = await import('../../src/components/SettingsPopupSlot.js')
const store = await import('../../src/utils/cockpit/settingsPopup.js')
const { configPopupRequest } = await import('../../src/commands/config/config.js')
const { CONFIG_POPUP_HINT, CONFIG_POPUP_WIDTH } = await import('../../src/components/Settings/Config.js')
const { railPlanAt } = await import('../../src/utils/helmGeometry.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

type Scene = { columns: number; rows: number; panel: number }
type Centre = { left: number; width: number; innerLeft: number; innerRight: number; innerWidth: number }

function centreOf(scene: Scene): Centre {
  const plan = railPlanAt(scene.columns, true)
  const left = plan.lanesW + scene.panel
  const width = scene.columns - plan.lanesW - scene.panel - plan.telemetryW
  return { left, width, innerLeft: left + 1, innerRight: left + width - 2, innerWidth: width - 2 }
}

const PANEL_ROWS = ['CERTIFIED', 'every check backed', 'runtime ok', 'settings ok', 'channel ok', 'keybindings ok', 'version locks ok']

function rail(width: number, rows: number, glyph: string, label: string): React.ReactNode {
  return React.createElement(
    Box,
    { flexDirection: 'column', width, flexShrink: 0, overflow: 'hidden' },
    ...Array.from({ length: rows }, (_, index) => React.createElement(Text, { key: index, wrap: 'truncate-end' }, index === 0 ? label.padEnd(width, glyph) : glyph.repeat(width))),
  )
}

function panel(width: number, rows: number): React.ReactNode {
  return React.createElement(
    Box,
    { flexDirection: 'column', width, flexShrink: 0, overflow: 'hidden', borderStyle: 'single', paddingX: 1 },
    React.createElement(Text, { bold: true }, 'health'),
    ...PANEL_ROWS.map((row, index) => React.createElement(Text, { key: index, dimColor: true, wrap: 'truncate-end' }, row)),
    ...Array.from({ length: Math.max(0, rows - 2 - PANEL_ROWS.length - 1) }, (_, index) => React.createElement(Text, { key: `pad-${index}` }, '~'.repeat(width - 4))),
  )
}

function scaffold(scene: Scene, centreRef: React.RefObject<DOMElement | null>): React.ReactNode {
  const plan = railPlanAt(scene.columns, true)
  const bottom = 3
  const body = scene.rows - bottom
  return React.createElement(
    AppStateProvider as never,
    {},
    React.createElement(
      ThemeProvider as never,
      {},
      React.createElement(
        Box,
        { flexDirection: 'column', width: scene.columns, height: scene.rows },
        React.createElement(
          Box,
          { flexDirection: 'row', flexGrow: 1, minHeight: 0, overflow: 'hidden' },
          rail(plan.lanesW, body, 'L', 'LANES'),
          scene.panel > 0 ? panel(scene.panel, body) : null,
          React.createElement(
            Box,
            { ref: centreRef, flexDirection: 'column', flexGrow: 1, minWidth: 0, overflow: 'hidden', borderStyle: 'round' },
            ...Array.from({ length: body - 2 }, (_, index) => React.createElement(Text, { key: index, wrap: 'truncate-end' }, index === 0 ? 'CENTRE' : 'c'.repeat(scene.columns))),
          ),
          rail(plan.telemetryW, body, 'R', 'TELEMETRY'),
        ),
        React.createElement(Box, { height: bottom, flexShrink: 0 }, React.createElement(Text, {}, 'B'.repeat(scene.columns))),
        React.createElement(slot.SettingsPopupSlot, { overlay: true, hostRef: centreRef, framed: true }),
      ),
    ),
  )
}

type Painted = { left: number; right: number; top: number; bottom: number; rows: string[]; ragged: number[] }

function painted(before: string[], after: string[]): Painted | null {
  let left = Number.POSITIVE_INFINITY
  let right = -1
  let top = -1
  let bottom = -1
  const rows: string[] = []
  for (let y = 0; y < after.length; y++) {
    const was = Array.from(before[y] ?? '')
    const now = Array.from(after[y] ?? '')
    const span = Math.max(was.length, now.length)
    let first = -1
    let last = -1
    for (let x = 0; x < span; x++) {
      if ((was[x] ?? ' ') === (now[x] ?? ' ')) continue
      if (first === -1) first = x
      last = x
    }
    if (first === -1) continue
    if (top === -1) top = y
    bottom = y
    left = Math.min(left, first)
    right = Math.max(right, last)
  }
  if (top === -1) return null
  const ragged: number[] = []
  for (let y = top; y <= bottom; y++) {
    const row = Array.from(after[y] ?? '')
    rows.push(row.slice(left, right + 1).join(''))
    const edges = [row[left] ?? ' ', row[right] ?? ' ']
    const corner = y === top ? ['╭', '╮'] : y === bottom ? ['╰', '╯'] : ['│', '│']
    if (edges[0] !== corner[0] || edges[1] !== corner[1]) ragged.push(y)
  }
  return { left, right, top, bottom, rows, ragged }
}

const SCAFFOLD_MARKS = ['LANES', 'CENTRE', 'TELEMETRY', 'BBBB']

function scaffoldPainted(screen: string, scene: Scene): boolean {
  return SCAFFOLD_MARKS.every(mark => screen.includes(mark)) && (scene.panel === 0 || screen.includes(PANEL_ROWS[0]!))
}

async function holdsStill(m: Mounted, polls: number, ms: number): Promise<boolean> {
  let last = m.screen()
  let run = 0
  return waitFor(() => {
    const now = m.screen()
    run = now === last ? run + 1 : 0
    last = now
    return run >= polls
  }, ms)
}

function sceneLabel(scene: Scene): string {
  return `${scene.columns}×${scene.rows}${scene.panel > 0 ? ' + panel' : ''}`
}

async function open(scene: Scene, request: ReturnType<typeof configPopupRequest>): Promise<{ m: Mounted; before: string[]; after: string[]; paint: Painted | null }> {
  const centreRef = React.createRef<DOMElement>()
  const m = await mountOffscreen(scaffold(scene, centreRef), scene.columns, scene.rows)
  const scaffoldUp = await waitFor(() => scaffoldPainted(m.screen(), scene), 4000)
  const scaffoldStill = scaffoldUp && (await holdsStill(m, 2, 2000))
  check(`${sceneLabel(scene)}: the scaffold painted and held still before the baseline frame was read`, scaffoldStill, scaffoldStill ? '' : scaffoldUp ? 'the scaffold kept changing for 2 s' : `after 4 s the screen held: ${JSON.stringify(m.lines().filter(line => line.length > 0).slice(0, 3))}`)
  const before = m.lines()
  store.openSettingsPopup(request)
  const title = `Mercury · ${request.view}`
  const hintHead = request.hint.slice(0, 12)
  const popupUp = await waitFor(() => m.screen().includes(title) && m.screen().includes(hintHead), 4000)
  const popupStill = popupUp && (await holdsStill(m, 2, 2000))
  check(`${sceneLabel(scene)}: the popup painted its title and its hint row and held still before the frame was read`, popupStill, popupStill ? '' : popupUp ? 'the popup kept changing for 2 s' : `after 4 s: title ${m.screen().includes(title) ? 'on screen' : 'absent'}, hint ${m.screen().includes(hintHead) ? 'on screen' : 'absent'}`)
  const after = m.lines()
  return { m, before, after, paint: painted(before, after) }
}

async function close(m: Mounted, view: string): Promise<void> {
  store.closeSettingsPopup()
  await waitFor(() => !m.screen().includes(`Mercury · ${view}`), 2000)
  m.unmount()
  await settle(40)
}

function untouched(before: string[], after: string[], from: number, to: number, rowsFrom: number, rowsTo: number): boolean {
  for (let y = rowsFrom; y <= rowsTo; y++) {
    const was = Array.from(before[y] ?? '').slice(from, to + 1).join('')
    const now = Array.from(after[y] ?? '').slice(from, to + 1).join('')
    if (was !== now) return false
  }
  return true
}

function judge(label: string, scene: Scene, paint: Painted | null, before: string[], after: string[], requested: number): void {
  const centre = centreOf(scene)
  const want = Math.min(requested, centre.innerWidth)
  check(`${label}: the popup painted`, paint !== null)
  if (paint === null) return
  const width = paint.right - paint.left + 1
  check(`${label}: the painted right edge never passes the centre column's inner edge (${centre.innerRight})`, paint.right <= centre.innerRight, `painted ${paint.left}..${paint.right}`)
  check(`${label}: the painted left edge never passes the centre column's inner edge (${centre.innerLeft})`, paint.left >= centre.innerLeft, `painted ${paint.left}..${paint.right}`)
  check(`${label}: the popup is ${want} wide (the request ${requested} clamped to the centre's ${centre.innerWidth}) and centred in the column`, width === want && paint.left === centre.innerLeft + Math.floor((centre.innerWidth - want) / 2), `${width} wide at ${paint.left}`)
  check(`${label}: no row is wider than its frame (every row keeps its two border cells at the frame's edges)`, paint.ragged.length === 0, `ragged rows ${JSON.stringify(paint.ragged)}: ${JSON.stringify(paint.ragged.map(y => (after[y] ?? '').slice(paint.left, paint.right + 1)))}`)
  const plan = railPlanAt(scene.columns, true)
  check(`${label}: the right rail's column is untouched beside the popup`, untouched(before, after, scene.columns - plan.telemetryW, scene.columns - 1, paint.top, paint.bottom))
  check(`${label}: the lanes rail and the panel are untouched beside the popup`, untouched(before, after, 0, centre.left - 1, paint.top, paint.bottom))
  check(`${label}: the frame closes on both corners`, paint.rows[0]!.startsWith('╭') && paint.rows[0]!.endsWith('╮') && paint.rows.at(-1)!.startsWith('╰') && paint.rows.at(-1)!.endsWith('╯'))
}

const context = { messages: [], options: {} } as never
const frame = (name: string, lines: string[]): void => {
  if (frameDir) writeFileSync(join(frameDir, `${name}.txt`), lines.join('\n') + '\n')
}

section('§1 178×51, both rails and a health panel on the left: /config fits the centre column')
{
  const scene: Scene = { columns: 178, rows: 51, panel: 44 }
  const { m, before, after, paint } = await open(scene, configPopupRequest(context))
  judge('178×51 + panel', scene, paint, before, after, CONFIG_POPUP_WIDTH)
  check('178×51 + panel: the hint row is cut to the narrower frame, never wrapped', paint !== null && !after.some(line => line.includes(CONFIG_POPUP_HINT)) && paint.rows.at(-2)!.includes('↑↓ select'), paint === null ? 'none' : paint.rows.at(-2))
  frame('config-beside-panel-178x51', after)
  await close(m, 'config')
}

section('§2 178×51, both rails, no panel: /config keeps its 110 columns at column 34')
{
  const scene: Scene = { columns: 178, rows: 51, panel: 0 }
  const { m, before, after, paint } = await open(scene, configPopupRequest(context))
  judge('178×51', scene, paint, before, after, CONFIG_POPUP_WIDTH)
  check('178×51: the hint row is whole at the page\'s width', paint !== null && paint.rows.at(-2)!.includes(CONFIG_POPUP_HINT), paint === null ? 'none' : paint.rows.at(-2))
  check('178×51: the popup still stands at column 34, 110 wide, as the page draws it', paint !== null && paint.left === 34 && paint.right === 143, paint === null ? 'none' : `${paint.left}..${paint.right}`)
  frame('config-rails-178x51', after)
  await close(m, 'config')
}

section('§3 160×51, both rails: the 110-column request no longer reaches into either rail')
{
  const scene: Scene = { columns: 160, rows: 51, panel: 0 }
  const { m, before, after, paint } = await open(scene, configPopupRequest(context))
  judge('160×51', scene, paint, before, after, CONFIG_POPUP_WIDTH)
  frame('config-rails-160x51', after)
  await close(m, 'config')
}

section('§4 178×51, both rails: a 150-column request (the usage popup\'s) fits the centre column too')
{
  const scene: Scene = { columns: 178, rows: 51, panel: 0 }
  const HINT = '↑↓ scroll · esc or click outside closes'
  const request = {
    view: 'usage' as const,
    width: 150,
    rows: 29,
    line: 'fixture · a body that paints its inner width',
    hint: HINT,
    body: (geometry: { inner: number; rowBudget: number }) =>
      React.createElement(
        Box,
        { flexDirection: 'column' },
        ...Array.from({ length: geometry.rowBudget }, (_, index) => React.createElement(Text, { key: index, wrap: 'truncate-end' }, 'u'.repeat(geometry.inner))),
      ),
  }
  const { m, before, after, paint } = await open(scene, request as never)
  judge('178×51 usage-wide', scene, paint, before, after, 150)
  check('178×51 usage-wide: the hint is the request\'s, whole', paint !== null && paint.rows.at(-2)!.includes(HINT), paint === null ? 'none' : paint.rows.at(-2))
  frame('usage-rails-178x51', after)
  await close(m, 'usage')
}

section('§5 the geometry, pure, and the layout wiring')
{
  const g = slot.settingsPopupGeometry({ width: 110, rows: 44 }, 116, 51, 31)
  check('a 116-column host at column 31: width 110, left 34, inner 106', g.width === 110 && g.left === 34 && g.inner === 106, JSON.stringify(g))
  const wide = slot.settingsPopupGeometry({ width: 150, rows: 29 }, 116, 51, 31)
  check('a 150-column request in a 116-column host clamps to 116 at column 31, inner 112', wide.width === 116 && wide.left === 31 && wide.inner === 112, JSON.stringify(wide))
  const narrow = slot.settingsPopupGeometry({ width: 110, rows: 44 }, 100, 51, 25)
  check('a 100-column host at column 25 clamps to 100 at column 25', narrow.width === 100 && narrow.left === 25, JSON.stringify(narrow))
  const whole = slot.settingsPopupGeometry({ width: 110, rows: 44 }, 178, 51)
  check('no host: the terminal is the host, left 34 as before', whole.width === 110 && whole.left === 34 && whole.top === 4, JSON.stringify(whole))
  check('the rows stay the terminal\'s: 44 from row 4 at 51 rows', g.rows === 44 && g.top === 4 && g.rowBudget === 37, JSON.stringify(g))
  const layout = readFileSync(join(REPO, 'src/components/FullscreenLayout.tsx'), 'utf8')
  check('the layout hands the cockpit slot its centre column as the host, framed as the column is', /<SettingsPopupSlot overlay=\{true\} hostRef=\{centreBoxRef\} framed=\{centerFrame\} \/>/.test(layout))
  check('the sequential road keeps the unhosted slot', layout.includes('<SettingsPopupSlot overlay={false} />'))
}

rmSync(HOME, { recursive: true, force: true })
console.log(`\nprove-settings-popup-host-fit: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
