#!/usr/bin/env bun
// gate-watch: src/components/concourse/ConcourseScreen.tsx src/components/concourse/ConcourseRoute.tsx
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 the restored draft\'s label names the keys the focused coordinator composer answers to')
const { restoredDraftLine, RESTORED_DRAFT_LINE, RESTORED_DRAFT_ARMED_LINE } = await import('../../src/components/concourse/ConcourseScreen.tsx')
const COLS = 130
const ROWS = 40
const COMPOSER_TEXT_CELLS = 37
{
  check('the label says the draft is restored, that ↵↵ sends and ⌃c clears — the keys the focused composer answers to (the composer paints only while its pane is focused, so there is no away line)', restoredDraftLine(false) === RESTORED_DRAFT_LINE && RESTORED_DRAFT_LINE.includes('restored draft') && RESTORED_DRAFT_LINE.includes('↵↵ sends') && /(?:⌃|ctrl\+)c clears/.test(RESTORED_DRAFT_LINE))
  check('armed, the label says ↵ again sends and esc keeps', restoredDraftLine(true) === RESTORED_DRAFT_ARMED_LINE && RESTORED_DRAFT_ARMED_LINE.includes('↵ again sends') && RESTORED_DRAFT_ARMED_LINE.includes('esc keeps'))
  check(`both labels fit the coordinator composer's hint row at ${COLS}×${ROWS} whole (${COMPOSER_TEXT_CELLS} cells; at 120 columns the pane's composer holds 35 and cuts the first label's last key)`, [RESTORED_DRAFT_LINE, RESTORED_DRAFT_ARMED_LINE].every(line => [...line].length <= COMPOSER_TEXT_CELLS), [RESTORED_DRAFT_LINE, RESTORED_DRAFT_ARMED_LINE].map(line => `${[...line].length}: ${line}`).join(' | '))
}

if (process.env.PROVE_RESTORED_DRAFT_STATIC === '1') {
  console.log('§2–§3 skipped (PROVE_RESTORED_DRAFT_STATIC=1)')
  process.exit(failures === 0 ? 0 : 1)
}

const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const framesArg = process.argv.indexOf('--frames')
const OUT_DIR = (framesArg !== -1 ? process.argv[framesArg + 1] : undefined) ?? process.env.RESTORED_DRAFT_CAPTURE_DIR ?? join(tmpdir(), `restored-draft-captures-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
interface Send {
  atTick?: number
  requireAwait?: boolean
  data: string
  awaitText?: string
  awaitPattern?: string
  minTick?: number
  awaitSettleTicks?: number
  mark?: string
}
const ESC = '\x1b'
const FOREIGN = 'change the greeting text from "Hello, " to "Hi there, " and then run python3 hello.py. Do both now.'

function newScratch(tag: string, opts: { draft: boolean }): { scratch: string; cwd: string } {
  const scratch = join(tmpdir(), `restored-draft-${tag}-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  seedFirstRun(scratch, [REPO])
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
  cfg['coordinatorEnabled'] = true
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  if (opts.draft) {
    writeFileSync(join(scratch, 'concourse-draft.json'), JSON.stringify({ _v: 1, draft: '', updatedAtMs: 1754000000000, coordinatorDraft: FOREIGN, coordinatorDraftCaret: FOREIGN.length }))
  }
  const fixture = referenceFixtureSnapshot() as Record<string, unknown> & { groups: { rows: { workspaceDir?: string }[] }[]; needsYou: unknown[]; coordinator: unknown; counts: { live: number } }
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.needsYou = []
  fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'Opus 5' }
  fixture.counts.live = 2
  writeFileSync(join(scratch, 'concourse-fixture.json'), JSON.stringify(fixture))
  return { scratch, cwd: REPO }
}

const markedFrames = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => markedFrames.get(`${tag}:${label}`) ?? []
function capture(tag: string, scratch: string, cwd: string, sends: Send[], total: number, readyText: string): string[] {
  const cols = COLS
  const rows = ROWS
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(scratch, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd, sends, total, progressBudgetTicks: total, readyText, cols, rows, out }))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: scratch,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE: 'always',
    MERCURY_CONCOURSE_FIXTURE: join(scratch, 'concourse-fixture.json'),
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_CREW_DIR: join(scratch, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    BROWSER: '/usr/bin/true',
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
const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))
const paneText = (lines: string[]): string => lines.map(l => l.trim()).filter(l => l.length > 0).join(' ')
const composerRow = (lines: string[]): string => lines.find(l => /│ │ │ ❯ /.test(l)) ?? ''
const legendOf = (lines: string[]): string => [...lines].reverse().find(l => l.trim().length > 0) ?? ''
const operatorEntries = (scratch: string): number => {
  const path = join(scratch, 'coordinator-conversation.json')
  if (!existsSync(path)) return 0
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: Array<{ role?: string }> }
  return (parsed.entries ?? []).filter(e => e.role === 'operator').length
}
const storedDraft = (scratch: string): string => (JSON.parse(readFileSync(join(scratch, 'concourse-draft.json'), 'utf8')) as { coordinatorDraft?: string }).coordinatorDraft ?? ''
const ROWS_LEGEND = '↑↓ choose · ↵ enter'
const LIVE_HEADER = '↵ enter session'
const onArrival = { requireAwait: true, atTick: 999, awaitText: LIVE_HEADER, minTick: 5, awaitSettleTicks: 3 }
const COLLAPSED_PANE = 'COORDINATOR · tab or click to focus'
const EMPTY_COMPOSER = 'talk to the coordinator'
const ARMED_LABEL = '↵ again sends'
const CTRL_C = '\x03'
const SHIFT_TAB = `${ESC}[Z`
const scratches: string[] = []

