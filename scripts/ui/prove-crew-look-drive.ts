#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { LEAD_ASK, TABLE, TABLE_BEFORE, WIDE, WIDE_TEXT, startCrewLookFixture, type Fixture } from '../crew/crew-look-fixture.ts'

const ROOT = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const SIZES = (argAfter('--sizes') ?? '269x70,178x51,120x40').split(',').map(s => s.split('x').map(Number) as [number, number])
const KEEP = process.argv.includes('--keep')
const DUMP = process.argv.includes('--dump')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
const CREW_TITLE = 'Mercury — crew'
const MODEL_TITLE = 'Mercury · model'
const FILES_TITLE = 'Mercury · files'
const USAGE_TITLE = 'Mercury · usage'
const CONFIG_TITLE = 'Mercury · config'
const USAGE_HINT = '↑↓ scroll · esc or click outside closes'
const CONFIG_HINT = '←/→ change'
const LEAD_ROW = '✶ Mercury Lead'
const HARBOUR_RUNNING = '◐ harbo'
const ATLAS_RUNNING = '◐ atlas'
const FJORD_RUNNING = '◐ fjord'
const PILL = 'back to the bottom'
const ESC = '\x1b'
const TAB = '\t'
const UP = '\x1b[A'
const PAGE_UP = '\x1b[5~'
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
const PASTED = 'a long pasted line for the crewmate: ' + Array.from({ length: 22 }, (_, i) => `segment-${String(i + 1).padStart(2, '0')}-of-the-paste`).join(' ')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first, or name a bundle with --dist`)
  process.exit(0)
}
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Cell = { c?: string; fg?: string; bg?: string; bold?: boolean }
type Grid = Cell[][]
const cellGlyph = (cell: Cell | undefined): string => (cell === undefined ? ' ' : (cell.c ?? ' ') === '' ? ' ' : (cell.c ?? ' '))
const rowsOf = (grid: Grid): string[] => grid.map(row => row.map(cellGlyph).join(''))
type Mark = { rows: string[]; grid: Grid; cols: number; lines: number }
type Capture = { marks: Record<string, Mark>; final: Mark; sends: number; receipts: number; endReason: string; status: number | null }

async function capture(name: string, cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'crew-look-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(460_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid for ${name}: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid; cols: number; rows: number }>; endReason?: string }
  if (FRAMES !== undefined) writeFileSync(join(FRAMES, `${name}-timing.json`), JSON.stringify({ ...payload, sends: cfg.sends }, (key, value) => key === 'grid' ? undefined : value, 2) + '\n')
  const marks: Record<string, Mark> = {}
  const toMark = (grid: Grid): Mark => ({ rows: rowsOf(grid), grid, cols: grid[0]?.length ?? 0, lines: grid.length })
  for (const m of payload.marks ?? []) marks[m.label] = toMark(m.grid)
  rmSync(dir, { recursive: true, force: true })
  return { marks, final: toMark(payload.grid), sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0, endReason: payload.endReason ?? '', status }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'crew-look-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'crew-look-cwd-')))
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipSovereignConsentPrompt: true }))
  writeFileSync(join(cwd, TABLE), TABLE_BEFORE)
  writeFileSync(join(cwd, WIDE), WIDE_TEXT)
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  const env: Record<string, string> = {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_SKIP_PERMISSIONS: '1',
    ANTHROPIC_BASE_URL: fixtureBase,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    BROWSER: '/usr/bin/true',
  }
  for (const stamp of ['MERCURY_TEAMMATES', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_DAEMON_CREW', 'MERCURY_CREW', 'NODE_ENV', 'CI']) delete process.env[stamp]
  return env
}

type Send = Record<string, unknown>
const bootSends = (ask: string): Send[] => [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
]
const see = (needle: string, mark: string, settle = 4, extra: Send = {}): Send => ({ data: '', atTick: 1500, awaitText: needle, requireAwait: true, minTick: 1, awaitSettleTicks: settle, mark, ...extra })
const clickOn = (needle: string, extra: Send = {}): Send => ({ data: CLICK, targetText: needle, atTick: 1500, awaitText: needle, requireAwait: true, minTick: 1, awaitSettleTicks: 2, ...extra })
const type = (data: string, ticks = 2, extra: Send = {}): Send => ({ data, afterPrevTicks: ticks, ...extra })
const later = (ticks: number, mark: string): Send => ({ data: '', afterPrevTicks: ticks, mark })
const popupTitles = { '/usage': USAGE_TITLE, '/config': CONFIG_TITLE, '/model': MODEL_TITLE, '/files': FILES_TITLE, '/teammates': CREW_TITLE }
const regexLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const seePopup = (title: string, needle: string, mark: string): Send => see(needle, mark, 6, {
  awaitPattern: String.raw`\A[^\n]*╭─+╮(?=[\s\S]*${regexLiteral(title)})(?=[\s\S]*${regexLiteral(needle)})(?=[\s\S]*\n│[❯›][^\n]*│(?: *\n| *\Z))`,
})
const popup = (command: keyof typeof popupTitles, needle: string, tag: string, typeTicks = 3): Send[] => [type(command, typeTicks), type('\r', 3), seePopup(popupTitles[command], needle, `${tag}-open`), type(ESC, 3), later(8, `${tag}-closed`)]

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()
const cells = (line: string): string[] => Array.from(line)

type Cockpit = { left: number; right: number; top: number; bottom: number; cols: number; composerTop: number; composerBottom: number; railRight: number; telemetryLeft: number | null }
function cockpitOf(rows: string[]): Cockpit | null {
  const first = cells(rows[0] ?? '')
  const left = first.indexOf('╭')
  if (left < 0) return null
  const right = first.indexOf('╮', left + 1)
  if (right < 0) return null
  let bottom = -1
  for (let y = 1; y < rows.length; y++) if (cells(rows[y]!)[left] === '╰') { bottom = y; break }
  if (bottom < 0) return null
  const cols = first.length
  let composerTop = -1
  let composerBottom = -1
  for (let y = bottom + 1; y < rows.length; y++) {
    const line = cells(rows[y]!)
    if (composerTop < 0 && line[0] === '╭') composerTop = y
    else if (composerTop >= 0 && line[0] === '╰') { composerBottom = y; break }
  }
  let telemetryLeft: number | null = null
  for (let y = 0; y < Math.min(6, rows.length) && telemetryLeft === null; y++) {
    const at = cells(rows[y]!).indexOf('╭', right + 1)
    if (at > right) telemetryLeft = at
  }
  return { left, right, top: 0, bottom, cols, composerTop, composerBottom, railRight: left - 1, telemetryLeft }
}
function cardBottomOf(rows: string[], cockpit: Cockpit): number {
  const centre = centreOf(rows, cockpit)
  for (let y = 2; y < Math.min(12, centre.length); y++) if (centre[y]!.startsWith('╰')) return y
  return 6
}

function integrity(rows: string[]): string[] {
  const faults: string[] = []
  const cockpit = cockpitOf(rows)
  if (cockpit === null) return ['no centre frame on the first row']
  const { left, right, bottom, cols, composerTop, composerBottom, railRight, telemetryLeft } = cockpit
  for (let y = 1; y < bottom; y++) {
    const line = cells(rows[y]!)
    if (line[left] !== '│') faults.push(`row ${y}: the view's left border reads ${JSON.stringify(line[left] ?? ' ')} at ${left}`)
    if (line[right] !== '│') faults.push(`row ${y}: the view's right border reads ${JSON.stringify(line[right] ?? ' ')} at ${right} — "${line.slice(Math.max(0, right - 30), right + 1).join('')}"`)
  }
  const bottomLine = cells(rows[bottom]!)
  if (bottomLine[right] !== '╯') faults.push(`row ${bottom}: the view's bottom-right corner reads ${JSON.stringify(bottomLine[right] ?? ' ')}`)
  for (let x = left + 1; x < right; x++) if (bottomLine[x] !== '─') { faults.push(`row ${bottom}: the view's bottom border is broken at ${x} (${JSON.stringify(bottomLine[x] ?? ' ')})`); break }
  const topLine = cells(rows[0]!)
  for (let x = left + 1; x < right; x++) if (topLine[x] !== '─') { faults.push(`row 0: the view's top border is broken at ${x} (${JSON.stringify(topLine[x] ?? ' ')})`); break }
  for (let y = 0; y < bottom; y++) {
    const line = cells(rows[y]!)
    const open = line[0]
    if (open === '╭' && line[railRight] !== '╮') faults.push(`row ${y}: the rail box opens at 0 but does not close at ${railRight} (${JSON.stringify(line[railRight] ?? ' ')})`)
    if (open === '│' && line[railRight] !== '│') faults.push(`row ${y}: the rail row lost its right border at ${railRight} (${JSON.stringify(line[railRight] ?? ' ')}) — "${line.slice(0, railRight + 1).join('')}"`)
    if (open === '╰' && line[railRight] !== '╯') faults.push(`row ${y}: the rail box closes at 0 but not at ${railRight}`)
    if (telemetryLeft !== null) {
      const t = line[telemetryLeft]
      if (t === '╭' && line[cols - 1] !== '╮') faults.push(`row ${y}: the telemetry box opens at ${telemetryLeft} but does not close at ${cols - 1}`)
      if (t === '│' && line[cols - 1] !== '│') faults.push(`row ${y}: the telemetry row lost its right border`)
    }
  }
  if (composerTop < 0 || composerBottom < 0) faults.push('no closed composer box under the view')
  else {
    for (let y = composerTop; y <= composerBottom; y++) {
      const line = cells(rows[y]!)
      const want = y === composerTop ? '╮' : y === composerBottom ? '╯' : '│'
      if (line[cols - 1] !== want) faults.push(`row ${y}: the composer's right edge reads ${JSON.stringify(line[cols - 1] ?? ' ')} not ${want}`)
    }
  }
  return faults
}

