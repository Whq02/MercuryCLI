#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanupScenario, CONFIG_HOME, scenario, SID_ERRORED, writeSyntheticSession } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = join(import.meta.dir, '..', '..')
const OPEN_TITLE = 'first task'
const OTHER_TITLE = 'apply the manifest'
const framesAt = process.argv.indexOf('--frames')
const frameDir = framesAt < 0 ? undefined : process.argv[framesAt + 1]
if (frameDir !== undefined) mkdirSync(frameDir, { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

type Cell = { c: string }
type Payload = { grid: Cell[][]; marks?: Array<{ label: string; grid: Cell[][] }> }
type Send = Record<string, unknown>

const lines = (grid: Cell[][]): string[] => grid.map(row => row.map(c => c.c || ' ').join('').trimEnd())

function capture(
  tag: string,
  name: string,
  cols: number,
  rows: number,
  sends: Send[],
  total: number,
  settings: Record<string, unknown> | null = null,
): { frame: string[]; marks: Record<string, string[]> } {
  const cfg = scenario(name, cols, rows) as Record<string, unknown>
  writeSyntheticSession('errors', SID_ERRORED)
  const settingsPath = join(CONFIG_HOME, 'settings.json')
  if (settings !== null) writeFileSync(settingsPath, JSON.stringify(settings))
  const out = join(CONFIG_HOME, `rail-recent-${tag}-${process.pid}.json`)
  const cfgPath = `${out}.cfg.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, sends, total, cols, rows, out }))
  try {
    const res = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts', 'ui', 'vshot.py'), cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(150_000),
      env: { ...process.env, MERCURY_AWAY_SUMMARY: '0', MERCURY_CONFIG_DIR: CONFIG_HOME, MERCURY_LIVE_GLYPHS: '0', MERCURY_CRITTER: 'crab' },
    })
    if (res.status !== 0) throw new Error(`vshot ${tag} rc=${res.status}: ${(res.stderr ?? '').slice(-400)}`)
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
    const marks: Record<string, string[]> = {}
    for (const m of payload.marks ?? []) marks[m.label] = lines(m.grid)
    return { frame: lines(payload.grid), marks }
  } finally {
    if (settings !== null) rmSync(settingsPath, { force: true })
    rmSync(out, { force: true })
    rmSync(cfgPath, { force: true })
  }
}

function railLines(frame: string[]): string[] {
  return frame.map(text => {
    const cut = text.indexOf('│')
    return (cut >= 0 ? text.slice(0, cut) : text).trimEnd()
  })
}

const isHeader = (line: string): boolean => /^[A-Z]/.test(line)
const railHeaders = (rail: string[]): string[] => rail.filter(isHeader).map(l => l.split(' · ')[0]!.trim())
function recentRows(rail: string[]): string[] {
  const rows: string[] = []
  let inside = false
  for (const line of rail) {
    if (isHeader(line)) inside = line.startsWith('RECENT')
    else if (inside && line.trim() !== '') rows.push(line.trim())
  }
  return rows
}

function stripRow(frame: string[]): string {
  return frame.find(line => line.includes('⊞ SESSIONS')) ?? ''
}

function saveFrame(name: string, frame: string[]): void {
  if (frameDir !== undefined) writeFileSync(join(frameDir, `${name}.txt`), frame.join('\n') + '\n')
}

console.log('='.repeat(60))
console.log(' the RECENT lane never names the conversation open in the view')
console.log('='.repeat(60))

console.log('\n§1 the list roads exclude the conversation in the view, not the bootstrap identity')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const FOLLOWS_SLOT = 'useSyncExternalStore(subscribeFocusedSessionConnector, conversationIdHere, conversationIdHere)'
const rail = src('src/components/HelmLanesRail.tsx')
check('the RECENT scan follows the focused slot', rail.includes(`const conversationId = ${FOLLOWS_SLOT}`))
check('the RECENT scan keys its scope on the conversation in the view', rail.includes('const recentScopeKey = `${getProjectRoot() || \'\'}::${conversationId}`'))
check('the RECENT scan excludes the conversation in the view', rail.includes('filterResumableSessions(all, conversationId)') && !rail.includes('getSessionId()'))
check('the /sessions picker model excludes the conversation in the view', src('src/components/mercury-ui/screens/sessionPickerModel.ts').includes('resumableNewestFirst(all, conversationIdHere())'))
check('the /sessiontab flip excludes the conversation in the view', src('src/commands/sessiontab/sessiontab.tsx').includes('filterResumableSessions(all, conversationIdHere())'))
check('the /resume picker excludes the conversation in the view', src('src/commands/resume/resume.tsx').includes('filterResumableSessions(loaded, conversationIdHere())'))

console.log('\n§2 a direct --resume boot beside an older session of the same project')
const SESSIONS_SEND: Send[] = [
  { minTick: 20, requireAwait: true, awaitText: 'Type a prompt', awaitStableTicks: 4, data: '', mark: 'direct' },
  { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, data: '/sessions' },
  { requireAwait: true, awaitText: '❯ /sessions', awaitSettleTicks: 2, data: '\r' },
  { minTick: 4, requireAwait: true, awaitText: 'Switch to', awaitStableTicks: 3, data: '', mark: 'picker' },
]
try {
  const direct = capture('direct', 'resume-2turn', 120, 44, SESSIONS_SEND, 120)
  const home = direct.marks.direct ?? direct.frame
  saveFrame('120x44-direct', home)
  const homeRail = railLines(home)
  const recent = recentRows(homeRail)
  check('R5 the RECENT lane never lists the conversation open in the view', !recent.some(row => row.includes(OPEN_TITLE)), `RECENT rows ${JSON.stringify(recent)}`)
  check('R5b the RECENT lane lists the older session of the project', recent.some(row => row.includes(OTHER_TITLE)), `RECENT rows ${JSON.stringify(recent)}`)
  check('R7 no sessions strip paints under the view (the RECENT lane and /sessions are the roads)', stripRow(home) === '', stripRow(home))
  const picker = direct.marks.picker ?? direct.frame
  saveFrame('120x44-sessions', picker)
  const switchAt = picker.findIndex(line => line.includes('Switch to ('))
  const pickerRows = switchAt < 0 ? [] : picker.slice(switchAt, switchAt + 8)
  check('R8 /sessions offers the older session and never the conversation open in the view', /Switch to \([1-9]\)/.test(pickerRows[0] ?? '') && pickerRows.some(line => line.includes(OTHER_TITLE)) && !pickerRows.some(line => line.includes(OPEN_TITLE)), JSON.stringify(pickerRows))

  const journey = capture('journey', 'resize-return', 120, 44, [], 120)
  const journeyRail = railLines(journey.frame)
  check('R6 the lanes rail carries the same sections after the resize journey as a direct boot', JSON.stringify(railHeaders(homeRail)) === JSON.stringify(railHeaders(journeyRail)), `direct ${JSON.stringify(railHeaders(homeRail))} vs journey ${JSON.stringify(railHeaders(journeyRail))}`)

  for (const [cols, rows] of [[178, 51], [80, 21]] as const) {
    const tag = `${cols}x${rows}`
    const shot = capture(tag, 'resume-2turn', cols, rows, [{ minTick: 20, requireAwait: true, awaitText: 'Type a prompt', awaitStableTicks: 4, data: '', mark: 'home' }], 80)
    const frame = shot.marks.home ?? shot.frame
    saveFrame(`${tag}-direct`, frame)
    const rows2 = recentRows(railLines(frame))
    if (cols >= 100) check(`R5 at ${tag} the RECENT lane never lists the open conversation`, !rows2.some(row => row.includes(OPEN_TITLE)), JSON.stringify(rows2))
    else check(`at ${tag} the compact cockpit painted the transcript`, frame.some(line => line.includes(OPEN_TITLE)))
  }
} finally {
  cleanupScenario('resume-picker')
}

console.log()
if (failures > 0) {
  console.log(`❌ ${failures} RAIL RECENT-LANE PROOF(S) FAILED`)
  process.exit(1)
}
console.log('✅ ALL RAIL RECENT-LANE PROOFS PASS')
