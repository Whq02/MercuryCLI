#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 the resolver — every region of the board keeps the ↑↓ row')
{
  const { browseKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const keysOf = (rows: ReadonlyArray<{ keys: string; label: string }>): string[] => rows.map(k => k.keys)
  for (const region of ['list', 'live', 'chat', 'rail'] as const) {
    const rows = browseKeysFor({ chatPresent: true, region })
    check(`the ${region} legend keeps '↑↓ browse' (the key fires there)`, rows.some(k => k.keys === '↑↓' && k.label === 'browse'), keysOf(rows).join(','))
  }
  check(
    'the region-less rows (the atlas) name where the key fires',
    browseKeysFor({ chatPresent: true }).find(k => k.keys === '↑↓')?.label === 'browse (list · live · split)',
  )
  check(
    'esc is relabelled by chat presence in every region',
    (['list', 'live', 'chat', 'rail'] as const).every(region => browseKeysFor({ chatPresent: false, region }).find(k => k.keys === 'esc')?.label === 'boot face' && browseKeysFor({ chatPresent: true, region }).find(k => k.keys === 'esc')?.label === 'focused chat'),
  )
}

console.log('§2 the screen — the board-browse arms: the live panel on a single-line draft, the split pane, the rows')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'the board-browse arm fires from the live panel on a single-line draft (its ↵ enters the same selection)',
    screen.includes("(region === 'live' && (key.upArrow || key.downArrow) && !liveDraftRef.current.text.includes(NL))"),
  )
  check('… and from the split chat pane (split-view D5 stands)', screen.includes("(region === 'chat' && (key.upArrow || key.downArrow))"))
  const listStart = screen.indexOf("if (region === 'list') {")
  const listEnd = screen.indexOf("if (region === 'chat') {", listStart)
  const list = screen.slice(listStart, listEnd)
  check(
    'the rows keep their own ↑↓ browse and their ↵',
    listStart > 0 && list.includes('if (key.upArrow || key.downArrow) {') && list.includes('if (key.return && pastGate()) {') && list.includes('const sel = sessionRows.find(r => r.sessionId === boardSelRef.current)') && list.includes('if (sel) compactSteerOrEnter(sel)'),
  )
  const enterStart = screen.indexOf('if (key.return && !key.shift) {')
  const enterEnd = screen.indexOf('if (reducedStage) {', enterStart)
  const enter = screen.slice(enterStart, enterEnd)
  check(
    'the live panel keeps its browse because its ↵ ENTERS the selection on an empty draft (arrows and ↵ agree there)',
    enter.includes("if (region !== 'live') return") && enter.includes('if (sel) enterSession(sel.sessionId)'),
  )
  check(
    'the browse arm names two regions only (the live panel and the split chat pane)',
    /if \(\s*\(region === 'live' && \(key\.upArrow \|\| key\.downArrow\) && !liveDraftRef\.current\.text\.includes\(NL\)\) \|\|\s*\(region === 'chat' && \(key\.upArrow \|\| key\.downArrow\)\)\s*\) \{/.test(screen),
  )
}

console.log('§3 the legend — the footer hands its region to the resolver; the atlas reads the region-less rows')
{
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the footer legend hands the focused region to the one resolver', layout.includes('const browseKeys = browseKeysFor({ chatPresent: chat, region })'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('the atlas reads the region-less rows (the row names where it fires)', screen.includes('keys: [...browseKeysFor({ chatPresent: chat }), CONCOURSE_HELP_KEY]'))
  const manifest = read('src/components/concourse/controlManifest.ts')
  check(
    'the resolver filters no row out for a region and the region-less row names where the key fires',
    !manifest.includes('CONCOURSE_BROWSE_KEYS.filter(') &&
      manifest.includes("? { keys: '↑↓', label: 'browse (list · live · split)' }"),
  )
}

