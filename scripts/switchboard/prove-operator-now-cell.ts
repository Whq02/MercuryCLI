#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import type { ConcourseSnapshotV1 } from '../../src/components/concourse/contracts.ts'

assert.ok(process.env.MERCURY_CONFIG_DIR)
delete process.env.MERCURY_HOME
process.env.NODE_ENV = 'test'
process.env.MERCURY_LIVE_GLYPHS = '0'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
const section = (t: string): void => console.log(`\n── ${t} ──`)
const REPO = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

const React = await import('react')
const h = React.createElement
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { ConcourseLayout, rowNeedsOperator } = await import('../../src/components/concourse/ConcourseLayout.tsx')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { PARK_REFUSED_NOW_LEAD, PARKING_NOW_LEAD } = await import('../../src/services/concourse/concourseSnapshot.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')

const CRASH = 'crashed — ended unexpectedly; enter to resume, or x x releases it'
const REFUSED = `${PARK_REFUSED_NOW_LEAD}a turn is in flight`
const PARKING = `${PARKING_NOW_LEAD}operator:close`

section('§1 which rows need the operator')
if (typeof rowNeedsOperator !== 'function') check('the layout exports the one predicate that names them', false)
else {
  check('a row with a waiting ask does, whatever its state', rowNeedsOperator({ state: 'working' }, 'run git push') && rowNeedsOperator({ state: 'needs-you', nowLabel: null }, 'run git push'))
  check('a needs-you row with a reason does (a crash, a process that is gone)', rowNeedsOperator({ state: 'needs-you', nowLabel: CRASH }) && rowNeedsOperator({ state: 'needs-you', nowLabel: 'its process is gone' }))
  check('a refused park does, in the working and the ready groups', rowNeedsOperator({ state: 'working', nowLabel: REFUSED }) && rowNeedsOperator({ state: 'ready-to-review', nowLabel: REFUSED }))
  check('a needs-you row with nothing to say does not (the row keeps its project and age)', !rowNeedsOperator({ state: 'needs-you' }) && !rowNeedsOperator({ state: 'needs-you', nowLabel: '' }) && !rowNeedsOperator({ state: 'needs-you' }, ''))
  check('a park in flight, a live activity line, a parked or attached row do not', !rowNeedsOperator({ state: 'working', nowLabel: PARKING }) && !rowNeedsOperator({ state: 'working', nowLabel: 'Bash · bun test parser' }) && !rowNeedsOperator({ state: 'parked', nowLabel: 'parked · 04m' }) && !rowNeedsOperator({ state: 'attached', nowLabel: 'with you' }) && !rowNeedsOperator({ state: 'ready-to-review' }))
}

type Scene = 'operator' | 'plain'
type Group = ConcourseSnapshotV1['groups'][number]
function snapshotOf(scene: Scene): ConcourseSnapshotV1 {
  const snapshot = JSON.parse(JSON.stringify(referenceFixtureSnapshot())) as ConcourseSnapshotV1
  const working = snapshot.groups.find(g => g.id === 'working')!
  for (const r of working.rows) {
    if (r.sessionId === 's-oauth') r.nowLabel = scene === 'operator' ? REFUSED : 'editing src/auth/callback.ts'
    if (r.sessionId === 's-parser') r.nowLabel = PARKING
    if (r.sessionId === 's-resize') r.nowLabel = 'Bash · bun test parser'
  }
  const needs: Group = {
    id: 'needs-you',
    label: 'NEEDS YOU',
    rows: [
      { ...working.rows[0]!, sessionId: 's-crash', title: 'Migration plan', state: 'needs-you', projectLabel: 'Moodle', ageLabel: '04m', nowLabel: scene === 'operator' ? CRASH : null },
      { ...working.rows[0]!, sessionId: 's-ask', title: 'Deploy checklist', state: 'needs-you', projectLabel: 'Moodle', ageLabel: '02m', nowLabel: null },
      { ...working.rows[0]!, sessionId: 's-headless', title: 'Nightly report', state: 'needs-you', kind: 'headless', workflowsAllowed: true, projectLabel: 'orchard-src', ageLabel: '09m', nowLabel: null },
    ],
  }
  snapshot.groups = [needs, ...snapshot.groups.filter(g => g.id !== 'queued')]
  snapshot.needsYou =
    scene === 'operator'
      ? [
          { obligationId: 'obl-ask', sessionId: 's-ask', title: 'Deploy checklist', question: '"Deploy checklist" asks to run git push origin main', projectLabel: 'Moodle', agentLabel: 'Mercury', ageLabel: '2m' },
          { obligationId: 'obl-headless', sessionId: 's-headless', title: 'Nightly report', question: '"Nightly report" asks to run npm publish', projectLabel: 'orchard-src', agentLabel: 'Mercury', ageLabel: '9m' },
        ]
      : []
  return snapshot
}