type Window = { top: number; bottom: number; left: number; right: number; width: number; height: number; rows: string[]; faults: string[] }
function windowOf(rows: string[], title: string): Window | null {
  const titleRow = rows.findIndex(line => line.includes(title))
  if (titleRow < 0) return null
  const titleCells = cells(rows[titleRow]!)
  const titleAt = titleCells.join('').indexOf(title)
  let left = -1
  for (let x = titleAt; x >= 0; x--) if (titleCells[x] === '│') { left = x; break }
  if (left < 0) return null
  let top = -1
  for (let y = titleRow; y >= 0; y--) if (cells(rows[y]!)[left] === '╭') { top = y; break }
  if (top < 0) return null
  const right = cells(rows[top]!).indexOf('╮', left + 1)
  if (right < 0) return null
  let bottom = -1
  for (let y = top + 1; y < rows.length; y++) if (cells(rows[y]!)[left] === '╰') { bottom = y; break }
  if (bottom < 0) return null
  const faults: string[] = []
  for (let y = top + 1; y < bottom; y++) {
    const line = cells(rows[y]!)
    if (line[left] !== '│' || line[right] !== '│') faults.push(`window row ${y}: edges read ${JSON.stringify(line[left] ?? ' ')} at ${left} and ${JSON.stringify(line[right] ?? ' ')} at ${right}`)
  }
  if (cells(rows[bottom]!)[right] !== '╯') faults.push(`window row ${bottom}: the bottom-right corner reads ${JSON.stringify(cells(rows[bottom]!)[right] ?? ' ')}`)
  const windowRows = rows.slice(top, bottom + 1).map(line => cells(line).slice(left, right + 1).join(''))
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1, rows: windowRows, faults }
}
const describe = (window: Window | null): string => (window === null ? 'no closed window' : `left ${window.left} · top ${window.top} · width ${window.width} · height ${window.height} (rows ${window.top}..${window.bottom})`)

