#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-concourse-arrow-focus.ts
//  THE ARROW-FOCUS LAW — the operator's live find on the deployed runtime:
//  "on the concourse when I have tab clicked
//  and I have the coordinator selected, I can still use the arrow keys to
//  select up and down on the live state for the chat boxes, but I can't
//  click enter until I tab there."
//
//  The disease: the screen's board-browse arm fired from the coordinator
//  panel (the base legend's '↑↓ browse' was bound from EVERY region) while
//  ↵ was region-gated — the board's selection moved under a focus that
//  could not act on it. The cure: arrows follow the SAME focus rule ↵
//  already follows — the selection moves only from the board-side panels
//  (the rows, the live view, the split chat pane); with the coordinator
//  focused, ↑↓ stay in that pane (its zero-state example walk, else inert)
//  and that panel's legend no longer prints the row.
//
//  §1–§3 pin the law at its owners (the pure resolver + the source arms);
//  §4 drives the BUILT bundle through vshot in the flow-captures ARROWS
//  shape — written under the box law, run at the pool. The leak needs a
//  coordinator conversation on disk (the pane's own zero-state example walk
//  consumes ↑↓ before the screen sees them — a bare fixture cannot show the
//  disease), so the driven legs seed the coordinator-truth scenario's store.
//
//  POISON: MERCURY_ARROW_FOCUS_POISON_DIST names a pre-fix bundle — §4 then
//  asserts the disease (the selection MOVED from the coordinator, ↵ did not
//  enter). PROVE_ARROW_FOCUS_STATIC=1 skips the drive (§1–§3 only).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-concourse-arrow-focus.ts
//  (§4 needs dist/mercury.mjs — `bun run build.ts` first.)
// ============================================================================
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
const ordered = (hay: string, a: string, b: string): boolean => {
  const ia = hay.indexOf(a)
  const ib = hay.indexOf(b)
  return ia !== -1 && ib !== -1 && ia < ib
}

// ── §1 · the ONE legend resolver: ↑↓ browse prints only where it fires ──────
console.log('§1 the resolver — the coordinator legend drops the ↑↓ row, every board-side region keeps it')
{
  const { browseKeysFor, regionKeysFor } = await import('../../src/components/concourse/controlManifest.ts')
  const keysOf = (rows: ReadonlyArray<{ keys: string; label: string }>): string[] => rows.map(k => k.keys)
  const coordinator = browseKeysFor({ chatPresent: true, region: 'coordinator' })
  check('the coordinator legend prints no ↑↓ row (a printed key that does not fire is a lie)', !keysOf(coordinator).includes('↑↓'), keysOf(coordinator).join(','))
  for (const region of ['list', 'live', 'chat', 'rail'] as const) {
    const rows = browseKeysFor({ chatPresent: true, region })
    check(`the ${region} legend keeps '↑↓ browse' (the key fires there)`, rows.some(k => k.keys === '↑↓' && k.label === 'browse'), keysOf(rows).join(','))
  }
  check(
    'the region-less rows (the atlas) name where the key fires',
    browseKeysFor({ chatPresent: true }).find(k => k.keys === '↑↓')?.label === 'browse (list · live · split)',
  )
  check(
    'the coordinator call keeps every other base row in order, esc still relabelled by chat presence',
    keysOf(coordinator).join(',') === keysOf(browseKeysFor({ chatPresent: true, region: 'list' })).filter(k => k !== '↑↓').join(',') &&
      browseKeysFor({ chatPresent: false, region: 'coordinator' }).find(k => k.keys === 'esc')?.label === 'boot face' &&
      coordinator.find(k => k.keys === 'esc')?.label === 'focused chat',
  )
  const own = regionKeysFor('coordinator', { newSession: true })
  check("the coordinator's own rows never claim a board browse and still teach ↵ send", own.every(k => k.keys !== '↑↓') && own.some(k => k.keys === '↵' && k.label === 'send'))
}

