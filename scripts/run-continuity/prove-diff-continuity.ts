#!/usr/bin/env bun
// ============================================================================
//  scripts/run-continuity/prove-diff-continuity.ts — R4: the /diff
//  review workspace is CONTINUOUS — stable frame, fair sources, live loading.
//
//  Observed (tactile inventory O8/O9/O4):
//    (a) stepping ←/→ into an empty source SHRANK + REPOSITIONED the whole
//        bottom-anchored dialog (~9-row top-edge jump at 120×40);
//    (b) enumerateExtraSources had ONE global cap with EARLY RETURN in
//        enumeration order — 19 stale worktrees starved handoff/artifact
//        sources out of existence (never enumerated, not merely overflowed);
//    (c) `Loading diff…` was bare dim text outside the ◐ working idiom.
//
//  R4: the list-level body reserves a terminal-derived budget (minHeight) in
//  BOTH the populated and empty branches — the frame stands while sources
//  change; per-family budgets bound lanes/handoffs/artifacts independently;
//  loading wears WorkingGlyph inside the same standing frame.
//
//  Run:  ~/.bun/bin/bun run scripts/run-continuity/prove-diff-continuity.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const ROOT = new URL('../../', import.meta.url).pathname
const src = (p: string): string => readFileSync(join(ROOT, p), 'utf8')

console.log('/diff workspace continuity ──')

{
  const dialog = src('src/components/diff/DiffDialog.tsx')
  check(
    'the body budget derives from the terminal ONLY (never file count)',
    dialog.includes('const bodyBudget = Math.max(4, (termRows || 24) - 12 - (wideSummary ? 0 : 7))'),
  )
  check('the list window still follows content within the budget', dialog.includes('Math.min(files.length, bodyBudget)'))
  const minHeights = dialog.match(/minHeight=\{bodyBudget\}/g) ?? []
  check('BOTH the empty and list branches reserve the budget', minHeights.length === 2, `found ${minHeights.length}`)
  check('loading wears the ◐ working idiom', /diffData\.loading \?[\s\S]{0,200}WorkingGlyph/.test(dialog))
}

{
  const sources = src('src/components/diff/diffSources.ts')
  check('per-family budgets exist', sources.includes('MAX_LANE_SOURCES') && sources.includes('MAX_HANDOFF_SOURCES') && sources.includes('MAX_ARTIFACT_SOURCES'))
  check(
    'the global early-return cap is DEAD (no family can starve another)',
    !sources.includes('if (out.length >= MAX_EXTRA_SOURCES) return out'),
  )
  check('lane flood is bounded, loop breaks instead of returning', sources.includes('if (laneBudget-- <= 0) break'))
  check('handoffs keep their own budget', sources.includes('if (handoffBudget-- <= 0) break'))
  check('artifacts keep their own budget', sources.includes('if (artifactBudget-- <= 0) break'))
}

console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
