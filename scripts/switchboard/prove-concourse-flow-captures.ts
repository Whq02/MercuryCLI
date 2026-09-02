#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-concourse-flow-captures.ts — the concourse-flow
//  render-verify legs on the BUILT bundle (vshot, 120×40 + 100×30):
//
//   C1  items 1–3: the git offer paints as the STANDARD consent card INSIDE
//       the coordinator pane (below its title, above the composer strip —
//       the mini-REPL), naming the EXACT folder; the rail row survives as a
//       mention; the card's own keys settle it (↓ moves the Select cursor
//       onto 'No'); at 100×30 the coordinator claims the stacked tall band.
//   C2  item 5: ↵ on a QUEUED row opens NO screen — the board stays, the
//       strip's meta row says 'queued — waits for a seat · N/M seats busy'.
//   C3  item 5's explicit door: tab → list, 'm' opens the deliver-on-start
//       room (its composer hint + the ⇧← back affordance).
//   C4  item 6: a coordinator turn in flight (a paced fixture wire) paints
//       the main chat's thinking presentation in the pane — star cadence +
//       a capitalised verb + '(Ns)' — and the strip's old inline
//       '↻ thinking…' token is gone.
//  Hermetic: scratch config home per capture; the fixture wire is the
//  estate's scripted API on a loopback port; nothing live.
// ============================================================================
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const BIN = join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const OUT_DIR = process.env.CONCFLOW_CAPTURE_DIR ?? join(tmpdir(), `concflow-captures-${process.pid}`)
mkdirSync(OUT_DIR, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')

type Grid = { grid: { c: string }[][] }
const linesOf = (g: Grid): string[] => g.grid.map(r => r.map(c => c.c || ' ').join(''))
const STAR_FRAMES = ['✶', '✸', '✹', '✺', '✷']

interface Send {
  atTick?: number
  afterPrevTicks?: number
  data: string
  awaitText?: string
  minTick?: number
  awaitSettleTicks?: number
  /** vshot snapshots the grid the moment this send becomes due — the frame
   *  BEFORE its bytes land, i.e. the settled state of the previous send. */
  mark?: string
}

// Every ESC-led chord is spelled with the escape sequence, never a raw
// control byte in this source: a raw 0x1b is invisible in review and one
// editor sweep away from silently becoming a bare '[B' (the send that read
// as "arrows dead on the whole concourse" — prove-esc-led-sends pins the
// tree-wide law).
const ESC = '\x1b'
const DOWN = `${ESC}[B`

function newScratch(tag: string): string {
  const scratch = join(tmpdir(), `concflow-${tag}-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  seedFirstRun(scratch, [REPO])
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  // A settled operator: the first-boot capacity ask owns every key while
  // armed; these frames are the flow, not the ask.
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
  // The fixture key is pre-approved (normalizeApiKeyForConfig keeps the last
  // 20 chars) so the boot never parks on the custom-API-key consent.
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  return scratch
}

function capture(
  tag: string,
  scratch: string,
  fixturePath: string | null,
  cols: number,
  rows: number,
  sends: Send[],
  total: number,
  extraEnv: Record<string, string> = {},
): string[] {
  const out = join(OUT_DIR, `${tag}-${cols}x${rows}.json`)
  const cfgPath = join(scratch, `${tag}-${cols}x${rows}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: REPO, sends, total, cols, rows, out }))
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    MERCURY_CONFIG_DIR: scratch,
    MERCURY_HOME: '',
    MERCURY_CONCOURSE: 'always',
    MERCURY_DAEMON_DIR: join(scratch, 'daemon'),
    MERCURY_CREW_DIR: join(scratch, 'crew'),
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_PARTY: '0',
    // Machine-independence: the boot's key is the pre-approved fixture key
    // (an ambient key — the gate's proof credential — parks the custom-key
    // consent card over the board and owns every key), and its base URL is a
    // closed port so no drive ever reaches a wire.
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    ...extraEnv,
  }
  if (fixturePath !== null) env.MERCURY_CONCOURSE_FIXTURE = fixturePath
  else delete env.MERCURY_CONCOURSE_FIXTURE
  const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], { encoding: 'utf8', timeout: vshotBudgetMs(240_000), env })
  if (res.status !== 0) throw new Error(`vshot ${tag} ${cols}x${rows} failed: ${(res.stderr ?? '').slice(-600)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as Grid & { marks?: ({ label: string } & Grid)[] }
  const lines = linesOf(payload)
  writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}.txt`), lines.join('\n') + '\n')
  for (const m of payload.marks ?? []) {
    markedFrames.set(`${tag}:${m.label}`, linesOf(m))
    writeFileSync(join(OUT_DIR, `${tag}-${cols}x${rows}-mark-${m.label}.txt`), linesOf(m).join('\n') + '\n')
  }
  return lines
}
/** The frames vshot snapshotted at each `mark` send, keyed `${tag}:${label}`. */
const markedFrames = new Map<string, string[]>()
const markOf = (tag: string, label: string): string[] => markedFrames.get(`${tag}:${label}`) ?? []