// ── §2 · the screen's arm: arrows follow the focus rule ↵ already follows ──
console.log('§2 the screen — the board-browse arm no longer names the coordinator; the board-side arms stand')
{
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check(
    'POISON: the pre-fix browse arm that named the coordinator is gone',
    !screen.includes("(region === 'live' || region === 'coordinator') &&") &&
      !screen.includes("(region === 'coordinator' ? draftRef : liveDraftRef).current.text.includes(NL)"),
    'the coordinator panel still browses the board on ↑↓',
  )
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
    listStart > 0 && list.includes('if (key.upArrow || key.downArrow) {') && list.includes('if (key.return && pastGate()) {') && list.includes('selectSession(row.sessionId)'),
  )
  const enterStart = screen.indexOf('if (key.return && !key.shift) {')
  const enterEnd = screen.indexOf('if (reducedStage) {', enterStart)
  const enter = screen.slice(enterStart, enterEnd)
  check(
    "the coordinator's ↵ is still the pane's own (an empty draft leaves it to the example walk; words send) — never a board enter",
    enterStart > 0 &&
      enter.includes("if (region === 'coordinator') {") &&
      enter.includes('if (draftRef.current.text.trim().length === 0) return') &&
      enter.includes('sendCoordinator()') &&
      !enter.slice(0, enter.indexOf("if (region !== 'live') return")).includes('enterSession('),
  )
  check(
    'the live panel keeps its browse because its ↵ ENTERS the selection on an empty draft (arrows and ↵ agree there)',
    enter.includes("if (region !== 'live') return") && enter.includes('if (sel) enterSession(sel.sessionId)'),
  )
  check('the screen names the law where the arm lives', screen.includes('THE ARROW-FOCUS LAW'))
  const pane = read('src/components/concourse/CoordinatorPane.tsx')
  check(
    'the pane owns its ↑↓ only while focused (the zero-state example walk consumes them before the screen)',
    ordered(pane, 'if (!focused) return', 'if (entries !== null && entries.length === 0 && (key.upArrow || key.downArrow)) {') &&
      ordered(pane, 'if (entries !== null && entries.length === 0 && (key.upArrow || key.downArrow)) {', 'event.stopImmediatePropagation()\n      const n = COORDINATOR_EXAMPLE_PROMPTS.length'),
  )
}

// ── §3 · the legend paint site and the atlas read the resolver ──────────────
console.log('§3 the legend — the footer hands its region to the resolver; the atlas reads the region-less rows')
{
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('the footer legend hands the focused region to the one resolver', layout.includes('const browseKeys = browseKeysFor({ chatPresent: chat, region })'))
  const screen = read('src/components/concourse/ConcourseScreen.tsx')
  check('the atlas reads the region-less rows (the row names where it fires)', screen.includes('keys: [...browseKeysFor({ chatPresent: chat }), CONCOURSE_HELP_KEY]'))
  const manifest = read('src/components/concourse/controlManifest.ts')
  check(
    'the manifest states the law at the resolver',
    manifest.includes('THE ARROW-FOCUS LAW') && manifest.includes("opts.region === 'coordinator' ? CONCOURSE_BROWSE_KEYS.filter(k => k.keys !== '↑↓')"),
  )
}

// ── §4 · the drive (vshot, the flow-captures ARROWS shape) ─────────────────
// Three captures of the built bundle over the seeded fixture board at 120×40:
//   coord  — a coordinator conversation on disk (the operator's state; the
//            pane's example walk is not in play): ↓ with the coordinator
//            focused leaves the ▸ selection EXACTLY where it was, ↵ does not
//            arm the row, and the coordinator-focused footer prints no
//            '↑↓ browse' while it still prints '↵ send'.
//   zero   — no conversation (the pane's own ↑↓): ↓ walks the example
//            highlight to the second prompt and the ▸ selection stays — a
//            CONTROL (holds before and after the fix; the pane received the
//            key and spent it on its own meaning).
//   list   — tab → the rows: ↓ moves the ▸ selection to the second row and
//            ↵ arms it ('enters (armed)' in the legend) — the direction the
//            operator could always take.
if (process.env.PROVE_ARROW_FOCUS_STATIC === '1') {
  console.log('§4 skipped (PROVE_ARROW_FOCUS_STATIC=1)')
  process.exit(failures === 0 ? 0 : 1)
}
const POISON_DIST = process.env.MERCURY_ARROW_FOCUS_POISON_DIST
const BIN = POISON_DIST ?? join(REPO, 'dist', 'mercury.mjs')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
console.log(POISON_DIST === undefined ? '§4 the drive — the built bundle at 120×40' : '§4 POISON — the pre-fix bundle: the selection moves from the coordinator')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { referenceFixtureSnapshot } = await import('../notifications/concourseReferenceSeed.ts')
const { COORDINATOR_EXAMPLE_PROMPTS } = await import('../../src/components/concourse/CoordinatorPane.tsx')
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
  /** vshot snapshots the grid the moment this send becomes due — the frame
   *  BEFORE its bytes land, i.e. the settled state of the previous send. */
  mark?: string
}
// Every ESC-led chord is spelled with the escape sequence, never a raw
// control byte in this source (prove-esc-led-sends pins the tree-wide law).
const ESC = '\x1b'
const DOWN = `${ESC}[B`

