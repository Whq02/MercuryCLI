#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-question-card-journeys.ts — the question card's
//  doors, driven on the BUILT binary in a PTY: every visible row is live,
//  the highlight is the operator's, typed text outlives navigation, and the
//  answer shape carries every answer.
//
//  The card under test is the AskUserQuestion consent surface in Apollo
//  Mode (the options letter themselves A–D and the free-text Other row is
//  E), one fixture of TWO questions — Q1 single-select, Q2 multi-select —
//  plus a preview-bearing world and a cancel world. A scripted backend
//  (scripts/lib/fixtureApi.ts, in-process) answers the model calls; vshot
//  drives the keys and the SGR mouse clicks (text-aimed: every click names
//  its row and resolves its cell on THIS boot's grid at fire time) and
//  snapshots the screen at every mark.
//
//  Legs:
//    A  keyboard — pick A on Q1; back to Q1; walk the highlight to E (it
//       stays; A keeps its tick); ↵ on the empty field is a hint, never a
//       cancel; type, ↵ → Q1 is the text; back again: E opens with the text
//       and the tick, the highlight walks to B (E keeps its tick), ↵ → B.
//       Q2: the B and D letters toggle their rows; the highlight walks to E;
//       ↵ on the empty field hints; typing checks E; ↵ keeps E checked and
//       moves on to Next; the review names every answer; submit.
//    B  mouse — the same journey with clicks: a click on the empty E row
//       puts the caret there; a click on the typed E row commits it (Q1) or
//       keeps it in the selection (Q2); clicks toggle B and D.
//    C  preview — a previewed Q1: the highlight roams while Flat keeps its
//       tick; notes typed and left with Esc survive; Q2's E text lands; the
//       wire carries the notes and the selected preview.
//    D  cancel — Esc on the card is the documented cancel: the card closes
//       and the transcript records the decline.
//
//  Run:  ~/.bun/bin/bun run scripts/interaction/prove-question-card-journeys.ts [A|B|C|D]
//  Requires the prebuilt dist (bun run build.ts); the world is kept on a red.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import figures from 'figures'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { DIST, nodeBinPath, requireDist } from '../streaming/artifactArena.ts'

const VSHOT = join(import.meta.dir, '..', 'ui', 'vshot.py')
const API_KEY = 'fixture-key-000'
/** vshot's terminal emulator lives in the user site-packages of the REAL
 *  home; the drive runs under a hermetic HOME (the app must see none of the
 *  operator's estate), so the module path is resolved here and handed over. */
const PYTHON_USER_SITE = spawnSync('/usr/bin/python3', ['-c', 'import site; print(site.getusersitepackages())'], {
  encoding: 'utf8',
}).stdout.trim()
const COLS = 120
const ROWS = 44

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

requireDist()

// ── the fixture ─────────────────────────────────────────────────────────────
const Q1 = 'Which engine should the cache use?'
const Q2 = 'Which features should the cache expose?'
const Q1_FRAGMENT = 'engine should the cache'
const Q2_FRAGMENT = 'features should the cache'
const QP = 'Which config shape should ship?'
const QP_FRAGMENT = 'config shape should ship'
const FINAL = 'Understood; the cache plan is settled.'
const CANCEL_FINAL = 'Understood; stopping here as asked.'
const Q1_TEXT = 'orchard'
const Q2_TEXT = 'plums'
const QP_TEXT = 'walnut'
const NOTE = 'keep it small'

const twoQuestions: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'AskUserQuestion',
    id: 'auq_card',
    preText: 'Two decisions remain open.',
    whenModel: 'opus',
    input: {
      questions: [
        {
          question: Q1,
          header: 'Engine',
          options: [
            { label: 'Redis', description: 'Shared network cache.' },
            { label: 'In-memory', description: 'Process-local.' },
            { label: 'File-based', description: 'Durable on one host.' },
            { label: 'Hybrid', description: 'Memory in front of a file.' },
          ],
        },
        {
          question: Q2,
          header: 'Features',
          multiSelect: true,
          options: [
            { label: 'TTL expiry', description: 'Time-based invalidation.' },
            { label: 'Manual flush', description: 'An operator command.' },
            { label: 'Stats endpoint', description: 'Hit/miss counters.' },
            { label: 'Warm start', description: 'Reload the last snapshot.' },
          ],
        },
      ],
    },
  },
  { kind: 'text', text: FINAL, whenModel: 'opus' },
]