async function rowsAt(cols: number, rows: number, scene: Scene): Promise<Record<string, string>> {
  const snapshot = snapshotOf(scene)
  const layout = h(ConcourseLayout, {
    snapshot,
    boardGroups: snapshot.groups,
    filtering: false,
    filterText: '',
    filterCaret: 0,
    region: 'list',
    boardSelectedId: 's-audit',
    railIndex: 0,
    focusTall: 'mirror',
    liveDraftRows: 1,
    coordinatorNode: () => null,
    mirrorNode: () => null,
    wiring: { selectSession: () => {}, enterSession: () => {}, selectObligation: () => {}, answerObligation: () => {}, openObligation: () => {}, focusComposer: () => {} },
  })
  const mounted = await mountOffscreen(h(AppStateProvider, { children: h(ThemeProvider, {}, layout) }), cols, rows)
  try {
    await waitFor(() => mounted.screen().includes('STATUS & TITLE') && mounted.screen().includes('Audit billing'), 5000)
    const lines = mounted.lines()
    const header = lines.find(l => l.includes('STATUS & TITLE')) ?? ''
    const from = header.indexOf('STATUS & TITLE') - 1
    const to = header.indexOf('LAST USED') + 'LAST USED'.length
    const head = lines.findIndex(l => l.includes('STATUS & TITLE'))
    const rail = lines.findIndex((l, i) => i > head && /NEEDS YOU · \d/.test(l.slice(from)) && !l.includes('⊞'))
    const list = lines.slice(head + 1, rail === -1 ? undefined : rail)
    const cut = (needle: string): string => (list.find(l => l.slice(from).includes(needle)) ?? '').slice(from, to)
    return {
      header: header.slice(from, to),
      crash: cut('Migration'),
      ask: cut('Deploy'),
      headless: cut('Nightly'),
      refused: cut('Fix OAuth'),
      parking: cut('Refactor'),
      plain: cut('Update term'),
      ready: cut('Audit billing'),
    }
  } finally {
    mounted.unmount()
  }
}

const NARROW: Array<[number, number]> = [[100, 40], [120, 40], [160, 44], [213, 50]]
const titleOf = (row: string, zone: number): string => row.slice(0, row.length - zone)

