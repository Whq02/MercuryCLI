#!/usr/bin/env bun
// ============================================================================
//  scripts/navigation/prove-section-crossing.ts — list-level EDGE CROSSING:
//  ↑↓ walk the WHOLE board, one section at a time, empty sections included.
//
//  The defect this pins: /workflows
//  with Active(0) · Recent(1) · Past(0) — the nav axis moved rows only WITHIN
//  the active section, so ↑↓ were dead everywhere while ← walked the
//  vertically-stacked section strip. The first fix crossed only into
//  NON-EMPTY sections — on that exact board there are none, so ↑↓ stayed
//  dead (operator re-report after deploy). The rail is a VERTICAL list; ↑↓
//  must reach everything it shows.
//
//  Laws:
//   · at a section's FIRST row (or inside an EMPTY section), ↑ steps to the
//     PREVIOUS section, landing on its LAST row; at the LAST row, ↓ steps to
//     the NEXT section's FIRST row;
//   · the step is ONE section at a time and LANDS on empty sections (their
//     honest empty state renders; sel pins to 0);
//   · the board's extremes stay hard stops (clamp-not-wrap — unlike ←'s
//     modulo wrap on the Tab axis);
//   · mid-list rows stay within-section motion (crossing decodes null);
//   · the nav axis stays LIVE on an empty section of a multi-section board
//     (rowCount-gating would kill the keys that landed there) and ↵ no-ops
//     without a row; the single-section empty board keeps the axis dead;
//   · the hook consumes the pure brain at the LIST branch, stores the
//     departed section's remembered row (same as the Tab axis), and clamps
//     against SAME-RENDER key counts (the rowCount prop lags one render
//     behind a section switch).
//
//  Run: ~/.bun/bin/bun run scripts/navigation/prove-section-crossing.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crossSectionAtEdge } from '../../src/components/mercury-ui/useNavigablePanes.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const eq = (
  got: { section: number; sel: number } | null,
  want: { section: number; sel: number } | null,
): boolean =>
  got === null || want === null ? got === want : got.section === want.section && got.sel === want.sel

console.log('============================================================')
console.log(' section edge-crossing — proof')
console.log('============================================================')

console.log('\n== the reported board: Active(0) · Recent(1) · Past(0) ==')
check('↑ on the only row lands on the EMPTY section above', eq(crossSectionAtEdge([0, 1, 0], 1, 0, -1), { section: 0, sel: 0 }))
check('↓ on the only row lands on the EMPTY section below', eq(crossSectionAtEdge([0, 1, 0], 1, 0, 1), { section: 2, sel: 0 }))
check('↓ from the empty section returns to the populated one', eq(crossSectionAtEdge([0, 1, 0], 0, 0, 1), { section: 1, sel: 0 }))
check('↑ from the empty bottom section returns too', eq(crossSectionAtEdge([0, 1, 0], 2, 0, -1), { section: 1, sel: 0 }))

console.log('\n== crossing lands on the honest edge row ==')
check('↓ at last row crosses to the NEXT section, FIRST row', eq(crossSectionAtEdge([0, 1, 3], 1, 0, 1), { section: 2, sel: 0 }))
check('↑ at first row crosses to the PREVIOUS section, LAST row', eq(crossSectionAtEdge([3, 2], 1, 0, -1), { section: 0, sel: 2 }))
check('single-row section: its row is both edges (↑)', eq(crossSectionAtEdge([1, 1], 1, 0, -1), { section: 0, sel: 0 }))
check('single-row section: its row is both edges (↓)', eq(crossSectionAtEdge([1, 1], 0, 0, 1), { section: 1, sel: 0 }))

console.log('\n== one section at a time — empties are STOPS, not skipped ==')
check('↓ steps onto the adjacent empty (not past it)', eq(crossSectionAtEdge([2, 0, 0, 4], 0, 1, 1), { section: 1, sel: 0 }))
check('a second ↓ steps through to the next empty', eq(crossSectionAtEdge([2, 0, 0, 4], 1, 0, 1), { section: 2, sel: 0 }))
check('↑ from a populated section onto the empty above', eq(crossSectionAtEdge([2, 0, 0, 4], 3, 0, -1), { section: 2, sel: 0 }))
check('empty→empty ↑ keeps walking', eq(crossSectionAtEdge([2, 0, 0, 4], 2, 0, -1), { section: 1, sel: 0 }))
check('landing upward on a populated section picks its LAST row', eq(crossSectionAtEdge([2, 0], 1, 0, -1), { section: 0, sel: 1 }))

console.log('\n== within-section motion keeps ownership; extremes clamp ==')
check('mid-list ↓ decodes null (within-section motion owns it)', eq(crossSectionAtEdge([3, 3], 0, 1, 1), null))
check('mid-list ↑ decodes null', eq(crossSectionAtEdge([3, 3], 1, 1, -1), null))
check('top of the FIRST section clamps', eq(crossSectionAtEdge([2, 2], 0, 0, -1), null))
check('bottom of the LAST section clamps (never wraps)', eq(crossSectionAtEdge([2, 2], 1, 1, 1), null))
check('empty extremes clamp too', eq(crossSectionAtEdge([0, 1], 0, 0, -1), null) && eq(crossSectionAtEdge([1, 0], 1, 0, 1), null))
check('single-section board decodes null both ways', eq(crossSectionAtEdge([4], 0, 3, 1), null) && eq(crossSectionAtEdge([4], 0, 0, -1), null))

console.log('\n== source pins: the hook consumes the brain, unkillably ==')
const panes = readFileSync(join(root, 'src/components/mercury-ui/useNavigablePanes.ts'), 'utf8')
check('LIST branch routes ↑↓ through crossSectionAtEdge', /const cross = keys\s*\n?\s*\? crossSectionAtEdge\(/.test(panes))
check(
  'crossing stores the departed remembered row (Tab-axis parity)',
  (panes.match(/rememberedSel\.current\.set\(sectionMemoKey\(clampedSection/g) ?? []).length >= 2,
)
check('count truth: clamp prefers same-render key counts', panes.includes('keyedCount ?? rowCount'))
check(
  'the nav axis survives an empty section on a multi-section board',
  panes.includes('const navActive = active && (rowCount > 0 || sectionCount > 1)'),
)
check(
  '↵ no-ops on an empty section (no ghost detail flip)',
  /activateCurrent = \(\): void => \{[\s\S]{0,400}?\(keyedCount \?\? rowCount\) === 0\) return/.test(panes),
)
check('crossing is absent from the DETAIL branch (list-only, deliberate)', !/crossSectionAtEdge/.test(panes.slice(panes.indexOf("if (level === 'detail')"), panes.indexOf('// LIST level'))))

console.log('')
if (failures > 0) {
  console.log(`❌ SECTION-CROSSING RED — ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ SECTION-CROSSING GREEN')
