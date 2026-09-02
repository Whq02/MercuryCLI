#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-click-expand.ts
//  PROOF: collapsed tool/agent results click-TOGGLE open and closed in the
//  fullscreen transcript.
//
//  What it guards, per leg — all in the REAL binary in a PTY, driven by real
//  SGR mouse press+release bytes (\x1b[<0;x;yM / m):
//   1. BASELINE — the collapsed states + their ⌄ cues: the agent result is
//      only the `Done (…)` line (report hidden), the lone Edit error is the
//      classified card with its `└ +N stack frames ⌄` fold, the 1-op glob
//      group is a one-line summary.
//   2. TOGGLE + GLOB — clicking the agent row twice returns it to the
//      collapsed baseline (a one-way expand would leave the report visible),
//      and clicking the glob group reveals the ACTUAL file list (the
//      Glob renderer would otherwise ignore `verbose` — the ⌄ promised more and
//      delivered nothing) on the warm DUNE_FAINT expanded block.
//   3. ERROR — clicking the folded error card reveals the raw uncapped
//      lines (stack frames visible, fold row gone). Gated by
//      isToolErrorResultTruncated (Messages.tsx error branch).
//
//  Contract greps pin the per-tool isResultTruncated gates + the dist ships.
//
//  Run: ~/.bun/bin/bun run scripts/interaction/prove-click-expand.ts
// ============================================================================
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DUNE_FAINT } from '../../src/components/mercuryPalette.ts'
import { CONFIG_HOME, cleanupScenario, scenario } from '../ui/renderScenarios.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

type Cell = { c: string; bg?: string }
type Grid = { grid: Cell[][] }

/** The frame, row-numbered, for a red that needs its evidence in the log
 *  (a row that is simply absent has no other witness). */
function dumpFrame(label: string, lines: string[]): void {
  console.log(`      ┌ ${label}`)
  lines.forEach((line, index) => {
    const row = line.trimEnd()
    if (row !== '') console.log(`      │ ${String(index).padStart(2, ' ')} ${row}`)
  })
  console.log('      └')
}

/** A press+release aimed by TEXT: the send names its row (`targetText`) and
 *  vshot resolves {X}/{Y} against THIS boot's grid at fire time — the row's
 *  first cell plus `targetDx`, inside its text. Coordinates never ride
 *  another boot's layout: the bottom chrome (the notification block, the
 *  resumed card) differs between boots and between the settled end of one
 *  capture and the click moment of the next. */
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
/** Every click is OBSERVED: it fires only once the row it aims at is on
 *  screen and has held for four ticks — a fixed tick raced slow boots, and a
 *  resume still streaming rows moved a coordinate-aimed click off its row.
 *  The aim is resolved on the live grid at fire time, so the click needs
 *  the row present, not a byte-identical screen: the cockpit keeps a live
 *  cell repainting (a caret, an indicator), and a whole-grid stability
 *  gate never opens there. requireAwait refuses a journey whose row never
 *  painted (exit 4) rather than clicking blind at the deadline; atTick
 *  stays the hard deadline. */
const SETTLED = { minTick: 10, awaitSettleTicks: 4, requireAwait: true } as const
const clickOn = (needle: string, atTick: number): Record<string, unknown> => ({
  targetText: needle,
  targetDx: 2,
  awaitText: needle,
  atTick,
  data: CLICK,
  ...SETTLED,
})