console.log(`§2 the drive — a stored draft on arrival (${COLS}×${ROWS}): the rows keep the focus, the pane shows it when tabbed to, ↵ arms, esc keeps, ⌃c clears`)
{
  const { scratch, cwd } = newScratch('enter', { draft: true })
  scratches.push(scratch)
  capture('enter', scratch, cwd, [
    { ...onArrival, data: '\r', mark: 'arrival' },
    { requireAwait: true, awaitText: 'enters (armed)', awaitSettleTicks: 3, data: '\t', mark: 'after-enter' },
    { requireAwait: true, awaitText: RESTORED_DRAFT_LINE, awaitSettleTicks: 3, data: '\r', mark: 'focused' },
    { requireAwait: true, awaitText: ARMED_LABEL, awaitSettleTicks: 3, data: ESC, mark: 'armed' },
    { requireAwait: true, awaitText: RESTORED_DRAFT_LINE, awaitSettleTicks: 3, data: CTRL_C, mark: 'disarmed' },
    { requireAwait: true, awaitText: EMPTY_COMPOSER, awaitSettleTicks: 3, data: '', mark: 'cleared' },
  ], 120, EMPTY_COMPOSER)
  const arrival = markOf('enter', 'arrival')
  const after = markOf('enter', 'after-enter')
  const focused = markOf('enter', 'focused')
  const armed = markOf('enter', 'armed')
  const disarmed = markOf('enter', 'disarmed')
  const cleared = markOf('enter', 'cleared')
  check('arrival: the restored draft never takes the focus — the rows have it (the pane legend is the rows’ own: ↑↓ choose · ↵ enter, the live header says ↵ enter session, no ↵ send) and the coordinator pane stands collapsed, its words off the screen', has(arrival, ROWS_LEGEND) && has(arrival, LIVE_HEADER) && !legendOf(arrival).includes('↵ send') && has(arrival, COLLAPSED_PANE) && !has(arrival, 'Do both now.'), `${legendOf(arrival).trim().slice(0, 118)} / ${arrival.filter(l => l.includes('COORDINATOR')).map(l => l.trim().slice(-50)).join(' | ')}`)
  check('one ↵ sends nothing (no operator entry at the end of the drive; the next frame shows the draft still held) — it did what the rows advertise: it armed the selected session (↵ again enters)', operatorEntries(scratch) === 0 && has(after, 'enters (armed)'), legendOf(after).trim().slice(0, 118))
  check('tab onto the coordinator pane: the stored draft is restored into its composer under the label that names the composer keys (↵↵ sends · ⌃c clears); the legend says ↵ send', (composerRow(focused).includes('change the greeting') || composerRow(focused).includes('Do both now.')) && has(focused, RESTORED_DRAFT_LINE) && legendOf(focused).includes('↵ send'), `${composerRow(focused).trim().slice(0, 100)} / ${legendOf(focused).trim().slice(0, 100)}`)
  check('the first ↵ in the composer ARMS: the label says ↵ again sends, nothing sent', has(armed, ARMED_LABEL) && operatorEntries(scratch) === 0 && composerRow(armed).includes('Do both now.'), paneText(armed).slice(0, 200))
  check('esc disarms — the draft and its restored label stay', has(disarmed, RESTORED_DRAFT_LINE) && !has(disarmed, ARMED_LABEL) && composerRow(disarmed).includes('Do both now.'), paneText(disarmed).slice(0, 200))
  check('⌃c in the focused composer clears the draft, as the label said: the composer is empty, the label gone, the store empty, nothing sent', has(cleared, EMPTY_COMPOSER) && !has(cleared, 'Do both now.') && !has(cleared, 'restored draft') && storedDraft(scratch) === '' && operatorEntries(scratch) === 0, `${composerRow(cleared).trim().slice(0, 80)} / stored ${JSON.stringify(storedDraft(scratch))}`)
}