const rowOf = (lines: string[], needle: string): number => lines.findIndex(l => l.includes(needle))
const has = (lines: string[], needle: string): boolean => rowOf(lines, needle) >= 0
/** CONCFLOW_ONLY=git-offer|queued|thinking narrows a re-run to one leg
 *  (iteration aid; the suite runs every leg). */
const ONLY = process.env.CONCFLOW_ONLY
const runLeg = (name: string): boolean => ONLY === undefined || ONLY === '' || ONLY === name

// ── C1: the git offer — the standard consent card inside the pane ──────────
console.log('C1 the git offer card (items 1–3)')
if (runLeg('git-offer')) {
  const folder = '/Users/op/play/parser-lab'
  const scratch = newScratch('git-offer')
  const fixture = referenceFixtureSnapshot()
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'Opus 5' }
  fixture.needsYou = [
    {
      obligationId: 'obl-git-1',
      sessionId: `folder:${folder}`,
      title: 'git offer',
      question: `this folder has no git — start one in ${folder} so sessions can fork it?`,
      projectLabel: 'parser-lab',
      agentLabel: 'Mercury',
      ageLabel: '1m',
      ref: 'permission:git-init:abc123def456',
    },
    ...fixture.needsYou,
  ]
  const fixturePath = join(scratch, 'concourse-fixture.json')
  writeFileSync(fixturePath, JSON.stringify(fixture))
  for (const [cols, rows] of [[120, 40], [100, 30]] as const) {
    const lines = capture('git-offer', scratch, fixturePath, cols, rows, [], 50)
    const title = rowOf(lines, 'Start a git repository')
    const coord = rowOf(lines, 'COORDINATOR')
    const strip = rowOf(lines, '↵ send')
    check(`${cols}×${rows}: the card frame paints with its title`, title >= 0)
    check(`${cols}×${rows}: the card names the EXACT folder`, has(lines, "git init(") && has(lines, folder))
    check(`${cols}×${rows}: the standard ask + options`, has(lines, 'Do you want to proceed?') && has(lines, 'Yes') && has(lines, 'No — run here as it is, alone'))
    check(`${cols}×${rows}: the standard key legend`, has(lines, '↑↓ choose · ↵ confirm · esc cancel'))
    if (cols >= 120) {
      check(`${cols}×${rows}: the card sits INSIDE the pane — below its title, above the composer`, coord >= 0 && title > coord && (strip < 0 || title < strip), `coord=${coord} card=${title} strip=${strip}`)
    } else {
      // Stacked: the card is the bottom-anchored overlay (the model picker's
      // own below-120 law) — above the composer strip, below the header.
      check(`${cols}×${rows}: the card overlays at the BOTTOM — above the composer strip`, title > 3 && strip > title, `card=${title} strip=${strip}`)
      // The overlay's bottom border sits ON the main band's last row: the
      // composer strip's own top rule (╭…╮) stays visible right beneath it.
      const legend = rowOf(lines, '↑↓ choose · ↵ confirm · esc cancel')
      const cardBottom = legend + 1
      check(`${cols}×${rows}: the strip's top rule survives beneath the overlay`, lines[cardBottom]?.trim().startsWith('╰') === true && lines[cardBottom + 1]?.trim().startsWith('╭') === true, `rows ${cardBottom}/${cardBottom + 1}: ${JSON.stringify(lines[cardBottom]?.trim().slice(0, 8))} ${JSON.stringify(lines[cardBottom + 1]?.trim().slice(0, 8))}`)
    }
    check(`${cols}×${rows}: the rail still MENTIONS the ask`, has(lines, 'NEEDS YOU') && has(lines, 'git offer'))
    check(`${cols}×${rows}: the strip's retired y/n context is absent`, !has(lines, 'y allows · n denies'))
  }
  // The card's own keys: ONE ↓ moves the Select cursor onto 'No'. The second
  // ↓ is sent with a mark, so its frame is the settled state after exactly
  // one ↓; the final frame then pins the Select's own law — on a two-option
  // list the second ↓ WRAPS back onto Yes (use-select-navigation
  // 'focus-next-option': forward chain exhausted ⇒ the first enabled item).
  // Asserting 'No' after 2×↓ was this leg's own error, not a dead key: the
  // byte tap on the built bundle read every ESC-led chord whole.
  const wrapped = capture('git-offer-down', scratch, fixturePath, 120, 40, [{ atTick: 999, awaitText: 'Do you want to proceed?', minTick: 5, awaitSettleTicks: 2, data: DOWN }, { afterPrevTicks: 4, data: DOWN, mark: 'after-one-down' }], 70)
  const moved = markOf('git-offer-down', 'after-one-down')
  // The Select paints its cursor glyph before the focused option.
  const cursorOn = (l: string): boolean => /[│ ]*❯\s+\d\./.test(l)
  const noLine = moved.find(l => l.includes('No — run here')) ?? ''
  const yesLine = moved.find(l => /\b1\. Yes\b/.test(l)) ?? ''
  check('the card owns the keys: ↓ moved the Select cursor onto No', cursorOn(noLine) && !cursorOn(yesLine), `yes=${JSON.stringify(yesLine.trim())} no=${JSON.stringify(noLine.trim())}`)
  const noLine2 = wrapped.find(l => l.includes('No — run here')) ?? ''
  const yesLine2 = wrapped.find(l => /\b1\. Yes\b/.test(l)) ?? ''
  check("the Select's wrap law holds on the card: a second ↓ returns the cursor to Yes", cursorOn(yesLine2) && !cursorOn(noLine2), `yes=${JSON.stringify(yesLine2.trim())} no=${JSON.stringify(noLine2.trim())}`)
}