function capture(
  tag: string,
  sends: Array<Record<string, unknown>>,
  total: number,
  extra: Record<string, unknown> = {},
): { lines: string[]; grid: Cell[][] } | null {
  // 50 rows: the keyless hosted boot paints a five-row notification block
  // (no live runner · model refused · the /logins ask · ↵ revives it) and a
  // resumed card under the transcript; at 40 rows that chrome scrolled the
  // first tool row — the agent's Done line — one row above the viewport, and
  // an expanded error card pushed the expanded glob list off the top.
  const cfg = scenario('click-expand', 80, 50) as Record<string, unknown>
  cfg['sends'] = sends
  cfg['total'] = total
  Object.assign(cfg, extra)
  const gridPath = `/tmp/click-expand-${tag}-${process.pid}.json`
  const cfgPath = `/tmp/click-expand-${tag}-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  if (res.status !== 0) {
    check(`${tag}: PTY capture ran`, false, res.stderr?.slice(0, 200) ?? '')
    return null
  }
  const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
  return { lines: grid.map(r => r.map(c => c.c).join('')), grid }
}

console.log('============================================================')
console.log(' click-to-toggle — collapsed tool/agent results (disclosure)')
console.log('============================================================')

// ---- source + dist contract (cheap, no PTY) --------------------------------
const src = (p: string) => readFileSync(p, 'utf8')
check(
  'AgentTool gates click-expand (isResultTruncated wired)',
  src('src/tools/AgentTool/AgentTool.tsx').includes('isResultTruncated,') &&
    src('src/tools/AgentTool/UI.tsx').includes('export function isResultTruncated'),
)
check(
  'AgentTool verbose reveals the report (not transcript-only)',
  src('src/tools/AgentTool/UI.tsx').includes('(isTranscriptMode || verbose) && content'),
)
check(
  'Grep + Glob + TaskOutput gate click-expand',
  src('src/tools/GrepTool/GrepTool.ts').includes('isResultTruncated,') &&
    src('src/tools/GlobTool/GlobTool.ts').includes('isResultTruncated,') &&
    src('src/tools/TaskOutputTool/TaskOutputTool.tsx').includes('isResultTruncated('),
)
check(
  'fork Glob renderer honors verbose (file list branch)',
  src('src/tools/GlobTool/UI.tsx').includes('opts.verbose && filenames.length > 0'),
)
// The click gate: an error result is always expandable (its fold is the
// error card's own render), a success result expands only when the tool's
// isResultTruncated says the persisted record holds more than the row shows.
check(
  'Messages.tsx error rows gate on the fold owner',
  /if \(\(result as \{ is_error\?: boolean \}\)\.is_error\) \{\s*verdict = true/.test(src('src/components/Messages.tsx')) &&
    /\)\.isResultTruncated\?\.\(record\) === true/.test(src('src/components/Messages.tsx')) &&
    src('src/components/FallbackToolUseErrorMessage.tsx').includes('export function isToolErrorResultTruncated'),
)
// Identifiers are minify-renamed in the bundle, but tool-def METHOD KEYS are
// property names and survive: 7 base isResultTruncated implementations + the
// 4 new gates (Agent · Grep · Glob · TaskOutput) ⇒ ≥ 11 occurrences. The
// error-fold gate has no stable literal — the live error-click leg below is
// its ships-in-dist proof.
check(
  'dist ships the 4 new isResultTruncated gates (11 method keys)',
  (readFileSync('dist/mercury.mjs', 'utf8').match(/isResultTruncated/g)?.length ?? 0) >= 11,
)

// ---- leg 1: baseline (collapsed) -------------------------------------------
const base = capture('base', [], 70)
let agentY = -1
let globY = -1
let errY = -1
if (base) {
  const rowOf = (needle: string): number => base.lines.findIndex(l => l.includes(needle))
  agentY = rowOf('Done (3 tool uses')
  globY = rowOf('Searched for 1 pattern')
  errY = rowOf('The target file could not be read')
  check('baseline: agent Done row present', agentY >= 0)
  if (agentY < 0) dumpFrame('baseline frame — the agent Done row is absent', base.lines)
  check('baseline: agent report HIDDEN', rowOf('REPORT-LINE') === -1)
  check(
    'baseline: agent row carries the ⌄ cue',
    agentY >= 0 && (base.lines[agentY]!.includes('⌄') || (base.lines[agentY + 1] ?? '').includes('⌄')),
  )
  check('baseline: glob group collapsed', globY >= 0 && rowOf('GlobTool/prompt.ts') === -1)
  check(
    'baseline: error card folded (stack frames hidden)',
    errY >= 0 && rowOf('+3 stack frames') >= 0 && rowOf('at Object.openSync') === -1,
  )
}

// ---- leg 2: TOGGLE the agent row (expand, then collapse back) ---------------
// The first click aims at the Done row; the second aims at the revealed
// report line — the same rendered item, so it toggles the block closed — and
// waits for that line to be on screen and settled first, so it lands on the
// expanded block, never on a frame that had not repainted yet.
if (base && agentY >= 0) {
  const t = capture(
    'toggle',
    [
      clickOn('Done (3 tool uses', 110), // expand agent
      clickOn('REPORT-LINE', 150), // collapse agent
    ],
    170,
    { stableTicks: 4 },
  )
  if (t) {
    const rowOf = (needle: string): number => t.lines.findIndex(l => l.includes(needle))
    check('toggle: agent report hidden again after 2nd click', rowOf('REPORT-LINE') === -1)
    const doneY = rowOf('Done (3 tool uses')
    check('toggle: agent Done row back on screen', doneY >= 0)
    check(
      'toggle: the ⌄ cue is back (honest fold marker)',
      doneY >= 0 && ((t.lines[doneY] ?? '').includes('⌄') || (t.lines[doneY + 1] ?? '').includes('⌄')),
    )
  }
} else {
  check('toggle leg ran', false, 'baseline rows missing')
}

// ---- leg 3: expand the glob group, then the lone error card -----------------
// The second click aims at the error card's own row and waits for the glob
// file list — the first expansion's needle — to be on screen and settled.
if (base && globY >= 0 && errY >= 0) {
  const e = capture(
    'grow',
    [
      clickOn('Searched for 1 pattern', 110), // expand glob group
      { ...clickOn('The target file could not be read', 150), awaitText: 'GlobTool/prompt.ts' }, // expand lone error card
    ],
    170,
    { stableTicks: 4 },
  )
  if (e) {
    const rowOf = (needle: string): number => e.lines.findIndex(l => l.includes(needle))
    const fileRow = rowOf('GlobTool/prompt.ts')
    check('glob click: file list revealed', fileRow >= 0 && rowOf('GlobTool.ts') >= 0)
    check(
      'glob click: expanded block wears the DUNE_FAINT bg',
      // Import-synced to the token (the oasis-retint lesson: a literal here
      // silently pins the PREVIOUS palette).
      fileRow >= 0 &&
        e.grid[fileRow]!.some(c => c.bg?.toLowerCase() === DUNE_FAINT.slice(1).toLowerCase()),
    )
    check('error click: raw stack frames revealed', rowOf('at Object.openSync') >= 0)
    check('error click: fold row gone', rowOf('+3 stack frames') === -1)
  }
} else {
  check('grow leg ran', false, 'baseline rows missing')
}

cleanupScenario('click-expand')

// ---- lifecycle: one tool-use id owns ONE visible card, settled honestly ----
// a resolved Edit paints ONE header card whose
// ± meta (`· +1/-1`, the editMeta lane — real structuredPatch counts) appears
// exactly once, AND the downstream diff card still renders (the lane rides the
// header, NOT summarizeToolResult — that dispatcher would suppress the hunks).
// 120 cols: the helm-home CENTER PANE is the message estate, and the ± tail
// gates on ≥80 LOCAL columns (same gate as the sibling inlineTail) — a 100-col
// terminal leaves only a 76-col pane.
{
  // 50 rows: the cockpit's centre pane keeps an eleven-row session hero
  // pinned at its top and the keyless hosted boot paints a five-row
  // notification block under the composer; at 40 rows the pane's
  // transcript window was ten rows and the Edit header sat above it.
  const cfg = scenario('tool-lifecycle', 120, 50)
  const gridPath = `/tmp/tool-lifecycle-${process.pid}.json`
  const cfgPath = `/tmp/tool-lifecycle-cfg-${process.pid}.json`
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
  const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
    encoding: 'utf8',
    timeout: vshotBudgetMs(120_000),
    env: {
      ...process.env,
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CONFIG_DIR: CONFIG_HOME,
    },
  })
  cleanupScenario('tool-lifecycle')
  if (res.status !== 0) {
    check('lifecycle: PTY capture ran', false, res.stderr?.slice(0, 200) ?? '')
  } else {
    const lines = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid.map(r =>
      r.map(c => c.c).join(''),
    )
    const editRows = lines.filter(l => l.includes('lifecycle-demo.txt'))
    check('lifecycle: ONE visible card for the resolved Edit id', editRows.length >= 1 && new Set(editRows.map(l => l.trim())).size <= 2, `rows=${editRows.length}`)
    const metaRows = lines.filter(l => l.includes('· +1/-1'))
    check('lifecycle: the settled ± meta rides the header EXACTLY once', metaRows.length === 1, `rows=${metaRows.length}: ${metaRows.map(l => l.trim()).join(' | ')}`)
    if (editRows.length === 0 || metaRows.length !== 1) dumpFrame('lifecycle frame — the Edit header is absent', lines)
    check(
      'lifecycle: the ± lane did NOT suppress the diff card (hunks still paint)',
      lines.some(l => l.includes('-alpha')) && lines.some(l => l.includes('+omega')),
    )
    // The fixture ALSO persists an unresolved trailing Bash tool_use
    // (toolu_lc_bash1, no tool_result). The resumed chain keeps the row, and
    // a use with no result is UNRESOLVED: it paints as the QUEUED card — the
    // dim dot, its command, `waiting…` — never a settled card. (Live
    // queued/running motion is billed-leg territory: the render-live-motion
    // pattern, not a fixture resume.)
    check(
      'lifecycle: the unresolved Bash paints as the queued card (its command + waiting…)',
      lines.some(l => l.includes('sleep 999')) && lines.some(l => l.includes('waiting…')),
      lines.filter(l => l.includes('sleep 999') || l.includes('waiting')).map(l => l.trim()).join(' | ') || '(neither row painted)',
    )
    // The trailing Bash tool_use has NO result, so it never RAN: a collapsed
    // `Ran 1 bash command ⌄` row is a settled claim the record does not hold
    // (the collapse walk keeps a result-less use out of the settled row).
    check(
      'lifecycle: the unresolved Bash is never a settled "Ran" row',
      !lines.some(l => /Ran \d+ bash command/.test(l)),
      lines.filter(l => /bash command/.test(l)).map(l => l.trim()).join(' | '),
    )
  }
}

// ---- lifecycle source contracts: the queued/unresolved branch --------------
// The capture above paints the queued card for the resumed result-less use;
// these pins keep its derivation honest at SOURCE: the queued branch derives
// from the REAL id sets (never a stored flag), renders the dim queued dot,
// and only ever renders the tool's own queued message — no outcome text
// exists on that path to fabricate.
{
  const atum = src('src/components/messages/AssistantToolUseMessage.tsx')
  check(
    'queued state derives from the live id sets',
    atum.includes('const resolved = lookups.resolvedToolUseIDs.has(param.id)') &&
      atum.includes('const inProgress = inProgressToolUseIDs.has(param.id)') &&
      atum.includes('const queued = !resolved && !inProgress'),
  )
  check(
    'queued card renders ONLY on the unresolved branch',
    /if \(queued\) \{\s*try \{\s*queuedMessage =\s*tool\.renderToolUseQueuedMessage\?\.\(parsedInput\.data, \{/.test(atum),
  )
  check(
    'the ± meta lane is settled-only (no invented counts on queued/errored)',
    /EDIT_META_TOOLS\.has\(param\.name\) &&\s*resolved &&\s*!errored &&\s*!verbose &&\s*!isTranscriptMode &&/.test(atum) &&
      atum.includes('if (!Array.isArray(patch)) return null') &&
      atum.includes('if (added === 0 && removed === 0) return null'),
  )
}

// ---- leg 4: BOTH collapsed bash rows expand — the further-up row too -------
// #16: the operator saw only the MOST RECENT
// "Ran 1 bash command ⌄" respond to clicks. This leg pins the harness truth
// on the two-bash-click scenario (60 filler turns ⇒ real scroll + virtual
// window; two separate single-Bash collapsed groups): clicking the OLDER row
// AND the newest row must each reveal their command. The field failure has
// not reproduced under resume-shaped sessions — if it regresses HERE, the
// geometry/dispatch path itself broke; the live-accretion condition stays
// tracked on the record.
{
  const run = (tag: string, sends: Array<Record<string, unknown>>, total: number): string[] | null => {
    // Fresh scenario per capture: re-stages the synthetic session so each
    // boot resumes a pristine file (the shared-SID reuse probe).
    const cfg = { ...scenario('two-bash-click', 80, 40) } as Record<string, unknown>
    // Every click is text-aimed and observed-settled (CLICK · SETTLED
    // above): a fixed tick raced slow boots (press before mouse tracking
    // armed), a click aimed by the PAINT of the needle landed on a row the
    // still-streaming resume later moved, and a click aimed by another
    // boot's settled coordinates missed by the rows the bottom chrome had
    // gained or lost in between (a transient notification present at the
    // click moment and gone by the baseline's settled end).
    cfg['sends'] = sends
    cfg['total'] = total
    const gridPath = `/tmp/click-expand-twobash-${tag}-${process.pid}.json`
    const cfgPath = `/tmp/click-expand-twobash-${tag}-cfg-${process.pid}.json`
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
    const res = spawnSync('/usr/bin/python3', [join(import.meta.dir, '../ui/vshot.py'), cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: {
        ...process.env,
        MERCURY_CONFIG_DIR: CONFIG_HOME,
      },
    })
    if (res.status !== 0) return null
    const grid = (JSON.parse(readFileSync(gridPath, 'utf8')) as Grid).grid
    return grid.map(r => r.map(c => c.c).join(''))
  }
  const bashRows = (lines: string[]): string => lines.filter(l => /bash command|Bash /.test(l)).map(l => l.trim()).join(' | ')
  const twoBase = run('base', [], 90)
  const rows = twoBase
    ? twoBase.map((l, i) => (/bash command/.test(l) ? i : -1)).filter(i => i >= 0)
    : []
  check('two-bash baseline shows BOTH collapsed rows', rows.length === 2, `rows=${JSON.stringify(rows)}`)
  if (rows.length === 2) {
    // Both rows wear the same collapsed label, and a text-aimed click lands
    // on the FIRST row carrying its needle: the further-up row.
    const afterTop = run('top', [{ ...clickOn('bash command', 110), targetDx: 0 }], 130)
    check(
      'clicking the FURTHER-UP row expands it (echo hi revealed)',
      afterTop !== null && afterTop.some(l => l.includes('Bash echo hi')),
      afterTop === null ? 'capture failed' : bashRows(afterTop),
    )
    // The newest row is aimed once the further-up row has expanded — its
    // label then reads `Bash echo hi`, so the only row still carrying the
    // collapsed label is the newest; the second click waits for that
    // expansion to be on screen and settled.
    const afterBot = run(
      'bottom',
      [
        { ...clickOn('bash command', 110), targetDx: 0 },
        { ...clickOn('bash command', 150), targetDx: 0, awaitText: 'Bash echo hi' },
      ],
      170,
    )
    check(
      'clicking the newest row expands it (shasum revealed)',
      afterBot !== null && afterBot.some(l => l.includes('shasum -a 256')),
      afterBot === null ? 'capture failed' : bashRows(afterBot),
    )
    // CLICK SLOP: a click with ONE CELL of trackpad drift (press → motion
    // x+1 → release) must still toggle — before the slop law, any drift
    // became a one-char selection and the DOM click was silently swallowed.
    // Two text-aimed sends: the press on the row's first cell, then the
    // motion and release one cell to the right, one tick later (nothing
    // repaints between a press and its release).
    const jitter = run(
      'jitter',
      [
        { ...clickOn('bash command', 110), targetDx: 0, data: '\x1b[<0;{X};{Y}M' },
        { targetText: 'bash command', targetDx: 1, afterPrevTicks: 1, data: '\x1b[<32;{X};{Y}M\x1b[<0;{X};{Y}m' },
      ],
      130,
    )
    check(
      'a one-cell drift click still toggles (the slop law)',
      jitter !== null && jitter.some(l => l.includes('Bash echo hi')),
      jitter === null ? 'capture failed' : bashRows(jitter),
    )
  }
}

console.log()
if (failures) {
  console.log(`❌ click-expand proof: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ click-expand proof green')