if (process.env.PROVE_ARROW_FOCUS_STATIC === '1') {
  console.log('§4 skipped (PROVE_ARROW_FOCUS_STATIC=1)')
  process.exit(failures === 0 ? 0 : 1)
}
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
console.log('§4 the drive — the built bundle at 120×40')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const OUT_DIR = process.env.ARROW_FOCUS_CAPTURE_DIR ?? join(tmpdir(), `arrow-focus-captures-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
interface Send {
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  mark?: string
}
const ESC = '\x1b'
const DOWN = `${ESC}[B`

function newScratch(tag: string): string {
  const scratch = join(tmpdir(), `arrow-focus-${tag}-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  seedFirstRun(scratch, [REPO])
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  const fixture = referenceFixtureSnapshot()
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.needsYou = []
  fixture.coordinator = { mode: 'off' }
  writeFileSync(join(scratch, 'concourse-fixture.json'), JSON.stringify(fixture))
  return scratch
}

const markedFrames = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => markedFrames.get(`${tag}:${label}`) ?? []
function capture(tag: string, scratch: string, sends: Send[], total: number): string[] {
  const cols = 120
  const rows = 40
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(scratch, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total, cols, rows, out }))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: scratch,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: join(scratch, 'concourse-fixture.json'),
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_CREW_DIR: join(scratch, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) throw new Error(`vshot ${tag} failed: ${(res.stderr ?? '').slice(-600)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const lines = linesOf(payload)
  writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}.txt`), lines.join('\n') + '\n')
  for (const m of payload.marks ?? []) {
    markedFrames.set(`${tag}:${m.label}`, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  return lines
}
const selRow = (lines: string[]): number => lines.findIndex(l => /▸ /.test(l) && /Audit|Fix OAuth|Refactor|Update/.test(l))
const titleOf = (line: string | undefined): string => (line ?? '').match(/(?:Audit|Fix OAuth|Refactor|Update)(?: \S+)*/)?.[0] ?? ''
const sameTitle = (a: string, b: string): boolean => {
  const x = a.split('…')[0] ?? ''
  const y = b.split('…')[0] ?? ''
  return x.length >= 8 && (x.startsWith(y) || y.startsWith(x))
}
const settle = { atTick: 999, awaitText: 'Fix OAuth', minTick: 5, awaitSettleTicks: 2 }
const scratches: string[] = []

{
  const scratch = newScratch('list')
  scratches.push(scratch)
  capture('list', scratch, [
    { ...settle, data: DOWN, mark: 'before' },
    { afterPrevTicks: 3, data: '\r', mark: 'after-down' },
    { afterPrevTicks: 3, data: '', mark: 'after-enter' },
  ], 80)
  const before = markOf('list', 'before')
  const afterDown = markOf('list', 'after-down')
  const afterEnter = markOf('list', 'after-enter')
  const rowBefore = selRow(before)
  const rowAfter = selRow(afterDown)
  const nextRow = before.findIndex((l, i) => i > rowBefore && titleOf(l) !== '')
  check(
    'list: on entry the rows hold focus, and ONE ↓ moved the ▸ selection onto the second row',
    rowBefore >= 0 && rowAfter > rowBefore && sameTitle(titleOf(afterDown[rowAfter]), titleOf(before[nextRow])),
    `before=${rowBefore}:${JSON.stringify(titleOf(before[rowBefore]))} after=${rowAfter}:${JSON.stringify(titleOf(afterDown[rowAfter]))} expected=${JSON.stringify(titleOf(before[nextRow]))}`,
  )
  const legend = afterEnter.find(l => /enters \(armed\)/.test(l)) ?? ''
  check('list: ↵ on the rows ARMS the selected row (the legend says enters (armed) — the second ↵ enters)', legend !== '', afterEnter.find(l => l.includes('tab panes'))?.trim().slice(0, 118) ?? '(no legend row)')
}

for (const s of scratches) rmSync(s, { recursive: true, force: true })
console.log(`  captures: ${OUT_DIR}`)
console.log(failures === 0 ? '\nprove-concourse-arrow-focus: ALL LAWS HOLD' : `\nprove-concourse-arrow-focus: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