const centreOf = (rows: string[], cockpit: Cockpit): string[] => rows.map(line => cells(line).slice(cockpit.left + 1, cockpit.right).join(''))
const railOf = (rows: string[], cockpit: Cockpit): string[] => rows.map(line => cells(line).slice(0, cockpit.railRight + 1).join(''))
const headerOf = (rows: string[]): string => flat(rows.find(line => line.includes('VIEW')) ?? '')
const railRow = (rows: string[], cockpit: Cockpit, needle: string): string | undefined => railOf(rows, cockpit).find(line => line.includes(needle))
const composerRow = (rows: string[]): string | undefined => rows.find(line => /^│[❯›]/.test(line))
const transcriptRows = (rows: string[], cockpit: Cockpit): string[] => centreOf(rows, cockpit).slice(cardBottomOf(rows, cockpit) + 1, cockpit.bottom).map(line => line.trimEnd())
const cardRows = (rows: string[], cockpit: Cockpit): string => centreOf(rows, cockpit).slice(2, cardBottomOf(rows, cockpit)).map(flat).join(' ')
const firstDiff = (a: string[], b: string[]): string => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `transcript row ${i}: "${flat(a[i] ?? '').slice(0, 60)}" vs "${flat(b[i] ?? '').slice(0, 60)}"`
  return ''
}
const wideRows = (rows: string[]): string[] => rows.filter(line => line.includes('c00=') || line.includes('c29='))
const pastCentre = (rows: string[], cockpit: Cockpit, needle: string): string[] => rows.filter(line => cells(line).slice(cockpit.right + 1, cockpit.telemetryLeft ?? cockpit.cols).join('').includes(needle))
function railInkCell(mark: Mark): Cell | undefined {
  const y = mark.rows.findIndex(line => cells(line).slice(0, 30).join('').includes('CREW'))
  if (y < 0) return undefined
  const line = cells(mark.rows[y]!)
  const x = line.findIndex((_, i) => line[i] === 'C' && line[i + 1] === 'R' && line[i + 2] === 'E' && line[i + 3] === 'W')
  return x < 0 ? undefined : mark.grid[y]?.[x]
}

function keep(size: string, label: string, mark: Mark | undefined): void {
  if (FRAMES === undefined || mark === undefined) return
  writeFileSync(join(FRAMES, `${size}-${label}.txt`), mark.rows.map(line => line.trimEnd()).join('\n') + '\n')
}
function dump(label: string, mark: Mark | undefined): void {
  console.log(`\n── ${label} ──`)
  if (mark === undefined) { console.log('(no frame)'); return }
  for (const row of mark.rows) if (row.trim()) console.log(`│ ${row.trimEnd()}`)
}

function returnPins(tag: string, before: Mark | undefined, after: Mark | undefined, cockpit: Cockpit, viewed: string): void {
  if (before === undefined || after === undefined) { check(`${tag}: both frames exist`, false, `${before === undefined ? 'no frame before' : ''} ${after === undefined ? 'no frame after' : ''}`); return }
  check(`${tag}: the header names the same crewmate after the pop-up closes`, headerOf(after.rows).includes(viewed) && headerOf(after.rows) === headerOf(before.rows), `${headerOf(before.rows)} → ${headerOf(after.rows)}`)
  const beforeRows = transcriptRows(before.rows, cockpit)
  const afterRows = transcriptRows(after.rows, cockpit)
  check(`${tag}: the transcript rows are the rows before it opened (the same scroll position, no leftover rows)`, beforeRows.join('\n') === afterRows.join('\n'), firstDiff(beforeRows, afterRows))
  const marksBefore = railOf(before.rows, cockpit).filter(line => /[◉★›]/.test(line)).map(flat)
  const marksAfter = railOf(after.rows, cockpit).filter(line => /[◉★›]/.test(line)).map(flat)
  check(`${tag}: the rail's ◉ ★ › marks are unchanged`, marksBefore.join(' | ') === marksAfter.join(' | '), `${marksBefore.join(' | ')} → ${marksAfter.join(' | ')}`)
  check(`${tag}: the composer reads as before`, flat(composerRow(after.rows) ?? '') === flat(composerRow(before.rows) ?? ''), `${flat(composerRow(before.rows) ?? '')} → ${flat(composerRow(after.rows) ?? '')}`)
  check(`${tag}: every border is whole after the close`, integrity(after.rows).length === 0, integrity(after.rows).slice(0, 3).join(' · '))
}