console.log('§3 the drive — the same window: a draft typed in the coordinator composer, the screen left and re-entered, comes back labelled when the pane is tabbed to; tab away disarms it; ⌃c clears it where the label says so')
{
  const { scratch, cwd } = newScratch('same', { draft: false })
  scratches.push(scratch)
  const TYPED = 'draft test line, do not send'
  const SHIFT_RIGHT = `${ESC}[1;2C`
  const FACE = '↵ start'
  try {
    capture('same', scratch, cwd, [
      { requireAwait: true, atTick: 999, awaitText: COLLAPSED_PANE, minTick: 5, awaitSettleTicks: 3, data: '\t' },
      { requireAwait: true, awaitText: EMPTY_COMPOSER, awaitSettleTicks: 3, data: TYPED },
      { requireAwait: true, awaitText: 'do not send', awaitSettleTicks: 3, data: ESC, mark: 'typed' },
      { requireAwait: true, awaitText: FACE, awaitSettleTicks: 3, data: SHIFT_RIGHT, mark: 'away' },
      { requireAwait: true, awaitText: COLLAPSED_PANE, awaitSettleTicks: 4, data: '\t', mark: 'returned' },
      { requireAwait: true, awaitText: RESTORED_DRAFT_LINE, awaitSettleTicks: 3, data: '\r', mark: 'focused' },
      { requireAwait: true, awaitText: ARMED_LABEL, awaitSettleTicks: 3, data: '\t', mark: 'armed' },
      { requireAwait: true, awaitText: COLLAPSED_PANE, awaitSettleTicks: 3, data: SHIFT_TAB, mark: 'tabbed-away' },
      { requireAwait: true, awaitText: RESTORED_DRAFT_LINE, awaitSettleTicks: 3, data: CTRL_C, mark: 'back' },
      { requireAwait: true, awaitText: EMPTY_COMPOSER, awaitSettleTicks: 3, data: '', mark: 'cleared' },
    ], 150, EMPTY_COMPOSER)
  } catch (error) {
    check('the same-window drive reached its end (every send fired on its needle; the composer emptied)', false, String(error).slice(-400))
  }
  const typed = markOf('same', 'typed')
  const away = markOf('same', 'away')
  const returned = markOf('same', 'returned')
  const focused = markOf('same', 'focused')
  const armed = markOf('same', 'armed')
  const tabbedAway = markOf('same', 'tabbed-away')
  const back = markOf('same', 'back')
  const cleared = markOf('same', 'cleared')
  check('the words typed in this window sit in the focused composer with no restored label (they were just typed)', composerRow(typed).includes('do not send') && !has(typed, 'restored draft') && legendOf(typed).includes('↵ send'), `${composerRow(typed).trim().slice(0, 80)} / ${legendOf(typed).trim().slice(0, 80)}`)
  check('esc leaves the screen (the boot face stands) with the words off it', has(away, FACE) && !has(away, 'do not send'), legendOf(away).trim().slice(0, 80))
  check('back in the same window the focus is on the rows (↑↓ choose · ↵ enter, no ↵ send) and the pane stands collapsed — the words wait off the screen', has(returned, ROWS_LEGEND) && !legendOf(returned).includes('↵ send') && has(returned, COLLAPSED_PANE) && !has(returned, 'do not send'), `${legendOf(returned).trim().slice(0, 100)} / ${returned.filter(l => l.includes('COORDINATOR')).map(l => l.trim().slice(-50)).join(' | ')}`)
  check('tab onto the composer: the draft is restored from the store WITH the label that names the composer keys (↵↵ sends · ⌃c clears)', composerRow(focused).includes('do not send') && has(focused, RESTORED_DRAFT_LINE) && legendOf(focused).includes('↵ send'), `${composerRow(focused).trim().slice(0, 80)} / ${focused.filter(l => l.includes('restored')).map(l => l.trim().slice(0, 60)).join(' | ')}`)
  check('the first ↵ in the composer arms (↵ again sends), nothing sent', has(armed, ARMED_LABEL) && operatorEntries(scratch) === 0 && composerRow(armed).includes('do not send'), paneText(armed).slice(0, 200))
  check('tab away from the armed composer folds the pane: the composer and its label leave the screen (the next frame shows the words kept)', has(tabbedAway, COLLAPSED_PANE) && !has(tabbedAway, ARMED_LABEL) && !has(tabbedAway, 'do not send'), tabbedAway.filter(l => l.includes('COORDINATOR')).map(l => l.trim().slice(-50)).join(' | '))
  check('⇧tab back onto the composer: the arming is gone with the focus — the label reads ↵↵ sends again, never ↵ again sends, so no ↵ elsewhere could have sent', has(back, RESTORED_DRAFT_LINE) && !has(back, ARMED_LABEL) && composerRow(back).includes('do not send') && operatorEntries(scratch) === 0, back.filter(l => l.includes('restored') || l.includes('again')).map(l => l.trim().slice(0, 60)).join(' | '))
  check('⌃c in the focused composer clears the draft, as the label said: the composer is empty, the label gone, the store empty, nothing sent', has(cleared, EMPTY_COMPOSER) && !has(cleared, 'do not send') && !has(cleared, 'restored draft') && storedDraft(scratch) === '' && operatorEntries(scratch) === 0, `${composerRow(cleared).trim().slice(0, 80)} / stored ${JSON.stringify(storedDraft(scratch))}`)
}

for (const s of scratches) rmSync(s, { recursive: true, force: true })
console.log(`  captures: ${OUT_DIR}`)
console.log(failures === 0 ? '\nprove-concourse-restored-draft: ALL LAWS HOLD' : `\nprove-concourse-restored-draft: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