const previewWorld: ScriptedTurn[] = [
  {
    kind: 'tool_use',
    name: 'AskUserQuestion',
    id: 'auq_preview',
    preText: 'Two decisions remain open.',
    whenModel: 'opus',
    input: {
      questions: [
        {
          question: QP,
          header: 'Config',
          options: [
            { label: 'Layered', description: 'Defaults merged per root.', preview: '### Layered\n\n```ts\nmerge(defaults, local)\n```' },
            { label: 'Flat', description: 'One frozen constant.', preview: '### Flat\n\n```ts\nObject.freeze({ ttl: 300 })\n```' },
          ],
        },
        {
          question: Q1,
          header: 'Engine',
          options: [
            { label: 'Redis', description: 'Shared network cache.' },
            { label: 'In-memory', description: 'Process-local.' },
            { label: 'File-based', description: 'Durable on one host.' },
            { label: 'Hybrid', description: 'Memory in front of a file.' },
          ],
        },
      ],
    },
  },
  { kind: 'text', text: FINAL, whenModel: 'opus' },
]

const cancelWorld: ScriptedTurn[] = [
  { ...(twoQuestions[0] as ScriptedTurn), id: 'auq_cancel' } as ScriptedTurn,
  { kind: 'text', text: CANCEL_FINAL, whenModel: 'opus' },
]

// ── the drive ───────────────────────────────────────────────────────────────
type Send = Record<string, unknown>
type Cell = { c: string }
type Mark = { label: string; atTick: number; grid: Cell[][] }
type Payload = { grid: Cell[][]; marks?: Mark[]; endReason?: string }

/** A press+release aimed by TEXT (vshot resolves {X}/{Y} on the live grid). */
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const BACKTAB = '\x1b[Z'
const ESC = '\x1b'

/** Observed-ready: fires once the needle is on screen and has settled. */
const awaits = (needle: string, data: string, extra: Send = {}): Send => ({
  requireAwait: true,
  awaitText: needle,
  awaitSettleTicks: 3,
  minTick: 5,
  data,
  ...extra,
})
/** A key some ticks after the previous send fired. */
const then = (data: string, extra: Send = {}): Send => ({ afterPrevTicks: 2, data, ...extra })
/** A screen snapshot a few ticks after the previous send (no bytes sent). */
const snap = (mark: string, ticks = 3): Send => ({ afterPrevTicks: ticks, data: '', mark })
/** A text-aimed click on the row carrying `needle`, once it is on screen. */
const clickOn = (needle: string, extra: Send = {}): Send => ({
  requireAwait: true,
  targetText: needle,
  targetDx: 2,
  awaitText: needle,
  awaitSettleTicks: 3,
  minTick: 5,
  data: CLICK,
  ...extra,
})

const rowsOf = (grid: Cell[][]): string[] => grid.map(r => r.map(c => c.c || ' ').join(''))

function dumpFrame(label: string, lines: string[]): void {
  console.log(`      ┌ ${label}`)
  lines.forEach((line, index) => {
    const row = line.trimEnd()
    if (row !== '') console.log(`      │ ${String(index).padStart(2, ' ')} ${row}`)
  })
  console.log('      └')
}

interface Drive {
  final: string[]
  marks: Map<string, string[]>
  endReason: string
  status: number | null
  requests: unknown[]
  toolResultText: string
  world: string
  discard: () => void
}