section('§2 a list too narrow for the NOW column: the rows that need the operator say why, the others keep their cells')
for (const [cols, rows] of NARROW) {
  const painted = await rowsAt(cols, rows, 'operator')
  const plain = await rowsAt(cols, rows, 'plain')
  const zone = painted.header.length - painted.header.indexOf('PROJECT')
  const dump = Object.entries(painted).map(([k, v]) => `${k}=[${v}]`).join(' ')
  check(`${cols} columns: no NOW column heads the list`, !painted.header.includes('NOW') && painted.header.includes('PROJECT') && painted.header.endsWith('LAST USED'), painted.header)
  check(`${cols} columns: the crashed row says its reason where its project and age stood`, /crashed — ended/.test(painted.crash) && !painted.crash.includes('Moodle') && !painted.crash.includes('04m'), painted.crash)
  check(`${cols} columns: the asking row says it waits for an answer`, /waiting for your/.test(painted.ask) && !painted.ask.includes('02m'), painted.ask)
  check(`${cols} columns: a headless asker leads with its kind and no workflows lead crowds the cell out`, /headless · wait/.test(painted.headless) && !painted.headless.includes('workflows'), painted.headless)
  check(`${cols} columns: the refused park says so`, /park refused — a/.test(painted.refused) && !painted.refused.includes('07m'), painted.refused)
  check(`${cols} columns: a park in flight and a live activity line stay off the row — project and age as before`, !painted.parking.includes('parking') && painted.parking.includes('18m') && /orchard/.test(painted.parking) && !painted.plain.includes('Bash') && painted.plain.includes('03m') && painted.ready.includes('12m') && painted.ready.includes('Moodle'), `${painted.parking} | ${painted.plain} | ${painted.ready}`)
  check(`${cols} columns: every title keeps its room — a row paints the same title with the reason as without it`, (['crash', 'ask', 'headless', 'refused'] as const).every(k => titleOf(painted[k]!, zone) === titleOf(plain[k]!, zone)) && titleOf(painted.refused!, zone).length > 8, dump)
  check(`${cols} columns: a row that does not need the operator is painted cell for cell as on a board where none does`, painted.parking === plain.parking && painted.plain === plain.plain && painted.ready === plain.ready && painted.header === plain.header, dump)
  check(`${cols} columns: with nothing to say the same rows carry their project and age`, plain.crash!.includes('04m') && plain.crash!.includes('Moodle') && plain.refused!.includes('07m') && !/crashed|waiting|park refused/.test(Object.values(plain).join(' ')), Object.values(plain).join(' | '))
}

section('§3 a list wide enough for the NOW column is as it was: every row keeps its cells and the column says what it said')
for (const [cols, rows] of [[214, 50], [96, 64]] as Array<[number, number]>) {
  const painted = await rowsAt(cols, rows, 'operator')
  check(`${cols} columns: the NOW column heads the list between PROJECT and LAST USED`, /PROJECT\s+NOW\s+LAST USED$/.test(painted.header), painted.header)
  check(`${cols} columns: the crashed, asking and refused rows keep project and age beside their words`, /Moodle\s+crashed — /.test(painted.crash) && painted.crash.includes('04m') && /waiting for your/.test(painted.ask) && painted.ask.includes('02m') && /park refused/.test(painted.refused) && painted.refused.includes('07m'), `${painted.crash} | ${painted.ask} | ${painted.refused}`)
  check(`${cols} columns: the column still carries a park in flight and the activity line`, /parking — /.test(painted.parking) && /Bash · bun/.test(painted.plain), `${painted.parking} | ${painted.plain}`)
}

section('§4 the source: one predicate, the brief cell, the tile off')
{
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  const cell = read('src/components/concourse/LiveNowCell.tsx')
  check('the layout hands the brief cell only where the NOW column is absent and the row needs the operator', layout.includes('const operatorCell = nowWidth === 0 && rowNeedsOperator(r, ask)') && layout.includes('<Box width={colProject + colAge} flexShrink={0}>\n                      <LiveNowCell row={r} ask={ask} brief />'))
  check('the brief cell registers no live tile and prints no workflows or next-fire lead', cell.includes('const tiled = live && !brief') && cell.includes('useLiveTile(row.sessionId, row.workspaceDir, tiled)') && cell.includes("if (tiled && !degraded && now.kind !== 'still') {") && cell.includes('row.workflowsAllowed === true && !brief') && cell.includes('row.scheduleNextFireMs !== undefined && !brief'))
}

console.log(failures === 0 ? '\nprove-operator-now-cell: ALL LAWS HOLD' : `\nprove-operator-now-cell: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
