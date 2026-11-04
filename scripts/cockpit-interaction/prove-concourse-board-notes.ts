#!/usr/bin/env bun
// gate-watch: src/components/concourse/ConcourseScreen.tsx src/components/concourse/ConcourseStrips.tsx src/components/concourse/splitView.ts src/services/switchboard/capacityCheck.ts
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { keyHintLabel } from '../../src/components/mercury-ui/keyHintLabel.ts'

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
const OUT_DIR = resolve(argAfter('--frames') ?? join(tmpdir(), `concourse-board-notes-${process.pid}`))
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const scratch = join(tmpdir(), `concourse-board-notes-${process.pid}-home`)
removeScratch(scratch)
mkdirSync(scratch, { recursive: true })
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')

type Grid = { grid: { c: string }[][]; endReason?: string; marks?: Array<{ label: string; grid: { c: string }[][] }> }
const linesOf = (grid: { c: string }[][]): string[] => grid.map(r => r.map(c => c.c || ' ').join(''))
const marked = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => marked.get(`${tag}:${label}`) ?? []

function seedHome(tag: string, opts: { capacityAnswered: boolean }): string {
  const home = join(scratch, `${tag}-home`)
  seedFirstRun(home, [REPO])
  const cfgPath = join(home, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  if (opts.capacityAnswered) cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  else delete cfg['switchboardCapacity']
  cfg['concourseCoordinator'] = { mode: 'off' }
  delete cfg['coordinatorEnabled']
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  return home
}

const QUEUED_ID = 'dispatch:cm-notes-1'
const PARKED_ID = 's-notes-parked'
const OLDER_ID = 'older:/tmp/notes-moodle'
const DOOR_ID = 'project:notes-orchard'
function boardFixture(home: string): Record<string, unknown> {
  const fixture = referenceFixtureSnapshot() as Record<string, unknown> & { groups: Array<{ id: string; label: string; rows: Array<Record<string, unknown>> }>; needsYou: unknown[]; counts: Record<string, number> }
  fixture.coordinator = { mode: 'off' }
  fixture.needsYou = []
  fixture.peek = null
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({ ownerLabel: null, ageLabel: null, seats: null, nowLabel: null, workspaceDir: home, ...extra })
  fixture.groups = [
    { id: 'queued', label: 'QUEUED', rows: [row({ sessionId: QUEUED_ID, title: 'queued probe', state: 'queued', projectLabel: 'orchard-src', seats: 'waits', waitReason: 'seat' })] },
    { id: 'parked', label: 'PARKED', rows: [row({ sessionId: PARKED_ID, title: 'Parked probe', state: 'parked', projectLabel: 'Moodle', ageLabel: '9m' })] },
    { id: 'older', label: 'OLDER', rows: [row({ sessionId: OLDER_ID, title: '3 older chats · ↵ to browse', state: 'parked', projectLabel: 'Moodle' })] },
    { id: 'elsewhere', label: 'ELSEWHERE', rows: [row({ sessionId: DOOR_ID, title: 'orchard-src · 1 running', state: 'elsewhere', projectLabel: 'orchard-src', nowLabel: 'switch to see them', door: { kind: 'switch-project', dir: join(home, 'orchard-src'), running: 1, needsYou: 0, finished: 0 } })] },
  ]
  fixture.counts = { ...fixture.counts, live: 3, needsYou: 0 }
  return fixture
}

function boardEnv(home: string, fixture: Record<string, unknown>, tag: string): NodeJS.ProcessEnv {
  const fixturePath = join(home, `${tag}-fixture.json`)
  writeFileSync(fixturePath, JSON.stringify(fixture))
  return {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: fixturePath,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREW_DIR: join(home, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_PARTY: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_OPERATOR: 'sam',
    USER: 'sam',
    LOGNAME: 'sam',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
  }
}

function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): string[] {
  const out = join(OUT_DIR, `${name}.json`)
  const cfgPath = join(scratch, `${name}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], readySettleTicks: 4, stableTicks: 3, ...cfg, out }))
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env, cwd: REPO })
  if (!existsSync(out)) {
    check(`${name}: the drive ran to its end (vshot exit ${res.status ?? '?'}, no frame)`, false, (res.stderr ?? '').slice(-600))
    return []
  }
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid
  const lines = linesOf(payload.grid)
  writeFileSync(join(OUT_DIR, `${name}.txt`), lines.map(l => l.trimEnd()).join('\n') + '\n')
  for (const m of payload.marks ?? []) {
    marked.set(`${name}:${m.label}`, linesOf(m.grid))
    writeFileSync(join(OUT_DIR, `${name}-mark-${m.label}.txt`), linesOf(m.grid).map(l => l.trimEnd()).join('\n') + '\n')
  }
  check(`${name}: the drive ran to its end (vshot exit ${res.status ?? '?'}, ${payload.endReason ?? '?'})`, res.status === 0 && (payload.endReason === 'ready' || payload.endReason === 'stable'), (res.stderr ?? '').trim().split('\n').slice(-3).join(' | '))
  return lines
}

const DOWN = '\u001b[B'
const CTRL_X = '\u0018'
const CTRL_G = '\u0007'
const COLS = 120
const ROWS = 40
const CHORD_WINDOW_S = 5
const LIVE_FOOT = /^\s*│ │ (.*?)\s*│ │/
const liveFootRows = (lines: string[]): string[] => lines.flatMap(l => {
  const m = LIVE_FOOT.exec(l)
  return m ? [m[1]!] : []
})
const readsAs = (row: string, text: string): boolean => {
  if (row === text) return true
  const cut = row.indexOf('…')
  if (cut < 0) return false
  const head = row.slice(0, cut)
  const tail = row.slice(cut + 1)
  return head.length + tail.length < text.length && text.startsWith(head) && text.endsWith(tail)
}
const inLiveFoot = (lines: string[], text: string): boolean => liveFootRows(lines).some(row => readsAs(row, text))
const notePlace = (lines: string[], text: string): string => {
  const foot = liveFootRows(lines).filter(row => row.length > 1)
  const at = lines.findIndex(l => l.includes(text.slice(0, 24)))
  return `foot: ${foot.join(' | ') || '(empty)'}${at >= 0 ? ` · row ${at}: ${lines[at]!.trim().slice(0, 140)}` : ''}`
}
const noteLaw = (tag: string, lines: string[], what: string, text: string): void =>
  check(`${tag}: ${what} answers in the live view's message-box foot — "${text}" (whole, or cut in the middle where the foot is narrower)`, inLiveFoot(lines, text), notePlace(lines, text))

console.log(`the board notices with the coordinator off (${COLS}×${ROWS}, two panes, the list focused): every setNote answer paints in the live view's message-box foot`)
{
  const home = seedHome('notes', { capacityAnswered: true })
  const SPLIT_REFUSED = 'split needs 121 columns (board 80 + chat 40 + the divider) — this frame is 120'
  const QUEUED_NOTE = 'queued · 3/5 busy · m queues a message'
  const ARMED_NOTE = keyHintLabel(`armed — ⌃x ⌃x again deletes (${CHORD_WINDOW_S} s)`)
  const OLDER_NOTE = 'the older chats stay — ↵ opens them; clear one at a time from there'
  const DOOR_NOTE = 'a door — ↵ switches the board to orchard-src; nothing to close here'
  const GROUND_NOTE = 'repo → the boot folder — new sessions launch there'
  const settle = { requireAwait: true, awaitSettleTicks: 3 }
  const chord = (mark: string): Array<Record<string, unknown>> => [
    { afterPrevTicks: 3, data: CTRL_X },
    { afterPrevTicks: 1, data: CTRL_X },
    { afterPrevTicks: 5, data: '', mark },
  ]
  capture('notes-off', {
    cols: COLS,
    rows: ROWS,
    total: 260,
    readyText: 'STATUS & TITLE',
    sends: [
      { ...settle, atTick: 999, awaitText: 'queued probe', minTick: 5, data: 's' },
      { afterPrevTicks: 5, data: '', mark: 'split' },
      { afterPrevTicks: 1, data: '\r' },
      { afterPrevTicks: 5, data: '', mark: 'queued' },
      { afterPrevTicks: 1, data: DOWN },
      ...chord('parked'),
      { afterPrevTicks: 1, data: DOWN },
      ...chord('older'),
      { afterPrevTicks: 1, data: DOWN },
      ...chord('door'),
      { afterPrevTicks: 1, data: CTRL_G },
      { ...settle, awaitText: 'launch here', data: '\r' },
      { afterPrevTicks: 5, data: '', mark: 'ground' },
    ],
  }, boardEnv(home, boardFixture(home), 'notes-off'))
  const split = markOf('notes-off', 'split')
  check('the board is two panes with the list focused and no coordinator pane (the switch off)', split.some(l => l.includes('+ new session · n')) && split.some(l => l.includes('STATUS & TITLE')) && !split.some(l => l.includes('COORDINATOR')), split.filter(l => /new session|COORDINATOR/.test(l)).map(l => l.trim().slice(0, 100)).join(' | '))
  noteLaw('split', split, 's where the frame is too narrow for the split view (the refusal)', SPLIT_REFUSED)
  noteLaw('queued', markOf('notes-off', 'queued'), '↵ on a queued row (the in-place disclaimer with the seat count and the m door)', QUEUED_NOTE)
  noteLaw('parked', markOf('notes-off', 'parked'), '⌃x ⌃x on a parked row (the arm before the delete)', ARMED_NOTE)
  noteLaw('older', markOf('notes-off', 'older'), '⌃x ⌃x on the older-chats row', OLDER_NOTE)
  noteLaw('door', markOf('notes-off', 'door'), '⌃x ⌃x on a project door row', DOOR_NOTE)
  noteLaw('ground', markOf('notes-off', 'ground'), '⌃g then ↵ on the boot folder (the repo switch receipt)', GROUND_NOTE)
  const ground = markOf('notes-off', 'ground')
  check('the notes replace one another in the one foot row: the ground receipt stands alone there, the earlier notes gone', liveFootRows(ground).filter(row => [SPLIT_REFUSED, QUEUED_NOTE, ARMED_NOTE, OLDER_NOTE, DOOR_NOTE, GROUND_NOTE].some(note => row.includes(note))).length === 1, liveFootRows(ground).join(' | '))
}

console.log('the capacity ask answered on entry (a home that never answered it): its receipt paints in the same foot')
{
  const home = seedHome('capacity', { capacityAnswered: false })
  capture('capacity-off', {
    cols: COLS,
    rows: ROWS,
    total: 160,
    readyText: 'STATUS & TITLE',
    sends: [
      { requireAwait: true, atTick: 999, awaitText: 'capacity check', minTick: 5, awaitSettleTicks: 3, data: 'n', mark: 'ask' },
      { afterPrevTicks: 8, data: '', mark: 'receipt' },
    ],
  }, boardEnv(home, boardFixture(home), 'capacity-off'))
  const ask = markOf('capacity-off', 'ask')
  const receipt = markOf('capacity-off', 'receipt')
  check('the capacity ask stood on entry', ask.some(l => /capacity|probe/i.test(l)), ask.filter(l => /capacity|probe/i.test(l)).map(l => l.trim().slice(0, 100)).join(' | '))
  const seats = Number(/(\d+) seats/.exec(liveFootRows(receipt).join(' '))?.[1])
  check(`capacity: n on the ask answers in the live view's message-box foot — "no probe — the machine's own reading decides — right now N seats"`, Number.isFinite(seats) && inLiveFoot(receipt, `no probe — the machine's own reading decides — right now ${seats} seats`), receipt.filter(l => /probe|seats/.test(l)).map(l => l.trim().slice(0, 140)).join(' | '))
}

console.log('the split view collapsing under a resize (130×40 → 120×40): the warning paints in the same foot')
{
  const home = seedHome('collapse', { capacityAnswered: true })
  const COLLAPSED = 'split collapsed — split needs 121 columns (board 80 + chat 40 + the divider) — this frame is 120'
  capture('collapse-off', {
    cols: 130,
    rows: ROWS,
    total: 200,
    readyText: 'STATUS & TITLE',
    sends: [
      { requireAwait: true, atTick: 999, awaitText: 'queued probe', minTick: 5, awaitSettleTicks: 3, data: 's', mark: 'before' },
      { afterPrevTicks: 6, data: '', mark: 'split-on' },
      { afterPrevTicks: 12, data: '', mark: 'after-resize' },
    ],
    resizes: [{ afterMark: 'split-on', afterMs: 400, cols: COLS, rows: ROWS }],
  }, boardEnv(home, boardFixture(home), 'collapse-off'))
  const on = markOf('collapse-off', 'split-on')
  const after = markOf('collapse-off', 'after-resize')
  check('s at 130 columns opens the split view (a chat pane beside the board)', on.length > 0 && !inLiveFoot(on, 'split needs'), liveFootRows(on).join(' | '))
  noteLaw('collapse', after, 'the frame shrinking under the split minimum (the collapse warning)', COLLAPSED)
}

console.log(`  frames: ${OUT_DIR}`)
console.log(failures === 0 ? '\nprove-concourse-board-notes: ALL LAWS HOLD' : `\nprove-concourse-board-notes: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