async function drive(tag: string, turns: ScriptedTurn[], sends: Send[], readyText: string): Promise<Drive> {
  const fixture = await startFixtureApi(turns)
  const nodeBin = nodeBinPath()
  const world = mkdtempSync(join(realpathSync(tmpdir()), `mercury-question-card-${tag}-`))
  const home = join(world, 'home')
  const cwd = join(world, 'project')
  const configDir = join(home, '.claude')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(
    join(configDir, '.config.json'),
    JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      customApiKeyResponses: { approved: [API_KEY.slice(-20)] },
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      switchboardCapacity: { askedAt: 0, allowed: true, recommendedSeats: 5 },
    }),
  )
  // The auto gate CLOSED: an open gate re-postures a fresh session to flow
  // and the card would letter nothing — the Apollo letters are the subject.
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ permissions: { disableAutoMode: 'disable' } }))
  const out = join(world, `grid-${tag}.json`)
  const cfgPath = join(world, `cfg-${tag}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: [nodeBin, DIST, '--permission-mode', 'apollo'],
      cwd,
      sends,
      readyText: [readyText],
      stableTicks: 4,
      total: 320,
      cols: COLS,
      rows: ROWS,
      out,
    }),
  )
  // A hermetic world: a fresh HOME and config home outside the repo (the
  // app must see none of the operator's estate — its sign-ins would pick
  // the main model and the daemon its seats), the file credential store,
  // every display pin, and the hosted capture profile forwarded.
  const env: NodeJS.ProcessEnv = {
    ...(process.env.MERCURY_VSHOT_BUDGET_SCALE ? { MERCURY_VSHOT_BUDGET_SCALE: process.env.MERCURY_VSHOT_BUDGET_SCALE } : {}),
    HOME: home,
    PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
    PYTHONPATH: PYTHON_USER_SITE,
    TERM: 'xterm-256color',
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: API_KEY,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: process.env.MERCURY_OPERATOR?.trim() || 'sam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
  }
  // ASYNC spawn: the fixture server lives in this process and must keep
  // its accept loop while the drive runs.
  const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let driverOut = ''
  child.stdout.on('data', d => (driverOut += d))
  child.stderr.on('data', d => (driverOut += d))
  const killer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(90_000))
  const status = await new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  clearTimeout(killer)
  await fixture.close()

  let final: string[] = []
  const marks = new Map<string, string[]>()
  let endReason = ''
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
    final = rowsOf(payload.grid)
    endReason = payload.endReason ?? ''
    for (const mark of payload.marks ?? []) marks.set(mark.label, rowsOf(mark.grid))
  }
  if (status !== 0) {
    console.log(`  [driver] ${tag}: vshot exit ${status}; end=${endReason}; tail: ${driverOut.split('\n').filter(Boolean).slice(-4).join(' | ')}`)
    // The wire as the fixture saw it: which model asked, and what the last
    // message of each request was — a refused or mis-routed turn names
    // itself here.
    for (const r of fixture.requests) {
      const body = r.body as { model?: string; messages?: Array<{ role?: string; content?: unknown }> } | null
      const last = body?.messages?.at(-1)
      const kinds = Array.isArray(last?.content) ? (last!.content as Array<{ type?: string }>).map(b => b.type).join('+') : typeof last?.content
      console.log(`  [wire] ${r.method} ${r.path} model=${body?.model ?? '-'} last=${last?.role ?? '-'}:${kinds ?? '-'}`)
    }
  }
  // The tool_result the submit sent back: the LAST messages request whose
  // final user message carries a tool_result block.
  let toolResultText = ''
  const requests = fixture.requests.filter(r => r.path.includes('/v1/messages')).map(r => r.body)
  for (const body of requests) {
    const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []
    const last = messages[messages.length - 1]
    const blocks = Array.isArray(last?.content) ? (last!.content as Array<{ type?: string; content?: unknown }>) : []
    const result = blocks.find(b => b.type === 'tool_result')
    if (result) toolResultText = typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? '')
  }
  return {
    final,
    marks,
    endReason,
    status,
    requests,
    toolResultText,
    world,
    discard: () => rmSync(world, { recursive: true, force: true }),
  }
}

// ── screen readers ──────────────────────────────────────────────────────────
/** Rows of the card from its title row down (the composer paints its own
 *  pointer glyph below; the search must never read it). */
function cardRows(rows: string[], title: string): string[] {
  const top = rows.findIndex(r => r.includes(title))
  return top < 0 ? [] : rows.slice(top)
}
const rowWith = (rows: string[], needle: string): string | undefined => rows.find(r => r.includes(needle))
const pointerOn = (rows: string[], needle: string): boolean =>
  rows.some(r => r.includes(figures.pointer) && r.includes(needle))
const tickOn = (rows: string[], needle: string): boolean =>
  rows.some(r => r.includes(needle) && r.includes(figures.tick))
const checkedRow = (rows: string[], needle: string): boolean =>
  rows.some(r => r.includes(needle) && r.includes(figures.checkboxOn))
const uncheckedRow = (rows: string[], needle: string): boolean =>
  rows.some(r => r.includes(needle) && r.includes(figures.checkboxOff))
const OTHER_SINGLE = 'Type something.'
const OTHER_MULTI = 'Type something'

function markOr(d: Drive, label: string): string[] {
  const rows = d.marks.get(label)
  if (!rows) {
    check(`mark ${label} was recorded`, false, `marks: ${[...d.marks.keys()].join(',') || 'none'} · end=${d.endReason}`)
    return []
  }
  return rows
}

const only = process.argv[2]?.toUpperCase()
const wants = (leg: string): boolean => only === undefined || only === leg

// ── the shared opening: the face, the chat, the directive ───────────────────
// THE LANDING RULE: a bare boot lands on the Boot face — ↵ on New Session
// enters the chat; the chat's own ready line gates the directive. The ↵
// that sends it follows a beat later: typed text and its ↵ in ONE write
// reach the composer's submit before its state holds the text, and an
// empty submit is dropped.
const opening = (directive: string): Send[] => [
  awaits('↑↓ choose', '\r', { awaitSettleTicks: 4 }),
  awaits('ype a prompt', directive, { minTick: 8, awaitSettleTicks: 5 }),
  then('\r', { afterPrevTicks: 3 }),
]

// ═══ LEG A — keyboard ════════════════════════════════════════════════════════
if (wants('A')) {
  section('LEG A — keyboard: the highlight is the operator’s; ↵ on E answers with the text; going back works')
  const d = await drive(
    'a',
    twoQuestions,
    [
      ...opening('settle the cache plan'),
      awaits(Q1_FRAGMENT, '\r', { mark: 'q1-first' }), // A (Redis) → Q2
      awaits(Q2_FRAGMENT, BACKTAB), // back to Q1
      awaits(Q1_FRAGMENT, DOWN, { mark: 'q1-back' }), // B
      then(DOWN), // C
      then(DOWN), // D
      then(DOWN), // E
      snap('q1-on-e'),
      then('\r'), // ↵ on the EMPTY field
      snap('q1-empty-enter'),
      then(Q1_TEXT),
      snap('q1-typed'),
      then('\r'), // ↵ answers with the text → Q2
      awaits(Q2_FRAGMENT, BACKTAB, { mark: 'q2-after-text' }), // back to Q1 again
      awaits(Q1_FRAGMENT, UP, { mark: 'q1-reopened' }), // D
      then(UP), // C
      then(UP), // B
      snap('q1-on-b'),
      then('\r'), // ↵ replaces the answer with B → Q2
      awaits(Q2_FRAGMENT, BACKTAB), // back to Q1 once more: the E text must still be there
      awaits(Q1_FRAGMENT, '', { mark: 'q1-kept-draft' }),
      then('\t'), // Tab → Q2
      awaits(Q2_FRAGMENT, 'b', { mark: 'q2-fresh' }), // toggle B
      then('d'), // toggle D
      snap('q2-toggled'),
      then(DOWN), // B
      then(DOWN), // C
      then(DOWN), // D
      then(DOWN), // E
      snap('q2-on-e'),
      then('\r'), // ↵ on the EMPTY field
      snap('q2-empty-enter'),
      then(Q2_TEXT),
      snap('q2-typed'),
      then('\r'), // ↵ keeps E in the selection and moves on to Next
      snap('q2-enter'),
      then('\r'), // Next → the review
      awaits('Review your answers', DOWN, { mark: 'review' }),
      then(DOWN),
      then('\r'), // Submit answers
    ],
    FINAL,
  )
  const q1First = markOr(d, 'q1-first')
  check('A: the drive completed (every awaited surface appeared)', d.status === 0, `status=${d.status} end=${d.endReason}`)
  check('A: Q1 paints its options as Apollo letters with E for Other', rowWith(cardRows(q1First, Q1), 'A. Redis') !== undefined && rowWith(cardRows(q1First, Q1), 'E. ') !== undefined)
  if (!rowWith(cardRows(q1First, Q1), 'A. Redis')) dumpFrame('q1-first', q1First)

  const back = cardRows(markOr(d, 'q1-back'), Q1)
  check('A: back on Q1 the answer A carries the tick and the highlight', tickOn(back, 'A. Redis') && pointerOn(back, 'A. Redis'))
  const onE = cardRows(markOr(d, 'q1-on-e'), Q1)
  check('A: the highlight walked to E and STAYED there (A keeps its tick)', pointerOn(onE, 'E. ') && tickOn(onE, 'A. Redis') && !pointerOn(onE, 'A. Redis'))
  if (!pointerOn(onE, 'E. ')) dumpFrame('q1-on-e', markOr(d, 'q1-on-e'))
  check('A: the footer states what ↵ does on the E row', onE.some(r => r.includes('Enter to answer with your text')))
  const emptyEnter = markOr(d, 'q1-empty-enter')
  const emptyCard = cardRows(emptyEnter, Q1)
  check('A: ↵ on the EMPTY E field keeps the card up, the row focused, and says what to do', emptyCard.length > 0 && pointerOn(emptyCard, 'E. ') && emptyCard.some(r => r.includes('Type something first')))
  if (emptyCard.length === 0) dumpFrame('q1-empty-enter', emptyEnter)
  const typed = cardRows(markOr(d, 'q1-typed'), Q1)
  check('A: the typed text paints on the E row under the highlight', typed.some(r => r.includes(figures.pointer) && r.includes(Q1_TEXT)))
  const afterText = markOr(d, 'q2-after-text')
  check('A: ↵ on the typed E row answered Q1 and advanced to Q2', cardRows(afterText, Q2).length > 0 && !afterText.some(r => r.includes(Q1)))
  const reopened = cardRows(markOr(d, 'q1-reopened'), Q1)
  check('A: Q1 reopens ON its answer: the E row holds the text with the tick and the highlight', reopened.some(r => r.includes(Q1_TEXT) && r.includes(figures.tick)) && reopened.some(r => r.includes(Q1_TEXT) && r.includes(figures.pointer)))
  if (!reopened.some(r => r.includes(Q1_TEXT))) dumpFrame('q1-reopened', markOr(d, 'q1-reopened'))
  const onB = cardRows(markOr(d, 'q1-on-b'), Q1)
  check('A: the highlight walked up to B and stayed (E keeps its tick and text)', pointerOn(onB, 'B. In-memory') && onB.some(r => r.includes(Q1_TEXT) && r.includes(figures.tick)))
  if (!pointerOn(onB, 'B. In-memory')) dumpFrame('q1-on-b', markOr(d, 'q1-on-b'))

  // The lost-input law: choosing B kept the text typed under E as an
  // uncommitted draft — Q1 reopens on B (tick + highlight) with the E row
  // still showing the text, and the wire (below) carries B, never the text.
  const kept = cardRows(markOr(d, 'q1-kept-draft'), Q1)
  check('A: after choosing B, Q1 reopens on B with the E text still there (kept, uncommitted)', tickOn(kept, 'B. In-memory') && pointerOn(kept, 'B. In-memory') && kept.some(r => r.includes(Q1_TEXT)) && !kept.some(r => r.includes(Q1_TEXT) && r.includes(figures.tick)))
  if (!kept.some(r => r.includes(Q1_TEXT))) dumpFrame('q1-kept-draft', markOr(d, 'q1-kept-draft'))
  const q2Fresh = cardRows(markOr(d, 'q2-fresh'), Q2)
  check('A: Tab from the reopened Q1 advanced to Q2', q2Fresh.length > 0)
  const toggled = cardRows(markOr(d, 'q2-toggled'), Q2)
  check('A: the B and D letters toggled exactly their rows', checkedRow(toggled, 'Manual flush') && checkedRow(toggled, 'Warm start') && uncheckedRow(toggled, 'TTL expiry') && uncheckedRow(toggled, 'Stats endpoint'))
  if (!checkedRow(toggled, 'Manual flush')) dumpFrame('q2-toggled', markOr(d, 'q2-toggled'))
  const q2OnE = cardRows(markOr(d, 'q2-on-e'), Q2)
  check('A: Q2’s highlight reached the E row (its box unchecked while empty)', pointerOn(q2OnE, 'E. ') && uncheckedRow(q2OnE, 'E. '))
  check('A: the footer states what ↵ does on Q2’s E row', q2OnE.some(r => r.includes('Enter to add your text')))
  const q2Empty = cardRows(markOr(d, 'q2-empty-enter'), Q2)
  check('A: ↵ on Q2’s EMPTY E field hints and checks nothing', q2Empty.some(r => r.includes('Type something first')) && uncheckedRow(q2Empty, 'E. ') && pointerOn(q2Empty, 'E. '))
  const q2Typed = cardRows(markOr(d, 'q2-typed'), Q2)
  check('A: typing on E checks its box (membership IS the text)', q2Typed.some(r => r.includes(Q2_TEXT) && r.includes(figures.checkboxOn)))
  if (!q2Typed.some(r => r.includes(Q2_TEXT))) dumpFrame('q2-typed', markOr(d, 'q2-typed'))
  // The button under the last question reads Submit (it opens the review);
  // an earlier question's reads Next.
  const q2Enter = cardRows(markOr(d, 'q2-enter'), Q2)
  const onButton = pointerOn(q2Enter, 'Submit') || pointerOn(q2Enter, 'Next')
  check('A: ↵ on the typed E row keeps it checked and moves the highlight on to the Submit/Next button', q2Enter.some(r => r.includes(Q2_TEXT) && r.includes(figures.checkboxOn)) && onButton && q2Enter.some(r => r.includes('Enter to continue')))
  if (!onButton) dumpFrame('q2-enter', markOr(d, 'q2-enter'))

  const review = markOr(d, 'review')
  check('A: the review names Q1’s replaced answer (B, not the text)', review.some(r => r.includes('In-memory')) && !review.some(r => r.includes(Q1_TEXT)))
  check('A: the review names Q2’s two rows AND the typed text', review.some(r => r.includes('Manual flush') && r.includes('Warm start') && r.includes(Q2_TEXT)))
  if (!review.some(r => r.includes(Q2_TEXT))) dumpFrame('review', review)
  check('A: the run finished (the model read the answers and replied)', d.final.some(r => r.includes('cache plan is settled')))
  check('A: the transcript row shows what was answered', d.final.some(r => r.includes('In-memory')) && d.final.some(r => r.includes(Q2_TEXT)))
  check('A: the answer shape carries B (Q1) and B, D + the text (Q2)', d.toolResultText.includes('In-memory') && d.toolResultText.includes('Manual flush') && d.toolResultText.includes('Warm start') && d.toolResultText.includes(Q2_TEXT), d.toolResultText.slice(0, 300))
  check('A: the replaced Q1 text is NOT in the answer shape', !d.toolResultText.includes(Q1_TEXT))
  if (failures === 0) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

// ═══ LEG B — mouse ═══════════════════════════════════════════════════════════
if (wants('B')) {
  const before = failures
  section('LEG B — mouse: a click on the E row is a live door in both selects')
  const d = await drive(
    'b',
    twoQuestions,
    [
      ...opening('settle the cache plan'),
      awaits(Q1_FRAGMENT, '\r'), // A → Q2
      awaits(Q2_FRAGMENT, BACKTAB), // back to Q1
      clickOn(OTHER_SINGLE, { mark: 'b-q1-back' }), // the empty E row: takes the caret
      snap('b-q1-click-e'),
      then(Q1_TEXT),
      snap('b-q1-typed'),
      clickOn(Q1_TEXT), // the typed E row: commits → Q2
      awaits(Q2_FRAGMENT, '', { mark: 'b-q2' }),
      clickOn('Manual flush'),
      clickOn('Warm start'),
      snap('b-q2-toggled'),
      clickOn(OTHER_MULTI), // the empty E row: takes the caret
      snap('b-q2-click-e'),
      then(Q2_TEXT),
      snap('b-q2-typed'),
      clickOn(Q2_TEXT), // the typed E row: stays in the selection
      snap('b-q2-click-text'),
      then(DOWN), // Next
      then('\r'), // the review
      awaits('Review your answers', DOWN, { mark: 'b-review' }),
      then(DOWN),
      then('\r'),
    ],
    FINAL,
  )
  check('B: the drive completed (every awaited row appeared and was clicked)', d.status === 0, `status=${d.status} end=${d.endReason}`)
  const clickE = cardRows(markOr(d, 'b-q1-click-e'), Q1)
  check('B: a click on the empty E row moved the highlight there (A keeps its tick)', pointerOn(clickE, 'E. ') && tickOn(clickE, 'A. Redis'))
  if (!pointerOn(clickE, 'E. ')) dumpFrame('b-q1-click-e', markOr(d, 'b-q1-click-e'))
  const q1Typed = cardRows(markOr(d, 'b-q1-typed'), Q1)
  check('B: the text typed after the click paints on the E row', q1Typed.some(r => r.includes(Q1_TEXT)))
  const q2 = markOr(d, 'b-q2')
  check('B: a click on the typed E row answered Q1 and advanced to Q2', cardRows(q2, Q2).length > 0 && !q2.some(r => r.includes(Q1)))
  const toggled = cardRows(markOr(d, 'b-q2-toggled'), Q2)
  check('B: clicks toggled B and D (and nothing else)', checkedRow(toggled, 'Manual flush') && checkedRow(toggled, 'Warm start') && uncheckedRow(toggled, 'TTL expiry') && uncheckedRow(toggled, 'Stats endpoint'))
  if (!checkedRow(toggled, 'Manual flush')) dumpFrame('b-q2-toggled', markOr(d, 'b-q2-toggled'))
  const q2ClickE = cardRows(markOr(d, 'b-q2-click-e'), Q2)
  check('B: a click on Q2’s empty E row took the caret without checking it', pointerOn(q2ClickE, 'E. ') && uncheckedRow(q2ClickE, 'E. '))
  const q2Typed = cardRows(markOr(d, 'b-q2-typed'), Q2)
  check('B: typing checked E', q2Typed.some(r => r.includes(Q2_TEXT) && r.includes(figures.checkboxOn)))
  const q2ClickText = cardRows(markOr(d, 'b-q2-click-text'), Q2)
  check('B: a click on the typed E row keeps it checked, text intact, highlight on it', q2ClickText.some(r => r.includes(Q2_TEXT) && r.includes(figures.checkboxOn) && r.includes(figures.pointer)))
  if (!q2ClickText.some(r => r.includes(Q2_TEXT) && r.includes(figures.checkboxOn))) dumpFrame('b-q2-click-text', markOr(d, 'b-q2-click-text'))
  const review = markOr(d, 'b-review')
  check('B: the review names Q1’s typed answer', review.some(r => r.includes(Q1_TEXT)))
  check('B: the review names Q2’s rows and text', review.some(r => r.includes('Manual flush') && r.includes('Warm start') && r.includes(Q2_TEXT)))
  check('B: the answer shape carries the Q1 text and Q2’s rows + text', d.toolResultText.includes(Q1_TEXT) && d.toolResultText.includes('Manual flush') && d.toolResultText.includes('Warm start') && d.toolResultText.includes(Q2_TEXT), d.toolResultText.slice(0, 300))
  check('B: the run finished', d.final.some(r => r.includes('cache plan is settled')))
  if (failures === before) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

// ═══ LEG C — preview ═════════════════════════════════════════════════════════
if (wants('C')) {
  const before = failures
  section('LEG C — a previewed question: the highlight roams, notes survive Esc, the E text lands')
  const d = await drive(
    'c',
    previewWorld,
    [
      ...opening('settle the config shape'),
      awaits(QP_FRAGMENT, DOWN, { mark: 'c-qp-first' }), // Flat
      then('\r'), // select Flat → Q1 (engine)
      awaits(Q1_FRAGMENT, BACKTAB), // back to the preview question
      awaits(QP_FRAGMENT, UP, { mark: 'c-qp-reopened' }), // the highlight to Layered
      snap('c-qp-roam'),
      then('n'), // notes
      then(NOTE),
      snap('c-qp-noted'),
      then(ESC), // leaves notes; the answer stands → advances
      awaits(Q1_FRAGMENT, DOWN, { mark: 'c-q1' }),
      then(DOWN),
      then(DOWN),
      then(DOWN), // E
      then(QP_TEXT),
      then('\r'), // → the review
      awaits('Review your answers', DOWN, { mark: 'c-review' }),
      then(DOWN),
      then('\r'),
    ],
    FINAL,
  )
  check('C: the drive completed', d.status === 0, `status=${d.status} end=${d.endReason}`)
  const reopened = cardRows(markOr(d, 'c-qp-reopened'), QP)
  check('C: the preview question reopens on its answer (Flat: tick + highlight)', tickOn(reopened, 'Flat') && pointerOn(reopened, 'Flat'))
  if (!tickOn(reopened, 'Flat')) dumpFrame('c-qp-reopened', markOr(d, 'c-qp-reopened'))
  const roam = cardRows(markOr(d, 'c-qp-roam'), QP)
  check('C: the highlight roams to Layered while Flat keeps its tick', pointerOn(roam, 'Layered') && tickOn(roam, 'Flat') && !pointerOn(roam, 'Flat'))
  if (!pointerOn(roam, 'Layered')) dumpFrame('c-qp-roam', markOr(d, 'c-qp-roam'))
  const noted = cardRows(markOr(d, 'c-qp-noted'), QP)
  check('C: the note paints while typed', noted.some(r => r.includes(NOTE)))
  const q1 = markOr(d, 'c-q1')
  check('C: Esc left the notes with the answer standing and moved on', cardRows(q1, Q1).length > 0)
  const review = markOr(d, 'c-review')
  check('C: the review carries Flat with its notes', review.some(r => r.includes('Flat') && r.includes(NOTE)))
  if (!review.some(r => r.includes(NOTE))) dumpFrame('c-review', review)
  check('C: the review carries the E text of the second question', review.some(r => r.includes(QP_TEXT)))
  check('C: the answer shape carries Flat, its preview, the notes and the E text', d.toolResultText.includes('Flat') && d.toolResultText.includes('Object.freeze') && d.toolResultText.includes(NOTE) && d.toolResultText.includes(QP_TEXT), d.toolResultText.slice(0, 400))
  check('C: the run finished', d.final.some(r => r.includes('cache plan is settled')))
  if (failures === before) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

// ═══ LEG D — cancel ══════════════════════════════════════════════════════════
if (wants('D')) {
  const before = failures
  section('LEG D — Esc on the card cancels as documented')
  const d = await drive(
    'd',
    cancelWorld,
    [...opening('settle the cache plan'), awaits(Q1_FRAGMENT, ESC, { mark: 'd-card' })],
    CANCEL_FINAL,
  )
  check('D: the drive completed', d.status === 0, `status=${d.status} end=${d.endReason}`)
  const card = markOr(d, 'd-card')
  check('D: the card was up with its Esc affordance stated', card.some(r => r.includes('Esc to cancel')))
  // Every chat is a hosted seat: the card's cancel travels the ask channel
  // as a DENIAL the model reads, painted on the transcript as the canon
  // denial row (the action was not run) under the ask.
  const denied = d.final.some(r => r.includes('want to proceed'))
  check('D: after Esc the card is gone and the denial is on the transcript', !d.final.some(r => r.includes('Esc to cancel')) && denied)
  if (!denied) dumpFrame('d-final', d.final)
  check('D: the session continued (the model replied to the denial)', d.final.some(r => r.includes('stopping here as asked')))
  if (failures === before) d.discard()
  else console.log(`  [forensics] world kept: ${d.world}`)
}

console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
