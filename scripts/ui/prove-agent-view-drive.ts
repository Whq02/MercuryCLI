#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { LEAD_ASK_SLEEPER, SEAT_NAME, startCrewStopFixture, type Fixture } from '../crew/crew-stop-fixture.ts'

const ROOT = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const SIZES = (argAfter('--sizes') ?? '269x70').split(',').map(s => s.split('x').map(Number) as [number, number])
const KEEP = process.argv.includes('--keep')
const VSHOT = join(ROOT, 'scripts', 'ui', 'vshot.py')
const CREW_TITLE = 'Mercury — crew'
const LEAD_ROW = 'Mercury Lead'
const MAIN_CHAT_KEY = 'm main chat'
const ESC = '\x1b'
const TAB = '\t'
const UP = '\x1b[A'
const FOCUS_IN = '\x1b[I'
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first, or name a bundle with --dist`)
  process.exit(0)
}
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

type Grid = Array<Array<{ c?: string } | string>>
const gridText = (grid: Grid): string => grid.map(row => row.map(c => (typeof c === 'object' && c !== null ? (c.c ?? ' ') : String(c))).join('').trimEnd()).join('\n')
type Capture = { text: string; marks: Record<string, string>; sends: number; receipts: number; endReason: string }

async function capture(cfg: Record<string, unknown>, env: Record<string, string>): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-view-cfg-'))
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(300_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', () => {
      clearTimeout(deadline)
      resolve()
    })
  })
  if (!existsSync(outPath)) throw new Error(`vshot wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  rmSync(dir, { recursive: true, force: true })
  return { text: gridText(payload.grid), marks, sends: Array.isArray(cfg.sends) ? cfg.sends.length : 0, receipts: Array.isArray(payload.sendReceipts) ? payload.sendReceipts.length : 0, endReason: payload.endReason ?? '' }
}

function seedWorld(): { home: string; cwd: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-view-home-')))
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agent-view-cwd-')))
  seedFirstRun(home, [cwd])
  return { home, cwd }
}

function driveEnv(home: string, fixtureBase: string): Record<string, string> {
  const env: Record<string, string> = {
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
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
  for (const stamp of ['MERCURY_CREWMATES', 'MERCURY_DAEMON_PERMISSION_MODE', 'MERCURY_SKIP_PERMISSIONS', 'MERCURY_DAEMON_CREW', 'MERCURY_CREW', 'NODE_ENV', 'CI']) delete process.env[stamp]
  return env
}

const bootSends = (ask: string): Array<Record<string, unknown>> => [
  { data: '\r', atTick: 999, awaitText: '↑↓ choose', requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 },
  { data: ask, atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3 },
  { data: '\r', afterPrevTicks: 4 },
]

const flat = (s: string): string => s.replace(/\s+/g, ' ')
const cells = (line: string): string[] => Array.from(line)
const RAIL_COLS = 32
const railText = (line: string): string => cells(line).slice(0, RAIL_COLS).join('')
const railRow = (text: string, needle: string): string | undefined => text.split('\n').map(railText).find(line => line.includes(needle))
const headerRow = (text: string): string => text.split('\n').find(line => /VIEW/.test(cells(line).slice(RAIL_COLS).join(''))) ?? ''
const centreText = (line: string): string => cells(line).slice(RAIL_COLS, RAIL_COLS + 205).join('')
function sessionRecords(home: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) for (const line of readFileSync(path, 'utf8').split('\n')) if (line.includes('task-notification')) out.push(line)
    }
  }
  const projects = join(home, 'projects')
  if (existsSync(projects)) walk(projects)
  return out
}
const composerRow = (text: string): string | undefined => text.split('\n').find(line => /^│[❯›]/.test(line))

type Window = { top: number; bottom: number; left: number; right: number; width: number; height: number; rows: string[] }
function windowOf(lines: string[], title: string): Window | null {
  const titleRow = lines.findIndex(line => line.includes(title))
  if (titleRow < 0) return null
  const titleCells = cells(lines[titleRow]!)
  const titleAt = titleCells.join('').indexOf(title)
  let left = -1
  for (let x = titleAt; x >= 0; x--) {
    if (titleCells[x] === '│') { left = x; break }
  }
  if (left < 0) return null
  let top = -1
  for (let y = titleRow; y >= 0; y--) {
    if (cells(lines[y]!)[left] === '╭') { top = y; break }
  }
  if (top < 0) return null
  const right = cells(lines[top]!).indexOf('╮', left + 1)
  if (right < 0) return null
  let bottom = -1
  for (let y = top + 1; y < lines.length; y++) {
    if (cells(lines[y]!)[left] === '╰') { bottom = y; break }
  }
  if (bottom < 0) return null
  const rows = lines.slice(top, bottom + 1).map(line => cells(line).slice(left, right + 1).join(''))
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1, rows }
}
const describe = (window: Window | null): string => (window === null ? 'no closed window' : `left ${window.left} · top ${window.top} · width ${window.width} · height ${window.height}`)