function newScratch(tag: string, seedConversation: boolean): string {
  const scratch = join(tmpdir(), `arrow-focus-${tag}-${process.pid}`)
  rmSync(scratch, { recursive: true, force: true })
  seedFirstRun(scratch, [REPO])
  const cfgPath = join(scratch, '.mercury.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
  // A settled operator: the first-boot capacity ask owns every key while
  // armed; these frames are the board, not the ask.
  cfg['switchboardCapacity'] = { askedAt: 1754000000000, allowed: true, recommendedSeats: 5 }
  cfg['concourseCoordinator'] = { mode: 'agent-assisted', assistModel: 'claude-opus-5' }
  // The fixture key is pre-approved (normalizeApiKeyForConfig keeps the last
  // 20 chars) so the boot never parks on the custom-API-key consent.
  cfg['customApiKeyResponses'] = { approved: ['fixture-key-000'], rejected: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg))
  if (seedConversation) {
    // The coordinator-truth scenario's durable store (renderScenarios.ts):
    // entries on disk take the pane OUT of its zero state, so ↑↓ reach the
    // screen's handler — exactly the operator's situation.
    const ts = 1754000000000
    writeFileSync(
      join(scratch, 'coordinator-conversation.json'),
      JSON.stringify(
        {
          entries: [
            { id: 'op:1', role: 'operator', text: 'what model are you running on?', ts },
            { id: 'co:1', role: 'coordinator', text: 'Mercury, running on `claude-opus-5` (Opus 5) — that is the engine this seat dispatches on.', ts: ts + 1000 },
          ],
          _v: 1,
        },
        null,
        2,
      ) + '\n',
    )
  }
  const fixture = referenceFixtureSnapshot()
  for (const g of fixture.groups) for (const r of g.rows) r.workspaceDir = scratch
  // No rail: the ring is coordinator · list · live, and the boot lands on
  // the coordinator (the screen's default region with no capsule).
  fixture.needsYou = []
  fixture.coordinator = { mode: 'agent-assisted', assistModelLabel: 'Opus 5' }
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
    // The display animations every capture pins still (the critter's sway
    // and blink, its gaze and sleep, the header's live seconds, the live
    // glyphs): a settle gate reads the whole grid, and a recorded frame
    // must never land on an arbitrary animation phase.
    MERCURY_CRITTER_IDLE: '0',    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',   MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    // Machine-independence: the boot's key is the pre-approved fixture key
    // and its base URL a closed port, so no drive ever reaches a wire.
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
const has = (lines: string[], needle: string): boolean => lines.some(l => l.includes(needle))
// A pane wraps a long entry at its own width, so one sentence can paint on
// two rows ("… what model are you running" / "on?"). Read the pane's cells
// (the text between its border glyphs) joined across rows, so a wrapped
// sentence is found whole and no pane is ever widened for a proof.
const hasWrapped = (lines: string[], needle: string): boolean =>
  lines
    .map(l => (l.split('│')[1] ?? '').trim())
    .join(' ')
    .includes(needle)
// The ▸ selection row and its session TITLE alone (single-spaced words);
// the age/activity columns to its right move between boots and must not
// decide the match (the flow-captures ARROWS leg's own reading).
const selRow = (lines: string[]): number => lines.findIndex(l => /▸ /.test(l) && /Audit|Fix OAuth|Refactor|Update/.test(l))
const titleOf = (line: string | undefined): string => (line ?? '').match(/(?:Audit|Fix OAuth|Refactor|Update)(?: \S+)*/)?.[0] ?? ''
const sameTitle = (a: string, b: string): boolean => {
  const x = a.split('…')[0] ?? ''
  const y = b.split('…')[0] ?? ''
  return x.length >= 8 && (x.startsWith(y) || y.startsWith(x))
}
// Re-trued: the operator's ruling
// reserved the board's state-word column, so a row title
// may CLIP at capture width — the await needle wants the truncation-
// surviving PREFIX (the same ≥8-char prefix selRow/titleOf/sameTitle
// already decide by), never the full seeded title.
const settle = { atTick: 999, awaitText: 'Fix OAuth', minTick: 5, awaitSettleTicks: 2 }
const scratches: string[] = []

// coord — the operator's state: a conversation on disk, the coordinator focused.
{
  const scratch = newScratch('coord', true)
  scratches.push(scratch)
  const lines = capture('coord', scratch, [
    { ...settle, data: DOWN, mark: 'before' },
    { afterPrevTicks: 3, data: '\r', mark: 'after-down' },
    { afterPrevTicks: 3, data: '', mark: 'after-enter' },
  ], 70)
  const before = markOf('coord', 'before')
  const afterDown = markOf('coord', 'after-down')
  const afterEnter = markOf('coord', 'after-enter')
  const rowBefore = selRow(before)
  const rowAfter = selRow(afterDown)
  const nextRow = before.findIndex((l, i) => i > rowBefore && titleOf(l) !== '')
  // Re-trued (POLISH2, the drift class): the pane OPENS the conversation
  // asynchronously now — 'opening the conversation…' at the settle mark is
  // the same premise truth (the zero-state example walk is NOT in play);
  // demanding the painted entry text raced the open. The teeth stay: the
  // example prompts must be absent.
  check(
    'coord: the pane is OUT of its zero state (conversation painted or opening — the example walk is not in play)',
    (hasWrapped(before, 'what model are you running on?') || has(before, 'opening the conversation')) && !has(before, COORDINATOR_EXAMPLE_PROMPTS[0]),
    before.find(l => l.includes('COORDINATOR'))?.trim().slice(0, 80) ?? '(no coordinator pane)',
  )
  check('coord: before any key the ▸ selection sits on the first session row', rowBefore >= 0 && titleOf(before[rowBefore]) !== '' && nextRow > rowBefore, `row=${rowBefore} title=${JSON.stringify(titleOf(before[rowBefore]))}`)
  if (POISON_DIST === undefined) {
    check(
      'coord: ↓ with the coordinator focused leaves the ▸ selection EXACTLY where it was',
      rowAfter === rowBefore && sameTitle(titleOf(afterDown[rowAfter]), titleOf(before[rowBefore])),
      `before=${rowBefore}:${JSON.stringify(titleOf(before[rowBefore]))} after=${rowAfter}:${JSON.stringify(titleOf(afterDown[rowAfter]))}`,
    )
    check('coord: ↵ with the coordinator focused does not arm the row (the legend never says enters (armed)) and the board stays', !has(afterEnter, 'enters (armed)') && has(afterEnter, 'SESSIONS') && has(lines, 'SESSIONS'))
    const legend = afterEnter.find(l => l.includes('tab panes')) ?? ''
    check("coord: the coordinator-focused footer prints no '↑↓ browse' and still prints '↵ send'", legend !== '' && !legend.includes('↑↓ browse') && legend.includes('↵ send'), legend.trim().slice(0, 118))
  } else {
    check(
      'POISON (pre-fix bundle): ↓ from the coordinator MOVED the ▸ selection onto the second row while ↵ still did not enter',
      rowAfter > rowBefore && sameTitle(titleOf(afterDown[rowAfter]), titleOf(before[nextRow])) && !has(afterEnter, 'enters (armed)') && has(afterEnter, 'SESSIONS'),
      `before=${rowBefore} after=${rowAfter}`,
    )
  }
}

// zero — the pane's own ↑↓ (a CONTROL: the same before and after the fix).
{
  const scratch = newScratch('zero', false)
  scratches.push(scratch)
  capture('zero', scratch, [
    { ...settle, data: DOWN, mark: 'before' },
    { afterPrevTicks: 3, data: '', mark: 'after' },
  ], 60)
  const before = markOf('zero', 'before')
  const after = markOf('zero', 'after')
  const first = COORDINATOR_EXAMPLE_PROMPTS[0]
  const second = COORDINATOR_EXAMPLE_PROMPTS[1]
  // Re-trued (POLISH2, the drift class): the pane CLIPS '↵ sends' at this
  // width ('· ↵…' on the kept capture) — the truncation-surviving highlight
  // mark is the '· ↵' tail only the highlighted row carries.
  const marked = (lines: string[], prompt: string): boolean => lines.some(l => l.includes(prompt) && l.includes('· ↵'))
  check('zero: the pane paints its example prompts with the first highlighted (· ↵ sends)', marked(before, first) && !marked(before, second), before.find(l => l.includes(first))?.trim().slice(0, 100) ?? '(no example row)')
  check('zero: ↓ walked the highlight to the second example — the pane received the key and spent it on its own meaning', marked(after, second) && !marked(after, first), after.find(l => l.includes(second))?.trim().slice(0, 100) ?? '(no example row)')
  check('zero: the ▸ selection stayed on the first session row', selRow(after) === selRow(before) && selRow(before) >= 0, `before=${selRow(before)} after=${selRow(after)}`)
}

// list — tab to the rows: ↓ moves the selection, ↵ arms it.
{
  const scratch = newScratch('list', true)
  scratches.push(scratch)
  capture('list', scratch, [
    { ...settle, data: '\t', mark: 'before' },
    { afterPrevTicks: 3, data: DOWN },
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
    'list: after tab → the rows, ONE ↓ moved the ▸ selection onto the second row',
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