// ── DIAG (CONCFLOW_ONLY=diag): which key paths reach the in-pane card ────
if (ONLY === 'diag') {
  const folder = '/Users/op/play/parser-lab'
  const scratch = newScratch('diag')
  const fixture = referenceFixtureSnapshot()
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'Opus 5' }
  fixture.needsYou = [
    { obligationId: 'obl-git-1', sessionId: `folder:${folder}`, title: 'git offer', question: `this folder has no git — start one in ${folder} so sessions can fork it?`, projectLabel: 'parser-lab', agentLabel: 'Mercury', ageLabel: '1m', ref: 'permission:git-init:abc123def456' },
  ]
  const fixturePath = join(scratch, 'concourse-fixture.json')
  writeFileSync(fixturePath, JSON.stringify(fixture))
  const settle = { atTick: 999, awaitText: 'Do you want to proceed?', minTick: 5, awaitSettleTicks: 2 }
  for (const [name, data] of [['down', '\x1b[B'], ['j', 'j'], ['digit2', '2']] as const) {
    const lines = capture(`diag-${name}`, scratch, fixturePath, 120, 40, [{ ...settle, data }, { afterPrevTicks: 4, data }], 70)
    const noLine = lines.find(l => l.includes('No — run here')) ?? ''
    const yesLine = lines.find(l => /\b1\. Yes\b/.test(l)) ?? ''
    const cursor = /❯\s+\d\./.test(noLine) ? 'No' : /❯\s+\d\./.test(yesLine) ? 'Yes' : 'none'
    const note = lines.find(l => l.includes('denied') || l.includes('unreachable') || l.includes('refused') || l.includes('failed')) ?? ''
    console.log(`  [INFO] key=${name}: cursor on ${cursor}; card present=${has(lines, 'Do you want to proceed?')}; note=${JSON.stringify(note.trim().slice(0, 100))}`)
  }
}

