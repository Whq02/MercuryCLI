#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-consent-preview-bounded.ts — the bounded
//  consent-preview law, across every file-diff consent card.
//
//  THE CLASS: an over-viewport consent card is broken twice over — it pushes
//  its own options and the composer off the pane (the MGR-1 stranding
//  class), and its CLOSE is a one-frame content shrink taller than the live
//  region, which crosses the inline writer's print-once flush line and
//  forces the epoch repaint (frame-writer.ts inlineEpochRepaint — "the cost
//  is print-once duplication"). The reprinted band is the operator's "the
//  same tool call twice / the edit deducted twice" sighting: the frozen
//  in-progress row above, the settled row below, both standing in history.
//  A card that always fits the pane can never make an epoch necessary.
//
//  The laws under proof:
//    §1 the plan — pure row math: shown ≤ budget, hidden named exactly,
//       expanded shows all, the budget floor holds on tiny panes.
//    §2 the hunk walk — line-granular bounding: totals honest, order kept,
//       the boundary hunk cut, later hunks dropped.
//    §3 the wiring — the Edit and sed consent cards render the BOUNDED
//       wrapper (ConsentFileEditDiff), never the bare unbounded diff; the
//       Write card rides the same shared module; the transcript's
//       rejected-edit surface stays deliberately unbounded; the shell cards
// keep their height-derived command budget.
//    §4 the expand door — the wrapper binds confirm:toggleFullPreview in
//       the Confirmation context (per-hook resolution, never Global), and
//       the named remainder tells the operator the whole edit applies.
//
//  Run: ~/.bun/bin/bun run scripts/permissions/prove-consent-preview-bounded.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const mod = await import('../../src/components/permissions/boundedDiffPreview.ts').catch(
  () => null,
)

section('§1 the plan — pure row math')
if (mod === null) {
  check('the shared bounded-preview module exists', false, 'boundedDiffPreview.ts missing')
} else {
  const { boundedPreviewPlan, consentDiffBudget, CARD_CHROME_ROWS, MIN_PREVIEW_ROWS } = mod
  check('the shared bounded-preview module exists', true)
  check(
    'budget = viewport minus the card chrome',
    consentDiffBudget(40) === 40 - CARD_CHROME_ROWS,
    String(consentDiffBudget(40)),
  )
  check(
    'the budget floor holds on a tiny pane',
    consentDiffBudget(8) === MIN_PREVIEW_ROWS,
    String(consentDiffBudget(8)),
  )
  const plan = boundedPreviewPlan(300, 22, false)
  check('an over-budget preview shows exactly the budget', plan.shown === 22, JSON.stringify(plan))
  check('…and names the remainder exactly', plan.hidden === 278, JSON.stringify(plan))
  const fits = boundedPreviewPlan(10, 22, false)
  check('an in-budget preview shows whole with nothing hidden', fits.shown === 10 && fits.hidden === 0)
  const expanded = boundedPreviewPlan(300, 22, true)
  check('expanded shows all — the operator asked', expanded.shown === 300 && expanded.hidden === 0)
}

section('§2 the hunk walk — line-granular bounding')
if (mod !== null) {
  const { boundHunksToRows, totalHunkRows } = mod
  const hunk = (start: number, n: number) => ({
    oldStart: start,
    oldLines: n,
    newStart: start,
    newLines: n,
    lines: Array.from({ length: n }, (_, i) => ` line ${start + i}`),
  })
  const hunks = [hunk(1, 10), hunk(50, 10), hunk(100, 10)] as never[]
  check('totalHunkRows sums every hunk', totalHunkRows(hunks as never) === 30)
  const cut = boundHunksToRows(hunks as never, 15)
  check('the walk keeps exactly the shown rows', totalHunkRows(cut as never) === 15)
  check('order kept, boundary hunk cut, later hunks dropped',
    cut.length === 2 &&
      (cut[0] as { lines: string[] }).lines.length === 10 &&
      (cut[1] as { lines: string[] }).lines.length === 5,
  )
  const whole = boundHunksToRows(hunks as never, 30)
  check('an exact fit keeps every hunk object', whole.length === 3 && whole[0] === hunks[0])
}

