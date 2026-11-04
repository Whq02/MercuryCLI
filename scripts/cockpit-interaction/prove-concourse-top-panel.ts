#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { removeScratch } from '../lib/removeScratch.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const OUT_DIR = resolve(argAfter('--frames') ?? join(tmpdir(), `concourse-top-panel-${process.pid}`))
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const scratch = join(tmpdir(), `concourse-top-panel-${process.pid}-home`)
removeScratch(scratch)
const chatHome = join(scratch, 'chat-home')
mkdirSync(chatHome, { recursive: true })
process.env.MERCURY_CONFIG_DIR = chatHome
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const { scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')

type Grid = { grid: { c: string }[][]; endReason?: string }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
const CRITTER_RUN = /[▀▄█]{7,}/
const critterRows = (lines: string[]): number[] => lines.flatMap((l, i) => (CRITTER_RUN.test(l) ? [i] : []))
const LOCKUP = 'SESSION CONCOURSE'
const CRUMBS = ['BOOT ›', '› CONCOURSE ›', 'FOCUSED CHAT']
const crumbRows = (lines: string[]): string[] => lines.filter(l => CRUMBS.some(c => l.includes(c))).map(l => l.trim())
const panelTop = (row: string): boolean => /^[╭┏]/.test(row.trimStart())

function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const out = join(OUT_DIR, `${name}.json`)
  const cfgPath = join(scratch, `${name}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env, cwd })
  if (res.status !== 0 || !existsSync(out)) {
    console.error(`✗ vshot (${name}) failed: ${(res.stderr ?? '').slice(-600)}`)
    process.exit(1)
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
  const lines = linesOf(payload)
  writeFileSync(join(OUT_DIR, `${name}.txt`), lines.map(l => l.trimEnd()).join('\n') + '\n')
  check(`${name}: the scene painted ready (${payload.endReason ?? '?'})`, payload.endReason === 'ready', lines.slice(0, 6).join('\n'))
  return lines
}

const boardHome = join(scratch, 'board-home')
seedFirstRun(boardHome, [REPO])
const boardEnv = (fixture: Record<string, unknown>, tag: string): NodeJS.ProcessEnv => {
  for (const g of fixture.groups as Array<{ rows: Array<Record<string, unknown>> }>) for (const r of g.rows) r.workspaceDir = boardHome
  const fixturePath = join(boardHome, `${tag}-fixture.json`)
  writeFileSync(fixturePath, JSON.stringify(fixture))
  return {
    ...process.env,
    MERCURY_CONFIG_DIR: boardHome,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath,
    MERCURY_DAEMON_DIR: join(boardHome, 'daemon'),
    MERCURY_CREW_DIR: join(boardHome, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_PARTY: '0',
    MERCURY_CRITTER_GAZE: '0',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
}
const boardCfg = (cols: number, rows: number, readyText: string): Record<string, unknown> =>
  ({ argv: ['node', BIN], sends: [], total: 150, readyText, readySettleTicks: 4, cols, rows })

const reference = referenceFixtureSnapshot()
const HANDLE = (reference.context as { operatorHandle: string }).operatorHandle
const handleRe = new RegExp(`(^|[^\\w])${HANDLE}([^\\w]|$)`)

console.log('W — the wide board (160×48, no ask): no top panel; the two panes start on the first row; no name anywhere on the board')
{
  const fixture = referenceFixtureSnapshot()
  fixture.needsYou = []
  ;(fixture.counts as { needsYou: number }).needsYou = 0
  const lines = capture('board-wide-160x48', boardCfg(160, 48, 'STATUS & TITLE'), boardEnv(fixture, 'wide'), REPO)
  check('W1 no critter rows on the board', critterRows(lines).length === 0, critterRows(lines).map(i => `row ${i}: ${lines[i]!.trim()}`).join(' | '))
  check(`W2 no "MERCURY — ${LOCKUP}" title bar`, !lines.some(l => l.includes(LOCKUP)), lines.find(l => l.includes(LOCKUP))?.trim())
  check('W3 no BOOT › CONCOURSE › FOCUSED CHAT breadcrumb', crumbRows(lines).length === 0, crumbRows(lines).join(' | '))
  check(
    'W4 the live view and the session list start on the first row (both top borders on row 0; the session header and SESSIONS on row 1)',
    panelTop(lines[0] ?? '') && ((lines[0] ?? '').match(/[╭┏]/g) ?? []).length === 2 && (lines[1] ?? '').includes('↵ enter session') && (lines[1] ?? '').includes('SESSIONS'),
    lines.slice(0, 2).map(l => l.trimEnd()).join('\n'),
  )
  const status = lines.findIndex(l => l.includes('▚▛▀▜▞') && l.includes(' seats'))
  check(
    `W5 the status row ends on the seats and the operator's name ("${HANDLE}") is on no row of the board`,
    status >= 0 && status > lines.length - 6 && /seats │$/.test((lines[status] ?? '').trimEnd()) && !lines.some(l => handleRe.test(l)),
    `status row ${status}: ${(lines[status] ?? '').trim()}`,
  )
}