// ── ARROWS: ↓ browses the plain board (the base legend's '↑↓ browse') ──────
// A capture pair on the built bundle at 120×40: the board's ▸ selection sits
// on the first row before any key and on the second row after ONE ↓ — the
// ESC-led chord reaches the screen whole through the rig.
console.log('ARROWS the plain board browses on ↓')
if (runLeg('arrows')) {
  const scratch = newScratch('arrows')
  const fixture = referenceFixtureSnapshot()
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.needsYou = []
  const fixturePath = join(scratch, 'concourse-fixture.json')
  writeFileSync(fixturePath, JSON.stringify(fixture))
  const settle = { atTick: 999, awaitText: 'Fix OAuth callback', minTick: 5, awaitSettleTicks: 2 }
  const before = capture('arrows-before', scratch, fixturePath, 120, 40, [], 45)
  const after = capture('arrows-after', scratch, fixturePath, 120, 40, [{ ...settle, data: '\t' }, { afterPrevTicks: 3, data: DOWN }], 60)
  const selRow = (lines: string[]): number => lines.findIndex(l => /▸ /.test(l) && /Audit|Fix OAuth|Refactor|Update/.test(l))
  // The session TITLE alone (single-spaced words); the age/activity columns
  // to its right move between two boots and must not decide the row match.
  const titleOf = (line: string | undefined): string => (line ?? '').match(/(?:Audit|Fix OAuth|Refactor|Update)(?: \S+)*/)?.[0] ?? ''
  const rowBefore = selRow(before)
  const rowAfter = selRow(after)
  const firstTitle = titleOf(before[rowBefore])
  // The next session row below the selection in the BEFORE frame (rows may
  // sit more than one line apart), by title.
  const nextRow = before.findIndex((l, i) => i > rowBefore && titleOf(l) !== '')
  const secondTitle = titleOf(before[nextRow])
  check('before any key the ▸ selection sits on the first session row', rowBefore >= 0 && firstTitle !== '' && nextRow > rowBefore, `row=${rowBefore} title=${JSON.stringify(firstTitle)} next=${JSON.stringify(secondTitle)}`)
  check('after ONE ↓ the ▸ selection moved onto the second row (titles by common prefix — the selection glyph re-truncates the cell)', rowAfter > rowBefore && (() => { const a = titleOf(after[rowAfter]).split('…')[0]; const b = secondTitle.split('…')[0]; return a.length >= 8 && (a.startsWith(b) || b.startsWith(a)) })() && secondTitle !== firstTitle, `before=${JSON.stringify(firstTitle)} after=${JSON.stringify(titleOf(after[rowAfter]))} expected=${JSON.stringify(secondTitle)}`)
}

