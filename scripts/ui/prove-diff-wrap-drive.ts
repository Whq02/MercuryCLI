#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-diff-wrap-drive-')))
const HOME = join(SCRATCH, 'home')
const WORK = join(SCRATCH, 'work')
for (const dir of [HOME, WORK]) mkdirSync(dir, { recursive: true })
writeFileSync(join(WORK, 'README.md'), '# work\n')
{
  const run = (args: string[]): boolean => spawnSync('git', args, { cwd: WORK, stdio: 'ignore' }).status === 0
  run(['init', '-q']) &&
    run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'add', '.']) &&
    run(['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed'])
}
process.env.MERCURY_CONFIG_DIR = HOME
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE
delete process.env.MERCURY_SKIP_PERMISSIONS
delete process.env.MERCURY_DAEMON_PERMISSION_MODE

const REPO = join(import.meta.dir, '..', '..')
const argValue = (name: string): string | undefined => {
  const joined = process.argv.find(a => a.startsWith(`${name}=`))
  if (joined) return joined.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const BIN = argValue('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argValue('--frames') ?? null
const KEEP = process.argv.includes('--keep')
if (FRAMES) mkdirSync(FRAMES, { recursive: true })
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first, or pass --dist <bundle>`)
  rmSync(SCRATCH, { recursive: true, force: true })
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { expandTabs } = await import('../../src/ink/tabstops.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-diff-wrap-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(HOME, [WORK])
writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ skipSovereignConsentPrompt: true }))

const COLS = 178
const ROWS = 51
const READY_LINE = '↵ start  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const CLOSING = 'Done.'
const TABLE = 'jobs.tsv'
const noteA = 'held on the tree, uncommitted, pending the ruling; the options are listed on the shared page beside the second commit, and the census is generated after the merge so the report and the frames can be filed beside the receipts page for the owner to read at leisure'
const header = 'name\tid\tstage\tpath\tnote'
const removedLong = `harbour\tq7\tstage two\t/srv/work/harbour\t${noteA} (held)`
const addedLong = `harbour\tq7\tstage two\t/srv/work/harbour\t${noteA} (folded)`
const contextLong = 'meadow\tm2\tstage three\t/srv/work/meadow\tmerged with the follow-up note that the report and the frames are filed beside the receipts page and the census is generated after the merge, then the summary is read by the owner before the next batch opens on the main line'
const removedShort = 'lantern\tp3\tstage one\t/srv/work/lantern\theld'
const addedShort = 'lantern\tp3\tstage one\t/srv/work/lantern\tfolded'
const BEFORE = [header, removedLong, contextLong, removedShort].join('\n') + '\n'
const AFTER = [header, addedLong, contextLong, addedShort].join('\n') + '\n'
const tablePath = join(WORK, TABLE)
writeFileSync(tablePath, BEFORE)

type GridCell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = GridCell[][]
type Mark = { label: string; atTick: number; atMs: number; grid: Grid }
type Capture = { status: number; tail: string; grid: Grid; marks: Mark[]; endReason: string }

const rowsOf = (grid: Grid): string[] => grid.map(row => row.map(cell => (cell.c === undefined || cell.c === '' ? ' ' : cell.c)).join(''))

async function capture(): Promise<Capture> {
  const api = await startFixtureApi([
    { kind: 'tool_use', whenModel: 'opus', preText: 'Reading the table.\n', name: 'Read', input: { file_path: tablePath } },
    { kind: 'tool_use', whenModel: 'opus', preText: 'Writing the table.\n', name: 'Write', input: { file_path: tablePath, content: AFTER } },
    { kind: 'text', whenModel: 'opus', text: CLOSING },
  ])
  const cfgPath = join(SCRATCH, 'cfg.json')
  const outPath = join(SCRATCH, 'grid.json')
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN],
      cwd: WORK,
      cols: COLS,
      rows: ROWS,
      sends: [
        { atTick: 120, awaitText: READY_LINE, minTick: 3, awaitSettleTicks: 3, data: '', mark: 'face' },
        { afterPrevTicks: 25, data: '\r', mark: 'enter' },
        { atTick: 400, awaitText: COMPOSER, minTick: 3, awaitSettleTicks: 3, requireAwait: true, data: 'hello', mark: 'composer' },
        { afterPrevTicks: 2, data: '\r', mark: 'sent' },
        { atTick: 400, awaitText: CLOSING, minTick: 3, awaitSettleTicks: 5, requireAwait: true, data: '', mark: 'done' },
      ],
      readyText: CLOSING,
      readySettleTicks: 5,
      total: 400,
      out: outPath,
    }),
  )
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: HOME,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_OPERATOR: 'sam',
      MERCURY_SPLASH: 'off',
      MERCURY_CRITTER_IDLE: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_SLEEP: '0',
      MERCURY_LIVE_CLOCK: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_TURN_RECEIPT: '0',
      MERCURY_OASIS_BG: '0',
      MERCURY_SPECTRA_GROUND: '0',
      MERCURY_SKIP_PERMISSIONS: '1',
      MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
      MERCURY_TEAMS_DIR: join(HOME, 'teams'),
      MERCURY_TABULA_DIR: join(HOME, 'tabula'),
      MERCURY_TERMINAL_TITLE: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await new Promise<Capture>(resolvePromise => {
    let tail = ''
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-1200)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-1200)))
    const wall = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(400 * 200) + 20_000)
    child.on('close', status => {
      clearTimeout(wall)
      let grid: Grid = []
      let marks: Mark[] = []
      let endReason = 'no grid'
      try {
        const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Mark[]; endReason?: string }
        grid = payload.grid
        marks = payload.marks ?? []
        endReason = payload.endReason ?? 'unknown'
      } catch {
        grid = []
      }
      resolvePromise({ status: status ?? 1, tail, grid, marks, endReason })
    })
  })
  await api.close().catch(() => undefined)
  return result
}

function printFrame(label: string, rows: string[]): void {
  console.log(`\n┌── ${label} ──`)
  for (const row of rows) console.log(`│${row.replace(/\s+$/, '')}`)
  console.log('└──')
}

const squash = (text: string): string => text.replace(/\s+/g, '')
const GUTTER = /^(\s*\d*\s)([-+ ])/

function readBox(grid: Grid, label: string): void {
  const rows = rowsOf(grid)
  const top = rows.findIndex(row => row.includes('┌') && row.includes('diff ·'))
  const x0 = top < 0 ? -1 : rows[top]!.indexOf('┌')
  const x1 = top < 0 ? -1 : rows[top]!.indexOf('┐', x0 + 1)
  const bottom = top < 0 ? -1 : rows.findIndex((row, index) => index > top && row[x0] === '└')
  check(`${label}: the diff box under the Write row is on screen with its top and bottom edges`, top >= 0 && x1 > x0 && bottom > top, `top=${top} x0=${x0} x1=${x1} bottom=${bottom}`)
  if (top < 0 || x1 <= x0 || bottom <= top) return
  const edges: string[] = []
  const bleeds: string[] = []
  const bands: string[] = []
  const gaps: string[] = []
  const inner: string[] = []
  let bandedRows = 0
  const bandMap: string[] = []
  for (let y = top + 1; y < bottom; y++) {
    const row = rows[y]!
    const cells = grid[y]!
    if (row[x0] !== '│' || row[x1] !== '│') edges.push(`row ${y}: edges read ${JSON.stringify(row[x0] ?? ' ')} at ${x0} and ${JSON.stringify(row[x1] ?? ' ')} at ${x1} — "${row.slice(Math.max(0, x1 - 24), x1 + 1)}"`)
    const nextBorder = row.indexOf('│', x1 + 1)
    const spare = row.slice(x1 + 1, nextBorder < 0 ? row.length : nextBorder)
    if (spare.trim() !== '') bleeds.push(`row ${y}: ${JSON.stringify(spare.trim().slice(0, 24))} painted right of the border at ${x1 + 1}`)
    const innerText = row.slice(x0 + 1, x1)
    const gutter = GUTTER.exec(innerText)
    const marker = gutter?.[2] ?? ' '
    const markerX = x0 + 1 + (gutter ? gutter[0].length - 1 : 0)
    const ground = cells[x1]?.bg ?? 'default'
    const painted = (x: number): boolean => cells[x] !== undefined && cells[x]!.bg !== ground
    const spareEnd = nextBorder < 0 ? row.length : nextBorder
    let past = 0
    for (let x = x1; x < spareEnd; x++) if (painted(x)) past++
    if (marker === '-' || marker === '+') {
      bandedRows++
      if (!painted(markerX)) bands.push(`row ${y}: the ${marker} row carries no band at its marker`)
      else {
        let holes = 0
        for (let x = markerX; x < x1; x++) if (!painted(x)) holes++
        if (holes > 0) gaps.push(`row ${y}: ${holes} unpainted cells inside the band`)
        if (!painted(x1 - 1)) bands.push(`row ${y}: the band stops short of the border`)
      }
    }
    if (past > 0) bands.push(`row ${y}: the band continues ${past} cells past the border at ${x1}`)
    bandMap.push(Array.from({ length: Math.min(row.length, spareEnd + 1) }, (_, x) => (x === x0 || x === x1 ? '│' : painted(x) ? '#' : row[x] === ' ' ? '.' : row[x]!)).join(''))
    inner.push(gutter ? innerText.slice(gutter[0].length) : innerText)
  }
  check(`${label}: every row inside the box keeps both border glyphs`, edges.length === 0, edges.slice(0, 3).join(' · '))
  check(`${label}: nothing is painted right of the border`, bleeds.length === 0, bleeds.slice(0, 3).join(' · '))
  check(`${label}: every red or green band ends exactly at the border`, bands.length === 0, bands.slice(0, 3).join(' · '))
  check(`${label}: the removed and added rows carry an unbroken band`, bandedRows >= 4 && gaps.length === 0, gaps.length ? gaps.slice(0, 3).join(' · ') : `${bandedRows} banded rows`)
  const innerJoined = squash(inner.join(''))
  for (const [name, text] of [['the over-long removed line', removedLong], ['the over-long added line', addedLong], ['the long context line', contextLong], ['the short removed line', removedShort], ['the short added line', addedShort]] as const) {
    const expanded = expandTabs(text)
    check(`${label}: ${name} wraps inside the box with every character kept`, innerJoined.includes(squash(expanded)), `${expanded.slice(0, 40)}…`)
  }
  const headerRow = rows[top + 1]!
  const headerCells = grid[top + 1]!
  const headerGround = headerCells[x1]?.bg ?? 'default'
  const headerGutter = GUTTER.exec(headerRow.slice(x0 + 1, x1))
  check(`${label}: the header line above the removed block paints neutral with no marker`, headerRow.includes('name') && headerCells.slice(x0 + 1, x1).every(cell => cell.bg === headerGround) && headerGutter?.[2] === ' ', headerRow.slice(x0, x0 + 20))
  check(`${label}: the header columns sit at the line's own tab stops`, headerGutter !== null && headerRow.slice(x0 + 1 + headerGutter[0].length, x1).startsWith(expandTabs(header)), JSON.stringify(headerRow.slice(x0 + 1, x0 + 48)))
  if (FRAMES) writeFileSync(join(FRAMES, `${COLS}x${ROWS}-${label}-band.txt`), bandMap.join('\n') + '\n')
}

console.log(`prove-diff-wrap-drive: the built product at ${COLS}x${ROWS}, a Write of a tab-separated table with an over-long removed and added pair`)
const run = await capture()
const finalRows = rowsOf(run.grid)
const done = run.marks.find(mark => mark.label === 'done')
printFrame(`${COLS}x${ROWS} final (end: ${run.endReason})`, finalRows)
if (FRAMES) {
  writeFileSync(join(FRAMES, `${COLS}x${ROWS}.txt`), finalRows.map(row => row.replace(/\s+$/, '')).join('\n') + '\n')
  if (done) writeFileSync(join(FRAMES, `${COLS}x${ROWS}-done.txt`), rowsOf(done.grid).map(row => row.replace(/\s+$/, '')).join('\n') + '\n')
}
check('the capture ran to its settled end (every send delivered)', run.status === 0 && run.grid.length === ROWS, `vshot exit ${run.status} · ${run.endReason} · ${run.tail.slice(-400)}`)
check('the Write landed on disk', existsSync(tablePath) && readFileSync(tablePath, 'utf8') === AFTER)
check('the turn settled (the closing text is on screen)', finalRows.some(row => row.includes(CLOSING)))
check('no consent card stood in the way (the bypass posture)', !finalRows.some(row => row.includes('Do you want to')))
if (run.grid.length === ROWS) readBox(run.grid, 'final')
if (done && done.grid.length === ROWS) readBox(done.grid, 'done')

if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-diff-wrap-drive: ALL LAWS HOLD' : `prove-diff-wrap-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