console.log('S — the board at 110×34 (the reference fixture, one ask): the panes start on the first row; the ask sits in the session list, the status row carries the project and the seats alone')
{
  const lines = capture('board-stacked-110x34', boardCfg(110, 34, 'STATUS & TITLE'), boardEnv(referenceFixtureSnapshot(), 'stacked'), REPO)
  check('S1 no critter rows, no title bar, no breadcrumb', critterRows(lines).length === 0 && !lines.some(l => l.includes(LOCKUP)) && crumbRows(lines).length === 0, lines.slice(0, 3).map(l => l.trimEnd()).join('\n'))
  check('S2 the panes start on the first row and the NEEDS YOU block sits below them, inside the session list', panelTop(lines[0] ?? '') && (lines[1] ?? '').includes('SESSIONS') && lines.findIndex(l => l.includes('NEEDS YOU')) > 1, lines.slice(0, 2).map(l => l.trimEnd()).join('\n'))
  const status = lines.find(l => l.includes('▚▛▀▜▞') && l.includes(' seats')) ?? ''
  check(
    'S3 the status row is the project chip and the seats, whole: no coordinator chip, no over-seat words, no name',
    /▚▛▀▜▞ │ Moodle ⌄\s+\d+\/\d+ seats │/.test(status) && !/coordinator|over the|live/.test(status) && !handleRe.test(status),
    status.trim(),
  )
}

console.log('C — the compact board (96×30): it paints no top panel either')
{
  const lines = capture('board-compact-96x30', boardCfg(96, 30, 'sessions · '), boardEnv(referenceFixtureSnapshot(), 'compact'), REPO)
  check('C1 no critter rows, no title bar, no breadcrumb on the compact board', critterRows(lines).length === 0 && !lines.some(l => l.includes(LOCKUP)) && crumbRows(lines).length === 0, lines.slice(0, 3).map(l => l.trimEnd()).join('\n'))
}

console.log('G — the guard: the chat screen keeps its header critter (160×48)')
{
  const cfg = scenario('frame', 160, 48) as Record<string, unknown>
  const lines = capture('chat-160x48', { ...cfg, total: 150, readyText: '❯ first task', readySettleTicks: 4 }, { ...process.env, MERCURY_CONFIG_DIR: chatHome, MERCURY_DAEMON_DIR: join(chatHome, 'daemon'), MERCURY_AWAY_SUMMARY: '0', MERCURY_CRITTER_GAZE: '0' }, REPO)
  cleanupScenario('frame')
  const rows = critterRows(lines)
  const top = rows.find(r => r < 8 && rows.includes(r + 1) && rows.includes(r + 2))
  check('G1 the chat header paints the critter: three stacked rows of its art at the top of the frame', top !== undefined, lines.slice(0, 8).map(l => l.trimEnd()).join('\n'))
}

if (failures === 0) removeScratch(scratch)
else console.log(`[forensics] world kept: ${scratch}`)
console.log(`  frames: ${OUT_DIR}`)
console.log(failures === 0 ? '\nprove-concourse-top-panel: ALL LAWS HOLD' : `\nprove-concourse-top-panel: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