section('§3 the wiring — every file-diff consent card is bounded; the transcript stays whole')
{
  const editCard = readFileSync(
    join(ROOT, 'src/components/permissions/FileEditPermissionRequest/FileEditPermissionRequest.tsx'),
    'utf8',
  )
  const sedCard = readFileSync(
    join(ROOT, 'src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx'),
    'utf8',
  )
  check(
    'the Edit consent card renders the bounded wrapper',
    editCard.includes('ConsentFileEditDiff') && !/content=\{<FileEditToolDiff/.test(editCard),
  )
  check(
    'the sed consent card renders the bounded wrapper',
    sedCard.includes('ConsentFileEditDiff') && !/<FileEditToolDiff\b/.test(sedCard),
  )
  const writeDiff = readFileSync(
    join(ROOT, 'src/components/permissions/FileWritePermissionRequest/FileWriteToolDiff.tsx'),
    'utf8',
  )
  check(
    'the Write card rides the ONE shared module',
    writeDiff.includes("from '../boundedDiffPreview.js'") &&
      writeDiff.includes('consentDiffBudget(') &&
      writeDiff.includes('boundHunksToRows('),
  )
  const transcriptSurface = readFileSync(join(ROOT, 'src/tools/FileEditTool/UI.tsx'), 'utf8')
  check(
    "the transcript's rejected-edit surface stays deliberately unbounded (bare FileEditToolDiff, no consent budget)",
    transcriptSurface.includes('<FileEditToolDiff') && !transcriptSurface.includes('consentRowBudget'),
  )
  const bash = readFileSync(
    join(ROOT, 'src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx'),
    'utf8',
  )
  check(
    'the shell card keeps its height-derived command budget',
    bash.includes('consentCommandPreview') || bash.includes('consentPreviewBudget'),
  )
}

section('§4 the expand door — one chord, Confirmation context, an honest remainder')
{
  const wrapper = readFileSync(
    join(ROOT, 'src/components/permissions/ConsentFileEditDiff.tsx'),
    'utf8',
  ).toString()
  check(
    'the wrapper binds confirm:toggleFullPreview in the Confirmation context',
    wrapper.includes("useKeybinding('confirm:toggleFullPreview'") &&
      wrapper.includes("context: 'Confirmation'"),
  )
  check(
    'expanded hands the diff an unbounded budget (null)',
    wrapper.includes('expanded ? null : consentDiffBudget(rows)'),
  )
  const diff = readFileSync(join(ROOT, 'src/components/FileEditToolDiff.tsx'), 'utf8')
  check(
    'the named remainder tells the operator the whole edit applies',
    diff.includes('more line') && diff.includes('the whole edit applies'),
  )
}

section('§5 the last two cards join the law — notebook cell + change set')
{
  const notebook = readFileSync(
    join(ROOT, 'src/components/permissions/NotebookEditPermissionRequest/NotebookEditToolDiff.tsx'),
    'utf8',
  )
  check(
    'the notebook card rides the ONE shared module',
    notebook.includes("from '../boundedDiffPreview.js'") && notebook.includes('consentDiffBudget('),
  )
  check(
    'the notebook card bounds ALL THREE branches (replace hunks + insert/delete bodies)',
    notebook.includes('boundHunksToRows(') && notebook.includes('boundedPreviewPlan('),
  )
  check(
    'the notebook card binds the expand chord in the Confirmation context',
    notebook.includes("useKeybinding('confirm:toggleFullPreview'") &&
      notebook.includes("context: 'Confirmation'"),
  )
  check('the notebook card names its cut honestly', notebook.includes('more line'))

  const changeSet = readFileSync(
    join(ROOT, 'src/components/permissions/ChangeSetPermissionRequest/ChangeSetPermissionRequest.tsx'),
    'utf8',
  )
  check(
    'the change-set card rides the ONE shared module',
    changeSet.includes("from '../boundedDiffPreview.js'") && changeSet.includes('consentDiffBudget('),
  )
  check(
    'the change-set card reads the terminal HEIGHT (a card with no rows input cannot bound itself)',
    /const \{ columns, rows \} = useTerminalSize\(\)/.test(changeSet),
  )
  check(
    'the change-set card caps the FILE list, not just per-file hunks',
    changeSet.includes('hiddenFiles') && changeSet.includes('more file'),
  )
  check(
    'the change-set card binds the expand chord in the Confirmation context',
    changeSet.includes("useKeybinding('confirm:toggleFullPreview'") &&
      changeSet.includes("context: 'Confirmation'"),
  )
}

console.log(
  failures === 0
    ? '\n ✅ CONSENT PREVIEWS BOUNDED — every card fits the pane; no card close can force the epoch'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