// ── C2/C3: the queued row — ↵ in place, m opens the room ──────────────────
console.log('C2/C3 the queued row (item 5)')
if (runLeg('queued')) {
  const scratch = newScratch('queued')
  const fixture = referenceFixtureSnapshot()
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  fixture.needsYou = []
  fixture.groups = [
    {
      id: 'queued',
      label: 'QUEUED',
      rows: [
        {
          sessionId: 'dispatch:cm-probe-1',
          title: 'queued probe',
          state: 'queued',
          projectLabel: 'orchard-src',
          ownerLabel: null,
          ageLabel: null,
          seats: 'waits',
          waitReason: 'seat',
        },
      ],
    },
    ...fixture.groups.filter(g => g.id !== 'queued'),
  ]
  fixture.peek = null
  const fixturePath = join(scratch, 'concourse-fixture.json')
  writeFileSync(fixturePath, JSON.stringify(fixture))
  const settle = { atTick: 999, awaitText: 'queued probe', minTick: 5, awaitSettleTicks: 2 }
  for (const [cols, rows] of [[120, 40], [100, 30]] as const) {
    const lines = capture('queued-enter', scratch, fixturePath, cols, rows, [{ ...settle, data: '\t' }, { afterPrevTicks: 3, data: '\r' }], 60)
    check(`${cols}×${rows}: ↵ on the queued row keeps the board`, has(lines, 'SESSIONS') && has(lines, 'queued probe'))
    check(`${cols}×${rows}: the in-place line — a disclaimer in the estate's voice`, lines.some(l => /queued — waits for a seat · \d+\/\d+ seats/.test(l)), lines.find(l => l.includes('queued —')) ?? '(no queued line)')
    check(`${cols}×${rows}: the void screen did NOT open`, !has(lines, 'add a message — it delivers') && !has(lines, '⇧← back to the concourse'))
  }
  const room = capture('queued-room', scratch, fixturePath, 120, 40, [{ ...settle, data: '\t' }, { afterPrevTicks: 4, data: 'm' }], 70)
  check('m on the queued row opens the deliver-on-start room (the explicit door)', has(room, 'add a message — it delivers when the session starts') && has(room, '⇧← back to the concourse'))
  check('the room names the queued session', has(room, 'queued probe'))
  check('the list legend advertises m', lines120HasM(scratch, fixturePath))
}

function lines120HasM(scratch: string, fixturePath: string): boolean {
  const lines = capture('queued-legend', scratch, fixturePath, 120, 40, [{ atTick: 999, awaitText: 'queued probe', minTick: 5, awaitSettleTicks: 2, data: '\t' }], 50)
  return lines.some(l => l.includes('m message queued'))
}

// ── C4: the thinking token (item 6) ─────────────────────────────────────────
console.log('C4 the thinking token (item 6)')
if (runLeg('thinking')) {
  const { startFixtureApi } = await import('../lib/fixtureApi.ts')
  const api = await startFixtureApi([
    { kind: 'paced', deltas: Array.from({ length: 60 }, (_, i) => `thinking-probe ${i + 1}. `), gapMs: 500, settleDelayMs: 2000 },
    { kind: 'text', text: 'Spare.' },
  ])
  try {
    const scratch = newScratch('thinking')
    const fixture = referenceFixtureSnapshot()
    for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
    fixture.needsYou = []
    fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'Opus 5' }
    const fixturePath = join(scratch, 'concourse-fixture.json')
    writeFileSync(fixturePath, JSON.stringify(fixture))
    const env = { ANTHROPIC_API_KEY: 'fixture-key-000', ANTHROPIC_BASE_URL: api.url, MERCURY_CACHE_CLOCK: '0' }
    const settle = { atTick: 999, awaitText: 'talk to the coordinator', minTick: 5, awaitSettleTicks: 2 }
    for (const [cols, rows] of [[120, 40], [100, 30]] as const) {
      const lines = capture('thinking', scratch, fixturePath, cols, rows, [{ ...settle, data: 'status?' }, { afterPrevTicks: 3, data: '\r' }], 75, env)
      const row = lines.find(l => STAR_FRAMES.some(s => l.includes(s)) && /\(\d+s\)/.test(l))
      // The verb is the main chat's own vocabulary — single words and the
      // quicksilver lines alike ('Salt-flat-gliding…', 'Heads down, wheels
      // up…'): capitalised, ellipsis-terminated, then the elapsed seconds.
      check(`${cols}×${rows}: the pane paints the main chat's thinking row (star cadence + verb + elapsed)`, row !== undefined && /[A-Z][^…]{2,60}… \(\d+s\)/.test(row), row ?? lines.filter(l => l.trim().length > 0).slice(-12).join(' | '))
      check(`${cols}×${rows}: the strip's old inline '↻ thinking…' token is gone`, !lines.some(l => l.includes('↻ thinking…') || l.includes(' thinking…')))
    }
  } finally {
    await api.close()
  }
}

console.log(`captures under ${OUT_DIR}`)
console.log(failures === 0 ? 'ALL CAPTURE LAWS HOLD' : `${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