function keep(label: string, frame: string | undefined): void {
  if (FRAMES === undefined || frame === undefined) return
  writeFileSync(join(FRAMES, `${label}.txt`), frame + '\n')
}

function dump(label: string, frame: string | undefined): void {
  console.log(`\n── ${label} ──`)
  if (frame === undefined) {
    console.log('(no frame)')
    return
  }
  for (const row of frame.split('\n')) if (row.trim()) console.log(`│ ${row}`)
}

async function leg(cols: number, rows: number): Promise<void> {
  const tag = `crew pop-up ${cols}x${rows}`
  console.log(`\n— ${tag} —`)
  const before = failures
  const fixture: Fixture = await startCrewStopFixture({ seatTool: 'sleep' })
  const { home, cwd } = seedWorld()
  const sends: Array<Record<string, unknown>> = [
    ...bootSends(LEAD_ASK_SLEEPER),
    { data: '/crewmates', atTick: 999, awaitText: SEAT_NAME, requireAwait: true, minTick: 5, awaitSettleTicks: 4, mark: 'crew-in-rail' },
    { data: '\r', afterPrevTicks: 4 },
    { data: ESC, atTick: 999, awaitText: MAIN_CHAT_KEY, requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'popup' },
    { data: '/crewmates', atTick: 999, awaitText: 'ype a prompt', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'popup-closed' },
    { data: '\r', afterPrevTicks: 4 },
    { data: 'm', atTick: 999, awaitText: MAIN_CHAT_KEY, requireAwait: true, minTick: 2, awaitSettleTicks: 4 },
    { data: TAB, atTick: 999, awaitText: 'message sleeper', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'main-chat' },
    { data: UP + UP + UP + UP, afterPrevTicks: 4 },
    { data: 'm', afterPrevTicks: 4 },
    { data: FOCUS_IN, afterPrevTicks: 6, mark: 'handed-back' },
    { data: ESC, atTick: 999, awaitText: 'you → sleeper', requireAwait: true, minTick: 2, awaitSettleTicks: 3, mark: 'view' },
    { data: FOCUS_IN, atTick: 999, awaitText: 'the interrupt ended', requireAwait: true, minTick: 2, awaitSettleTicks: 4, mark: 'cut-row' },
    { data: TAB, afterPrevTicks: 4 },
    { data: '\r', afterPrevTicks: 5 },
    { data: FOCUS_IN, afterPrevTicks: 8, mark: 'back' },
  ]
  let cap: Capture | null = null
  try {
    cap = await capture({ cols, rows, total: 520, cwd, argv: ['node', DIST], sends, stableTicks: 6 }, driveEnv(home, fixture.base))
  } finally {
    await fixture.close()
  }
  const { marks } = cap
  const size = `${cols}x${rows}`
  for (const [label, frame] of Object.entries(marks)) keep(`${size}-${label}`, frame)
  check(`${tag}: every send became due (the frames the sends waited on all painted)`, cap.receipts === cap.sends, `${cap.receipts}/${cap.sends} · end ${cap.endReason}`)
  const inRail = marks['crew-in-rail'] ?? ''
  check(`${tag}: the lead's CREW row reads "${LEAD_ROW}" first`, railRow(inRail, LEAD_ROW) !== undefined, flat(inRail).slice(0, 200))
  check(`${tag}: the sleeper is a CREW row before the pop-up opens`, railRow(inRail, SEAT_NAME) !== undefined, flat(inRail).slice(0, 200))
  const popup = marks['popup'] ?? ''
  const window = windowOf(popup.split('\n'), CREW_TITLE)
  console.log(`  the crew window: ${describe(window)}`)
  check(`${tag}: /crewmates opens the crew view as one closed window inside the centre`, window !== null && window.left > RAIL_COLS && window.width < cols - 2 * RAIL_COLS - 4 && window.top > 1 && window.bottom < rows - 6, describe(window))
  check(`${tag}: the composer stays on screen under the pop-up`, composerRow(popup) !== undefined, flat(popup).slice(-300))
  check(`${tag}: the crew view's key row carries "${MAIN_CHAT_KEY}"`, window !== null && window.rows.some(row => row.includes(MAIN_CHAT_KEY)), window === null ? '' : flat(window.rows[window.rows.length - 2] ?? ''))
  const closed = marks['popup-closed'] ?? ''
  check(`${tag}: esc closes the pop-up (the composer placeholder is back, no crew window)`, !closed.includes(CREW_TITLE) && closed.includes('ype a prompt'), flat(closed).slice(0, 200))
  const main = marks['main-chat'] ?? ''
  const starRow = railRow(main, '★')
  console.log(`  the ★ row: "${(starRow ?? '').trim()}"`)
  check(`${tag}: m marks the sleeper ★ in the rail`, starRow !== undefined && starRow.includes(SEAT_NAME), starRow ?? 'no ★ row')
  const header = headerRow(main)
  console.log(`  the view header: "${flat(header).slice(0, 120)}"`)
  check(`${tag}: the view header says main chat for the sleeper`, /★ VIEW · sleeper · main chat/.test(header), flat(header).slice(0, 160))
  check(`${tag}: the composer placeholder reads "message sleeper"`, (composerRow(main) ?? '').includes('message sleeper'), (composerRow(main) ?? '').slice(0, 80))
  check(`${tag}: the footer says ↵ sends to sleeper · m on Mercury Lead returns the main chat`, main.includes('sends to sleeper') && main.includes('m on Mercury Lead returns the main chat'), flat(main).slice(-400))
  const handed = marks['handed-back'] ?? ''
  check(`${tag}: m on Mercury Lead hands the main chat back (no ★ row)`, railRow(handed, '★') === undefined, railRow(handed, '★') ?? '')
  const view = marks['view'] ?? ''
  const viewHeader = headerRow(view)
  console.log(`  the view header after the hand-back: "${flat(viewHeader).slice(0, 120)}"`)
  check(`${tag}: the sleeper's own transcript takes the centre (its prompt wears the [you → sleeper] plate, the lead's rows are gone)`, /VIEW · sleeper · viewing/.test(viewHeader) && view.split('\n').some(line => centreText(line).includes('[you → sleeper]')) && !view.split('\n').some(line => centreText(line).includes('launching the sleeper')), flat(view).slice(0, 300))
  const cut = marks['cut-row'] ?? ''
  const cutRow = cut.split('\n').map(centreText).find(line => line.includes('the interrupt ended') || line.includes('Interrupted ·'))
  console.log(`  the cut row in the sleeper's transcript: "${(cutRow ?? '').trim().slice(0, 120)}"`)
  check(`${tag}: esc interrupts the sleeper alone — its transcript shows the interrupt row (the tool-phase cut names the tool it ended)`, cutRow !== undefined && /the interrupt ended Sleep — the turn is over|Interrupted · What should Mercury do instead\?/.test(cutRow), cutRow ?? 'no cut row in the centre')
  check(`${tag}: the sleeper's card reads interrupted (the operator's own kind, never a bare stopped) and the lead's own turn is untouched (the status row still names the session)`, cut.split('\n').some(line => centreText(line).includes('◉ sleeper') && centreText(line).includes('interrupted')), flat(cut).slice(0, 200))
  check(`${tag}: the view stays on the sleeper after the interrupt`, /VIEW · sleeper/.test(headerRow(cut)), flat(headerRow(cut)).slice(0, 120))
  const back = marks['back'] ?? ''
  const backHeader = headerRow(back)
  check(`${tag}: Mercury Lead in the rail goes back (the header reads the plain view, the lead's rows return)`, /VIEW/.test(backHeader) && !/viewing|main chat/.test(backHeader) && back.split('\n').some(line => centreText(line).includes('launching the sleeper')), flat(backHeader).slice(0, 160))
  const leadRowBack = railRow(back, LEAD_ROW)
  check(`${tag}: Mercury Lead wears the view mark again`, leadRowBack !== undefined && /›/.test(leadRowBack), leadRowBack ?? 'no Mercury Lead row')
  const sleeperRowBack = railRow(back, SEAT_NAME)
  console.log(`  the sleeper's CREW row after the return: "${(sleeperRowBack ?? '').trim()}"`)
  check(`${tag}: the interrupted sleeper keeps its CREW row, reading interrupted, after the return to Mercury Lead`, sleeperRowBack !== undefined && sleeperRowBack.includes('interrupted'), sleeperRowBack ?? 'no sleeper row — the CREW box lost it')
  const records = sessionRecords(home)
  const interruptedNotice = records.find(line => line.includes('<status>interrupted</status>'))
  console.log(`  the lead's notice in the session records: ${interruptedNotice === undefined ? '(none)' : interruptedNotice.slice(0, 200)}`)
  check(`${tag}: the lead's notice carries the typed kind <status>interrupted</status> and says the operator interrupted it`, interruptedNotice !== undefined && interruptedNotice.includes('interrupted by the operator on its screen'), records.filter(line => line.includes('task-notification')).join(' | ').slice(0, 300))
  check(`${tag}: the notice is the operator's kind, never the crew view's stop`, !records.some(line => line.includes('stopped from the crew view · r on its row')), records.filter(line => line.includes('stopped from the crew view · r on its row')).join(' | ').slice(0, 300))
  if (failures > before || process.env.AGENT_VIEW_KEEP === '1') {
    for (const [label, frame] of Object.entries(marks)) dump(`${tag} · ${label}`, frame)
    dump(`${tag} · final`, cap.text)
    console.log(`  [fixture] ${fixture.hits.map(h => `${h.route}${h.step ? `#${h.step}` : ''}`).join(',')}`)
  }
  if (KEEP) console.log(`  [keep] ${tag} home ${home} cwd ${cwd}`)
  else {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(`bundle: ${DIST}`)
for (const [cols, rows] of SIZES) await leg(cols, rows)
console.log(failures === 0 ? '\nprove-agent-view-drive: ALL LAWS HOLD' : `\nprove-agent-view-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