function popupPins(tag: string, mark: Mark | undefined, title: string, cockpit: Cockpit, needles: string[], under?: Mark): void {
  if (mark === undefined) { check(`${tag}: the frame exists`, false); return }
  const window = windowOf(mark.rows, title)
  console.log(`  ${tag}: ${describe(window)}`)
  check(`${tag}: the pop-up is one closed window whose every row keeps both edges`, window !== null && window.faults.length === 0, window === null ? 'no closed window' : window.faults.slice(0, 3).join(' · '))
  if (window !== null) {
    check(`${tag}: the window floats inside the view (never over the view's frame, the rail or the composer)`, window.left > cockpit.left && window.right < cockpit.right && window.top > cockpit.top && window.bottom < cockpit.bottom, `${describe(window)} · view ${cockpit.left}..${cockpit.right} × ${cockpit.top}..${cockpit.bottom}`)
    const bleed = window.rows.filter(row => needles.some(needle => row.includes(needle)))
    check(`${tag}: the window is opaque (no transcript row shows through it)`, bleed.length === 0, bleed.slice(0, 2).map(flat).join(' | '))
  }
  check(`${tag}: every border outside the window is whole`, integrity(mark.rows).length === 0, integrity(mark.rows).slice(0, 3).join(' · '))
  check(`${tag}: the composer stays on screen under the pop-up`, composerRow(mark.rows) !== undefined, 'no composer row')
  if (under !== undefined) {
    const before = railInkCell(under)
    const during = railInkCell(mark)
    check(`${tag}: the pop-up dims the cockpit it floats over (the rail's CREW ink changes)`, before !== undefined && during !== undefined && (before.fg !== during.fg || before.bg !== during.bg), `CREW ink ${JSON.stringify(before?.fg)}/${JSON.stringify(before?.bg)} → ${JSON.stringify(during?.fg)}/${JSON.stringify(during?.bg)}`)
  }
}


