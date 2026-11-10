#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

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
  console.error(`${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const OUT_DIR = resolve(argAfter('--frames') ?? join(tmpdir(), `row-line-wraps-${process.pid}`))
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const j = (value: unknown): string => JSON.stringify(value)

const { closeChordHintOf } = await import('../../src/components/concourse/controlManifest.ts')
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.ts')
const { PARK_REFUSED_NOW_LEAD } = await import('../../src/services/concourse/concourseSnapshot.ts')
const rowLine = (await import('../../src/components/concourse/rowLine.ts').catch(() => null)) as null | typeof import('../../src/components/concourse/rowLine.ts')

const hintOf = (rung: string): string => keyHintLabel(closeChordHintOf(rung as never, false) ?? '')
const ARCHIVES = hintOf('archive')
const DELETES = hintOf('delete')
const ARMS = hintOf('arm-delete')
const ARMED = ['armed — ↵ again enters · tab to message · esc disarms', 'armed — ↵ again enters · esc disarms']
const REFUSAL = `${PARK_REFUSED_NOW_LEAD}1 crewmate is waiting to retry by itself`

console.log('W1 a line under the selected row breaks after a separator when a clause fits, at a space when it does not, and loses no word, at the cell each board width gives it')
{
  check('the four hints are the ones the board composes', ARCHIVES.endsWith('again archives it (the chat stands parked)') && DELETES.endsWith('again deletes it (the record ends)') && /again arms the delete · .+ in 5 s ends it$/.test(ARMS), j([ARCHIVES, DELETES, ARMS]))
  for (const cell of [37, 50, 69]) {
    for (const words of [ARCHIVES, DELETES, ARMS, ARMED[0]!, REFUSAL]) {
      const lines = rowLine?.rowLineLines(words, cell) ?? []
      const rows = rowLine?.rowLineRows(words, cell)
      check(`${cell} cells · "${words.slice(0, 34)}…": ${lines.length} row(s), each inside the cell, none starting or ending on a space, the words whole when the rows are read on`, lines.length > 0 && rows === lines.length && lines.every(line => line.length <= cell - 2 && line === line.trim()) && lines.join(' ') === words, j({ rows, lines }))
    }
  }
  const armsAt37 = rowLine?.rowLineLines(ARMS, 37) ?? []
  const armedAt37 = rowLine?.rowLineLines(ARMED[0]!, 37) ?? []
  const armedAt50 = rowLine?.rowLineLines(ARMED[0]!, 50) ?? []
  check('a hint with clauses breaks after its separator, never inside a clause that fits', j(armsAt37) === j([`${ARMS.split(' · ')[0]} ·`, ARMS.split(' · ')[1]]) && j(armedAt37) === j(['armed — ↵ again enters ·', 'tab to message · esc disarms']) && j(armedAt50) === j(['armed — ↵ again enters · tab to message ·', 'esc disarms']), j({ armsAt37, armedAt37, armedAt50 }))
  check('at 69 cells (a 213-column board) every chord hint is one row, as before', rowLine !== null && [ARCHIVES, DELETES, ARMS].every(words => rowLine.rowLineRows(words, 69) === 1))
  check('at 37 cells (100 and 120 columns) each takes two rows', rowLine !== null && [ARCHIVES, DELETES, ARMS, ARMED[0]!, REFUSAL].every(words => rowLine.rowLineRows(words, 37) === 2), j(rowLine === null ? null : [ARCHIVES, DELETES, ARMS, ARMED[0]!, REFUSAL].map(words => rowLine.rowLineRows(words, 37))))
  check("the list's columns are the ones it had: project 9 cells and 12 from 66, age 9, the NOW column from 72", rowLine !== null && j([39, 65, 66, 71, 72].map(inner => rowLine.listColumns(inner))) === j([{ colProject: 9, colAge: 9, nowWidth: 0 }, { colProject: 9, colAge: 9, nowWidth: 0 }, { colProject: 12, colAge: 9, nowWidth: 0 }, { colProject: 12, colAge: 9, nowWidth: 0 }, { colProject: 12, colAge: 9, nowWidth: 21 }]) && rowLine.rowNowCellWidth(39) === 18 && rowLine.rowNowCellWidth(72) === 20, rowLine === null ? 'no rowLine module' : j([39, 65, 66, 71, 72].map(inner => rowLine.listColumns(inner))))
}

const scratch = join(tmpdir(), `row-line-wraps-${process.pid}-home`)
removeScratch(scratch)
mkdirSync(scratch, { recursive: true })
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
seedFirstRun(scratch, [REPO])
{
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 4 }
  cfg['concourseCoordinator'] = { mode: 'off' }
  delete cfg['coordinatorEnabled']
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
}

const TITLES = { refused: 'Fix OAuth callback', live: 'Refactor parser', stopped: 'Audit billing receipts', parked: 'Trace reconnect race' }
const fixture = referenceFixtureSnapshot() as Record<string, unknown> & { counts: Record<string, number> }
{
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({ ownerLabel: null, seats: null, nowLabel: null, workspaceDir: scratch, ...extra })
  fixture.coordinator = { mode: 'off' }
  fixture.needsYou = []
  fixture.peek = null
  fixture.groups = [
    { id: 'working', label: 'WORKING', rows: [
      row({ sessionId: 's-wraps-refused', title: TITLES.refused, state: 'working', projectLabel: 'Moodle', ageLabel: '07m', nowLabel: REFUSAL }),
      row({ sessionId: 's-wraps-live', title: TITLES.live, state: 'working', projectLabel: 'orchard-src', ageLabel: '18m', nowLabel: 'Bash · bun test parser' }),
    ] },
    { id: 'stopped', label: 'STOPPED', rows: [row({ sessionId: 's-wraps-stopped', title: TITLES.stopped, state: 'stopped', projectLabel: 'Moodle', ageLabel: '12m' })] },
    { id: 'parked', label: 'PARKED', rows: [row({ sessionId: 's-wraps-parked', title: TITLES.parked, state: 'parked', projectLabel: 'orchard-src', ageLabel: '9m' })] },
  ]
  fixture.counts = { ...fixture.counts, live: 2, needsYou: 0, working: 2, queued: 0 }
}
const fixturePath = join(scratch, 'row-line-fixture.json')
writeFileSync(fixturePath, JSON.stringify(fixture))

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
const ESC = String.fromCharCode(27)
const DOWN = `${ESC}[B`
const CTRL_X = String.fromCharCode(24)

const selects = (title: string): string => `▸ [^│\\n]*${title}`
const selectsWithout = (title: string, gone: string): string => `(?s)\\A(?!.*${gone}).*▸ [^│\\n]*${title}`

function capture(cols: number, rows: number): Map<string, string[]> {
  const out = join(OUT_DIR, `row-line-${cols}x${rows}.json`)
  const cfgPath = join(scratch, `vshot-${cols}.json`)
  writeFileSync(cfgPath, JSON.stringify({
    argv: ['node', BIN],
    cwd: REPO,
    sends: [
      { data: '', awaitText: 'SESSIONS', requireAwait: true, awaitSettleTicks: 4, mark: 'refused' },
      { afterPrevTicks: 3, data: DOWN, awaitPattern: selects(TITLES.refused) },
      { afterPrevTicks: 3, data: '\r', awaitPattern: selects(TITLES.live) },
      { data: '', awaitText: 'armed —', requireAwait: true, awaitSettleTicks: 3, mark: 'armed' },
      { data: ESC, awaitText: 'armed —', requireAwait: true, awaitSettleTicks: 2 },
      { afterPrevTicks: 4, data: DOWN, awaitPattern: selectsWithout(TITLES.live, 'armed —') },
      { afterPrevTicks: 3, data: CTRL_X, awaitPattern: selects(TITLES.stopped) },
      { data: '', awaitText: 'again arch', requireAwait: true, awaitSettleTicks: 3, mark: 'archives' },
      { data: ESC, awaitText: 'again arch', requireAwait: true, awaitSettleTicks: 2 },
      { afterPrevTicks: 4, data: DOWN, awaitPattern: selectsWithout(TITLES.stopped, 'again arch') },
      { afterPrevTicks: 3, data: CTRL_X, awaitPattern: selects(TITLES.parked) },
      { data: '', awaitText: 'again arms', requireAwait: true, awaitSettleTicks: 3, mark: 'arms' },
    ],
    total: 170,
    cols,
    rows,
    out,
  }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(240_000),
    env: {
      ...(process.env as Record<string, string>),
      MERCURY_CONFIG_DIR: scratch,
      MERCURY_HOME: '',
      MERCURY_TMPDIR: join(scratch, 'temp'),
      MERCURY_SPLASH: 'off',
      MERCURY_CONCOURSE: 'always',
      MERCURY_CONCOURSE_FIXTURE: fixturePath,
      MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
      MERCURY_CREW_DIR: join(scratch, 'crew'),
      MERCURY_AWAY_SUMMARY: '0',
      MERCURY_PARTY: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    },
  })
  const marks = new Map<string, string[]>()
  if (res.status !== 0 || !existsSync(out)) {
    console.log(`  the capture at ${cols}x${rows} ended ${res.status}: ${(res.stderr ?? '').slice(-400)}`)
    return marks
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  for (const mark of payload.marks ?? []) {
    const lines = linesOf(mark)
    marks.set(mark.label, lines)
    writeFileSync(join(OUT_DIR, `row-line-${cols}x${rows}--${mark.label}.txt`), lines.join('\n') + '\n')
  }
  return marks
}

type Line = { title: string; glyph: string; rows: string[]; cell: number }
function lineUnderSelected(lines: string[]): Line | null {
  const at = lines.findIndex(line => line.includes('▸ '))
  if (at === -1) return null
  const selected = lines[at]!
  const marker = selected.indexOf('▸ ')
  const glyphAt = marker + 2
  const borderAt = Math.max(selected.lastIndexOf('│'), selected.lastIndexOf('┃'))
  const cell = borderAt - 1 - glyphAt
  const rows: string[] = []
  let glyph = ''
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!
    const lead = line.slice(marker, glyphAt)
    const body = line.slice(glyphAt, borderAt).trimEnd()
    if (lead.trim() !== '' || body === '') break
    if (rows.length === 0) {
      if (body[1] !== ' ' || body[0] === ' ') break
      glyph = body[0]!
      rows.push(body.slice(2))
    } else {
      if (body.slice(0, 2).trim() !== '') break
      rows.push(body.slice(2))
    }
  }
  const title = selected.slice(marker + 2, borderAt).trim()
  return { title, glyph, rows, cell }
}

const SIZES = [[100, 30], [120, 40], [160, 50], [213, 60]] as const
for (const [cols, rows] of SIZES) {
  console.log(`W2 the board at ${cols}x${rows}`)
  const marks = capture(cols, rows)
  const scenes: Array<[string, string, string, string[]]> = [
    ['refused', TITLES.refused, GLYPH.fail, [REFUSAL]],
    ['armed', TITLES.live, GLYPH.handoff, ARMED],
    ['archives', TITLES.stopped, GLYPH.handoff, [ARCHIVES]],
    ['arms', TITLES.parked, GLYPH.handoff, [ARMS]],
  ]
  for (const [mark, title, glyph, expected] of scenes) {
    const lines = marks.get(mark)
    const line = lines === undefined ? null : lineUnderSelected(lines)
    const staged = line !== null && line.title.includes(title.slice(0, 12))
    const words = line === null ? '' : line.rows.map(row => row.trim()).join(' ')
    const whole = expected.includes(words)
    const wanted = line === null ? -1 : rowLine !== null ? rowLine.rowLineRows(whole ? words : expected[0]!, line.cell) : whole ? line.rows.length : -1
    check(`${mark}: the selected row is "${title}"`, staged, line === null ? '(no selected row in the frame)' : line.title)
    check(`${mark}: the line under it says its words whole, under its glyph, with no ellipsis`, staged && whole && line.glyph === glyph && !line.rows.some(row => row.includes('…')), line === null ? '' : j({ glyph: line.glyph, rows: line.rows }))
    check(`${mark}: on ${line?.cell ?? '?'} cells it takes the rows its words need and no more, each row ending on a whole word`, staged && whole && line.rows.length === wanted && line.rows.every(row => row.length <= line.cell - 2), line === null ? '' : j({ rows: line.rows.length, wanted, cell: line.cell }))
  }
  const refusedRow = (marks.get('refused') ?? []).find(line => line.includes('▸ ')) ?? ''
  check("the refused row's own cell still leads with the refusal", refusedRow.includes(PARK_REFUSED_NOW_LEAD.trim()), refusedRow.trim().slice(0, 140))
  if (cols >= 213) {
    const one = ['archives', 'arms'].map(mark => lineUnderSelected(marks.get(mark) ?? [])?.rows.length)
    check('a board wide enough keeps each chord hint on one row', j(one) === j([1, 1]), j(one))
  }
}

removeScratch(scratch)
console.log(failures === 0 ? `\nprove-row-line-wraps: ALL LAWS HOLD (frames under ${OUT_DIR})` : `\nprove-row-line-wraps: ${failures} FAILURE(S) (frames under ${OUT_DIR})`)
process.exit(failures === 0 ? 0 : 1)
