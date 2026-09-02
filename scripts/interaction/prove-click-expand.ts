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

function capture(
  tag: string,
  clicks: Array<{ x: number; y: number; atTick: number }>,
  total: number,
): { lines: string[]; grid: Cell[][] } | null {
  const cfg = scenario('click-expand', 80, 40)
  cfg.sends = clicks.map(k => ({
    atTick: k.atTick,
    data: `\x1b[<0;${k.x};${k.y}M\x1b[<0;${k.x};${k.y}m`,
  }))
  cfg.total = total
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
// Expanding scrolls earlier rows off the bottom-anchored viewport, but a full
// expand+collapse returns the layout to the baseline — so the same coords hit
// the same row twice, and the collapsed state must be back on screen.
if (base && agentY >= 0) {
  // 1-based SGR coords; col 10 sits inside the row text (non-blank cells).
  const t = capture(
    'toggle',
    [
      { x: 10, y: agentY + 1, atTick: 40 }, // expand agent
      { x: 10, y: agentY + 1, atTick: 56 }, // collapse agent
    ],
    76,
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
// The error card sits BELOW the glob group: with the viewport bottom-anchored,
// the glob expansion pushes rows ABOVE it up — the error card's screen rows
// stay put, so both clicks use baseline coordinates.
if (base && globY >= 0 && errY >= 0) {
  const e = capture(
    'grow',
    [
      { x: 10, y: globY + 1, atTick: 40 }, // expand glob group
      { x: 12, y: errY + 1, atTick: 56 }, // expand lone error card
    ],
    76,
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
  const cfg = scenario('tool-lifecycle', 120, 40)
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
    check(
      'lifecycle: the ± lane did NOT suppress the diff card (hunks still paint)',
      lines.some(l => l.includes('-alpha')) && lines.some(l => l.includes('+omega')),
    )
    // The fixture ALSO persists an unresolved trailing Bash tool_use
    // (toolu_lc_bash1, no tool_result). The resume loader FILTERS incomplete
    // trailing turns — honesty means it paints NOTHING, never a fabricated
    // settled card. (Live queued/running motion is billed-leg territory:
    // the render-live-motion pattern, not a fixture resume.)
    check(
      'lifecycle: the filtered unresolved Bash paints NO ghost card',
      !lines.some(l => l.includes('sleep 999') || l.includes('Long-running fixture command')),
    )
  }
}

// ---- lifecycle source contracts: the queued/unresolved branch --------------
// A fixture resume cannot paint the queued state (the loader drops trailing
// unresolved tool_use), so the queued card's honesty is pinned at SOURCE: the
// queued branch derives from the REAL id sets (never a stored flag), renders
// the dim queued dot, and only ever renders the tool's own queued message —
// no outcome text exists on that path to fabricate.
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
  const run = (clicks: Array<{ x: number; y: number }>, total: number): string[] | null => {
    // Fresh scenario per capture: re-stages the synthetic session so each
    // boot resumes a pristine file (the shared-SID reuse probe).
    const cfg = { ...scenario('two-bash-click', 80, 40) }
    // Observed-SETTLED clicking (proof-hygiene, corrected twice): a fixed
    // tick raced slow boots (press before mouse tracking armed); the first
    // correction awaited the rows' PAINT (+2 ticks) — and CI 30231040753
    // proved paint is still too early: on a slow shared runner the needle
    // paints while the resume is STILL STREAMING filler rows, so a click
    // aimed by the baseline boot's coordinates lands on a row that only
    // later settles at that position (all three click legs dead, twice,
    // deadline raises useless). The invariant a coordinate-aimed click
    // needs is a layout that STOPPED MOVING: awaitStableTicks fires the
    // click only after the whole grid has been byte-identical for 10
    // consecutive ticks past the needle. atTick stays the hard deadline.
    cfg.sends = clicks.map(k => ({
      atTick: 110,
      minTick: 10,
      awaitText: 'bash command',
      awaitStableTicks: 10,
      data: `\x1b[<0;${k.x};${k.y}M\x1b[<0;${k.x};${k.y}m`,
    }))
    cfg.total = total
    const gridPath = `/tmp/click-expand-twobash-${process.pid}.json`
    const cfgPath = `/tmp/click-expand-twobash-cfg-${process.pid}.json`
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
  const twoBase = run([], 90)
  const rows = twoBase
    ? twoBase.map((l, i) => (/bash command/.test(l) ? i : -1)).filter(i => i >= 0)
    : []
  check('two-bash baseline shows BOTH collapsed rows', rows.length === 2, `rows=${JSON.stringify(rows)}`)
  if (rows.length === 2) {
    const afterTop = run([{ x: 20, y: rows[0]! + 1 }], 130)
    check(
      'clicking the FURTHER-UP row expands it (echo hi revealed)',
      afterTop !== null && afterTop.some(l => l.includes('Bash echo hi')),
      afterTop === null
        ? 'capture failed'
        : afterTop.filter(l => /bash command|Bash /.test(l)).map(l => l.trim()).join(' | '),
    )
    const afterBot = run([{ x: 20, y: rows[1]! + 1 }], 130)
    check(
      'clicking the newest row expands it (shasum revealed)',
      afterBot !== null && afterBot.some(l => l.includes('shasum -a 256')),
      afterBot === null
        ? 'capture failed'
        : afterBot.filter(l => /bash command|Bash /.test(l)).map(l => l.trim()).join(' | '),
    )
    // CLICK SLOP: a click with ONE CELL of trackpad drift (press → motion
    // x+1 → release) must still toggle — before the slop law, any drift
    // became a one-char selection and the DOM click was silently swallowed
    //
    const jitter = (() => {
      const cfg = { ...scenario('two-bash-click', 80, 40) }
      const y = rows[0]! + 1
      cfg.sends = [
        {
          atTick: 110,
          minTick: 10,
          awaitText: 'bash command',
          awaitStableTicks: 10,
          data: `\x1b[<0;20;${y}M\x1b[<32;21;${y}M\x1b[<0;21;${y}m`,
        },
      ]
      cfg.total = 130
      const gridPath = `/tmp/click-expand-jitter-${process.pid}.json`
      const cfgPath = `/tmp/click-expand-jitter-cfg-${process.pid}.json`
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
    })()
    check(
      'a one-cell drift click still toggles (the slop law)',
      jitter !== null && jitter.some(l => l.includes('Bash echo hi')),
      jitter === null
        ? 'capture failed'
        : jitter.filter(l => /bash command|Bash /.test(l)).map(l => l.trim()).join(' | '),
    )
  }
}

console.log()
if (failures) {
  console.log(`❌ click-expand proof: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ click-expand proof green')