async function leg(cols: number, rows: number): Promise<void> {
  const size = `${cols}x${rows}`
  const tag = size
  console.log(`\n— crew look ${size} —`)
  const before = failures
  const { home, cwd } = seedWorld()
  const fixture: Fixture = await startCrewLookFixture({ cwd })
  const nextSize: [number, number] = cols === 269 ? [178, 51] : cols === 178 ? [120, 40] : [178, 51]
  const swap = (needle: string, awaited: string): Send => ({ data: CLICK, targetText: needle, atTick: 1500, awaitText: awaited, requireAwait: true, minTick: 1, awaitSettleTicks: 4 })
  const sends: Send[] = [
    ...bootSends(LEAD_ASK),
    see(HARBOUR_RUNNING, 'lead', 8),
    clickOn(HARBOUR_RUNNING),
    see('[harbour]', 'view-harbour', 6),
    type(`\x1b[200~${PASTED}\x1b[201~`, 2),
    type('\r', 3),
    later(6, 'pasted'),
    see('its turn ended', 'harbour-ended', 8),
    clickOn(ATLAS_RUNNING),
    see('ledger row 40', 'view-atlas', 8),
    ...popup('/usage', USAGE_HINT, 'usage'),
    ...popup('/config', CONFIG_HINT, 'config'),
    ...popup('/model', '↑↓ select · ↵ switch', 'model'),
    ...popup('/files', '↑↓ move · ↵ open', 'files'),
    ...popup('/teammates', CREW_TITLE, 'crew'),
    type(PAGE_UP, 3),
    type(PAGE_UP, 3),
    later(3, 'atlas-scrolled'),
    ...popup('/usage', USAGE_HINT, 'usage-scrolled', 1),
    clickOn(FJORD_RUNNING),
    see('[fjord]', 'view-fjord', 6),
    type(PAGE_UP, 3),
    later(5, 'fjord-pgup'),
    clickOn(ATLAS_RUNNING),
    see('ledger row', 'view-atlas-again', 6),
    swap(FJORD_RUNNING, 'VIEW · atlas'),
    swap(ATLAS_RUNNING, 'VIEW · fjord'),
    swap(FJORD_RUNNING, 'VIEW · atlas'),
    swap(LEAD_ROW, 'VIEW · fjord'),
    later(10, 'rapid'),
    type('/teammates', 3),
    type('\r', 3),
    seePopup(CREW_TITLE, 'm main chat', 'crew-over-lead'),
    type('m', 3),
    see('★ VIEW · ', 'pinned', 6),
    ...popup('/usage', USAGE_HINT, 'usage-pinned'),
    ...popup('/teammates', CREW_TITLE, 'crew-pinned'),
    clickOn(LEAD_ROW),
    later(8, 'lead-pinned'),
    type(TAB, 3),
    type(UP.repeat(12), 3),
    later(4, 'rail-top'),
    type('m', 3),
    later(6, 'unpinned'),
    type(ESC, 3),
    clickOn(ATLAS_RUNNING, { mark: 'swap-resize' }),
    later(12, 'after-resize'),
    clickOn(LEAD_ROW),
    later(8, 'back'),
  ]
  const resizes = [{ afterMark: 'swap-resize', afterMs: 60, cols: nextSize[0], rows: nextSize[1] }]
  let cap: Capture | null = null
  try {
    cap = await capture(size, { cols, rows, total: 1800, cwd, argv: ['node', DIST], sends, resizes, stableTicks: 6 }, driveEnv(home, fixture.base))
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  for (const [label, mark] of Object.entries(marks)) keep(size, label, mark)
  keep(size, 'final', cap.final)
  check(`${tag}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends && cap.status === 0, `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason}`)
  const lead = marks['lead']
  const cockpit = lead === undefined ? null : cockpitOf(lead.rows)
  if (cockpit === null) {
    check(`${tag}: the cockpit frame is readable`, false, 'no centre frame')
  } else {
    console.log(`  the view: columns ${cockpit.left}..${cockpit.right} · rows 0..${cockpit.bottom} · composer rows ${cockpit.composerTop}..${cockpit.composerBottom} · rail 0..${cockpit.railRight}${cockpit.telemetryLeft === null ? '' : ` · telemetry from ${cockpit.telemetryLeft}`}`)
    check(`${tag}: the lead's view paints whole with the three crewmates in the rail`, integrity(lead!.rows).length === 0 && [ATLAS_RUNNING, FJORD_RUNNING, HARBOUR_RUNNING].every(needle => railRow(lead!.rows, cockpit, needle) !== undefined), integrity(lead!.rows).slice(0, 3).join(' · ') || railOf(lead!.rows, cockpit).filter(line => line.includes('·')).map(flat).join(' | '))
    const harbour = marks['view-harbour']
    check(`${tag}: one click on harbour's row opens it in the view (header, card, its own rows)`, harbour !== undefined && headerOf(harbour.rows).includes('VIEW · harbour · viewing') && cardRows(harbour.rows, cockpit).includes('◉ harbour') && transcriptRows(harbour.rows, cockpit).some(line => line.includes('[harbour]')), harbour === undefined ? 'no frame' : `${headerOf(harbour.rows)} · ${cardRows(harbour.rows, cockpit).slice(0, 120)}`)
    if (harbour !== undefined) check(`${tag}: harbour's view paints whole`, integrity(harbour.rows).length === 0, integrity(harbour.rows).slice(0, 3).join(' · '))
    const ended = marks['harbour-ended']
    check(`${tag}: harbour's turn ends while it is viewed — the view stays on harbour, its last row is on screen, the card no longer says it sleeps`, ended !== undefined && headerOf(ended.rows).includes('VIEW · harbour') && transcriptRows(ended.rows, cockpit).some(line => line.includes('its turn ended')) && !cardRows(ended.rows, cockpit).includes('Sleeping'), ended === undefined ? 'no frame' : `${headerOf(ended.rows)} · ${cardRows(ended.rows, cockpit).slice(0, 160)}`)
    if (ended !== undefined) {
      check(`${tag}: the ended crewmate's view paints whole`, integrity(ended.rows).length === 0, integrity(ended.rows).slice(0, 3).join(' · '))
      const pastedRows = transcriptRows(ended.rows, cockpit).filter(line => line.includes('segment-'))
      console.log(`  the pasted line in harbour's transcript: ${pastedRows.length} rows${pastedRows.length ? ` — "${flat(pastedRows[0]!).slice(0, 80)}…"` : ''}`)
      check(`${tag}: the long pasted line lands in harbour's transcript with the [you → harbour] plate and wraps inside the view`, pastedRows.length >= 2 && pastedRows[0]!.includes('[you → harbour]') && pastCentre(ended.rows, cockpit, 'segment-').length === 0 && pastedRows.join('').includes('segment-22-of-the-paste'), pastedRows.map(flat).join(' | ').slice(0, 300))
      const endedRail = railOf(ended.rows, cockpit)
      check(`${tag}: the rail still marks the ended crewmate ◉ › while it is the view (the row stays in the CREW lane)`, endedRail.some(line => line.includes('◉ harbour') && line.includes('›')), endedRail.filter(line => /CREW|◉|◐|★|✶/.test(line)).map(flat).join(' | '))
    }
    const atlas = marks['view-atlas']
    check(`${tag}: the first visit of atlas opens at the bottom of its transcript (its Sleep row on screen, no pill)`, atlas !== undefined && headerOf(atlas.rows).includes('VIEW · atlas · viewing') && centreOf(atlas.rows, cockpit).some(line => line.includes('ledger row')) && centreOf(atlas.rows, cockpit).some(line => line.includes('287s')) && !atlas.rows.some(line => line.includes(PILL)), atlas === undefined ? 'no frame' : centreOf(atlas.rows, cockpit).slice(6, 30).map(flat).filter(Boolean).join(' | ').slice(0, 400) + (atlas !== undefined && atlas.rows.some(line => line.includes(PILL)) ? ' · the pill stands' : ''))
    if (atlas !== undefined) {
      check(`${tag}: atlas's view paints whole (no row past the view's border, the rail intact)`, integrity(atlas.rows).length === 0, integrity(atlas.rows).slice(0, 3).join(' · '))
      const past = atlas.rows.filter(line => cells(line).slice(cockpit.right + 1, cockpit.telemetryLeft ?? cockpit.cols).join('').trim() !== '')
      check(`${tag}: nothing paints between the view's right border and the telemetry rail`, past.length === 0, past.slice(0, 2).map(line => flat(cells(line).slice(cockpit.right - 10).join('')).slice(0, 80)).join(' | '))
    }
    const diffMark = [atlas, marks['atlas-scrolled']].find(mark => mark !== undefined && centreOf(mark.rows, cockpit).some(line => line.includes('┌') && line.includes('diff ·')))
    if (diffMark !== undefined) {
      const diffRows = centreOf(diffMark.rows, cockpit)
      const diffTop = diffRows.findIndex(line => line.includes('┌') && line.includes('diff ·'))
      const x0 = diffRows[diffTop]!.indexOf('┌')
      const x1 = diffRows[diffTop]!.indexOf('┐', x0 + 1)
      const diffBottom = diffRows.findIndex((line, index) => index > diffTop && line[x0] === '└')
      const broken = diffBottom < 0 ? ['no bottom edge'] : diffRows.slice(diffTop + 1, diffBottom).filter(line => line[x0] !== '│' || line[x1] !== '│').map(line => flat(line).slice(0, 60))
      check(`${tag}: the diff box in atlas's transcript keeps both edges on every row`, x1 > x0 && diffBottom > diffTop && broken.length === 0, broken.slice(0, 2).join(' | '))
    } else console.log(`  the Write's diff box in atlas's transcript: not painted (the runner's record carries no toolUseResult)`)
    const wide = [atlas, marks['atlas-scrolled']].find(mark => mark !== undefined && wideRows(centreOf(mark.rows, cockpit)).length > 0)
    console.log(`  the wide Bash result in atlas's transcript: ${wide === undefined ? 'not painted (the runner\'s record carries no toolUseResult)' : `${wideRows(centreOf(wide.rows, cockpit)).length} rows`}`)
    if (wide !== undefined) check(`${tag}: the wide Bash result stays inside the view`, pastCentre(wide.rows, cockpit, 'c0').length === 0 && integrity(wide.rows).length === 0, integrity(wide.rows).slice(0, 3).join(' · '))
    const atlasNeedles = ['never breaks on its own', 'ledger row', '[you → atlas]']
    for (const [tagName, title] of [['usage', USAGE_TITLE], ['config', CONFIG_TITLE], ['model', MODEL_TITLE], ['files', FILES_TITLE], ['crew', CREW_TITLE]] as const) {
      popupPins(`${tag}: /${tagName} over atlas`, marks[`${tagName}-open`], title, cockpit, atlasNeedles, atlas)
      returnPins(`${tag}: /${tagName} closed`, atlas, marks[`${tagName}-closed`], cockpit, 'atlas')
    }
    const scrolled = marks['atlas-scrolled']
    check(`${tag}: PgUp scrolls atlas's transcript (the rows moved, the pill stands)`, scrolled !== undefined && atlas !== undefined && transcriptRows(scrolled.rows, cockpit).join('\n') !== transcriptRows(atlas.rows, cockpit).join('\n') && scrolled.rows.some(line => line.includes(PILL)), scrolled === undefined ? 'no frame' : transcriptRows(scrolled.rows, cockpit).slice(0, 3).map(flat).join(' | '))
    popupPins(`${tag}: /usage over the scrolled atlas`, marks['usage-scrolled-open'], USAGE_TITLE, cockpit, atlasNeedles, scrolled)
    returnPins(`${tag}: /usage closed over the scrolled atlas`, scrolled, marks['usage-scrolled-closed'], cockpit, 'atlas')
    const fjord = marks['view-fjord']
    check(`${tag}: the swap to fjord from the scrolled atlas paints fjord's rows alone (no atlas row left over)`, fjord !== undefined && headerOf(fjord.rows).includes('VIEW · fjord · viewing') && transcriptRows(fjord.rows, cockpit).some(line => line.includes('[fjord]')) && !transcriptRows(fjord.rows, cockpit).some(line => line.includes('[atlas]') || line.includes('ledger row')), fjord === undefined ? 'no frame' : transcriptRows(fjord.rows, cockpit).map(flat).filter(Boolean).slice(0, 6).join(' | ').slice(0, 300))
    if (fjord !== undefined) {
      check(`${tag}: fjord's view paints whole`, integrity(fjord.rows).length === 0, integrity(fjord.rows).slice(0, 3).join(' · '))
      const fjordRows = transcriptRows(fjord.rows, cockpit).filter(line => line.trim() !== '')
      check(`${tag}: fjord's short transcript stands at its top with no jump pill (the pill's law holds on the swapped transcript)`, fjordRows.length > 0 && fjordRows[0]!.includes('[you → fjord]') && !fjord.rows.some(line => line.includes(PILL)), fjordRows.slice(0, 2).map(flat).join(' | ') + (fjord.rows.some(line => line.includes(PILL)) ? ' · the pill stands' : ''))
      check(`${tag}: fjord's long line wraps inside the view`, centreOf(fjord.rows, cockpit).some(line => line.includes('the second crewmate says')) && pastCentre(fjord.rows, cockpit, 'fjord').length === 0, centreOf(fjord.rows, cockpit).filter(line => line.includes('fjord')).map(flat).slice(0, 3).join(' | '))
    }
    const fjordPgUp = marks['fjord-pgup']
    check(`${tag}: PgUp on fjord's short transcript changes nothing (nothing to scroll, no pill)`, fjordPgUp !== undefined && fjord !== undefined && transcriptRows(fjordPgUp.rows, cockpit).join('\n') === transcriptRows(fjord.rows, cockpit).join('\n') && !fjordPgUp.rows.some(line => line.includes(PILL)), fjordPgUp === undefined ? 'no frame' : firstDiff(transcriptRows(fjord!.rows, cockpit), transcriptRows(fjordPgUp.rows, cockpit)) || 'the pill stands')
    const again = marks['view-atlas-again']
    check(`${tag}: back on atlas its transcript is where it was left (the scrolled rows, the pill standing for the rows below)`, again !== undefined && scrolled !== undefined && headerOf(again.rows).includes('VIEW · atlas') && transcriptRows(again.rows, cockpit).join('\n') === transcriptRows(scrolled.rows, cockpit).join('\n') && again.rows.some(line => line.includes(PILL)), again === undefined || scrolled === undefined ? 'no frame' : firstDiff(transcriptRows(scrolled.rows, cockpit), transcriptRows(again.rows, cockpit)) || (again.rows.some(line => line.includes(PILL)) ? '' : 'no pill'))
    const rapid = marks['rapid']
    check(`${tag}: four swaps at the product's own pace end on the lead with the lead's rows alone and every border whole`, rapid !== undefined && !/viewing|main chat/.test(headerOf(rapid.rows)) && transcriptRows(rapid.rows, cockpit).some(line => line.includes('[Mercury]') || line.includes('[sam]')) && !transcriptRows(rapid.rows, cockpit).some(line => line.includes('[fjord]') || line.includes('[atlas]')) && integrity(rapid.rows).length === 0, rapid === undefined ? 'no frame' : `${headerOf(rapid.rows)} · ${integrity(rapid.rows).slice(0, 2).join(' · ')} · ${transcriptRows(rapid.rows, cockpit).filter(line => line.trim()).slice(0, 3).map(flat).join(' | ').slice(0, 200)}`)
    const crewOrder = (mark: Mark | undefined): string => (mark === undefined ? '' : railOf(mark.rows, cockpit).filter(line => /[◐◉★●] (atlas|fjord|harbour)/.test(line)).map(line => /(atlas|fjord|harbour)/.exec(line)![1]).join(','))
    console.log(`  the CREW rows' order: atlas viewed ${crewOrder(atlas)} · fjord viewed ${crewOrder(fjord)} · atlas again ${crewOrder(again)} · the lead ${crewOrder(rapid)}`)
    check(`${tag}: the CREW rows keep their places across the swaps (the viewed row is marked where it stands, never moved to the top)`, crewOrder(atlas) !== '' && crewOrder(atlas) === crewOrder(fjord) && crewOrder(fjord) === crewOrder(again) && crewOrder(again) === crewOrder(rapid), `${crewOrder(atlas)} → ${crewOrder(fjord)} → ${crewOrder(again)} → ${crewOrder(rapid)}`)
    popupPins(`${tag}: the crew pop-up over the lead`, marks['crew-over-lead'], CREW_TITLE, cockpit, ['launching the crew'], rapid)
    const pinned = marks['pinned']
    const pinnedName = pinned === undefined ? '' : (/★ VIEW · (\S+) · main chat/.exec(headerOf(pinned.rows))?.[1] ?? '')
    console.log(`  m on the crew pop-up's first row pinned: "${pinnedName || 'nobody'}"`)
    check(`${tag}: m on the selected crewmate pins it — ★ in the rail, the header says main chat, the card says THE MAIN CHAT, the pop-up gone`, pinned !== undefined && pinnedName !== '' && railRow(pinned.rows, cockpit, '★') !== undefined && railRow(pinned.rows, cockpit, '★')!.includes(pinnedName.slice(0, 5)) && cardRows(pinned.rows, cockpit).includes('THE MAIN CHAT') && !pinned.rows.some(line => line.includes(CREW_TITLE)), pinned === undefined ? 'no frame' : `${headerOf(pinned.rows)} · ${railRow(pinned.rows, cockpit, '★') ?? 'no ★ row'}`)
    if (pinned !== undefined) check(`${tag}: the pinned view paints whole`, integrity(pinned.rows).length === 0, integrity(pinned.rows).slice(0, 3).join(' · '))
    const pinnedNeedles = ['the second crewmate says', 'never breaks on its own', 'ledger row', 'its turn ended']
    popupPins(`${tag}: /usage over the pinned ${pinnedName}`, marks['usage-pinned-open'], USAGE_TITLE, cockpit, pinnedNeedles, pinned)
    returnPins(`${tag}: /usage closed over the pinned ${pinnedName}`, pinned, marks['usage-pinned-closed'], cockpit, pinnedName)
    popupPins(`${tag}: the crew pop-up over the pinned ${pinnedName}`, marks['crew-pinned-open'], CREW_TITLE, cockpit, pinnedNeedles, pinned)
    returnPins(`${tag}: the crew pop-up closed over the pinned ${pinnedName}`, pinned, marks['crew-pinned-closed'], cockpit, pinnedName)
    const leadPinned = marks['lead-pinned']
    check(`${tag}: Mercury Lead in the rail goes back while ${pinnedName} stays the main chat (★ kept, the composer still addresses it)`, leadPinned !== undefined && !/viewing|main chat/.test(headerOf(leadPinned.rows)) && railRow(leadPinned.rows, cockpit, '★') !== undefined && (composerRow(leadPinned.rows) ?? '').includes(`message ${pinnedName}`) && transcriptRows(leadPinned.rows, cockpit).some(line => line.includes('[Mercury]') || line.includes('[sam]')), leadPinned === undefined ? 'no frame' : `${headerOf(leadPinned.rows)} · ${railRow(leadPinned.rows, cockpit, '★') ?? 'no ★'} · ${flat(composerRow(leadPinned.rows) ?? '')}`)
    if (leadPinned !== undefined) check(`${tag}: the lead's view under a pinned crewmate paints whole`, integrity(leadPinned.rows).length === 0, integrity(leadPinned.rows).slice(0, 3).join(' · '))
    const railTop = marks['rail-top']
    console.log(`  the rail's cursor after Tab and ↑×12: "${flat(railRow(railTop?.rows ?? [], cockpit, '❯') ?? 'no ❯ row')}"`)
    const unpinned = marks['unpinned']
    check(`${tag}: m on Mercury Lead in the rail hands the main chat back (no ★ row, the composer addresses the lead)`, unpinned !== undefined && railRow(unpinned.rows, cockpit, '★') === undefined && !(composerRow(unpinned.rows) ?? '').includes(`message ${pinnedName}`), unpinned === undefined ? 'no frame' : `${railRow(unpinned.rows, cockpit, '★') ?? 'no ★'} · ${flat(composerRow(unpinned.rows) ?? '')} · cursor "${flat(railRow(unpinned.rows, cockpit, '❯') ?? '')}"`)
    const resized = marks['after-resize']
    const resizedCockpit = resized === undefined ? null : cockpitOf(resized.rows)
    console.log(`  after the resize to ${nextSize[0]}x${nextSize[1]} during the swap: ${resized === undefined ? 'no frame' : `${resized.cols}x${resized.lines}${resizedCockpit === null ? '' : ` · view ${resizedCockpit.left}..${resizedCockpit.right} × 0..${resizedCockpit.bottom}`}`}`)
    check(`${tag}: a resize during the swap to atlas lands on a whole frame at ${nextSize[0]}x${nextSize[1]} — atlas viewed, its rows, every border`, resized !== undefined && resizedCockpit !== null && resized.cols === nextSize[0] && resized.lines === nextSize[1] && headerOf(resized.rows).includes('VIEW · atlas') && integrity(resized.rows).length === 0 && transcriptRows(resized.rows, resizedCockpit).some(line => line.includes('[atlas]') || line.includes('287s')), resized === undefined ? 'no frame' : `${headerOf(resized.rows)} · ${integrity(resized.rows).slice(0, 3).join(' · ')}`)
    const back = marks['back']
    check(`${tag}: Mercury Lead in the rail goes back after the resize — the lead's rows return whole`, back !== undefined && !/viewing|main chat/.test(headerOf(back.rows)) && integrity(back.rows).length === 0 && back.rows.some(line => line.includes('[Mercury]') || line.includes('[sam]')) && !back.rows.some(line => line.includes('[atlas]')), back === undefined ? 'no frame' : `${headerOf(back.rows)} · ${integrity(back.rows).slice(0, 3).join(' · ')}`)
  }
  if (failures > before || DUMP) {
    for (const [label, mark] of Object.entries(marks)) dump(`${size} · ${label}`, mark)
    dump(`${size} · final`, cap.final)
    console.log(`  [fixture] ${fixture.hits.map(h => `${h.route}${h.mate ? `:${h.mate}` : ''}#${h.step}`).join(',')}`)
  }
  if (KEEP) console.log(`  [keep] ${size} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(`bundle: ${DIST}`)
for (const [cols, rows] of SIZES) await leg(cols, rows)
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-crew-look-drive: ALL LAWS HOLD' : `prove-crew-look-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
